/**
 * Central Route Registry for All MCP Tools
 * Dispatches tool calls to appropriate domain route handlers
 */

import { formatMcpError, isErrorResult } from '../utils/mcpFormatter.js';
import { db } from '../config/database.js';
import { attachArchiveDisclosure, ALL_PROJECTS } from '../services/archiveDisclosure.js';
import { ARCHIVE_DISCLOSURE_OPS } from '../config/archiveDisclosureConfig.js';
import type { McpResponse } from '../utils/mcpFormatter.js';
import { logger } from '../utils/logger.js';
import { ensureActiveSession } from '../services/session/SessionTracker.js';
import { shadowCompareResolution, SessionLifecycleService } from '../services/session/domain/lifecycle/index.js';
import { SESSION_CONFIG } from '../config/sessionConfig.js';
import { normalizeActor } from '../config/actorRegistry.js';
import { recordEnsureFailure } from '../utils/sessionObservability.js';
import { projectHandler } from '../handlers/project.js';
import {
  resolveProjectBinding,
  auditProjectResolution,
  explicitProjectTargetParams,
  scopeNarrowingNotice,
  PROJECT_SCOPE_NARROWED_KEY,
  PROJECT_SCOPE_NARROWED_LOG_PREFIX,
  type ProjectBindingResolution,
} from '../services/projectBinding.js';
import { runWithProjectScope } from '../services/effectiveProjectScope.js';
import { enforceCallerIdentity } from '../services/callerIdentityGuard.js';
import { opEffect } from '../config/opRegistry.js';
import {
  attributionNoticeKey,
  markNoticed,
  renderConfiguredAttributionNotice,
  shouldNotice,
  ATTRIBUTION_NOTICE_KEY,
} from '../services/attributionNotice.js';
import { MandrelClassifiedError } from '../utils/mcpErrorStatus.js';

// Import all route modules
import { systemRoutes } from './system.routes.js';
import { contextRoutes } from './context.routes.js';
import { projectRoutes } from './project.routes.js';
import { decisionsRoutes } from './decisions.routes.js';
import { tasksRoutes } from './tasks.routes.js';
import { searchRoutes } from './search.routes.js';
import { linksRoutes } from './links.routes.js';
import { recallRoutes } from './recall.routes.js';
import { threadRoutes } from './thread.routes.js';
import { branchRoutes } from './branch.routes.js';
import { sessionRoutes } from './session.routes.js';
import { artifactRoutes } from './artifact.routes.js';

/**
 * Execution context passed through route handlers
 */
export interface RouteContext {
  connectionId?: string;
  /**
   * TRANSPORT IDENTITY MARKER. Did the caller PRESENT a connection
   * identity, or did the transport substitute a shared literal for it?
   *
   * `false` is the whole point: `server/healthServer.ts` collapses an ABSENT
   * `X-Connection-ID` into the literal `'http-default'` BEFORE dispatch, so by the time a
   * call reaches here "absent" and "explicitly named http-default" are the same string and
   * nothing downstream can tell them apart. Passing `undefined` instead does not recover it
   * — 16 downstream sites substitute a SECOND shared literal, `'default-session'`. The only
   * way the information survives to a guard is to carry it explicitly, which is this field.
   *
   * `undefined` means "not a transport that reads request identity" — an in-process caller,
   * a test, a background job. Those never shared a slot with a customer. A TRANSPORT does
   * not get to leave it undefined: see TransportRouteContext below, where it is REQUIRED.
   *
   * Consumed by services/callerIdentityGuard.ts. Nothing else branches on it — in
   * particular `connectionId` is NOT rewritten, so the resolution of every call is
   * byte-for-byte what it was (legacy == today for everything not rejected).
   */
  identified?: boolean;
  /**
   * Sessions Foundation Phase 1: the principal that owns this call, derived at the edge
   * (HTTP bridge X-Actor-ID header / stdio MANDREL_ACTOR env / remote declared header /
   * REST auth `sub`). Threaded ONLY into lazy session creation for attribution — never
   * into resolution in Phase 1.
   */
  actor?: string;
  /**
   * PROJECT BINDING: the raw `X-Mandrel-Project` header this connection
   * declared — an autonomous client stating, as configuration, which project it is scoped
   * to. Undefined for every client that does not configure one (the default, and every
   * human), in which case the process-wide `MANDREL_PROJECT_ID` env is consulted and, if
   * that is unset too, there is NO binding and resolution is untouched.
   * See services/projectBinding.ts for the precedence ladder.
   */
  projectBinding?: string;
  /**
   * THE AGENT LOOP THIS CALL BELONGS TO — the identity a branch POSITION is
   * keyed on, when the caller declares one (`X-Loop-ID`).
   *
   * WHY IT IS NOT `connectionId`: measured 2026-08-27, one `claude` process hosts a
   * coordinator and eight subagents and multiplexes all nine over THREE shared stdio bridge
   * processes, every one of which declares the SAME `X-Connection-ID`. A connection is a
   * TRANSPORT; a loop is an AGENT. Keying position on the transport made one
   * `branch_positions` row the position of nine agents at once.
   *
   * Undefined for every caller that declares none — and then position keying falls back to
   * the connection identity SCOPED BY ACTOR, exactly as `resolvePositionKeys` documents.
   */
  loopId?: string;
}

/**
 * THE CONTEXT A **TRANSPORT** CONSTRUCTS — identical to RouteContext except
 * that `identified` is REQUIRED.
 *
 * This is the compiler doing the work a convention would otherwise have to do. Every surface
 * that turns an inbound request into a tool call — the flat HTTP bridge
 * (server/healthServer.ts), the streamable `/mcp` transport (server/remoteMcpTransport.ts),
 * the stdio server (server/MandrelMcpServer.ts) — types its executor context as this, so a
 * FOURTH transport added tomorrow does not compile until it has decided whether its callers
 * present an identity (TS2741, "Property 'identified' is missing"). A guard that depends on
 * a marker every transport must remember to set is a guard with a countdown on it; making
 * the omission a build error is the only version of that promise that cannot rot
 * (prefer the compiler so a second, weaker copy of the rule cannot exist).
 *
 * RouteContext itself keeps the field optional because its other callers — in-process code,
 * the tick, ~100 test call sites — are not transports and have no request identity to read.
 */
export interface TransportRouteContext extends RouteContext {
  identified: boolean;
}

/**
 * CONTENT-PRODUCING ("ACTION") TOOLS — the single source of truth for lazy
 * session creation.
 *
 * Lazy-session model (P-B): a DB session row is created ONLY when one of these
 * tools runs on a connection. Every other tool is PASSIVE and never creates a
 * session — so passive connects, dashboard polls, searches, stats, help, and
 * `project_*` navigation leave zero empty session rows behind.
 *
 * Keep this set TIGHT and in ONE place: adding a tool here is the only way to
 * make a tool create sessions, so noise can't creep back in silently. A tool is
 * an ACTION only if it persists user-authored content that should be attributed
 * to a session (creates), NOT if it merely reads or mutates existing rows.
 *
 * NOTE on project_switch: intentionally PASSIVE. Switching project must NOT
 * spawn a session (one-session-per-connection); if a session already exists it
 * is re-pinned to the new project by projectHandler.syncSessionProject, and if
 * none exists yet the NEXT real action creates one already pinned to the
 * switched-to project.
 */
export const ACTION_TOOLS: ReadonlySet<string> = new Set<string>([
  'context_store',
  'task_create',
  'decision_record',
]);

/**
 * Lazily ensure a DB session exists for this connection BEFORE a content-
 * producing tool writes, so the write attaches to the correct per-connection
 * session. Inherits the connection's CURRENT project; a later project_switch
 * re-pins that same session (never spawns a new one).
 *
 * Connection-scoped and idempotent: if the connection already has an active
 * session, ensureActiveSession returns it unchanged (no duplicate rows). Failure
 * here must not block the tool — the write path degrades to "no session" exactly
 * as before, so a session-tracking hiccup never breaks the user's action.
 */
/**
 * Phase 4 header-less tightening (dark, config-gated): the pure guard deciding whether an
 * action must be REJECTED for lacking a derivable actor. Returns an Error to throw when
 * SESSION_CONFIG.requireActor is ON and no actor is derivable (would otherwise fall to the
 * flagged `anonymous`), else null. Kept pure + exported so it is unit-testable with no DB.
 *
 * The message names the missing `X-Actor-ID` header explicitly (fail loud) so
 * the caller knows exactly how to comply. DARK by default: with requireActor=false this is
 * ALWAYS null and the anonymous path is byte-identical to before Phase 4.
 */
export class ActorRequirementError extends MandrelClassifiedError {
  /**
   * WAS a bare `new Error(...)`. A bare Error carries no code at all, so the
   * transport had nothing to classify it by: it fell to the unclassified default, and — since
   * routeExecutorInner returns it IN BAND rather than throwing it to the express catch — the
   * caller was told **200 OK** for a write that was refused. Measured at the real HTTP
   * surface before this change.
   *
   * 403, matching CallerIdentityError, and for the same reason: the caller is authenticated
   * and is being refused on policy, not asked to authenticate. Read `MANDREL_SESSION_REQUIRE_ACTOR`
   * as the deployment saying "anonymous principals may not write here" — a permission
   * statement about a caller that got in the door. See that class for why 401 is wrong.
   */
  constructor(readonly toolName: string) {
    super(
      `Action '${toolName}' rejected: no actor could be derived and MANDREL_SESSION_REQUIRE_ACTOR ` +
        `is enabled. Declare a principal via the 'X-Actor-ID' request header (or authenticate) — ` +
        `anonymous writes are disabled in this environment.`,
      403
    );
    this.name = 'ActorRequirementError';
  }
}

export function actorRequirementError(toolName: string, actor?: string): Error | null {
  if (!SESSION_CONFIG.requireActor) return null;
  if (normalizeActor(actor) !== null) return null;
  return new ActorRequirementError(toolName);
}

export async function ensureSessionForAction(toolName: string, connectionId?: string, actor?: string): Promise<void> {
  // Phase 4 header-less tightening — evaluated BEFORE the swallow-try below so a rejection
  // PROPAGATES out of the gate (to routeExecutorInner's catch → formatMcpError → a clear
  // error response), rather than being swallowed like a best-effort tracking hiccup. Dark by
  // default (requireActor=false → this is a no-op and the anonymous path is unchanged).
  const rejection = actorRequirementError(toolName, actor);
  if (rejection) {
    logger.warn(
      `🚫 Action '${toolName}' rejected — requireActor is ON and no X-Actor-ID/auth actor was present ` +
        `(connection: ${connectionId ?? 'stdio'})`
    );
    throw rejection;
  }

  try {
    const connId = connectionId ?? 'stdio';

    // SHADOW WIRING (Phase 2a, INERT at the default). Only when resolverMode === 'shadow':
    // compute the legacy resolution AND the new resolveSession() READ-ONLY, log agree/disagree,
    // and bump the shadow counters — BEFORE the (unchanged) legacy ensure below runs, so both
    // observe the same pre-action state. In 'legacy' mode this block is skipped entirely and the
    // code path from here down is byte-identical to before Phase 2a. resolverMode never reaches
    // 'actor' in 2a (that's the 2b cutover), but if it did we still fall through to legacy here —
    // acting on the new resolver is deliberately NOT wired in this phase.
    if (SESSION_CONFIG.resolverMode === 'shadow') {
      await shadowCompareResolution({ connectionId: connId, actor });
    }

    // Resolve the connection's current project (same key the route layer uses).
    let projectId: string | undefined;
    try {
      await projectHandler.initializeSession(connId);
      // PROJECT-SCOPE: effective — the session row this gate creates must be pinned to the
      // project the call's writes will actually land in; for a bound client that is the binding.
      projectId = (await projectHandler.getCurrentProjectId(connId)) ?? undefined;
    } catch {
      projectId = undefined;
    }

    // ACTOR MODE (Phase 2b cutover, INERT unless resolverMode === 'actor'): the action gate
    // resolves/creates the session by ACTOR (explicit → pin → newest-open → advisory-locked
    // create with connection_id NULL), reactivating a resumed session and caching it per
    // connection. legacy/shadow fall through to the byte-identical connection-keyed path below.
    if (SESSION_CONFIG.resolverMode === 'actor') {
      const sessionId = await SessionLifecycleService.ensureSessionForActor({
        actor,
        connectionId: connId,
        projectId,
        // W3: a session minted HERE exists because a content-producing tool
        // needed one. Declared explicitly at the call site (not inherited from a default) so
        // the recorded reason is the one THIS path actually knows.
        creationReason: 'automatic-write',
      });
      logger.info(
        `📋 Lazy session ready for action '${toolName}' (actor mode): ${sessionId.substring(0, 8)}... (connection: ${connId})`
      );
      return;
    }

    const sessionId = await ensureActiveSession(
      projectId,
      undefined, // title
      undefined, // description
      undefined, // sessionGoal
      undefined, // tags
      undefined, // aiModel
      connId,    // connectionId — isolates this session to this connection
      actor,     // Phase 1: stamp the derived actor on a newly-created session (attribution)
      // W3: the legacy-mode twin of the actor-mode branch above — a session
      // minted here exists because a content-producing tool needed one. Declared explicitly.
      'automatic-write'
    );
    logger.info(
      `📋 Lazy session ready for action '${toolName}': ${sessionId.substring(0, 8)}... (connection: ${connId})`
    );
  } catch (error) {
    // Never block the user action on a session-tracking failure. Emit a VISIBLE counter so this
    // fail-open path (attribution silently lost — F3) is observable, not just logged.
    recordEnsureFailure(toolName);
    logger.warn(`⚠️  Lazy session ensure failed for '${toolName}'; proceeding without`, {
      metadata: { error: (error as Error)?.message }
    });
  }
}

/**
 * DUAL-CHANNEL OUTPUT SEAM.
 *
 * THE ONE mechanism — not 29 copy-pastes. Every tool result flows back through
 * `routeExecutor`, so this is the single place that guarantees the spec's
 * `structuredContent` is present on EVERY response:
 *
 *   1. If a handler set `structuredContent` directly (the rich tools that build a
 *      clean record/array), keep it.
 *   2. Else if it set the legacy `data` sibling, PROMOTE that to `structuredContent`
 *      (back-compat — generalizes the existing decisions-route `data` pattern to all).
 *   3. Else synthesize a minimal `{ ok }` object so a tool that only returns prose
 *      (system/status/ping) STILL carries a machine-readable success flag. No tool
 *      is ever left without structuredContent — the operator's "all tools" bar.
 *
 * `ok` is always (re)stamped from the response's error flag so a consumer never has
 * to infer success from text. The legacy `data` sibling is PRESERVED (back-compat
 * for the Command UI + task-1 tests that read `.data`); structuredContent is the new
 * canonical machine channel mirroring it.
 */
function ensureStructuredContent(resp: McpResponse): McpResponse {
  const ok = !isErrorResult(resp);
  let structured: Record<string, any>;

  if (resp.structuredContent && typeof resp.structuredContent === 'object') {
    structured = resp.structuredContent;
  } else if (resp.data && typeof resp.data === 'object' && !Array.isArray(resp.data)) {
    structured = resp.data;
  } else if (resp.data !== undefined) {
    // A primitive/array data payload — wrap it so structuredContent is always an object.
    structured = { value: resp.data };
  } else {
    structured = {};
  }

  // Always stamp the machine-readable success flag (handlers may omit it).
  if (structured.ok === undefined) structured.ok = ok;

  return { ...resp, structuredContent: structured };
}

/**
 * SCOPE-NARROWING NOTICE — the caller's half of "a read that returns less
 * than asked must SAY SO", and the operator's half, emitted from the one object that knows.
 *
 * Sibling of `ensureStructuredContent` above and placed here for the same reason: every tool
 * result on BOTH surfaces flows back through `routeExecutor`, so the rule has exactly one
 * home and covers the whole population — every call the binding narrowed — rather than the
 * one handler whose author remembered. `session_list.allProjects` is the only member today;
 * the override classifier derives membership from each tool's own schema, so the next one
 * is covered on the day it is declared, with nothing to add here.
 *
 * BOTH CHANNELS, ONE SENTENCE. The prose is PREPENDED to the first text block rather than
 * appended as a new one: a warning belongs before the results it qualifies, and a client
 * that reads only `content[0].text` — which is the client most likely to draw the wrong
 * conclusion from a short list — still sees it. The block COUNT is unchanged, so nothing
 * that counts blocks is disturbed. The machine channel carries the same string plus the raw
 * facts under a stable key, so a consumer branches on presence instead of parsing prose.
 *
 * UNCONDITIONAL on success/failure. "Your widening flag was ignored" is true either way, and
 * a classifier deciding when a true statement is worth making is exactly the kind of verdict
 * logic that goes wrong quietly (C3). A call REFUSED by the ladder never reaches here at all
 * (resolveProjectBinding throws before dispatch), so an error response carrying this notice
 * always means the narrowing really did happen.
 *
 * The WARN is not folded into `auditProjectResolution`: that prefix is the WRITE audit, an
 * operator greps it to answer "where did this write land", and pushing narrowed READS into
 * it would silently change that population. Best-effort — a log failure must never break a
 * caller's read.
 */
function annotateScopeNarrowing(
  resp: McpResponse,
  binding?: ProjectBindingResolution,
  toolName?: string,
  context?: RouteContext
): McpResponse {
  const notice = scopeNarrowingNotice(binding);
  if (!notice) return resp;

  try {
    logger.warn(
      `${PROJECT_SCOPE_NARROWED_LOG_PREFIX} tool=${toolName ?? 'unknown'} ` +
        `narrowed=${notice.params.join(',')} projectId=${notice.projectId} ` +
        `project=${notice.projectName ?? 'unknown'} binding=${notice.bindingOrigin ?? 'unknown'}`,
      {
        metadata: {
          audit: PROJECT_SCOPE_NARROWED_LOG_PREFIX,
          tool: toolName ?? null,
          narrowedScopeOverrides: notice.params,
          projectId: notice.projectId,
          projectName: notice.projectName ?? null,
          bindingOrigin: notice.bindingOrigin ?? null,
          connectionId: context?.connectionId ?? null,
          actor: context?.actor ?? null,
        },
      }
    );
  } catch {
    /* observability must never break a read */
  }

  const content = [...(resp.content ?? [])];
  const firstText = content.findIndex((c) => c?.type === 'text');
  if (firstText === -1) {
    content.unshift({ type: 'text', text: notice.message });
  } else {
    content[firstText] = {
      ...content[firstText],
      text: `${notice.message}\n\n${content[firstText].text ?? ''}`,
    };
  }

  return {
    ...resp,
    content,
    structuredContent: {
      ...(resp.structuredContent ?? {}),
      [PROJECT_SCOPE_NARROWED_KEY]: notice,
    },
  };
}

/**
 * Execute MCP Tool via Route Dispatcher
 * Central entry point for all active MCP tools (context_update added in T1)
 */
/**
 * WRITE AUDIT for the project a content-producing call is scoped to ( * report acceptance line 520). Records the project ID plus the RUNG of the precedence
 * ladder that produced it — the id alone says WHERE the write went; the rung says WHY,
 * which is what makes a wrong-project write diagnosable instead of merely visible.
 *
 * For a BOUND client the resolution is already known (the gate above computed it). For an
 * UNBOUND client the project comes from rung 3, so we read it exactly the way the route
 * about to run will — `projectHandler.getCurrentProjectId(connectionId)` — and this is a
 * pure READ: `ensureSessionForAction` has just run `initializeSession` for the same
 * connection in the same tick, so no state is created or mutated here.
 *
 * Never throws: a failure to read the current project degrades to an audit line with
 * `projectId=none`, which is itself the visible signal (a past incident — no silent degrade).
 */
async function auditWrite(
  toolName: string,
  binding: ProjectBindingResolution,
  context?: RouteContext
): Promise<void> {
  let projectId = binding.projectId;
  let projectName = binding.projectName;
  if (!projectId) {
    try {
      const connId = context?.connectionId ?? 'default-session';
      // PROJECT-SCOPE: effective — the audit line records WHERE the write landed, so it must
      // read the same effective scope the route about to run reads. (Reached only when the
      // binding produced no id, i.e. the unbound path, where effective == rung 3.)
      projectId = (await projectHandler.getCurrentProjectId(connId)) ?? undefined;
      if (projectId) {
        projectName = (await projectHandler.getProject(projectId))?.name;
      }
    } catch {
      projectId = undefined;
    }
  }
  auditProjectResolution({
    tool: toolName,
    projectId,
    projectName,
    source: binding.source,
    bound: binding.bound,
    bindingOrigin: binding.bindingOrigin,
    connectionId: context?.connectionId,
    actor: context?.actor,
    overriddenScopeParams: binding.overriddenScopeParams,
  });
}

/**
 * THE public tool seam — every tool call on BOTH surfaces (flat `/mcp/tools/*` and the
 * gateway dispatcher) arrives here.
 *
 * EFFECTIVE-SCOPE WRAP. Establishing the ambient project
 * scope is the FIRST thing that happens, before any resolution or dispatch, so that
 * `projectHandler.getCurrentProjectId/getCurrentProject` return the BOUND project for
 * everything this call does — including the six tools that resolve a project while declaring
 * no project parameter, which the argument-materialisation below structurally cannot reach
 * (see services/effectiveProjectScope.ts for the full mechanism). One wrap, one place; the
 * accessors are the choke point, not the schema.
 */

/**
 * Stamp the archive disclosure onto an op that declares `includeArchived`.
 *
 * Resolves the project the same way the routes do — the arg if given, else the connection's
 * current project — and hands both to the disclosure service, which measures the archived
 * population and renders the one line that reports it.
 */
async function applyArchiveDisclosure(
  resp: McpResponse,
  toolName: string,
  args: any,
  context?: RouteContext
): Promise<McpResponse> {
  const decl = ARCHIVE_DISCLOSURE_OPS[toolName];
  if (!decl) return resp;
  // A call that emitted no count has nothing to disclose (project_list without includeStats).
  if (decl.appliesWhen && !decl.appliesWhen(args)) return resp;
  const entities = decl.entities;

  // an op whose counts span every project measures fleet-wide; the scopeNote
  // on the block says so. Never the caller's current project standing in for "all".
  if (decl.scope === 'all-projects') {
    return attachArchiveDisclosure(
      resp,
      (sql, params) => db.query(sql, params),
      entities.length === 1 ? entities[0] : entities,
      ALL_PROJECTS,
      args?.includeArchived === true
    );
  }

  // The project the op READ: `projectId`, or `project` (project_info names its subject that
  // way, by id OR name — measureArchiveDisclosure resolves either), else the current one.
  let projectId: string | undefined =
    args?.projectId ?? (typeof args?.project === 'string' ? args.project : undefined);
  if (!projectId) {
    try {
      const sessionId = context?.connectionId || 'default-session';
      await projectHandler.initializeSession(sessionId);
      // PROJECT-SCOPE: effective — the same resolution the routes themselves perform (arg
      // first, else the connection's current project). Under a binding this is the bound
      // project; unbound it is rung 3. The disclosure must describe the SAME population the
      // op just read, so it must resolve the project the same way the op did.
      projectId = (await projectHandler.getCurrentProjectId(sessionId)) || undefined;
    } catch {
      // No project in scope is not an error here — it means there is no population to
      // describe, so the block is omitted rather than fabricated.
      return resp;
    }
  }

  return attachArchiveDisclosure(
    resp,
    (sql, params) => db.query(sql, params),
    entities.length === 1 ? entities[0] : entities,
    projectId,
    args?.includeArchived === true
  );
}

/**
 * WHAT `routeExecutorInner` HANDS BACK OUT OF BAND (see THE RESOLUTION SINK below).
 * Both members exist for the same structural reason: the decision is made deep inside the
 * inner executor, and the response it shaped only exists outside it.
 */
interface RouteResolution {
  /** The project-binding ladder's answer for this call. */
  binding?: ProjectBindingResolution;
  /**
   * A PENDING unattributed-write notice: decided by the action gate, attached (or dropped)
   * by the sink once the response's success is known. Absent means "do not notice".
   */
  attribution?: { message: string; key: string };
}

/**
 * ATTACH THE UNATTRIBUTED-WRITE NOTICE (customer contoso, 2026-09-09).
 *
 * WHY THE DECISION AND THE ATTACHMENT LIVE IN DIFFERENT PLACES, and why that is not a
 * second copy of the rule: the ELIGIBILITY question ("is this call content-producing and
 * unattributed?") is answered exactly once, at the ACTION_TOOLS gate, from the same
 * `ACTION_TOOLS` set that decides session creation — there is no second list. But a notice
 * must only ride a SUCCESSFUL response, and success is not known until the response exists,
 * which is here. So the gate parks the rendered string on the resolution seam and this
 * function decides its fate.
 *
 * ONLY ON SUCCESS, and `markNoticed` fires ONLY here. If the write ERRORED, the user gets
 * neither the record nor the warning — burning their one notice on a failed call would
 * leave them worse off than if the feature did not exist.
 *
 * BOTH CHANNELS, and the notice LEADS. It is PREPENDED to the first text block (not
 * appended, not a new block) because the client this exists for SUMMARISES tool results and
 * keeps the head — that is the measured reason the ping echo failed to reach him. It is
 * ALSO set at the TOP LEVEL of structuredContent, because some clients render only the
 * machine channel.
 *
 * NEVER BREAKS A WRITE. Everything is wrapped: a notice is a courtesy, and a courtesy that
 * can fail a customer's write is a defect worse than the one it reports.
 */
function attachAttributionNotice(resp: McpResponse, resolved: RouteResolution): McpResponse {
  const pending = resolved.attribution;
  if (!pending) return resp;
  try {
    if (isErrorResult(resp)) return resp;

    const content = [...(resp.content ?? [])];
    const firstText = content.findIndex((c) => c?.type === 'text');
    if (firstText === -1) {
      content.unshift({ type: 'text', text: pending.message });
    } else {
      content[firstText] = {
        ...content[firstText],
        text: `${pending.message}\n\n${content[firstText].text ?? ''}`,
      };
    }

    const annotated = {
      ...resp,
      content,
      structuredContent: {
        ...(resp.structuredContent ?? {}),
        [ATTRIBUTION_NOTICE_KEY]: pending.message,
      },
    };

    // MARK LAST, AFTER THE ATTACHMENT SUCCEEDED — never before it (the reviewer probe A).
    // `markNoticed` is what CONSUMES the one notice this caller gets for the whole TTL
    // window, so it must only run once the notice has actually been built into a response.
    // Marking first meant any throw between the two lines (a non-iterable `content` is the
    // reachable shape) burned the notice with nothing delivered: the catch below would
    // return the response unannotated, the user would be told nothing, and they would then
    // be SUPPRESSED for six hours — a silent failure of exactly the "say something" property
    // this feature exists to provide. Order is the whole fix: consume the notice only where
    // it was delivered.
    markNoticed(pending.key, Date.now());
    return annotated;
  } catch (error) {
    logger.warn('⚠️  Attribution notice attach failed; response returned unannotated', {
      metadata: { error: (error as Error)?.message },
    });
    return resp;
  }
}

export async function routeExecutor(toolName: string, args: any, context?: RouteContext): Promise<McpResponse> {
  return runWithProjectScope(
    {
      connectionId: context?.connectionId,
      projectBinding: context?.projectBinding,
      // T4: diagnostics only — see ProjectScopeContext.actor.
      actor: context?.actor,
      // the declared agent-loop identity, read back by position keying.
      loopId: context?.loopId,
    },
    async () => {
      // THE RESOLUTION SINK. `routeExecutorInner` owns the switch and returns from ~70 places,
      // so the binding it resolved cannot be read from its return value without restructuring
      // every one of them. It writes the resolution here instead, and the seam reads it AFTER
      // the response exists — which is the only point where both the decision and the answer
      // it shaped are in hand. Left undefined when the ladder THREW (a refused call), which is
      // correct: nothing was narrowed, the caller was already told loudly.
      const resolved: RouteResolution = {};
      const resp = ensureStructuredContent(
        await routeExecutorInner(toolName, args, context, resolved)
      );
      // ARCHIVE DISCLOSURE — THE ONE SEAM. Placed here, AFTER
      // ensureStructuredContent, because that is the point where every op's response has a
      // single normalised structured channel regardless of whether its handler set
      // `structuredContent` or the legacy `data`. See ARCHIVE_DISCLOSURE_OPS for why the
      // seam is here and not in the eight handlers.
      const disclosed = await applyArchiveDisclosure(resp, toolName, args, context);
      const narrowed = annotateScopeNarrowing(disclosed, resolved.binding, toolName, context);
      // UNATTRIBUTED-WRITE NOTICE — attached LAST so it leads everything, including a
      // scope-narrowing notice. See attachAttributionNotice for why it is here and not
      // in the action gate that decided it.
      return attachAttributionNotice(narrowed, resolved);
    }
  );
}

async function routeExecutorInner(
  toolName: string,
  args: any,
  context?: RouteContext,
  resolved?: RouteResolution
): Promise<McpResponse> {
  try {
    // Log deprecation warning for old tool names
    const deprecatedTools = ['aidis_ping', 'aidis_status', 'aidis_help', 'aidis_explain', 'aidis_examples'];
    if (deprecatedTools.includes(toolName)) {
      const newName = toolName.replace('aidis_', 'mandrel_');
      logger.warn(`⚠️  Tool '${toolName}' is deprecated. Use '${newName}' instead.`);
    }

    // PROJECT BINDING GATE (an earlier task — Amp-orb eval W5, client half). THE choke point:
    // every tool call on BOTH surfaces reaches here (the flat /mcp/tools/* dispatcher and the
    // gateway, which delegates to routeExecutor(opId, …)), so the precedence ladder is
    // enforced in exactly ONE place and the nine per-route resolveProjectId() copies stay
    // unchanged. Runs BEFORE the action gate on purpose: a contradiction must fail before a
    // session row is created or re-pinned, not after.
    //
    // UNBOUND clients (no X-Mandrel-Project, no MANDREL_PROJECT_ID — every human, every
    // client today) get {bound:false} and NOTHING below this comment changes their behaviour.
    const binding: ProjectBindingResolution = await resolveProjectBinding(
      toolName,
      args,
      context?.projectBinding
    );
    // Hand the resolution to the seam (see THE RESOLUTION SINK in routeExecutor). Written
    // BEFORE the materialisation below and before any gate can reject, so a call refused by
    // a LATER guard still reports a narrowing that genuinely happened.
    if (resolved) resolved.binding = binding;
    if (binding.projectId && binding.scopeParam) {
      // MATERIALISE the resolved project as the call's own project argument. Every route
      // already honours an explicit project argument, so this pins the call through the code
      // path that exists — no new resolution rule, no ninth copy. Copy rather than mutate so
      // the caller's validated args object is never altered underneath it.
      //
      // NOT GATED ON `binding.bound`. The resolution now carries a canonical
      // UUID for the UNBOUND explicit-argument caller too — that is the rung-1 normalizer —
      // and materialising it here is what makes ONE resolution rule reach every downstream
      // consumer, including the tag/link edge resolver that was taking the raw string into
      // `AND project_id = $n`. `projectId` is only ever set by resolveProjectBinding after a
      // successful lookup(), so this can never materialise an unvalidated value.
      args = { ...(args ?? {}), [binding.scopeParam]: binding.projectId };
    }

    // UNIDENTIFIED-CALLER GATE. Placed HERE, immediately after the binding
    // ladder and BEFORE the action gate, for two reasons that are both load-bearing:
    //
    //   * AFTER the ladder, because G2's whole question is "did rung 1 or rung 2 answer?"
    //     `binding.projectId` IS that answer — set by an explicit project argument (the
    //     rung-1 normalizer) or by an X-Mandrel-Project / MANDREL_PROJECT_ID
    //     binding, and undefined only when the call would fall through to the shared rung-3
    //     slot. Reading the ladder's own output rather than re-deriving "does this call name
    //     a project" is what stops the guard and the resolution from disagreeing: there is
    //     one resolution per call and both read it.
    //   * BEFORE the action gate, so a rejected call creates NO session row and re-pins
    //     nothing. Same ordering rationale as the binding gate above it: a contradiction
    //     must fail before state moves, not after.
    //
    // Every tool call on BOTH surfaces reaches this line (the gateway dispatcher delegates
    // to routeExecutor(opId, …)), so the rule has exactly one home.
    //
    // "EXPLICIT PROJECT" IS TWO THINGS, NOT ONE. `binding.projectId` covers rungs 1 and 2.
    // It does NOT cover a tool whose project param is EXEMPT — `project_delete.project`,
    // `project_update.project` — because exemption means "this names a target, it does not
    // select a write scope", so the ladder deliberately returns nothing for it. Those calls
    // are nonetheless fully self-describing, and treating them as ambient would reject the
    // Command UI's Delete Project with no per-call remedy (measured across all 28 write ops,
    // not inferred). Both derivations read the SAME source (services/projectBinding.ts).
    const namesExplicitTarget = explicitProjectTargetParams(toolName).some((p) => {
      const v = (args ?? {})[p];
      return typeof v === 'string' && v.trim() !== '';
    });
    enforceCallerIdentity({
      toolName,
      identified: context?.identified,
      hasExplicitProject: binding.projectId !== undefined || namesExplicitTarget,
    });

    // P-B ACTION GATE: lazily create this connection's DB session ONLY when a
    // content-producing tool runs. Passive/read tools fall straight through and
    // never create a session row. Centralised here so the create-timing decision
    // lives in exactly one place (see ACTION_TOOLS above).
    if (ACTION_TOOLS.has(toolName)) {
      await ensureSessionForAction(toolName, context?.connectionId, context?.actor);
      // WRITE AUDIT (report acceptance line 520): every content-producing call records the
      // project id it is scoped to AND which rung of the ladder produced it. Emitted after
      // the action gate so the interactive rung (rung 3) reads the same state the route
      // will. Never throws — an audit hiccup must not break a write.
      await auditWrite(toolName, binding, context);
    }

    // ─────────────────────────────────────────────────────────────────────────────────────
    // UNATTRIBUTED-WRITE NOTICE (customer contoso, 2026-09-09).
    //
    // ITS POPULATION IS `OP_REGISTRY.effect`, THE CANONICAL WRITE SET — deliberately NOT
    // the ACTION_TOOLS gate above it, and this block sits OUTSIDE that gate for exactly
    // that reason. ACTION_TOOLS is three ops (context_store, task_create, decision_record)
    // and exists for LAZY SESSION CREATION, not for "is this a write";
    // config/opRegistry.ts's own header says anchoring write-classification there ships
    // "a guard with a hole shaped exactly like the author's mental model",
    // and names `link` as a write that is not in it. Anchored there, an unattributed user
    // who works through task_update, link, or the project ops would never be told anything
    // while the feature claimed to cover unattributed writes.
    //
    // So the predicate is `opEffect(toolName) === 'write'` — the SAME derivation
    // callerIdentityGuard's G2 reads, from the one list an op must appear in to exist at
    // all, with totality compiler-enforced (`effect` is required on OpRegistryEntry) and
    // an unknown op failing CLOSED to 'write'. `scope-switch` (project_switch) is excluded:
    // it persists the project slot, not a record, so there is no record to tell the user
    // was saved anonymously.
    //
    // WHAT KEEPS THE WIDER REACH FROM BECOMING NOISE is the once-per-window suppression,
    // which is keyed on the connection and not on the op — so a user working through ten
    // different write ops is told once, not ten times.
    //
    // requireActor FALSE is a precondition, not an oversight: when it is TRUE an
    // ACTION_TOOLS call is REJECTED by `actorRequirementError` and that path is untouched.
    // This notice is for the WAIVER deployments, where an unattributed write succeeds and,
    // until now, said nothing at all.
    //
    // Only the DECISION is made here; the string is parked on the resolution seam and
    // attached by `attachAttributionNotice` once the response's success is known.
    // Best-effort — a failure to decide must never break the write.
    if (opEffect(toolName) === 'write') {
      try {
        const noticeKey = attributionNoticeKey(context?.connectionId);
        // `shouldNotice` carries the ENABLED kill switch as well as the TTL window, so the
        // feature being off is one answer from one place, not a flag read twice.
        if (
          resolved &&
          !SESSION_CONFIG.requireActor &&
          normalizeActor(context?.actor) === null &&
          shouldNotice(noticeKey, Date.now())
        ) {
          resolved.attribution = { message: renderConfiguredAttributionNotice(), key: noticeKey };
        }
      } catch (error) {
        logger.warn('⚠️  Attribution notice decision failed; write proceeds unannotated', {
          metadata: { error: (error as Error)?.message },
        });
      }
    }

    switch (toolName) {
      // System & Navigation (5 tools)
      case 'mandrel_ping':
      case 'aidis_ping': // DEPRECATED - use mandrel_ping
        // context is threaded so ping can echo the DERIVED caller identity — the answer to
        // "did my X-Actor-ID land?". discover({action:'ping'}) delegates
        // here with the same context, so the gateway surface gets it too.
        return await systemRoutes.handlePing(args, context);
      case 'mandrel_status':
      case 'aidis_status': // DEPRECATED - use mandrel_status
        return await systemRoutes.handleStatus();
      case 'mandrel_help':
      case 'aidis_help': // DEPRECATED - use mandrel_help
        return await systemRoutes.handleHelp();
      case 'mandrel_explain':
      case 'aidis_explain': // DEPRECATED - use mandrel_explain
        return await systemRoutes.handleExplain(args);
      case 'mandrel_examples':
      case 'aidis_examples': // DEPRECATED - use mandrel_examples
        return await systemRoutes.handleExamples(args);
      // THE AGENT CAPTURE CONTRACT (P4 L1) — gateway discover.contract.
      case 'mandrel_contract':
        return await systemRoutes.handleCaptureContract();

      // Context Management (4 tools) - pass context for session isolation
      case 'context_store':
        return await contextRoutes.handleStore(args, context);
      case 'context_search':
        return await contextRoutes.handleSearch(args, context);
      case 'context_get_recent':
        return await contextRoutes.handleGetRecent(args, context);
      case 'context_update':
        return await contextRoutes.handleUpdate(args, context);
      case 'context_stats':
        return await contextRoutes.handleStats(args, context);
      // ARTIFACT REFERENCES: resolve WHERE an external artifact lives, its
      // expected identity, and the fail-closed verification contract. Mandrel stores no bytes.
      case 'context_artifact':
        return await artifactRoutes.handleResolve(args, context);
      case 'context_delete':
        return await contextRoutes.handleDelete(args, context);
      case 'context_restore':
        return await contextRoutes.handleRestore(args, context);

      // Project Management (8 tools) - pass context for session isolation
      case 'project_list':
        return await projectRoutes.handleList(args, context);
      case 'project_create':
        return await projectRoutes.handleCreate(args);
      case 'project_update':
        return await projectRoutes.handleUpdate(args);
      case 'project_delete':
        return await projectRoutes.handleDelete(args, context);
      case 'project_switch':
        return await projectRoutes.handleSwitch(args, context);
      case 'project_current':
        return await projectRoutes.handleCurrent(args, context);
      case 'project_info':
        return await projectRoutes.handleInfo(args, context);
      // WS2 living summary: deterministic current-state briefing.
      case 'project_briefing':
        return await projectRoutes.handleBriefing(args, context);
      // REPROJECT: move a record between projects, preserving
      // its id, timestamps and typed edges. No `context` needed — both ends are explicit.
      case 'project_move_record':
        return await projectRoutes.handleMoveRecord(args);

      // Technical Decisions (4 tools) - pass context for session isolation
      case 'decision_record':
        return await decisionsRoutes.handleRecord(args, context);
      case 'decision_search':
        return await decisionsRoutes.handleSearch(args, context);
      case 'decision_get':
        return await decisionsRoutes.handleGet(args, context);
      case 'decision_update':
        return await decisionsRoutes.handleUpdate(args, context);
      case 'decision_stats':
        return await decisionsRoutes.handleStats(args, context);
      case 'decision_delete':
        return await decisionsRoutes.handleDelete(args, context);
      case 'decision_restore':
        return await decisionsRoutes.handleRestore(args, context);
      // THE DECISION INBOX.
      case 'decision_answer':
        return await decisionsRoutes.handleAnswer(args, context);
      case 'decision_discuss':
        return await decisionsRoutes.handleDiscuss(args, context);

      // Task Management (9 tools) - pass context for session isolation
      case 'task_create':
        return await tasksRoutes.handleCreate(args, context);
      case 'task_list':
        return await tasksRoutes.handleList(args, context);
      case 'task_update':
        return await tasksRoutes.handleUpdate(args, context);
      case 'task_details':
        return await tasksRoutes.handleDetails(args, context);
      case 'task_bulk_update':
        return await tasksRoutes.handleBulkUpdate(args, context);
      case 'task_progress_summary':
        return await tasksRoutes.handleProgressSummary(args, context);
      case 'task_delete':
        return await tasksRoutes.handleDelete(args, context);
      case 'task_restore':
        return await tasksRoutes.handleRestore(args, context);
      case 'cancel_task':
        return await tasksRoutes.handleCancel(args, context);
      // ATOMIC TASK CLAIM — the claim lifecycle.
      // PASSIVE w.r.t. the lazy-session gate: a claim mutates an EXISTING row, it does not
      // author content, so it must not spawn a session (ACTION_TOOLS stays the tight 3).
      case 'task_claim':
        return await tasksRoutes.handleClaim(args, context);
      case 'task_renew':
        return await tasksRoutes.handleRenew(args, context);
      case 'task_release':
        return await tasksRoutes.handleRelease(args, context);

      // Session Lifecycle (session-rework SR-2) — explicit user-controlled
      // start/end/status. PASSIVE w.r.t. the action gate: session_start runs its OWN
      // end-then-open lifecycle, so it must NOT be in ACTION_TOOLS (that would lazily
      // spawn a session BEFORE the handler, double-creating). All three resolve "the
      // current session" from context.connectionId (the SR-1 per-connection key).
      //
      // (The old 5 auto-management session MCP tools were deleted 2025-10-24; analytics
      //  remain on the REST API at /api/v2/sessions/*. This is the deliberate
      //  re-introduction of the user-facing lifecycle per the operator's current direction.)
      case 'session_start':
        return await sessionRoutes.handleStart(args, context);
      case 'session_end':
        return await sessionRoutes.handleEnd(args, context);
      case 'session_status':
        return await sessionRoutes.handleStatus(args, context);
      // Sessions Foundation Phase 2a — DB-persisted PIN, actor-scoped.
      // PASSIVE (not in ACTION_TOOLS): pinning is targeting metadata, not content, and must
      // not lazily spawn a session.
      case 'session_pin':
        return await sessionRoutes.handlePin(args, context);
      // SESSION IDENTITY read model (Amp-orb eval W3) — READ-ONLY, and PASSIVE
      // w.r.t. the action gate (not in ACTION_TOOLS): asking "which session am I / who owns
      // this one" must never itself mint a session, or the answer would be an artifact of the
      // question.
      case 'session_list':
        return await sessionRoutes.handleList(args, context);
      case 'session_get':
        return await sessionRoutes.handleGet(args, context);

      // Smart Search & AI (3 tools) - pass context for session isolation
      case 'smart_search':
        return await searchRoutes.handleSmartSearch(args, context);
      case 'get_recommendations':
        return await searchRoutes.handleRecommendations(args, context);
      case 'project_insights':
        return await searchRoutes.handleProjectInsights(args, context);
      case 'project_tags':
        return await searchRoutes.handleTagCensus(args, context);

      // Typed-edge graph (Mandrel Core Redesign T2a) - pass context for project scoping
      case 'link':
        return await linksRoutes.handleLink(args, context);
      case 'unlink':
        return await linksRoutes.handleUnlink(args, context);
      case 'get_links':
        return await linksRoutes.handleGetLinks(args, context);

      // recall_thread (Mandrel Core Redesign T3) — the traversal-narrative headline tool
      case 'recall_thread':
        return await recallRoutes.handleRecallThread(args, context);

      // Branch position (PHASE 1 positional membership)
      // — stand on / read / step off the session's current branch (PASSIVE: no session
      // spawn — position is targeting metadata, not content).
      case 'branch_open':
        return await branchRoutes.handleOpen(args, context);
      case 'branch_current':
        return await branchRoutes.handleCurrent(args, context);
      case 'branch_close':
        return await branchRoutes.handleClose(args, context);
      // branch_history (SK2) — READ, and the only branch tool that needs no
      // position: it reads the durable membership edges, not the live pointer, so a CLOSED
      // branch still answers.
      case 'branch_history':
        return await branchRoutes.handleHistory(args, context);
      // Mutable branch membership (P3) — DECLARE a
      // record's branch after the fact, or REMOVE it. Both WRITE, both append to the
      // branch_membership_moves audit log.
      case 'branch_assign':
        return await branchRoutes.handleAssign(args, context);
      case 'branch_unassign':
        return await branchRoutes.handleUnassign(args, context);

      // DEPRECATED anchor aliases (retired by PHASE 1) — WARN and delegate to the branch
      // position tools above. Kept one phase so existing habits/scripts don't break cold.
      case 'thread_set':
        return await threadRoutes.handleSet(args, context);
      case 'thread_current':
        return await threadRoutes.handleCurrent(args, context);
      case 'thread_clear':
        return await threadRoutes.handleClear(args, context);


      // Unknown tool
      default:
        logger.warn(`Unknown MCP tool requested: ${toolName}`);
        return formatMcpError(
          `Unknown tool: ${toolName}. Use 'mandrel_help' to see available tools.`,
          'route_executor'
        );
    }
  } catch (error) {
    logger.error(`Error executing tool ${toolName}`, error as Error);
    return formatMcpError(error as Error, toolName);
  }
}