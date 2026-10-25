/**
 * Health Check Server
 * Provides HTTP health endpoints and MCP tool HTTP bridge
 */

import * as http from 'http';
import express from 'express';
import { logger } from '../utils/logger.js';
import { embeddingService } from '../services/embedding.js';
import { MANDREL_VERSION } from '../version.js';
import { portManager } from '../utils/portManager.js';
import { dbPool, poolHealthCheck } from '../services/databasePool.js';
import { AIDIS_TOOL_DEFINITIONS } from '../config/toolDefinitions.js';
import { ProjectController } from '../api/controllers/projectController.js';
import createSessionRouter from '../api/v2/sessionRoutes.js';
import { createDecisionsRestRouter } from '../api/decisionsRestRoutes.js';
import { AI_MODELS } from '../config/aiModels.js';
import { readProvenanceMeter } from '../services/provenanceMeter.js';
import { deriveActor } from '../config/actorRegistry.js';
import { PROJECT_BINDING_HEADER } from '../config/projectBindingConfig.js';
import { LOOP_ID_HEADER } from '../config/positionKeyConfig.js';
import { bearerAuth, dualBearerAuth, bridgeAuth } from '../middleware/bearerAuth.js';
import { mountOAuthRoutes } from './oauthRoutes.js';
import { BETTER_AUTH_CONFIG } from '../config/betterAuthConfig.js';
import type { RemoteMcpTransport } from './remoteMcpTransport.js';
import { httpStatusForToolOutcome } from '../utils/mcpErrorStatus.js';
import { isErrorResult } from '../utils/mcpFormatter.js';
import { assertToolInputWithinLimit } from '../utils/toolInputLimit.js';
import { mcpJsonBody } from './mcpBodyParser.js';
import {
  MCP_FLAT_MAX_REQUEST_BODY_BYTES,
  MCP_MAX_REQUEST_BODY_BYTES,
  MCP_REST_MAX_REQUEST_BODY_BYTES,
} from '../config/mcpRequestLimitsConfig.js';

/**
 * Header carrying the client-DECLARED actor. Mirrors the same constant in
 * remoteMcpTransport.ts (configs-not-hardcoded — no literal at the call site). Read
 * case-insensitively by express.Request#header.
 */
const ACTOR_ID_HEADER = 'x-actor-id';

/**
 * HTTP Health Check Server
 * Provides health endpoints and MCP tool HTTP bridge
 */
export interface McpExecutorContext {
  connectionId?: string;
  /**
   * TRANSPORT IDENTITY MARKER — REQUIRED on this surface. `false` = this
   * request presented NO `X-Connection-ID` and the shared literal below was substituted for
   * it. See routes/index.ts TransportRouteContext for why a transport does not get to leave
   * this undefined.
   */
  identified: boolean;
  /** Sessions Foundation Phase 1: the actor to attribute a lazily-created session to.
   *  Derived at the edge by `deriveActor` from the VERIFIED OAuth `sub` and/or the
   *  client-DECLARED X-Actor-ID header. The combining rule is flag-gated —
   *  override by default, scoped composite when enabled — so read deriveActor, not this line. */
  actor?: string;
  /** PROJECT BINDING: the raw client-declared X-Mandrel-Project scope for
   *  this call, if any. Undefined = no declared header (MANDREL_PROJECT_ID is then consulted
   *  by config/projectBindingConfig.ts; with neither set there is no binding at all). */
  projectBinding?: string;
  /** THE AGENT LOOP: the raw client-declared X-Loop-ID for this call, if
   *  any. Undefined = the caller declared none, and position keying falls back to the
   *  connection identity scoped by actor (config/positionKeyConfig.ts). */
  loopId?: string;
}

export class HealthServer {
  private server: http.Server | null = null;
  private app: express.Application;
  private port: number = 8080;
  private dbHealthy: boolean = false;
  private circuitBreakerState: string = 'closed';
  private mcpToolExecutor?: (toolName: string, args: any, context?: McpExecutorContext) => Promise<any>;
  private projectController: ProjectController;
  private remoteMcp?: RemoteMcpTransport;

  constructor(
    mcpToolExecutor?: (toolName: string, args: any, context?: McpExecutorContext) => Promise<any>,
    remoteMcp?: RemoteMcpTransport
  ) {
    this.app = express();
    this.mcpToolExecutor = mcpToolExecutor;
    this.remoteMcp = remoteMcp;
    this.projectController = new ProjectController();
    this.setupMiddleware();
    this.setupRoutes();
  }

  /**
   * Setup Express middleware
   */
  private setupMiddleware(): void {
    // CORS headers for cross-origin requests from frontend
    // Default to localhost:3000 for security, allow override via env
    const allowedOrigins = process.env.CORS_ORIGIN?.split(',') || ['http://localhost:3000'];
    
    this.app.use((req, res, next) => {
      const origin = req.headers.origin;
      if (origin && allowedOrigins.includes(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
      }
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-API-Version, X-Request-ID, X-Correlation-ID');

      // Handle OPTIONS preflight requests immediately
      if (req.method === 'OPTIONS') {
        res.status(200).end();
        return;
      }

      next();
    });

    // OAuth authorization-server surface (better-auth) — MOUNTED BEFORE express.json().
    // The better-auth handler reads the raw request body itself; applying express.json()
    // first would consume the stream and hang the handler. mountOAuthRoutes is a no-op
    // (returns null) when MANDREL_OAUTH_ENABLED!=true, so the default static-bearer-only
    // deployment is unaffected. The auth routes are scoped to <basePath> + the explicit
    // .well-known + /sign-in + /consent paths and never intercept /mcp or /mcp/tools/*.
    mountOAuthRoutes(this.app);

    // NO APP-WIDE BODY PARSER. An `app.use(express.json({limit:'10mb'}))` used to sit here
    // and ran BEFORE every route's auth guard, so an unauthenticated caller could make this
    // process parse 10 MB of JSON per request on /mcp, /mcp/tools/* and every REST mutation.
    // Each route that reads a body now parses it AFTER its guard, with its own bound from
    // config/mcpRequestLimitsConfig.ts (the /api/v2/sessions and /api/decisions routers and
    // the OAuth routes already carried their own). The app-wide urlencoded parser went with
    // it: no route on this app reads a form body.
  }

  /**
   * Setup Express routes
   */
  private setupRoutes(): void {
    // Mount session analytics REST API routes.
    //
    // SECURITY (an earlier task / the trust-boundary change): this family serves AND mutates
    // real session data (ids, project names, timestamps, modified files, lifecycle) and was
    // reachable UNAUTHENTICATED on the public internet — both via an nginx bypass on
    // command.example.com and directly on mandrel.example.com (:8080). Gate the WHOLE
    // family in ONE place, using the SAME static Bearer guard the remote /mcp transport uses
    // (MCP_AUTH_TOKEN). This is the sole trust-boundary crossing from the Command backend
    // (:5000, which authenticates the USER via JWT) into this mcp-server (:8080): the Command
    // backend presents MCP_AUTH_TOKEN as the INTERNAL SERVICE TOKEN on every proxied call.
    //
    // UNCONDITIONAL + FAIL-CLOSED, on purpose (NOT behind the dark MCP_BRIDGE_AUTH_ENABLED
    // flag): the /mcp/tools/* bridge ships dark because it serves on-box agents that don't
    // yet send a token; this family has exactly ONE legitimate caller — the Command backend,
    // updated in the SAME change to send the token — so there is no dark-rollout need. A
    // security leak must fail closed NOW: no/blank/wrong token → 401; MCP_AUTH_TOKEN unset on
    // the server → 503 (never open). Static-only (bearerAuth, not dualBearerAuth): the caller
    // is a service presenting the shared secret, never an OAuth browser client — so the gate
    // is identical regardless of OAuth config and carries no JWKS network dependency.
    // ONE guard at the mount = every current AND future sub-route is authed by construction
    // (a past incident class-fix) — no session sub-route can be born public again.
    const sessionRouter = createSessionRouter();
    this.app.use('/api/v2/sessions', bearerAuth(), sessionRouter);
    // Count endpoints from the router stack (computed) so the log can't drift from the
    // actual route set defined in sessionRoutes.ts.
    const sessionEndpointCount = (sessionRouter.stack as Array<{ route?: unknown }>).filter(
      (layer) => layer.route
    ).length;
    logger.info(`📊 Session Analytics API mounted: /api/v2/sessions/* (${sessionEndpointCount} endpoints)`);

    // THE DECISION INBOX — REST half.
    //
    // Same posture as /api/v2/sessions (an earlier task / the trust-boundary change): this
    // surface serves and MUTATES real decision data (decision_answer/decision_discuss), so
    // it is gated at the mount with the SAME static Bearer guard — UNCONDITIONAL +
    // FAIL-CLOSED, never behind the dark bridge flag. ONE guard here = every current AND
    // future sub-route under /api/decisions is authed by construction.
    const decisionsRestRouter = createDecisionsRestRouter();
    this.app.use('/api/decisions', bearerAuth(), decisionsRestRouter);
    const decisionsEndpointCount = (decisionsRestRouter.stack as Array<{ route?: unknown }>).filter(
      (layer) => layer.route
    ).length;
    logger.info(`📊 Decision Inbox REST API mounted: /api/decisions/* (${decisionsEndpointCount} endpoints)`);

    // Meta/config endpoint: the SINGLE-SOURCE AI-model list (the auditor review C4). Both
    // session modals fetch this instead of hardcoding the list. Read-only, no auth
    // concern (it's a static config list). Kept OUT of the session-analytics router so
    // that router's endpoint count stays honest.
    this.app.get('/api/v2/meta/ai-models', (_req, res) => {
      res.status(200).json({ success: true, data: { models: AI_MODELS } });
    });

    // EDGE PROVENANCE METER: declared vs guessed edge
    // minting per week × project × source — the read surface of the instrument the
    // 2026-07-28 dead-mechanism incident lacked. bearerAuth: this reads cross-project
    // graph data, so it gets the same fail-closed guard as /api/v2/sessions (never open).
    this.app.get('/api/v2/graph/provenance', bearerAuth(), this.handleProvenanceMeterExpress.bind(this));

    // Health check endpoints (existing)
    this.app.get('/healthz', this.handleHealthCheckExpress.bind(this));
    this.app.get('/health', this.handleHealthCheckExpress.bind(this));
    this.app.get('/readyz', this.handleReadinessCheckExpress.bind(this));
    this.app.get('/livez', this.handleLivenessCheckExpress.bind(this));
    this.app.get('/health/mcp', this.handleMcpHealthCheckExpress.bind(this));
    this.app.get('/health/database', this.handleDatabaseHealthCheckExpress.bind(this));
    this.app.get('/health/embeddings', this.handleEmbeddingsHealthCheckExpress.bind(this));
    // Idle-reaper liveness — the seam an external monitor polls.
    this.app.get('/health/reaper', this.handleReaperHealthCheckExpress.bind(this));

    // Remote Streamable HTTP MCP transport (NEW — bearer-auth guarded).
    // Mounted on EXACT path '/mcp' so it does NOT intercept the unauthenticated
    // on-box bridge at '/mcp/tools/*' below.
    if (this.remoteMcp) {
      // Auth guard for /mcp:
      //   - OAuth ENABLED  → dualBearerAuth(): static MCP_AUTH_TOKEN (UNCHANGED backward-
      //     compatible path) OR a valid better-auth OAuth JWT (RFC 8707 audience-bound),
      //     else 401 + WWW-Authenticate discovery hint.
      //   - OAuth DISABLED → bearerAuth(): the pre-existing static-only guard, byte-for-byte
      //     (incl. the 503 fail-closed when MCP_AUTH_TOKEN is unset).
      const auth = BETTER_AUTH_CONFIG.enabled ? dualBearerAuth() : bearerAuth();
      // AUTH, THEN PARSE: the body is read only after `auth` passes, and only up to
      // MCP_MAX_REQUEST_BODY_BYTES — an unauthenticated body is never parsed at all.
      // GET/DELETE carry no body, so they mount no parser.
      const mcpBody = mcpJsonBody(MCP_MAX_REQUEST_BODY_BYTES, 'jsonrpc');
      this.app.post('/mcp', auth, mcpBody.parse, this.remoteMcp.handlePost, mcpBody.onError);
      this.app.get('/mcp', auth, this.remoteMcp.handleSessionRequest);
      this.app.delete('/mcp', auth, this.remoteMcp.handleSessionRequest);
      logger.info(
        `🌐 Remote MCP transport mounted: POST/GET/DELETE /mcp ` +
        `(${BETTER_AUTH_CONFIG.enabled ? 'dual static+OAuth auth' : 'static Bearer-auth'} required)`
      );
    }

    // MCP tool endpoints (on-box bridge). Guarded by bridgeAuth() — the SECURITY P0 interim
    // shield (an earlier task PHASE 1; default flipped fail-CLOSED in PHASE 2).
    // MCP_BRIDGE_AUTH_ENABLED now defaults TRUE (fail-CLOSED): by default these three routes
    // require a valid credential (static MCP_AUTH_TOKEN, a command HS256 login JWT, or — if
    // enabled — an OAuth JWT), else 401; enforce-but-unconfigured fails closed (503). Pass-
    // through is available only by EXPLICITLY disabling the flag (false/0/off/no). This surface
    // executes ANY MCP tool, so it defaults closed, never open. ONE guard for all three routes
    //.
    const bridgeGuard = bridgeAuth();
    this.app.get('/mcp/tools/schemas', bridgeGuard, this.handleToolSchemasExpress.bind(this));
    this.app.get('/mcp/tools', bridgeGuard, this.handleToolListExpress.bind(this));
    // AUTH, THEN PARSE — same order as /mcp, with this surface's own limit.
    const flatBody = mcpJsonBody(MCP_FLAT_MAX_REQUEST_BODY_BYTES, 'flat');
    this.app.post(
      '/mcp/tools/:toolName',
      bridgeGuard,
      flatBody.parse,
      this.handleMcpToolExpress.bind(this),
      flatBody.onError,
    );

    // V2 MCP API (handle all v2/mcp paths as middleware)
    this.app.use('/v2/mcp', this.handleV2McpExpress.bind(this));

    // Project API.
    //
    // SECURITY (sibling sweep of the trust-boundary change):
    // POST /api/v2/projects/:id/set-primary MUTATES prod state — it flips which project is
    // primary for every new session — and was reachable UNAUTHENTICATED directly on
    // mandrel.*:8080, so an anonymous caller could change that state. Gate it with the SAME
    // mount-level static Bearer guard the /api/v2/sessions family uses (714f00d): the sole
    // legitimate caller is the Command backend (:5000, authenticates the USER via JWT), which
    // already presents MCP_AUTH_TOKEN as the INTERNAL SERVICE TOKEN on this proxied call
    // (McpService.callMcpEndpoint → authHeader()). UNCONDITIONAL + FAIL-CLOSED (not behind the
    // dark bridge flag): no/blank/wrong token → 401; MCP_AUTH_TOKEN unset → 503 (never open).
    // One guard at the mount = the mutation is authed by construction.
    this.app.post(
      '/api/v2/projects/:id/set-primary',
      bearerAuth(),
      express.json({ limit: MCP_REST_MAX_REQUEST_BODY_BYTES }),
      this.handleProjectSetPrimaryExpress.bind(this),
    );

    // 404 handler
    this.app.use((req, res) => {
      res.status(404).json({ error: 'Not found', path: req.path });
    });
  }

  /**
   * Set database health status
   */
  setDatabaseHealth(healthy: boolean): void {
    this.dbHealthy = healthy;
  }

  /**
   * Set circuit breaker state
   */
  setCircuitBreakerState(state: string): void {
    this.circuitBreakerState = state;
  }

  /**
   * Start the health server
   */
  async start(): Promise<number> {
    // Get port from port manager
    this.port = await portManager.assignPort('aidis-mcp');

    // Create HTTP server from Express app
    this.server = http.createServer(this.app);

    return new Promise<number>((resolve, reject) => {
      this.server!.listen(this.port, async () => {
        try {
          const actualPort = (this.server!.address() as any)?.port || this.port;

          // Register the service with its actual port
          await portManager.registerService('aidis-mcp', actualPort, '/healthz');
          await portManager.logPortConfiguration('aidis-mcp', actualPort);

          logger.info(`✅ Health endpoints available:`);
          logger.info(`   🏥 Liveness:  http://localhost:${actualPort}/healthz`);
          logger.info(`   🎯 Readiness: http://localhost:${actualPort}/readyz`);

          resolve(actualPort);
        } catch (error) {
          reject(error);
        }
      });
    });
  }

  /**
   * Stop the health server
   */
  async stop(): Promise<void> {
    if (this.server) {
      logger.info('🏥 Closing health check server...');
      await new Promise<void>((resolve) => {
        this.server!.close(async () => {
          // Unregister the service from port registry
          await portManager.unregisterService('aidis-mcp');
          logger.info('✅ Health check server closed and unregistered');
          resolve();
        });
      });
      this.server = null;
    }
  }

  address(): ReturnType<http.Server['address']> {
    return this.server?.address() ?? null;
  }

  /**
   * Express handler wrappers
   */
  private async handleHealthCheckExpress(_req: express.Request, res: express.Response): Promise<void> {
    const healthData = {
      status: 'healthy',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      pid: process.pid,
      version: MANDREL_VERSION, // <semver>+<revision>, see ../version.ts — the PRODUCT version
      embeddings: embeddingService.getEmbeddingMode() // 'real' | 'mock'
    };
    res.json(healthData);
  }

  private async handleReadinessCheckExpress(_req: express.Request, res: express.Response): Promise<void> {
    const poolHealth = await poolHealthCheck();
    const poolStats = dbPool.getStats();

    const isReady = this.dbHealthy &&
                   this.circuitBreakerState !== 'open' &&
                   poolHealth.healthy;

    const readinessData = {
      status: isReady ? 'ready' : 'not_ready',
      database: this.dbHealthy ? 'connected' : 'disconnected',
      circuit_breaker: this.circuitBreakerState,
      pool: {
        healthy: poolHealth.healthy,
        total_connections: poolStats.totalCount,
        active_connections: poolStats.activeQueries,
        pool_utilization: `${poolStats.poolUtilization.toFixed(1)}%`,
        health_status: poolStats.healthStatus
      },
      timestamp: new Date().toISOString()
    };

    res.status(isReady ? 200 : 503).json(readinessData);
  }

  private async handleLivenessCheckExpress(_req: express.Request, res: express.Response): Promise<void> {
    const livenessData = {
      status: 'alive',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      pid: process.pid
    };
    res.json(livenessData);
  }

  private async handleMcpHealthCheckExpress(_req: express.Request, res: express.Response): Promise<void> {
    const mcpHealth = {
      status: 'healthy',
      transport: 'stdio',
      tools_available: AIDIS_TOOL_DEFINITIONS.length,
      timestamp: new Date().toISOString()
    };
    res.json(mcpHealth);
  }

  private async handleDatabaseHealthCheckExpress(_req: express.Request, res: express.Response): Promise<void> {
    const poolStats = dbPool.getStats();
    const dbHealth = {
      status: this.dbHealthy ? 'healthy' : 'unhealthy',
      connected: this.dbHealthy,
      pool: {
        total: poolStats.totalCount,
        active: poolStats.activeQueries,
        idle: poolStats.idleCount,
        utilization: `${poolStats.poolUtilization.toFixed(1)}%`
      },
      timestamp: new Date().toISOString()
    };

    res.status(this.dbHealthy ? 200 : 503).json(dbHealth);
  }

  private async handleEmbeddingsHealthCheckExpress(_req: express.Request, res: express.Response): Promise<void> {
    const embeddingsHealth = {
      status: 'healthy',
      service: 'local-transformers-js',
      model: 'Xenova/all-MiniLM-L6-v2',
      dimensions: 384,
      timestamp: new Date().toISOString()
    };
    res.json(embeddingsHealth);
  }

  /**
   * GET /health/reaper — publish the idle reaper's liveness.
   *
   * WHY THIS ENDPOINT EXISTS
   *   SessionTimeoutService counts consecutive failed sweeps and logs one REAPER-DOWN
   *   line at the configured threshold — but a `logger.error` only reaches someone
   *   already reading logs. The alerting lives OUT of this process so the MCP server keeps no
   *   outward-facing notifier dependency. This route is the seam between the two: the
   *   detector publishes its verdict, and an external monitor polls it and pages.
   *
   * WHY IT ALWAYS RETURNS 200 (deliberate, and it differs from /health/database)
   *   Two consumers would misread a 5xx here. docker-compose's mcp-server healthcheck
   *   spiders /health, and mandrel-health unit does `curl -f /health || systemctl
   *   restart mandrel` — both are wired to /health, not here, and this route is kept
   *   OUT of that aggregate on purpose. A wedged reaper is a poisoned DB row: a restart
   *   does not clear it, so escalating this into a restart trigger would flap the whole
   *   server while fixing nothing. The verdict is the `down` FIELD; the status code
   *   stays 200 so no generic `-f` prober can ever turn a reaper outage into a restart
   *   loop.
   *
   * WHAT IS DELIBERATELY NOT PUBLISHED
   *   The raw `lastFailure` driver message. It is a Postgres error string and a CHECK
   *   violation can carry row content; this surface is reachable by anything that can
   *   reach :8080. It publishes `lastFailureClass` (a bounded enum) instead — enough to
   *   name the cause in a page, with the raw text left in the server log.
   */
  private async handleReaperHealthCheckExpress(_req: express.Request, res: express.Response): Promise<void> {
    // Pure pass-through. The body is shaped by buildReaperHealthPayload() so that the
    // end-to-end acceptance test consumes the SAME builder this route serves, rather than
    // a look-alike of its own.
    const { buildReaperHealthPayload } = await import('../services/sessionTimeout.js');
    res.status(200).json(buildReaperHealthPayload());
  }

  /**
   * EDGE PROVENANCE METER read endpoint.
   *   GET /api/v2/graph/provenance?weeks=12&projectId=<uuid>
   * Thin pass-through to readProvenanceMeter() — the SAME gather the alarm's window count
   * shares its view with, so this surface and the alarm cannot disagree about what an edge
   * is. FAIL LOUD: a failed read is a 500 with the error class, never an empty-but-200.
   */
  private async handleProvenanceMeterExpress(req: express.Request, res: express.Response): Promise<void> {
    try {
      const weeksRaw = req.query.weeks;
      const weeks =
        typeof weeksRaw === 'string' && /^[0-9]+$/.test(weeksRaw) ? Number(weeksRaw) : undefined;
      const projectIdRaw = req.query.projectId;
      const projectId = typeof projectIdRaw === 'string' && projectIdRaw !== '' ? projectIdRaw : null;
      if (projectId !== null && !/^[0-9a-f-]{36}$/i.test(projectId)) {
        res.status(400).json({ success: false, error: 'projectId must be a UUID' });
        return;
      }
      const meter = await readProvenanceMeter({ projectId, weeks });
      res.status(200).json({ success: true, data: meter });
    } catch (error) {
      logger.error('❌ Provenance meter read failed', error as Error);
      res.status(500).json({ success: false, error: 'provenance meter read failed' });
    }
  }

  private async handleToolSchemasExpress(_req: express.Request, res: express.Response): Promise<void> {
    res.json({
      success: true,
      tools: AIDIS_TOOL_DEFINITIONS,
      count: AIDIS_TOOL_DEFINITIONS.length,
      timestamp: new Date().toISOString(),
      note: 'Complete MCP tool definitions with inputSchema for all AIDIS tools'
    });
  }

  private async handleToolListExpress(_req: express.Request, res: express.Response): Promise<void> {
    res.json({
      success: true,
      tools: AIDIS_TOOL_DEFINITIONS.map(tool => ({
        ...tool,
        endpoint: `/mcp/tools/${tool.name}`
      })),
      count: AIDIS_TOOL_DEFINITIONS.length,
      timestamp: new Date().toISOString()
    });
  }

  /**
   * Sessions Foundation Phase 1: the ACTOR to attribute a lazily-created session to on the
   * on-box /mcp/tools/* bridge surface. Pure plumbing — it hands the verified OAuth `sub`
   * (populated by bridgeAuth's OAuth path as req.oauthSubject) and the declared X-Actor-ID
   * header to `deriveActor`, which owns the ONE precedence rule. Undefined → the
   * lifecycle service stamps the flagged `anonymous` actor. Attribution, not authz. Mirrors
   * remoteMcpTransport#actorFor.
   *
   * THE RULE IS FLAG-GATED, so do not restate it here:
   * default OFF = a verified `sub` OVERRIDES the declared header; ON = the `sub` SCOPES it into
   * a server-assembled composite. Read deriveActor for the current truth.
   */
  private actorFor(req: express.Request): string | undefined {
    const sub = (req as { oauthSubject?: { sub?: string } }).oauthSubject?.sub;
    return deriveActor(sub, req.header(ACTOR_ID_HEADER));
  }

  private async handleMcpToolExpress(req: express.Request, res: express.Response): Promise<void> {
    if (!this.mcpToolExecutor) {
      res.status(500).json({ error: 'MCP tool executor not configured' });
      return;
    }

    try {
      const toolName = String(req.params.toolName);
      // No JSON body (missing, or not sent as application/json) is the caller's error: 400,
      // never a TypeError 500.
      if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
        res.status(400).json({ success: false, error: 'Request body must be a JSON object sent with Content-Type: application/json' });
        return;
      }
      const rawArgs = req.body.arguments || req.body.args || {};
      // Schema-driven coercion happens in validateToolArguments.
      const args = rawArgs;
      // TOOL-INPUT ELEMENT LIMIT — before anything walks the arguments. A throw lands in the
      // catch below as McpError -32602 → 400.
      assertToolInputWithinLimit(toolName, args);

      // THE COLLAPSE. `|| 'http-default'` merges every caller that presents
      // no identity onto ONE shared, sticky, last-writer-wins project slot. It is LEFT IN
      // PLACE deliberately — deleting it re-keys reads, and 5 of 7 tenants have no primary
      // project, so their auto-select would fall to a non-deterministic `projects[0]`
      // (guard G3; the real removal is an earlier task). What was missing is that the collapse
      // DESTROYED the distinction it collapses: downstream, "absent" and "explicitly named
      // http-default" are the same string, and substituting `undefined` instead only moves
      // the problem to the SECOND shared literal ('default-session', 16 sites). So the fact
      // is carried forward explicitly, next to the value that erases it.
      const declaredConnectionId = req.header('X-Connection-ID');
      const identified = declaredConnectionId !== undefined && declaredConnectionId.trim() !== '';
      const connectionId = declaredConnectionId || 'http-default';
      if (!identified) {
        logger.debug('MCP tool request without X-Connection-ID header, using shared session state');
      }

      // Sessions Foundation Phase 1: derive the ACTOR to attribute a lazily-created session
      // to (attribution, not authz). This surface is guarded by bridgeAuth() (see route wiring
      // above): when OAuth is ENABLED and the caller presents a valid OAuth JWT, bridgeAuth
      // populates req.oauthSubject and req.oauthSubject.sub IS the authenticated principal
      //. X-Actor-ID is the DECLARED handle for static-bearer
      // on-box callers (the tick runtime, the Claude Code bridge) that have no authenticated
      // principal. deriveActor unifies both under ONE flag-gated rule: default
      // OFF = a verified sub OVERRIDES the declared header; ON = the sub SCOPES it into a
      // server-assembled composite. ADDITIVE either way: a static-bearer caller has no
      // oauthSubject → sub is undefined → falls through to X-Actor-ID → `anonymous` if unset,
      // exactly as before.
      const actor = this.actorFor(req);

      // PROJECT BINDING: the client-declared project scope for this call.
      // Raw pass-through — the trim/blank rule and the header>env ladder are owned by
      // config/projectBindingConfig.ts, never re-stated at a call site.
      const projectBinding = req.header(PROJECT_BINDING_HEADER);

      // THE AGENT LOOP. A connection is a TRANSPORT and one transport
      // carries many agents; this is the only field on the wire by which two agents that
      // share both a connection id and an actor can declare that they are different loops.
      // Raw pass-through — the whole keying ladder lives in config/positionKeyConfig.ts.
      const loopId = req.header(LOOP_ID_HEADER);

      const result = await this.mcpToolExecutor(toolName, args, { connectionId, identified, actor, projectBinding, loopId });
      // THE ENVELOPE MUST AGREE WITH THE RESULT IT WRAPS.
      //
      // WAS: an unconditional `success: true`. Every error raised INSIDE routeExecutorInner is
      // caught there and returned as an in-band error result (`formatMcpError` -> isError:true),
      // so it never reaches the catch below — and this literal then told the HTTP caller the
      // call SUCCEEDED while the result it carried said it failed. The actor-requirement
      // rejection, PROJECT_SCOPE_SWITCH_UNIDENTIFIED, PROJECT_AMBIENT_WRITE_UNIDENTIFIED,
      // every ProjectBindingError and every in-band validation rejection shared this.
      //
      // THE STATUS CODE (an earlier task — the deferred half of an earlier decision).
      //
      // WAS: a bare `res.json(...)`, i.e. an unconditional 200. That was correct for an
      // ordinary MCP tool error and WRONG for a POLICY REFUSAL, which also arrives here in
      // band: the binding gate and the identity guards throw before dispatch,
      // routeExecutorInner catches and returns formatMcpError, and the caller was told
      // 200 OK for a write that never happened. Measured, all four at the real surface:
      // PROJECT_AMBIENT_WRITE_UNIDENTIFIED, PROJECT_SCOPE_SWITCH_UNIDENTIFIED,
      // PROJECT_BINDING_UNRESOLVED and the actor rejection each returned 200.
      //
      // ONE AUTHORITY. This line and the catch below now call the SAME function. They used
      // to be two independent answers to one question, and they did disagree in production:
      // an McpError -32602 raised by flat validation escaped to the catch and was classified
      // 400, while the identical -32602 raised on the GATEWAY path was caught by
      // dispatchGateway, returned in band, and reported 200. One client mistake, two statuses,
      // decided by which surface the client happened to call.
      //
      // `failed` is computed ONCE and handed to both consumers, so the envelope's `success`
      // and the status can never be derived from two different readings of the same result.
      // `isErrorResult` remains the single definition — see utils/mcpFormatter.ts for why
      // `isError` is authoritative and `structuredContent.ok` is not a second opinion.
      //
      // THE BODY IS UNCHANGED, deliberately. Only the status moves. Both stdio bridges key on
      // `response.result !== undefined` before they look at a status, so
      // they see a byte-identical payload and are unaffected.
      const failed = isErrorResult(result);
      res
        .status(httpStatusForToolOutcome({ kind: 'returned', result, failed }))
        .json({ success: !failed, result });
    } catch (error: any) {
      // THE tool-call status seam. Every tool call on this surface — flat
      // opId (`/mcp/tools/task_update`) AND gateway (`/mcp/tools/task` + {action}) — lands
      // in this ONE catch, because executeMcpTool forks flat-vs-gateway BENEATH it. So the
      // client-vs-server classification is made in exactly one place for both surfaces; no
      // per-tool and no per-surface copy exists to drift.
      //
      // WAS: an unconditional res.status(500). A strict-mode `Unknown parameter(s)` throw
      // (McpError -32602, "Invalid params") therefore reached the caller as a SERVER error,
      // telling every retrying agent client to retry a request that can never succeed, and
      // inflating the 5xx rate we alert on. httpStatusForError maps client errors to 4xx and
      // leaves EVERYTHING it does not explicitly recognise at 500 (fail closed) — see
      // utils/mcpErrorStatus.ts for the full rationale and its two compiler guarantees.
      const status = httpStatusForToolOutcome({ kind: 'threw', error });
      // Log at the level the classification implies: a client mistake is not an incident and
      // must not page, while a genuine 5xx still logs as an error.
      const detail = `${String(req.params.toolName)}: ${error?.message}`;
      if (status >= 500) {
        logger.error(`MCP tool call failed (${status})`, error as Error);
      } else {
        logger.warn(`MCP tool call rejected (${status}) ${detail}`);
      }
      res.status(status).json({
        success: false,
        error: error.message,
        type: error.constructor.name
      });
    }
  }

  private async handleV2McpExpress(req: express.Request, res: express.Response): Promise<void> {
    const path = req.path.replace('/v2/mcp', '') || '/';

    if (path === '/') {
      // NOTE: this '2.0.0' is the V2 MCP **API/schema** version (the contract this
      // /v2/mcp surface speaks, with its own compatibleVersions negotiation) — NOT
      // the product/package version. It is intentionally kept SEPARATE from
      // MANDREL_VERSION and must move only when the V2 API contract itself changes.
      res.json({
        version: '2.0.0',
        compatibleVersions: ['2.0.0', '2.1.0'],
        endpoints: {
          tools: '/v2/mcp/tools/:toolName',
          list: '/v2/mcp/tools',
          health: '/v2/mcp/health'
        }
      });
    } else if (path === '/health') {
      res.json({
        status: 'healthy',
        version: '2.0.0',
        timestamp: new Date().toISOString(),
        toolsAvailable: AIDIS_TOOL_DEFINITIONS.length
      });
    } else if (path === '/tools' && req.method === 'GET') {
      res.json({
        success: true,
        version: '2.0.0',
        data: {
          tools: AIDIS_TOOL_DEFINITIONS.map(tool => ({
            name: tool.name,
            endpoint: `/v2/mcp/tools/${tool.name}`
          })),
          totalCount: AIDIS_TOOL_DEFINITIONS.length
        }
      });
    } else {
      res.status(404).json({
        success: false,
        error: 'V2 API endpoint not found',
        version: '2.0.0'
      });
    }
  }

  private async handleProjectSetPrimaryExpress(req: express.Request, res: express.Response): Promise<void> {
    try {
      const mockReq = {
        params: { id: req.params.id },
        body: req.body
      } as any;

      let responseData: any = null;
      let statusCode = 200;

      const mockRes = {
        status: (code: number) => {
          statusCode = code;
          return mockRes;
        },
        json: (data: any) => {
          responseData = data;
        }
      } as any;

      await this.projectController.setPrimary(mockReq, mockRes);
      res.status(statusCode).json(responseData);
    } catch (error: any) {
      res.status(500).json({
        success: false,
        error: error.message || 'Internal server error'
      });
    }
  }
}
