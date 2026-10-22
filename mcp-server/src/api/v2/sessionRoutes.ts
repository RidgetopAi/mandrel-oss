/**
 * Session Analytics REST API Routes
 * Migrated from MCP to reduce AI context and enable automation
 * Part of MCP → REST migration (Phase 2D/2E, Phase 3)
 */

import express, { Router } from 'express';
import { SessionAnalyticsController } from '../controllers/sessionAnalyticsController.js';
import { logger } from '../../utils/logger.js';

/**
 * Session Analytics Router
 * Provides 13 REST endpoints for session tracking and analytics.
 * (The live count is logged computed from the router stack in setupRoutes(), so it
 *  can't drift from this comment again — see the mount log below.)
 */
export class SessionAnalyticsRouter {
  private router: Router;
  private controller: SessionAnalyticsController;

  constructor() {
    this.router = express.Router();
    this.controller = new SessionAnalyticsController();
    this.setupMiddleware();
    this.setupRoutes();
  }

  /**
   * Setup middleware for session routes
   */
  private setupMiddleware(): void {
    // JSON body parsing (already handled by parent router, but explicit here)
    this.router.use(express.json({ limit: '1mb' }));

    // Request logging middleware
    this.router.use((req, _res, next) => {
      logger.debug(`Session API: ${req.method} ${req.path}`);
      next();
    });
  }

  /**
   * Setup all session analytics routes
   */
  private setupRoutes(): void {
    // Session Lifecycle (NEW)
    // Note: These must be defined BEFORE the /:sessionId routes to avoid conflicts

    // Start new session
    this.router.post(
      '/start',
      this.controller.startSession.bind(this.controller)
    );

    // Get active session
    this.router.get(
      '/active',
      this.controller.getActiveSession.bind(this.controller)
    );

    // Phase 3: Analytics
    // Note: These must be defined BEFORE the /:sessionId routes to avoid conflicts
    // '/stats' route
    this.router.get(
      '/stats',
      this.controller.getStats.bind(this.controller)
    );

    // '/compare' route
    this.router.get(
      '/compare',
      this.controller.compareSessions.bind(this.controller)
    );

    // '/' route (list sessions)
    this.router.get(
      '/',
      this.controller.listSessions.bind(this.controller)
    );

    // Phase 2D/2E: Activity Tracking
    this.router.post(
      '/:sessionId/activities',
      this.controller.recordActivity.bind(this.controller)
    );

    this.router.get(
      '/:sessionId/activities',
      this.controller.getActivities.bind(this.controller)
    );

    // Phase 2D/2E: File Tracking
    this.router.post(
      '/:sessionId/files',
      this.controller.recordFileEdit.bind(this.controller)
    );

    this.router.get(
      '/:sessionId/files',
      this.controller.getFiles.bind(this.controller)
    );

    // File Sync (Manual Trigger)
    this.router.post(
      '/:sessionId/sync-files',
      this.controller.syncFiles.bind(this.controller)
    );

    // Phase 2D/2E: Productivity
    this.router.post(
      '/:sessionId/productivity',
      this.controller.calculateProductivity.bind(this.controller)
    );

    // End session
    this.router.post(
      '/:sessionId/end',
      this.controller.endSession.bind(this.controller)
    );

    // '/:sessionId' route (get single session detail)
    // IMPORTANT: Must be defined LAST to avoid conflicts with named routes above
    this.router.get(
      '/:sessionId',
      this.controller.getSessionDetail.bind(this.controller)
    );

    logger.info(`Session analytics routes initialized: ${this.routeCount()} endpoints`);
  }

  /**
   * Count the registered HTTP routes on this router (each express layer that carries a
   * `.route` is one endpoint). Computed so the logged count can never drift from the
   * actual set of routes defined above.
   */
  routeCount(): number {
    return (this.router.stack as Array<{ route?: unknown }>).filter((layer) => layer.route).length;
  }

  /**
   * Get the Express router instance
   */
  getRouter(): Router {
    return this.router;
  }
}

/**
 * Create and export router instance
 */
export default function createSessionRouter(): Router {
  const sessionRouter = new SessionAnalyticsRouter();
  return sessionRouter.getRouter();
}
