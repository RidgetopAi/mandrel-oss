#!/usr/bin/env node

/**
 * AIDIS MCP Server - ENTERPRISE HARDENED
 *
 * This is the main server class for our AI Development Intelligence System.
 * It creates an MCP server that AI agents can connect to for:
 * - Persistent context management
 * - Naming consistency enforcement
 * - Technical decision tracking
 * - Multi-agent coordination
 *
 * ORACLE ENTERPRISE HARDENING:
 * - Process singleton pattern (no multiple instances)
 * - Health check endpoints (/healthz, /readyz)
 * - Graceful shutdown handling
 * - MCP debug logging
 * - Connection retry with exponential backoff
 * - Circuit breaker pattern
 */

import { MANDREL_VERSION } from '../version.js';
import { formatInstructions, PROJECT_INSTRUCTIONS_ENABLED } from '../config/projectEchoConfig.js';
import { logger, CorrelationIdManager } from '../utils/logger.js';
import { RequestLogger } from '../middleware/requestLogger.js';
import { ErrorHandler } from '../utils/errorHandler.js';
import { CircuitBreaker, RetryHandler } from '../utils/resilience.js';
import { HealthServer } from './healthServer.js';
import { backgroundServices } from '../services/backgroundServices.js';
import { registerMcpHandlers, type McpHandlerDeps } from './registerMcpHandlers.js';
import { RemoteMcpTransport } from './remoteMcpTransport.js';
import { assertRemoteMcpEnvOrExit } from './requireRemoteMcpEnv.js';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ErrorCode,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';

import { initializeDatabase, closeDatabase } from '../config/database.js';
import { embeddingService } from '../services/embedding.js';
import { dbPool } from '../services/databasePool.js';
import { validationMiddleware } from '../middleware/validation.js';
import { SessionTracker } from '../services/session/SessionTracker.js';
import { ActiveSessionStore } from '../services/session/index.js';
import { liveFeatureFlags } from '../config/liveFeatureFlags.js';
// Phase 6.3: Route executor integration - replaces individual handler imports
import { routeExecutor, type TransportRouteContext } from '../routes/index.js';
// MCP-2026 rebuild Phase 2: gateway dispatch (dark — only reached when a gateway/discover
// tool name is called; the flat opId names route through the unchanged path below).
import { isGatewayTool, dispatchGateway, flatRejectionError } from '../routes/gateway.js';
// Keep projectHandler for the request-log project attribution only (loggingProjectId)
import { projectHandler } from '../handlers/project.js';
// The ambient project scope, so the request-log attribution resolves the EFFECTIVE project
// (it runs before routeExecutor establishes its own scope — see loggingProjectId).
import { runWithProjectScope } from '../services/effectiveProjectScope.js';

// Enterprise hardening constants
const MAX_RETRIES = 3;
// Helper function to get environment variable with AIDIS_ prefix and fallback
function getEnvVar(aidisKey: string, legacyKey: string, defaultValue: string = ''): string {
  return process.env[aidisKey] || process.env[legacyKey] || defaultValue; // env-read: via-callers
}

const SKIP_DATABASE = getEnvVar('AIDIS_SKIP_DATABASE', 'SKIP_DATABASE', 'false') === 'true';
const SKIP_STDIO_TRANSPORT = getEnvVar('AIDIS_SKIP_STDIO', 'SKIP_STDIO', 'false') === 'true';

/**
 * AIDIS Server Class - ENTERPRISE HARDENED
 *
 * This handles all MCP protocol communication and routes requests
 * to our various handlers (context, naming, decisions, etc.)
 */
export default class MandrelMcpServer {
  private server: Server;
  private healthServer: HealthServer;
  // private v2McpRouter: V2McpRouter; // Disabled - using direct integration
  private circuitBreaker: CircuitBreaker;
  private remoteMcp: RemoteMcpTransport;

  constructor() {
    this.circuitBreaker = new CircuitBreaker();
    // Phase 5 Integration: Initialize V2 API router
    // this.v2McpRouter = new V2McpRouter(); // Disabled - using direct integration

    this.server = new Server(
      {
        name: 'aidis-mcp-server',
        version: MANDREL_VERSION, // <semver>+<revision>, see ../version.ts — CUSTOMER-VISIBLE
      },
      {
        capabilities: {
          tools: {},
          resources: {},
        },
        // PROJECT VISIBILITY: connect-time instructions reminding the client
        // that all writes scope to the ACTIVE project. STATIC here — the stdio Server is a
        // single long-lived instance (the bridge multiplexes many connections through it),
        // so it can't name one connection's project; the per-connection DYNAMIC name is set
        // on the remote HTTP transport (remoteMcpTransport.ts). Omitted when disabled.
        ...(PROJECT_INSTRUCTIONS_ENABLED ? { instructions: formatInstructions(undefined) } : {}),
      }
    );

    // Shared MCP handler dependencies — used by BOTH the stdio Server and each
    // per-session HTTP Server so tool logic lives in exactly one place (DRY).
    const handlerDeps: McpHandlerDeps = {
      executeMcpTool: this.executeMcpTool.bind(this),
      getServerStatus: this.getServerStatus.bind(this),
    };

    // Register handlers on the long-lived stdio Server (connectionId defaults to stdio)
    registerMcpHandlers(this.server, handlerDeps);

    // Remote Streamable HTTP transport reuses the SAME handler registration per session
    this.remoteMcp = new RemoteMcpTransport(handlerDeps);

    // Initialize health server with MCP tool executor + remote transport mount
    this.healthServer = new HealthServer(
      this.executeMcpTool.bind(this),
      this.remoteMcp
    );
  }

  /**
   * The project id stamped on this request's LOG context — i.e. WHICH PROJECT this request
   * operated in. Best-effort: never throws, degrades to undefined.
   *
   * RENAMED from `getCurrentProjectId` to remove a name collision with the
   * project-scope accessor, which would otherwise have forced the choke-point guard
   * (src/tests/projectScopeChokePoint.contract.test.ts) to carry an "unrelated" escape hatch
   * — a category that means "ignore me" (prefer the compiler over a rule a
   * reviewer has to remember).
   *
   * IT NOW RESOLVES THE EFFECTIVE SCOPE, for two measured reasons:
   *
   *  1. BINDING-BLIND. It read the connection's rung-3 slot, so under a binding every log line
   *     for a bound client was attributed to the auto-selected project rather than the one the
   *     request actually used. Log-only — the persisted audit paths already use the effective
   *     accessor — but wrong attribution in logs is exactly what makes the next incident hard
   *     to trace, and this is the same "no surface reports the wrong project" class.
   *  2. IT READ THE WRONG KEY-SPACE. It looked a DB SESSION id (ActiveSessionStore, and via
   *     `getCurrentSessionId()` with no argument, so the 'default' connection's at that) up in
   *     `projectHandler['sessionStates']`, which is keyed by CONNECTION id. The two key spaces
   *     do not overlap, so the field resolved to undefined on essentially every request
   *     (measured: src/tests/loggingProjectAttribution.contract.test.ts pins both halves).
   *
   * Going through `getCurrentProjectId` inside the ambient scope is what makes it correct
   * without adding a second resolution rule: ONE accessor, the same one every tool crosses.
   * It costs one indexed lookup per call — the honest price of a log field that is true.
   */
  private async loggingProjectId(
    connectionId: string,
    projectBinding?: string
  ): Promise<string | undefined> {
    try {
      // PROJECT-SCOPE: effective — a request-log line attributes the request to the project it
      // actually operated in, which is the effective scope by definition.
      const read = () => projectHandler.getCurrentProjectId(connectionId);
      // The scope is established HERE because this runs BEFORE routeExecutor's wrap: the log
      // context is built to WRAP the operation, so it cannot be resolved from inside it.
      const projectId = await runWithProjectScope({ connectionId, projectBinding }, read);
      return projectId ?? undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * TS006-2: Estimate token usage from text
   * Uses conservative estimation: 1 token ≈ 4 characters
   */
  private estimateTokenUsage(text: string): number {
    if (!text) return 0;
    return Math.ceil(text.length / 4);
  }

  // setupHealthServer(), handleMcpToolRequest(), handleV2McpRequest(), and simulateV2Routing() methods moved to server/healthServer.ts

  /**
   * Execute MCP Tool (shared logic for both MCP and HTTP)
   * @param context - Optional execution context with connectionId for session isolation
   */
  private async executeMcpTool(
    toolName: string,
    args: any,
    context?: TransportRouteContext
  ): Promise<any> {
    // Generate correlation ID for request tracing
    const correlationId = CorrelationIdManager.generate();
    // Use connectionId from context for session isolation, default for stdio
    const connectionId = context?.connectionId ?? 'stdio';
    // TRANSPORT IDENTITY MARKER. A supplied context has already decided (the
    // type requires it). NO context means this is the raw stdio path: one client per process,
    // over a pipe it owns exclusively, so the 'stdio' slot is not SHARED with anyone — which
    // is the only property the unidentified-caller guards care about. Stated here rather than
    // defaulted somewhere generic, so the claim is attached to the transport that makes it
    // true (investigation entry-path table, row 9).
    const identified = context?.identified ?? true;
    // Sessions Foundation Phase 1: the actor to attribute a newly-created session to.
    // stdio has no header, so fall back to the MANDREL_ACTOR env (lets a stdio client
    // declare its identity via config); undefined → the lifecycle service stamps anonymous.
    const actor = context?.actor ?? process.env.MANDREL_ACTOR ?? undefined;
    // PROJECT BINDING: the client-declared project scope, when the transport
    // saw an X-Mandrel-Project header. stdio has no headers — a stdio client binds itself via
    // the MANDREL_PROJECT_ID env, which configuredBinding() reads directly, so nothing is
    // plumbed here for it (undefined = "no declared header", NOT "no binding").
    const projectBinding = context?.projectBinding;
    const sessionId = this.getCurrentSessionId(connectionId);

    // TS006-2: Estimate input tokens
    const inputTokens = this.estimateTokenUsage(JSON.stringify(args || {}));

    // Resolved BEFORE the wrapped operation because the log context is built to wrap it.
    // Binding-aware — see loggingProjectId.
    const logProjectId = await this.loggingProjectId(connectionId, projectBinding);

    const result = await RequestLogger.wrapOperation(
      toolName,
      args,
      async () => {
        // MCP-2026 Phase 2 — GATEWAY DISPATCH (dark unless a gateway/discover tool is called).
        // A call to a gateway name (`context`, `task`, … or `discover`) is resolved to its opId
        // and validated+routed through the SAME per-op machinery; flat opId names fall straight
        // through to the unchanged path below. At the default surface these names are advertised
        // to no one, so this branch is only reached by an explicit gateway caller.
        if (isGatewayTool(toolName)) {
          return await dispatchGateway(toolName, args || {}, { connectionId, identified, actor, projectBinding });
        }
        // FLAT_TOOLS=reject: a gateway-folded flat name is deprecated on this instance (dark at
        // the `accept` default — always null there, so the flat path is byte-identical to before).
        const flatReject = flatRejectionError(toolName);
        if (flatReject) return flatReject;

        // ORACLE HARDENING: Input validation middleware
        const validation = validationMiddleware(toolName, args || {});
        if (!validation.success) {
          throw new McpError(
            ErrorCode.InvalidParams,
            `Input validation failed: ${validation.error}`
          );
        }

        const validatedArgs = validation.data;

        return this.executeToolOperation(toolName, validatedArgs, connectionId, identified, actor, projectBinding);
      },
      {
        correlationId,
        sessionId: sessionId || 'unknown-session',
        projectId: logProjectId
      }
    );

    // TS006-2: Estimate output tokens and record usage
    try {
      const outputTokens = this.estimateTokenUsage(JSON.stringify(result));

      if (sessionId) {
        SessionTracker.recordTokenUsage(sessionId || 'unknown-session', inputTokens, outputTokens);
      }
    } catch (error) {
      // Don't fail the request if token tracking fails
      logger.error('Failed to record token usage', error as Error);
    }

    return result;
  }

  /**
   * Phase 6.3: Execute the actual tool operation via route dispatcher
   * All tool routing logic moved to routes/index.ts
   */
  private async executeToolOperation(
    toolName: string,
    validatedArgs: any,
    connectionId?: string,
    /** did the caller present a connection identity? Decided by the transport. */
    identified?: boolean,
    actor?: string,
    projectBinding?: string
  ): Promise<any> {
    // Delegate to centralized route executor with connection context for session isolation
    // All 38 MCP tools now handled by domain-based route modules. `actor` (Phase 1) rides
    // along for attribution of any lazily-created session.
    return await routeExecutor(toolName, validatedArgs, { connectionId, identified, actor, projectBinding });
  }

  // MCP request-handler registration extracted to server/registerMcpHandlers.ts so the
  // stdio Server and every per-session HTTP Server share ONE handler definition (DRY).

  // PARAMETER COERCION MOVED (P0). The transport-level
  // `deserializeParameters()` that lived here was a hardcoded NAME ALLOW-LIST
  // (arrayParams=[tags,…] / numberParams=[limit,…]) with a SILENT PASS-THROUGH default,
  // so any strictly-typed param whose NAME nobody remembered to add went unrescued —
  // loudly for numbers, SILENTLY for arrays (dropped filter -> wrong results).
  //
  // It could never have been fixed in place: at this seam a GATEWAY call is still named
  // `context`/`task`, so the per-op schema that says what each param SHOULD be is not yet
  // resolved. Coercion is now SCHEMA-DRIVEN and lives at the one seam that does hold the
  // resolved schema — `coerceArgsToDeclaredTypes` in middleware/validation.ts, called from
  // validateToolArguments, which every op crosses on every transport (flat, gateway, and
  // discover.ping/status). No name list, deny-by-default, zero advertised-token cost.

  // Phase 6.3: All 38 handler methods removed - now in routes/*.routes.ts
  // Handlers extracted to:
  //   - routes/system.routes.ts (5 tools: ping, status, help, explain, examples)
  //   - routes/context.routes.ts (4 tools)
  //   - routes/project.routes.ts (6 tools)
  //   - routes/naming.routes.ts (4 tools)
  //   - routes/decisions.routes.ts (4 tools)
  //   - routes/tasks.routes.ts (6 tools)
  //   - routes/sessions.routes.ts (5 tools)
  //   - routes/search.routes.ts (3 tools)
  //   - routes/patterns.routes.ts (2 tools)
  // All routing logic centralized in routes/index.ts via routeExecutor()

  /**
   * Get current session ID from active session store for a specific connection
   * @param connectionId - Connection identifier for session isolation
   */
  private getCurrentSessionId(connectionId?: string): string | null {
    return ActiveSessionStore.get(connectionId);
  }

  /**
   * Get server status information
   */
  private async getServerStatus() {
    const uptime = process.uptime();
    const memoryUsage = process.memoryUsage();

    // Test database connectivity
    let databaseConnected = false;
    try {
      const { db } = await import('../config/database.js');
      const result = await db.query('SELECT 1 as test');
      databaseConnected = result.rows.length > 0;
    } catch (error) {
      logger.warn('Database connectivity test failed', { metadata: { error } });
    }

    return {
      version: MANDREL_VERSION, // <semver>+<revision>, see ../version.ts
      uptime,
      startTime: new Date(Date.now() - uptime * 1000).toISOString(),
      environment: process.env.NODE_ENV || 'development',
      database: {
        connected: databaseConnected,
        host: getEnvVar('AIDIS_DATABASE_HOST', 'DATABASE_HOST', 'localhost'),
        port: getEnvVar('AIDIS_DATABASE_PORT', 'DATABASE_PORT', '5432'),
        database: getEnvVar('AIDIS_DATABASE_NAME', 'DATABASE_NAME', 'aidis_development'),
      },
      memory: {
        used: memoryUsage.rss,
        heap: memoryUsage.heapUsed,
        external: memoryUsage.external,
      },
      // this used to be the deleted JSON FeatureFlagStore's
      // getAllFlags(), which on every container in the fleet returned `{}` because
      // the config file was never shipped into the image. The resource therefore
      // reported "no flags on" while mandrel_status reported the real ones. Same
      // builder as mandrel_status now, so the two cannot disagree.
      featureFlags: liveFeatureFlags(),
    };
  }

  /**
   * Start the AIDIS MCP Server
   * Phase 6.3: Simplified using backgroundServices module
   */
  async start(): Promise<void> {
    RequestLogger.logSystemEvent('server_startup_initiated', {
      version: MANDREL_VERSION, // <semver>+<revision>, see ../version.ts
      processId: process.pid,
      nodeVersion: process.version
    });

    // FAIL-LOUD STARTUP GUARD: if this process is in a mode that actually
    // serves the remote HTTP MCP transport but a required env var is missing/empty, log
    // a NAMED FATAL error and exit non-zero BEFORE binding any port — never boot into a
    // broken fail-closed state. No-op for local/stdio/dev/test. See requireRemoteMcpEnv.ts.
    assertRemoteMcpEnvOrExit();

    try {
      // ORACLE FIX #2: Initialize database with retry and circuit breaker
      logger.info('Initializing database connection with retry logic', {
        component: 'STARTUP',
        operation: 'database_init'
      });

      if (!SKIP_DATABASE) {
        await RetryHandler.executeWithRetry(async () => {
          await this.circuitBreaker.execute(async () => {
            const startTime = Date.now();
            // Initialize legacy database connection
            await initializeDatabase();

            // Initialize optimized connection pool (TR008-4)
            await dbPool.initialize();

            logger.info('Database connection established successfully', {
              component: 'STARTUP',
              operation: 'database_connected',
              duration: Date.now() - startTime,
              metadata: {
                circuitBreakerState: this.circuitBreaker.getState()
              }
            });
          });
        });

        // LAZY SESSION LIFECYCLE (no eager create on boot/connect).
        // Previously this called ensureActiveSession('stdio') at startup, which
        // stamped an empty DB session row on every server boot even if the
        // connection never produced any content. We no longer do that: a session
        // is created lazily by the route-level ACTION gate (routes/index.ts) the
        // first time a content-producing tool (context_store / task_create /
        // decision_record) runs on a connection. Passive/read tools never create
        // a session. The detected AI model is applied when that lazy create fires.
        logger.info('📋 Session lifecycle: lazy (created on first content-producing tool, not on boot)');
      } else {
        logger.info('🧪 Skipping database initialization (AIDIS_SKIP_DATABASE=true)');
      }

      // Refuse to start when the embedding model cannot load (no silent mock fallback).
      await embeddingService.verifyStartup();

      // Phase 6.3: Start background services via backgroundServices module
      logger.info('🚀 Starting background services...');
      try {
        await backgroundServices.startAll();
        logger.info('✅ Background services initialized successfully');
      } catch (error) {
        logger.warn('⚠️  Failed to initialize background services', { metadata: { error } });
        logger.warn('   Background processing will be disabled');
      }

      // ORACLE FIX #3: Start health check server
      logger.info(`🏥 Starting health check server...`);
      try {
        await this.healthServer.start();
        logger.info(`✅ Health endpoints available`);
      } catch (error) {
        logger.warn('⚠️  Failed to start health server', { metadata: { error } });
      }

      // ORACLE FIX #4: Create transport with MCP debug logging
      if (!SKIP_STDIO_TRANSPORT) {
        logger.info('🔗 Creating MCP transport with debug logging...');
        const transport = new StdioServerTransport();

        // Enhanced connection logging
        logger.info('🤝 Connecting to MCP transport...');
        await this.server.connect(transport);

        logger.info('✅ AIDIS MCP Server is running and ready for connections!');
      } else {
        logger.info('🧪 Skipping MCP stdio transport (AIDIS_SKIP_STDIO=true)');
      }

      logger.info('🔒 Enterprise Security Features:');
      logger.info(`   🔒 Process Singleton: ACTIVE (PID: ${process.pid})`);
      logger.info(`   🔄 Retry Logic: ${MAX_RETRIES} attempts with exponential backoff`);
      logger.info(`   ⚡ Circuit Breaker: ${this.circuitBreaker.getState().toUpperCase()}`);
      logger.info(`   🐛 MCP Debug: ${getEnvVar('AIDIS_MCP_DEBUG', 'MCP_DEBUG', 'DISABLED')}`);

      logger.info('🎯 AIDIS System Status: ONLINE');

    } catch (error) {
      // Enhanced error handling for startup failures
      ErrorHandler.handleError(error as Error, {
        component: 'STARTUP',
        operation: 'server_startup_failed',
        systemState: {
          memoryUsage: process.memoryUsage(),
          uptime: process.uptime()
        }
      }, 'startup');

      // Clean up on startup failure
      await this.gracefulShutdown('STARTUP_FAILURE');
      process.exit(1);
    }
  }

  /**
   * Enhanced Graceful Shutdown
   * Phase 6.3: Simplified using backgroundServices module
   */
  async gracefulShutdown(signal: string): Promise<void> {
    RequestLogger.logSystemEvent('graceful_shutdown_initiated', {
      signal,
      uptime: process.uptime(),
      memoryUsage: process.memoryUsage()
    });

    try {
      if (!SKIP_DATABASE) {
        // Flush in-memory data before ending session
        logger.info('💾 Flushing in-memory session data...');
        try {
          await SessionTracker.flushTokensToDatabase();
          await SessionTracker.flushActivityToDatabase();
          logger.info('✅ Session data flushed to database');
        } catch (error) {
          logger.warn('⚠️  Failed to flush session data', { metadata: { error } });
        }

        // SR-1: Park ALL active sessions as 'interrupted' (resumable) on shutdown.
        //
        // REPLACES the old stdio-only endSession: shutdown used to end
        // ONLY the 'stdio' connection's session, leaving every bridge/http/remote
        // session 'active' with ended_at NULL forever (they accumulated, and a restart
        // minted duplicates because the RAM map was empty). Now we mark them ALL
        // 'interrupted' (ended_at left NULL = resumable): the next action on each
        // connection within the re-attach window resumes the SAME session, and the
        // idle reaper terminalizes any that never resume. DB-only flip — full finalize
        // happens only on explicit/manual session_end.
        logger.info('📋 Marking active sessions interrupted (resumable)...');
        try {
          const interrupted = await SessionTracker.markAllInterrupted();
          logger.info(`✅ ${interrupted} session(s) marked interrupted for clean restart`);
        } catch (error) {
          logger.warn('⚠️  Failed to mark sessions interrupted', { metadata: { error } });
        }
      }

      // Phase 6.3: Stop background services via backgroundServices module
      logger.info('🚀 Stopping background services...');
      try {
        await backgroundServices.stopAll();
        logger.info('✅ Background services stopped gracefully');
      } catch (error) {
        logger.warn('⚠️  Failed to stop background services', { metadata: { error } });
      }

      // Close any live remote MCP HTTP sessions before tearing down the server
      if (this.remoteMcp) {
        logger.info('🌐 Closing remote MCP HTTP sessions...');
        try {
          await this.remoteMcp.closeAll();
          logger.info('✅ Remote MCP HTTP sessions closed');
        } catch (error) {
          logger.warn('⚠️  Failed to close remote MCP sessions', { metadata: { error } });
        }
      }

      // Close health check server
      if (this.healthServer) {
        logger.info('🏥 Closing health check server...');
        await this.healthServer.stop();
        logger.info('✅ Health check server closed');
      }

      if (!SKIP_DATABASE) {
        // Close database connections
        logger.info('🔌 Closing database connections...');
        await closeDatabase();
        logger.info('✅ Database connections closed');
      }

      RequestLogger.logSystemEvent('graceful_shutdown_completed', {
        signal,
        shutdownDuration: process.uptime(),
        finalMemoryUsage: process.memoryUsage()
      });

    } catch (error) {
      logger.error('Error during graceful shutdown', error as Error, {
        component: 'SHUTDOWN',
        operation: 'shutdown_error',
        metadata: { signal }
      });
      throw error;
    }
  }
}
