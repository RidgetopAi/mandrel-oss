import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';

import config from './config/environment';
import { logger, morganLogStream } from './config/logger';
import { initializeDatabase } from './database/connection';
// import { backendPool } from './database/poolManager'; // Temporarily commented out
import { errorHandler, notFoundHandler } from './middleware/errorHandler';
import { correlationMiddleware } from './middleware/correlationId';
import { requestLoggingMiddleware } from './middleware/requestLogger';
import { projectContextMiddleware } from './middleware/project';
import { requestMonitoringMiddleware } from './middleware/requestMonitoring';
import { dbEvents } from './services/dbEvents';
import { sseService } from './services/sse';
import apiRoutes from './routes';
import resolveRoutes from './routes/resolve';
import resolveJsonRoutes from './routes/resolveJson';
import { ensureFeatureFlags } from './utils/featureFlags';
import { declareIntentionallyUnauthenticated } from './middleware/authz';
import { portManager } from './utils/portManager';

/**
 * AIDIS Command Backend Server
 * REST API server for AIDIS database administration
 */

const app = express();

// Trust the reverse proxy chain so req.ip / express-rate-limit use the real
// client IP from X-Forwarded-For (set by nginx) instead of throwing
// ERR_ERL_UNEXPECTED_X_FORWARDED_FOR or bucketing all clients under the proxy IP.
// SECURITY-sensitive: value is config-driven (TRUST_PROXY), default 'loopback'.
// Never `true` — that would let a client forge X-Forwarded-For to bypass limits.
app.set('trust proxy', config.trustProxy);

const featureFlagsPromise = ensureFeatureFlags();

/**
 * PUBLIC BY NECESSITY (an earlier task census, 2026-08-25). Two measured reasons, not a
 * judgement call:
 *   • an external uptime probe checks exactly this path (`EDGE_PROBE_PATH` default) on
 *     every tenant and expects 200 with no credential.
 *   • the SPA reads it BEFORE login — a past outage showed
 *     where `/api/feature-flags -> 502` meant the operator could not log in at all.
 * It serves flag names and a version string, no infrastructure detail. Declared, not
 * assumed: the classification is what keeps it out of the coverage guard's failure list.
 */
app.get('/api/feature-flags', declareIntentionallyUnauthenticated(
  'an external uptime probe checks this on every tenant with no credential, and the SPA reads it pre-login; serves flag names + version only'
), async (_req, res) => {
  const featureFlags = await featureFlagsPromise;
  const metadata = featureFlags.getMetadata();
  res.json({
    success: true,
    version: metadata.version,
    updatedAt: metadata.updatedAt,
    flags: featureFlags.getAllFlags()
  });
});

// Security middleware
app.use(helmet());

// CORS middleware
app.use(cors(config.cors));

// Body parsing middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Correlation ID middleware (must be first)
app.use(correlationMiddleware);

// Morgan HTTP logging (integrated with Winston)
app.use(morgan(config.nodeEnv === 'development' ? 'dev' : 'combined', {
  stream: morganLogStream
}));

// Request/response logging middleware
app.use(requestLoggingMiddleware);

// Request monitoring middleware (applied to all API routes)
app.use('/api', requestMonitoringMiddleware);

// Oracle Phase 1: Project context middleware (applied to all API routes)
app.use('/api', projectContextMiddleware);

// Navigation JSON resolve (Feature C interlinking): GET /api/resolve/:id returns
// the resolved record as JSON (200/404/409/400) so the SPA can read it and do a
// client-side navigation (a 302 can't be cleanly read by fetch). Mounted BEFORE the
// general /api router so it is matched explicitly; the /api middlewares above still
// apply. Reuses the SAME resolveNavId as the /r/:id 302 route (single source).
app.use('/api/resolve', resolveJsonRoutes);

// API routes
app.use('/api', apiRoutes);

// Navigation SPINE short-link, also mounted top-level so the literal /r/:id works
// when the backend is hit directly (dev, or after a vhost rule / SPA shim routes
// the pretty /r/<id> short link). The canonical browser-reachable path today is
// /api/r/:id (the prod vhost routes /api to the backend); this top-level mount is
// the same router, so there is no second handler to drift.
// The project-scope resolver must cover this mount too: resolve.ts reads
// a `project_id` query param, and this router is mounted OUTSIDE /api, so the app-wide
// /api mount above does not reach it. Without this line getRequestProjectId() throws here.
app.use('/r', projectContextMiddleware);
app.use('/r', resolveRoutes);

// Root endpoint. REDUCED: it served `config.app.version` to anyone —
// a build number is what an attacker matches against a CVE list. Nothing in-tree reads
// this route's body; the frontend container healthcheck hits the FRONTEND on :3000.
app.get('/', declareIntentionallyUnauthenticated(
  'unauthenticated banner for anyone who hits the backend root; reduced to a name and a timestamp, no version or build detail'
), (_req, res) => {
  res.json({
    success: true,
    data: {
      message: 'Mandrel Command Backend API',
      timestamp: new Date().toISOString()
    }
  });
});

// 404 handler (must be before error handler)
app.use(notFoundHandler);

// Global error handler (must be last)
app.use(errorHandler);

/**
 * Start server
 */
async function startServer(): Promise<void> {
  try {
    // Initialize logging
    logger.info('Starting AIDIS Command Backend...', {
      version: config.app.version,
      environment: config.nodeEnv,
      logLevel: config.logging.level,
      dbLogLevel: config.logging.dbLogLevel
    });

    // Initialize database connection
    await initializeDatabase();

    // Initialize optimized connection pool (TR008-4)
    // await backendPool.initialize(); // Temporarily commented out
    logger.info('Database initialized successfully');

    // Start DB Events Listener for SSE
    await dbEvents.start();
    logger.info('DB Events Listener started for SSE');

    const featureFlags = await featureFlagsPromise;
    app.locals.featureFlags = featureFlags;

    // Get service name based on environment for port management
    const serviceName = config.nodeEnv === 'production' ? 'aidis-command-prod' : 'aidis-command-dev';

    // Get dynamic port assignment
    const assignedPort = await portManager.assignPort(serviceName, config.port);

    // Start HTTP server with dynamic port assignment
    const server = app.listen(assignedPort, async () => {
      const actualPort = (server.address() as any)?.port || assignedPort;

      // Register the service with its actual port
      await portManager.registerService(serviceName, actualPort, '/api/health');
      await portManager.logPortConfiguration(serviceName, actualPort);

      logger.info('AIDIS Command Backend started successfully', {
        port: actualPort,
        assignedPort,
        serviceName,
        environment: config.nodeEnv,
        database: `${config.database.database}@${config.database.host}:${config.database.port}`,
        endpoints: [
          'GET /api/health - Server health',
          'GET /api/db-status - Database status',
          'GET /api/version - Version info'
        ]
      });

      logger.info('🚀 AIDIS Command Backend started');
      logger.info(`📍 Service: ${serviceName}`);
      logger.info(`📍 Server running on http://localhost:${actualPort}`);
      logger.info(`🌍 Environment: ${config.nodeEnv}`);
      logger.info(`📊 Logging: ${config.logging.level} (DB: ${config.logging.dbLogLevel})`);
    });

    // Graceful shutdown handling
    const shutdown = async (signal: string) => {
      logger.info(`Received ${signal}, shutting down gracefully...`, {
        signal,
        timestamp: new Date().toISOString()
      });

      // Stop SSE service and disconnect all clients
      sseService.disconnectAll();
      logger.info('SSE service stopped');

      // Stop DB Events Listener
      await dbEvents.stop();
      logger.info('DB Events Listener stopped');

      // Unregister from port registry
      await portManager.unregisterService(serviceName);

      server.close(() => {
        logger.info('HTTP server closed successfully');
        process.exit(0);
      });
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));

  } catch (error) {
    logger.error('Failed to start server', {
      error: error instanceof Error ? error.message : 'Unknown error',
      stack: error instanceof Error ? error.stack : undefined
    });
    logger.error('❌ Failed to start server', { error });
    process.exit(1);
  }
}

// Start the server
if (require.main === module) {
  startServer();
}

export default app;