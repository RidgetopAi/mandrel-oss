/**
 * Remote Streamable HTTP MCP transport.
 *
 * Mounts the MCP Streamable HTTP transport on the existing Express app (HealthServer)
 * at `POST /mcp`, `GET /mcp`, `DELETE /mcp` per the Streamable HTTP spec.
 *
 * Design:
 *   - STATEFUL sessions: `sessionIdGenerator` is set; we keep a map of
 *     { transport, server } keyed by `Mcp-Session-Id`, matching the server's existing
 *     connectionId model (the session id becomes the connectionId for tool dispatch,
 *     so HTTP sessions are isolated from stdio and from each other).
 *   - DRY: each per-session SDK `Server` registers the SAME handlers as stdio via
 *     `registerMcpHandlers()`. No tool logic is duplicated; CallTool delegates back to
 *     the shared `executeMcpTool()`.
 *   - AUTH: the `bearerAuth()` middleware is applied to the route(s) by the caller
 *     BEFORE these handlers run, so unauthorized requests never create a session.
 *   - DNS-rebinding / Origin protection via the SDK transport options.
 */

import type { Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest, LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import { logger } from '../utils/logger.js';
import { MANDREL_SERVER_NAME, MANDREL_VERSION } from '../version.js';
import { registerMcpHandlers, type McpHandlerDeps } from './registerMcpHandlers.js';
import { resolveInstructions } from '../utils/projectEcho.js';
import { runWithProjectScope } from '../services/effectiveProjectScope.js';
import { PROJECT_INSTRUCTIONS_ENABLED } from '../config/projectEchoConfig.js';
import { deriveActor } from '../config/actorRegistry.js';
import { PROJECT_BINDING_HEADER } from '../config/projectBindingConfig.js';
import { LOOP_ID_HEADER } from '../config/positionKeyConfig.js';
import { MCP_MAX_REQUEST_BODY_BYTES } from '../config/mcpRequestLimitsConfig.js';

const MCP_SESSION_HEADER = 'mcp-session-id';
// The stable per-connection identity the bridge / remote client sends (SR-1, migration
// 050). It is the KEY for connection→session→project recovery: an mcp-session-id is
// ephemeral (re-minted every initialize / lost on restart), but X-Connection-ID is stable
// across a restart, so dispatching tools under it lets SessionTracker's SR-1 re-attach
// recover the SAME session row — and therefore the SAME project — from the DB after a
// restart. We prefer it for dispatch when present and fall back to the mcp-session-id
// (preserving the original per-session isolation for clients that don't send it).
const CONNECTION_ID_HEADER = 'x-connection-id';
// Sessions Foundation Phase 1: the declared-actor header on the remote MCP surface.
const ACTOR_ID_HEADER = 'x-actor-id';
// PROJECT BINDING: the client-declared project scope on the remote MCP
// surface. Name owned by config/projectBindingConfig.ts (configs-not-hardcoded) — imported
// rather than re-typed so the header name exists exactly once in the product.
const JSONRPC_INVALID_REQUEST = -32600;
// Session-expired (idle-evicted) is distinct from a malformed/no-session request: it is
// a recoverable state where the client should RE-INITIALIZE. We use a dedicated code in
// the implementation-defined JSON-RPC range (-32000..-32099) so a well-behaved MCP
// client can recognize "re-initialize needed" rather than treating it as a fatal
// protocol/auth error. (Auth failures stay 401/-32001 in bearerAuth — see CONSTRAINTS.)
const JSONRPC_SESSION_EXPIRED = -32002;

// Bounds on the per-session transport map. Even an AUTHENTICATED caller must not be
// able to grow memory without limit by spamming `initialize`. We cap the number of
// live sessions and evict idle ones, so memory stays bounded on the public endpoint.
const DEFAULT_MAX_SESSIONS = 100;
// Idle TTL before a session is evicted. Tuned so a working dev rarely hits idle-expiry:
// 24 hours comfortably spans an overnight gap or a long weekend break while staying
// BOUNDED for memory/security (not unbounded). Raised from 4h → 24h as a
// cheap complement to rehydrate-on-miss: fewer sessions ever go idle, so fewer
// rehydrations are needed. Override with MCP_SESSION_IDLE_MS (milliseconds), no code change.
const DEFAULT_SESSION_IDLE_MS = 24 * 60 * 60 * 1000; // 24 hours

// Rehydration rate limit (rehydrate-on-miss). Even an AUTHENTICATED caller
// must not be able to spam unknown session ids to force unbounded session re-creation, so
// we cap rehydrations per (principal+connection) within a rolling window. A legitimate
// client only rehydrates ONCE after a restart/idle-expiry per connection, then keeps using
// the revived session — so a small budget never bites a real user. Tunable without a code
// change via MCP_REHYDRATE_MAX_PER_WINDOW / MCP_REHYDRATE_WINDOW_MS.
const DEFAULT_REHYDRATE_MAX_PER_WINDOW = 10;
const DEFAULT_REHYDRATE_WINDOW_MS = 60 * 1000; // 1 minute

// Our session ids are RFC-4122 v4 UUIDs (randomUUID()). Rehydration ONLY accepts an
// incoming id matching this exact format; anything else is treated as a garbage/forged id
// and gets the normal 404 (never rehydrated), so an attacker cannot spawn arbitrary
// sessions by sending made-up ids.
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Protocol version advertised on the synthetic rehydration initialize. Taken from the
// installed SDK's LATEST_PROTOCOL_VERSION (not hardcoded) so it can never drift from what
// the transport actually negotiates; the synthetic init is internal and immediately
// discarded, so the exact value only needs to be SDK-accepted.
const SYNTHETIC_INIT_PROTOCOL_VERSION = LATEST_PROTOCOL_VERSION;

function resolveMaxSessions(): number {
  const raw = process.env.MCP_MAX_SESSIONS;
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_MAX_SESSIONS;
}

function resolveSessionIdleMs(): number {
  const raw = process.env.MCP_SESSION_IDLE_MS;
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_SESSION_IDLE_MS;
}

function resolvePositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name]; // env-read: via-callers
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

interface SessionEntry {
  transport: StreamableHTTPServerTransport;
  server: Server;
  /** Epoch ms of the last request seen on this session; drives idle eviction + LRU. */
  lastActivity: number;
  /**
   * The connection identity to use for TOOL DISPATCH (project isolation key), updated on
   * every request from the X-Connection-ID header (falling back to the mcp-session-id).
   * The per-session SDK handlers read this at call time so a stable X-Connection-ID drives
   * SR-1 DB re-attach (→ correct project) while clients without the header keep the
   * original per-session isolation. See dispatchConnectionId().
   */
  dispatchConnId?: string;
  /**
   * Sessions Foundation Phase 1: the DECLARED actor for this session, updated per-request
   * from the X-Actor-ID header (verified OAuth `sub` takes precedence when present). Read at
   * tool-call time to attribute a lazily-created session. Attribution only (not authz).
   */
  actor?: string;
  /**
   * PROJECT BINDING: the raw X-Mandrel-Project this session declared,
   * refreshed per-request exactly like `actor` above. Read at tool-call time by the
   * routeExecutor binding gate. Undefined = this client configured no binding (the
   * default), in which case MANDREL_PROJECT_ID is consulted and, failing that, project
   * resolution is completely untouched.
   */
  projectBinding?: string;
  /**
   * THE AGENT LOOP THIS SESSION'S CALLS BELONG TO — the declared
   * `X-Loop-ID`, refreshed per-request exactly like `actor` and `projectBinding` above and
   * read at tool-call time by the position-keying ladder (config/positionKeyConfig.ts,
   * rung 1).
   *
   * It is the only discriminator that separates two agents sharing BOTH a connection and
   * an actor — the population the branch-position cross-talk was filed on. Until this
   * field existed the streamable surface DROPPED the header: a client declaring its loop
   * identity on `POST /mcp` was keyed as though it had declared nothing, while the same
   * client on `POST /mcp/tools/*` was keyed correctly. A silently ignored identity
   * declaration is worse than an unsupported one — the caller believes it is isolated and
   * is not, and nothing tells it otherwise.
   */
  loopId?: string;
}

/**
 * THE PER-REQUEST IDENTITY a session carries — ONE type, so the set of things a request
 * declares about itself cannot be enumerated differently in different places.
 *
 * WHY A TYPE AND NOT THREE LOCALS — the defect this shape exists to prevent, and it is the
 * defect that made an earlier task necessary: `actor` and `projectBinding` were hand-copied
 * onto the session entry at THREE sites (existing-session refresh, createSession,
 * rehydrate) and handed to the dynamic registrar as SEPARATE positional getters. When
 * `loopId` was added to RouteContext and to the flat transport it was missed at all four —
 * not because anyone decided this surface should ignore it, but because no single place
 * said what "the identity" IS. A fifth field would have been dropped the same way. There
 * is now exactly one producer (`identityFor`) and one consumer (`getIdentity`).
 */
interface RequestIdentity {
  actor?: string;
  projectBinding?: string;
  loopId?: string;
}

/**
 * Parse `MCP_ALLOWED_HOSTS` (comma-separated) into a list for DNS-rebinding protection.
 * Defaults to localhost variants so local dev / on-box never breaks.
 */
function resolveAllowedHosts(): string[] {
  const raw = process.env.MCP_ALLOWED_HOSTS;
  const defaults = ['localhost', '127.0.0.1', 'localhost:8080', '127.0.0.1:8080'];
  if (!raw || raw.trim() === '') {
    return defaults;
  }
  const configured = raw.split(',').map(h => h.trim()).filter(Boolean);
  // Always keep localhost reachable for on-box health/testing alongside the public host.
  return Array.from(new Set([...configured, ...defaults]));
}

/**
 * Manages per-session Streamable HTTP MCP transports and exposes Express handlers.
 */
export class RemoteMcpTransport {
  // Insertion-ordered Map; we use the JS Map iteration order + lastActivity to evict
  // the least-recently-used entry when the cap is hit.
  private sessions = new Map<string, SessionEntry>();
  private readonly allowedHosts: string[];
  private readonly maxSessions: number;
  private readonly sessionIdleMs: number;
  private readonly rehydrateMaxPerWindow: number;
  private readonly rehydrateWindowMs: number;
  // Per-(principal+connection) sliding-window timestamps of recent rehydrations, for the
  // rehydration rate limit. Pruned opportunistically; bounded by the number of distinct
  // authenticated principals/connections that have rehydrated within the window.
  private rehydrateHits = new Map<string, number[]>();

  constructor(private readonly deps: McpHandlerDeps) {
    this.allowedHosts = resolveAllowedHosts();
    this.maxSessions = resolveMaxSessions();
    this.sessionIdleMs = resolveSessionIdleMs();
    this.rehydrateMaxPerWindow = resolvePositiveIntEnv(
      'MCP_REHYDRATE_MAX_PER_WINDOW', DEFAULT_REHYDRATE_MAX_PER_WINDOW
    );
    this.rehydrateWindowMs = resolvePositiveIntEnv(
      'MCP_REHYDRATE_WINDOW_MS', DEFAULT_REHYDRATE_WINDOW_MS
    );
    logger.info(
      `🌐 Remote MCP transport configured (DNS-rebinding protection on; allowedHosts=${this.allowedHosts.join(',')}; ` +
      `maxSessions=${this.maxSessions}; sessionIdleMs=${this.sessionIdleMs}; ` +
      `rehydrate=${this.rehydrateMaxPerWindow}/${this.rehydrateWindowMs}ms)`
    );
  }

  /**
   * The connection identity used for TOOL DISPATCH (project isolation key). Prefer the
   * stable X-Connection-ID header — it survives a server restart, so SR-1's DB re-attach
   * (SessionTracker.getActiveSession → SessionRepo.findReattachable) can recover the same
   * session row and therefore the same PROJECT after a restart/rehydration. Fall back to
   * the (ephemeral) mcp-session-id when the client does not send X-Connection-ID, which
   * preserves the original per-session isolation for those clients.
   */
  private dispatchConnectionId(req: Request, sessionId: string | undefined): string | undefined {
    const conn = req.header(CONNECTION_ID_HEADER);
    if (conn && conn.trim() !== '') return conn.trim();
    return sessionId;
  }

  /**
   * Sessions Foundation Phase 1: the ACTOR to attribute a lazily-created session to on the
   * remote MCP surface. Pure plumbing — it hands the verified OAuth `sub` and the declared
   * X-Actor-ID header to `deriveActor`, which owns the ONE precedence rule so it cannot drift
   *. Undefined → the lifecycle service stamps the flagged `anonymous` actor.
   * Attribution, not authz.
   *
   * THE RULE IS FLAG-GATED, so do not restate it here:
   * with MANDREL_ACTOR_COMPOSITE_ENABLED off (the shipped default) a verified `sub` OVERRIDES
   * the declared header; with it on the `sub` SCOPES the declared handle into a server-assembled
   * composite, so N agents under one human get N actors. Read deriveActor for the current truth.
   */
  private actorFor(req: Request): string | undefined {
    const sub = (req as { oauthSubject?: { sub?: string } }).oauthSubject?.sub;
    return deriveActor(sub, req.header(ACTOR_ID_HEADER));
  }

  /**
   * PROJECT BINDING: the raw client-declared project scope for this
   * request. Pure transport plumbing — the trim/blank-is-absent rule and the
   * header-beats-env ladder live in config/projectBindingConfig.ts, not here.
   */
  private projectBindingFor(req: Request): string | undefined {
    return req.header(PROJECT_BINDING_HEADER);
  }

  /**
   * THE DECLARED AGENT LOOP for this request. Pure transport plumbing: the
   * header NAME is owned by config/positionKeyConfig.ts beside the ladder that consumes it,
   * and the trim/blank-is-absent rule lives in `composePositionKey` — so this surface and
   * the flat one cannot come to disagree about what a loop id is.
   */
  private loopIdFor(req: Request): string | undefined {
    return req.header(LOOP_ID_HEADER);
  }

  /**
   * EVERY per-request identity this transport reads, assembled in ONE place. Each site that
   * stamps a session entry calls THIS — see RequestIdentity for the measured reason.
   */
  private identityFor(req: Request): RequestIdentity {
    return {
      actor: this.actorFor(req),
      projectBinding: this.projectBindingFor(req),
      loopId: this.loopIdFor(req),
    };
  }

  /**
   * PROJECT VISIBILITY: resolve the connect-time `instructions` for a NEW
   * session. Keyed by the dispatch connection id (X-Connection-ID when present) — the SDK
   * session id is not yet minted at initialize time, so a client that sends no connection
   * id gets the STATIC (project-agnostic) reminder; one that does gets the DYNAMIC string
   * naming its active project. Returns undefined when the feature is disabled (→ the Server
   * is built with NO instructions, i.e. the exact prior behavior). Never throws.
   */
  private async resolveSessionInstructions(req: Request): Promise<string | undefined> {
    if (!PROJECT_INSTRUCTIONS_ENABLED) return undefined;
    const connId = this.dispatchConnectionId(req, undefined);
    // EFFECTIVE-SCOPE WRAP. The connect-time instructions are the ONE project
    // resolution that happens outside routeExecutor — it runs at `initialize`, before any tool
    // call exists — so the ambient scope has to be established here too, or a bound client is
    // told the auto-selected project by the very first thing the server says to it.
    // `runWithProjectScope` is deliberately the only way to populate the store, so this call
    // and routeExecutor's are the complete set (both are asserted by
    // src/tests/projectScopeChokePoint.contract.test.ts).
    return runWithProjectScope(
      { connectionId: connId, projectBinding: this.projectBindingFor(req) },
      () => resolveInstructions(connId)
    );
  }

  /**
   * A stable principal key for the rehydration rate limit. OAuth callers are keyed by
   * their verified `sub`; static-token tenants share one key (the container IS the tenant).
   * Combined with the connection so one noisy connection can't exhaust another's budget.
   */
  private rehydratePrincipalKey(req: Request, oldSessionId: string): string {
    const sub = (req as { oauthSubject?: { sub?: string } }).oauthSubject?.sub ?? 'static-tenant';
    const conn = req.header(CONNECTION_ID_HEADER)?.trim() || oldSessionId;
    return `${sub}::${conn}`;
  }

  /**
   * Sliding-window rate-limit check for rehydration. Returns true if a rehydration is
   * ALLOWED for this principal (and records it), false if the budget is exhausted.
   */
  private allowRehydration(principalKey: string): boolean {
    const now = Date.now();
    const cutoff = now - this.rehydrateWindowMs;
    const hits = (this.rehydrateHits.get(principalKey) ?? []).filter(ts => ts > cutoff);
    if (hits.length >= this.rehydrateMaxPerWindow) {
      this.rehydrateHits.set(principalKey, hits); // keep the pruned list
      return false;
    }
    hits.push(now);
    this.rehydrateHits.set(principalKey, hits);
    return true;
  }

  /** Number of live HTTP MCP sessions (for diagnostics/tests). */
  public sessionCount(): number {
    return this.sessions.size;
  }

  /** Mark a session as just-active (touch) so it survives LRU/idle eviction. */
  private touch(sessionId: string): void {
    const entry = this.sessions.get(sessionId);
    if (entry) entry.lastActivity = Date.now();
  }

  /**
   * Evict sessions that have been idle longer than the configured TTL. Closing the
   * SDK transport triggers onclose → cleanupSession, which removes the map entry.
   */
  private evictIdleSessions(now: number): void {
    for (const [sid, entry] of this.sessions) {
      if (now - entry.lastActivity > this.sessionIdleMs) {
        logger.debug(`♻️  Evicting idle MCP HTTP session ${sid.substring(0, 8)}… (idle > ${this.sessionIdleMs}ms)`);
        this.evictSession(sid, entry);
      }
    }
  }

  /**
   * Enforce the max-session cap. If still at/over the cap after idle eviction, evict
   * the least-recently-used session(s) until there is room for one more.
   */
  private enforceSessionCap(): void {
    const now = Date.now();
    this.evictIdleSessions(now);

    while (this.sessions.size >= this.maxSessions) {
      // Find the least-recently-used live session.
      let lruSid: string | undefined;
      let lruEntry: SessionEntry | undefined;
      for (const [sid, entry] of this.sessions) {
        if (!lruEntry || entry.lastActivity < lruEntry.lastActivity) {
          lruSid = sid;
          lruEntry = entry;
        }
      }
      if (!lruSid || !lruEntry) break;
      logger.debug(
        `♻️  Evicting LRU MCP HTTP session ${lruSid.substring(0, 8)}… ` +
        `(cap=${this.maxSessions} reached; live=${this.sessions.size})`
      );
      this.evictSession(lruSid, lruEntry);
    }
  }

  /**
   * Evict a single session: remove it from the map FIRST (so transport.onclose's
   * cleanupSession is a no-op) and close its SDK transport to free resources.
   */
  private evictSession(sessionId: string, entry: SessionEntry): void {
    this.sessions.delete(sessionId);
    // Close asynchronously; we don't await inside the hot path. Errors are swallowed
    // since the entry is already gone from the map.
    void Promise.resolve(entry.transport.close()).catch(() => { /* already evicted */ });
  }

  /**
   * POST /mcp — handles initialize and all subsequent JSON-RPC requests.
   * Creates a new stateful session on `initialize`; otherwise routes to the existing
   * session identified by the `Mcp-Session-Id` header.
   */
  public handlePost = async (req: Request, res: Response): Promise<void> => {
    const sessionId = req.header(MCP_SESSION_HEADER) || undefined;

    try {
      // Existing session → reuse its transport.
      if (sessionId && this.sessions.has(sessionId)) {
        const entry = this.sessions.get(sessionId)!;
        this.touch(sessionId);
        // Refresh the dispatch connection id from THIS request's X-Connection-ID so the
        // isolation key tracks the (stable) connection, not the ephemeral session id.
        entry.dispatchConnId = this.dispatchConnectionId(req, sessionId);
        Object.assign(entry, this.identityFor(req));
        await entry.transport.handleRequest(req, res, req.body);
        return;
      }

      // No session id + initialize request → create a new session.
      if (!sessionId && isInitializeRequest(req.body)) {
        await this.createSession(req, res);
        return;
      }

      // A session id WAS supplied but is not (or no longer) in our map. The common causes
      // are (1) idle eviction, (2) a SERVER RESTART / DEPLOY that wiped the in-RAM map —
      // the worst case, which kicks EVERY connected client — and (3) LRU eviction. All are
      // RECOVERABLE: auth already passed (the bearer/OAuth token is still valid), so the
      // session id is the client's only lost state. Rather than return a 404 that every
      // real MCP client (Amp, Claude Code, Codex, …) IGNORES — silently bricking the
      // connection — we REHYDRATE: transparently re-create a valid session bound to that
      // exact id and handle the request, so the client never sees the drop
      // ("rehydrate-on-miss"). Guarded: id-format validation + per-principal rate limit
      // below; rehydration runs ONLY here, AFTER the auth middleware.
      if (sessionId) {
        await this.rehydrateAndHandle(sessionId, req, res);
        return;
      }

      // No session id and not an initialize request → genuine protocol error.
      logger.warn('MCP POST rejected: no session id on a non-initialize request');
      res.status(400).json({
        jsonrpc: '2.0',
        error: {
          code: JSONRPC_INVALID_REQUEST,
          message:
            'Bad Request: no session ID provided for a non-initialize request. ' +
            'Send an "initialize" request first to establish an MCP session.',
        },
        id: (req.body && typeof req.body === 'object' && 'id' in req.body) ? req.body.id : null,
      });
    } catch (error) {
      logger.error('Error handling MCP POST request', error as Error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error.' },
          id: null,
        });
      }
    }
  };

  /**
   * GET /mcp — server-to-client SSE stream for an established session.
   * DELETE /mcp — explicit session termination.
   * Both require a valid existing session id.
   */
  public handleSessionRequest = async (req: Request, res: Response): Promise<void> => {
    const sessionId = req.header(MCP_SESSION_HEADER) || undefined;
    if (!sessionId || !this.sessions.has(sessionId)) {
      res.status(400).send('Invalid or missing session ID');
      return;
    }

    try {
      const entry = this.sessions.get(sessionId)!;
      this.touch(sessionId);
      await entry.transport.handleRequest(req, res, req.body);
    } catch (error) {
      logger.error('Error handling MCP session request (GET/DELETE)', error as Error);
      if (!res.headersSent) {
        res.status(500).send('Internal server error');
      }
    }
  };

  /**
   * Build a fully-wired per-session SDK Server + Streamable HTTP transport, identical for
   * a fresh `initialize` AND for rehydration (so a rehydrated session is byte-for-byte the
   * same as a normal one — same tool dispatch, same isolation). `autoRegister` controls
   * whether `onsessioninitialized` inserts the SDK-minted id into the map: TRUE for a normal
   * new session, FALSE for rehydration (where WE register under the OLD id, not the throwaway
   * id the synthetic init mints).
   */
  private buildSession(
    autoRegister: boolean,
    instructions?: string
  ): { server: Server; transport: StreamableHTTPServerTransport } {
    // A per-session SDK Server with the SAME capabilities as stdio. PROJECT VISIBILITY
    //: pass connect-time `instructions` (the SDK surfaces them in the
    // initialize result → client.getInstructions()). DYNAMIC per-connection when the
    // caller resolved the active project name; omitted entirely when the feature is off
    // (preserves the prior "no instructions" behavior exactly).
    const server = new Server(
      { name: MANDREL_SERVER_NAME, version: MANDREL_VERSION }, // <semver>+<revision> — CUSTOMER-VISIBLE (remote HTTP transport)
      {
        capabilities: { tools: {}, resources: {} },
        ...(instructions ? { instructions } : {}),
      }
    );

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableDnsRebindingProtection: true,
      allowedHosts: this.allowedHosts,
      // Applies only when the SDK reads the body itself. Every handleRequest call in this file
      // passes the express-parsed body, which healthServer.ts bounds to the same number after
      // auth — see config/mcpRequestLimitsConfig.ts.
      maxRequestBodySize: MCP_MAX_REQUEST_BODY_BYTES,
      onsessioninitialized: (sid: string) => {
        if (!autoRegister) return; // rehydration registers under the OLD id itself
        // Bound the map BEFORE inserting: evict idle/LRU sessions so an authenticated
        // caller spamming `initialize` cannot grow memory without limit.
        this.enforceSessionCap();
        // Store under the SDK-generated id so subsequent requests resolve.
        this.sessions.set(sid, { transport, server, lastActivity: Date.now() });
        logger.info(`🟢 MCP HTTP session initialized: ${sid.substring(0, 8)}… (live=${this.sessions.size})`);
      },
      onsessionclosed: (sid: string) => {
        this.cleanupSession(sid);
      },
    });

    // The connectionId for tool dispatch is resolved at CALL time: prefer the live
    // dispatchConnId stored on the session entry (set per-request from X-Connection-ID),
    // falling back to the transport's session id. transport.sessionId is only assigned
    // during handleRequest(init), so reading it lazily is correct for both paths.
    registerMcpHandlersWithDynamicConnectionId(
      server,
      this.deps,
      () => {
        const sid = transport.sessionId;
        const entry = sid ? this.sessions.get(sid) : undefined;
        return entry?.dispatchConnId ?? sid;
      },
      // THE LIVE IDENTITY GETTER — one call reading one entry, returning the whole
      // RequestIdentity (declared actor / project binding / loop id). It replaced three
      // separate positional getters that each re-read the same entry: the loop id was
      // never added as a fourth, which is exactly how the streamable surface came to drop
      // a declared identity that the flat surface honoured.
      () => {
        const sid = transport.sessionId;
        const entry = sid ? this.sessions.get(sid) : undefined;
        return {
          actor: entry?.actor,
          projectBinding: entry?.projectBinding,
          loopId: entry?.loopId,
        };
      },
    );

    // Clean up map entry when transport closes for any reason.
    transport.onclose = () => {
      const sid = transport.sessionId;
      if (sid) this.cleanupSession(sid);
    };

    return { server, transport };
  }

  /**
   * Create a new stateful session: build a per-session transport + SDK Server,
   * register the shared handlers (keyed by session id for isolation), connect, and
   * let the transport handle the initialize request.
   */
  private async createSession(req: Request, res: Response): Promise<void> {
    // PROJECT VISIBILITY: resolve the connect-time instructions BEFORE
    // building the Server (they are baked into the initialize result at construction).
    // DYNAMIC per-connection — keyed by the SAME dispatch id tool calls use (X-Connection-ID
    // when present) so the named project matches where the first write will land. Best-effort:
    // resolveInstructions never throws (falls back to the STATIC reminder).
    const instructions = await this.resolveSessionInstructions(req);
    const { server, transport } = this.buildSession(/* autoRegister */ true, instructions);
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
    // Stamp the dispatch connection id on the freshly-created entry so the FIRST
    // post-initialize tool call already routes by X-Connection-ID (the entry is inserted
    // synchronously during the init handleRequest above, via onsessioninitialized).
    const sid = transport.sessionId;
    const entry = sid ? this.sessions.get(sid) : undefined;
    if (entry) {
      entry.dispatchConnId = this.dispatchConnectionId(req, sid);
      Object.assign(entry, this.identityFor(req));
    }
  }

  /**
   * REHYDRATE-ON-MISS. An authenticated request arrived carrying a
   * Mcp-Session-Id we no longer hold (idle-evicted, LRU-evicted, or — the big one —
   * wiped by a server restart/deploy). Transparently re-create a valid session bound to
   * that EXACT id and handle the request, so the client never sees a 404 it would ignore.
   *
   * Mechanism (verified against @modelcontextprotocol/sdk 1.32.1 internals — see the
   * sdkCoupling guard test): the SDK exposes no public "mark initialized" API. So we:
   *   1. Build a fresh server+transport with the SAME wiring a normal session uses
   *      (buildSession, autoRegister=false so the synthetic init's throwaway id is NOT
   *      registered).
   *   2. Drive ONE synthetic `initialize` through the transport's underlying web-standard
   *      transport (the same inner surface the Express wrapper delegates to), passing the
   *      init body as parsedBody. This flips the private `_initialized` flag to true and
   *      mints a throwaway session id; we capture + discard the Response.
   *   3. Overwrite the inner transport's `sessionId` with the incoming OLD id and register
   *      the entry in the Map under that OLD id, so validateSession (sessionId === old) now
   *      passes for the original request.
   *   4. Hand the ORIGINAL request to transport.handleRequest(req, res, req.body) — the
   *      exact Express 3-arg shape this file already uses everywhere.
   *
   * GUARDS (all BEFORE re-creating anything): runs only post-auth (the auth middleware
   * already ran); the old id must match OUR uuid format (else normal 404 — no forging);
   * and a per-principal sliding-window rate limit (else 429). Project isolation is restored
   * because tools dispatch under the stable X-Connection-ID (dispatchConnId), so SR-1's DB
   * re-attach recovers the prior session row + project.
   */
  private async rehydrateAndHandle(oldSessionId: string, req: Request, res: Response): Promise<void> {
    // GUARD 1 — id format. A garbage / forged id is NOT rehydrated: fall back to the
    // original self-healing 404 so an attacker can't spawn arbitrary sessions by id.
    if (!UUID_V4_RE.test(oldSessionId)) {
      this.respondSessionExpired(oldSessionId, req, res);
      return;
    }

    // GUARD 2 — rate limit per (principal+connection). A legit client rehydrates once per
    // restart then reuses the revived session, so this only bites abusive spam.
    const principalKey = this.rehydratePrincipalKey(req, oldSessionId);
    if (!this.allowRehydration(principalKey)) {
      logger.warn(`MCP rehydrate rate-limited for ${principalKey.substring(0, 24)}…`);
      res.status(429).json({
        jsonrpc: '2.0',
        error: {
          code: JSONRPC_SESSION_EXPIRED,
          message:
            'Too many session rehydrations in a short window. Wait a moment and retry, ' +
            'or re-initialize the connection. Your credentials are still valid.',
          data: { reason: 'rehydrate_rate_limited', action: 'retry', retryable: true },
        },
        id: (req.body && typeof req.body === 'object' && 'id' in req.body) ? req.body.id : null,
      });
      return;
    }

    logger.info(
      `♻️  Rehydrating MCP session ${oldSessionId.substring(0, 8)}… ` +
      `(unknown id post-auth → transparent revive instead of 404)`
    );

    const { server, transport } = this.buildSession(/* autoRegister */ false);
    await server.connect(transport);

    // Drive ONE synthetic initialize through the inner web-standard transport so the SDK
    // flips `_initialized` true. We pass the init JSON-RPC body as parsedBody (no stream),
    // and supply a minimal Web Request with an allowed Host so DNS-rebinding validation
    // passes. The Response is captured + DISCARDED.
    await this.driveSyntheticInitialize(transport);

    // Stamp the OLD id onto the inner transport so validateSession accepts the original
    // request (sessionId === transport.sessionId). The public wrapper's sessionId is a
    // read-only getter delegating to the inner transport, so we set it on the inner one.
    const inner = (transport as unknown as { _webStandardTransport: { sessionId?: string } })._webStandardTransport;
    inner.sessionId = oldSessionId;

    // Register under the OLD id (autoRegister was false, so nothing is in the map yet).
    this.enforceSessionCap();
    this.sessions.set(oldSessionId, {
      transport,
      server,
      lastActivity: Date.now(),
      dispatchConnId: this.dispatchConnectionId(req, oldSessionId),
      ...this.identityFor(req),
    });
    logger.info(
      `✅ Rehydrated session ${oldSessionId.substring(0, 8)}… ` +
      `(connId=${(this.dispatchConnectionId(req, oldSessionId) ?? '∅').substring(0, 16)}; live=${this.sessions.size})`
    );

    // Now handle the ORIGINAL request on the revived session — the exact Express 3-arg
    // shape used everywhere else in this file.
    await transport.handleRequest(req, res, req.body);
  }

  /**
   * Drive a single synthetic `initialize` through the transport's inner web-standard
   * transport to flip its private `_initialized` flag. Returns nothing — the synthetic
   * Response (and the throwaway session id it mints) is discarded; the caller then
   * overwrites the session id with the real OLD one.
   *
   * This is the SDK-coupling point: it reaches the inner `_webStandardTransport` (the same
   * surface the public wrapper delegates to internally) and passes the init body as
   * `parsedBody`. The sdkCoupling guard test exercises THIS method end-to-end so any future
   * SDK change to these internals fails loudly.
   */
  private async driveSyntheticInitialize(transport: StreamableHTTPServerTransport): Promise<void> {
    const initBody = {
      jsonrpc: '2.0',
      id: 'rehydrate-synthetic-init',
      method: 'initialize',
      params: {
        protocolVersion: SYNTHETIC_INIT_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'mandrel-rehydrate', version: MANDREL_VERSION },
      },
    };
    // A minimal Web-standard POST Request whose Host is in allowedHosts so the SDK's
    // DNS-rebinding validation passes for the synthetic init.
    const syntheticHost = this.allowedHosts[0] ?? 'localhost';
    // Use the global (Web-standard) Request/Response, NOT the Express Request type imported
    // at the top of this file — the SDK's inner transport speaks the Fetch API surface.
    const WebRequest = globalThis.Request;
    const webReq = new WebRequest(`http://${syntheticHost}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        host: syntheticHost,
      },
      body: JSON.stringify(initBody),
    });
    const inner = (transport as unknown as {
      _webStandardTransport: {
        handleRequest: (
          req: globalThis.Request,
          opts: { parsedBody?: unknown }
        ) => Promise<globalThis.Response>;
      };
    })._webStandardTransport;
    // Capture + discard the synthetic Response (and consume its body so no stream leaks).
    const resp = await inner.handleRequest(webReq, { parsedBody: initBody });
    try { await resp?.text?.(); } catch { /* nothing to drain */ }
  }

  /**
   * The original self-healing 404 (kept for the BAD-id path: an unknown id that is NOT in
   * our uuid format is not rehydrated, it gets this actionable re-initialize error).
   */
  private respondSessionExpired(sessionId: string, req: Request, res: Response): void {
    logger.info(
      `MCP POST: unknown session ${sessionId.substring(0, 8)}… with non-conforming id → asking client to re-initialize`
    );
    res.status(404).json({
      jsonrpc: '2.0',
      error: {
        code: JSONRPC_SESSION_EXPIRED,
        message:
          'MCP session not found and could not be restored. Re-initialize the connection ' +
          '(reconnect / restart your MCP client) to start a new session, then retry. ' +
          'Your credentials are still valid — this is not an auth failure.',
        data: {
          reason: 'session_expired',
          action: 'reinitialize',
          retryable: true,
        },
      },
      id: (req.body && typeof req.body === 'object' && 'id' in req.body) ? req.body.id : null,
    });
  }

  private cleanupSession(sessionId: string): void {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;
    this.sessions.delete(sessionId);
    logger.info(`🔴 MCP HTTP session closed: ${sessionId.substring(0, 8)}… (live=${this.sessions.size})`);
  }

  /** Close all sessions on shutdown. */
  public async closeAll(): Promise<void> {
    const entries = Array.from(this.sessions.values());
    this.sessions.clear();
    await Promise.allSettled(entries.map(e => e.transport.close()));
  }
}

/**
 * Register MCP handlers where the connectionId is resolved dynamically at call time
 * (the HTTP session id is only known after the transport processes `initialize`).
 *
 * This wraps `registerMcpHandlers` semantics but supplies a live connectionId getter.
 */
function registerMcpHandlersWithDynamicConnectionId(
  server: Server,
  deps: McpHandlerDeps,
  getConnectionId: () => string | undefined,
  getIdentity?: () => RequestIdentity
): void {
  // We reuse the shared registration but wrap executeMcpTool so the connectionId and the
  // declared per-request identity are injected per-call from the live session entry. Tool
  // logic stays in ONE place.
  //
  // THE IDENTITY ARRIVES AS ONE OBJECT, not as N getters. Three positional
  // getters were three chances to forget the fourth field, and the fourth field — the loop
  // id — was in fact forgotten here, so every position on this surface was keyed as though
  // no client had ever declared a loop.
  const wrappedDeps: McpHandlerDeps = {
    ...deps,
    executeMcpTool: (toolName, args, context) => {
      const connectionId = context?.connectionId ?? getConnectionId();
      const identity = getIdentity?.();
      const actor = context?.actor ?? identity?.actor;
      const projectBinding = context?.projectBinding ?? identity?.projectBinding;
      const loopId = context?.loopId ?? identity?.loopId;
      // TRANSPORT IDENTITY MARKER. On this surface `connectionId` is
      // dispatchConnectionId()'s output: the client's X-Connection-ID header if it sent one,
      // else the per-session Mcp-Session-Id. BOTH are presented identities — the SDK session
      // id is minted per client connection, so two clients never share it (measured §4.4 of
      // the investigation: two streamable sessions held two different projects while the
      // shared flat slot moved under neither). It is undefined only when the client has
      // neither, and that caller IS the unidentified population.
      const identified = connectionId !== undefined && connectionId !== '';
      const ctx =
        connectionId || actor || projectBinding || loopId
          ? { connectionId, identified, actor, projectBinding, loopId }
          : { identified };
      return deps.executeMcpTool(toolName, args, ctx);
    },
  };
  registerMcpHandlers(server, wrappedDeps);
}
