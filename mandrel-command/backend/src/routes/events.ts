import { Router, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { sseService } from '../services/sse';
import {
  ensureAuthForSse,
  extractSseProjectContext,
  issueSseTicket,
  SSE_TICKET_CONFIG,
} from '../middleware/sseAuth';
import { authenticateToken } from '../middleware/auth';
import { declareAnyAuthenticatedMayWrite } from '../middleware/authz';
import { AuthenticatedRequest } from '../types/auth';
import { logger } from '../config/logger';

const router = Router();

/**
 * Ticket minting is cheap but it is a CREDENTIAL FACTORY, so it is bounded. The limit is
 * generous relative to real use — a browser tab mints one ticket per SSE connect, and
 * reconnects are backed off client-side — and tight enough that a hijacked session cannot
 * farm tickets in bulk.
 */
export const SSE_TICKET_MINT_RATE_LIMIT = {
  windowMs: 60_000,
  max: 60,
} as const;

const ticketMintLimiter = rateLimit({
  windowMs: SSE_TICKET_MINT_RATE_LIMIT.windowMs,
  max: SSE_TICKET_MINT_RATE_LIMIT.max,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    logger.warn('SSE ticket mint rate limit reached', { ip: req.ip, path: req.path });
    res.status(429).json({
      success: false,
      error: 'Too Many Requests',
      message: 'Too many SSE connect tickets requested. Please try again shortly.',
    });
  },
});

/**
 * POST /api/events/ticket
 *
 * Exchange a session JWT — carried in the Authorization HEADER, where it belongs — for a
 * single-use, seconds-lived opaque ticket that `EventSource` can put in its URL. This is
 * the whole reason the SSE stream no longer accepts `?token=`: the thing that ends up in
 * access logs, browser history and Referer headers is now a spent handle rather than a
 * 24-hour credential.
 *
 * Response: { success, data: { ticket, expiresInMs } }
 */
router.post(
  '/events/ticket',
  ticketMintLimiter,
  authenticateToken,
  declareAnyAuthenticatedMayWrite('any authenticated user may mint a connect ticket for their OWN session'),
  (req: AuthenticatedRequest, res: Response) => {
    const userId = req.user?.id;
    const tokenId = req.tokenId;

    // Fail closed. `authenticateToken` sets both; if either is missing the middleware did
    // not run, and minting a ticket for an unknown session is exactly the bypass this
    // endpoint exists to prevent.
    if (!userId || !tokenId) {
      logger.error('SSE ticket mint: authenticated request carried no user/session id');
      res.status(401).json({
        success: false,
        error: 'Unauthorized',
        message: 'User not authenticated',
      });
      return;
    }

    const { ticket, expiresInMs } = issueSseTicket(userId, tokenId);
    res.json({
      success: true,
      data: { ticket, expiresInMs, ttlMs: SSE_TICKET_CONFIG.ttlMs },
    });
  }
);

/**
 * SSE endpoint for real-time database updates
 * 
 * GET /api/events
 * 
 * Query parameters:
 *   - ticket: single-use connect ticket from POST /api/events/ticket (required unless an
 *             Authorization header is supplied). A session JWT in `?token=` is REFUSED.
 *   - projectId: Filter events by project UUID (optional)
 *   - entities: Comma-separated entity types to subscribe to (optional)
 *               Valid values: contexts, tasks, decisions, projects, sessions
 *
 * Example:
 *   GET /api/events?ticket=xxx&projectId=123&entities=tasks,contexts
 * 
 * Response format: text/event-stream
 * 
 * Events:
 *   - system: Connection confirmation and server messages
 *   - contexts: Context entity changes
 *   - tasks: Task entity changes
 *   - decisions: Technical decision entity changes
 *   - projects: Project entity changes
 *   - sessions: Session entity changes
 * 
 * Event data format:
 * {
 *   entity: string,
 *   action: 'insert' | 'update' | 'delete',
 *   id: string,
 *   projectId?: string,
 *   at: string (ISO 8601 timestamp)
 * }
 */
router.get(
  '/events',
  ensureAuthForSse,
  extractSseProjectContext,
  sseService.handleSubscribe
);

/**
 * SSE stats endpoint (for monitoring and debugging)
 * 
 * GET /api/events/stats
 * 
 * Requires authentication via Authorization header (these are ordinary fetch callers, so
 * no ticket is involved)
 * 
 * Response:
 * {
 *   totalConnections: number,
 *   connectionsByUser: { [userId: string]: number },
 *   nextEventId: number,
 *   uptimeSeconds: number
 * }
 */
router.get('/events/stats', ensureAuthForSse, (_req, res) => {
  const stats = sseService.getStats();
  res.json({
    success: true,
    data: stats
  });
});

/**
 * SSE clients endpoint (for debugging - shows detailed connection info)
 * 
 * GET /api/events/clients
 * 
 * Requires authentication
 * 
 * Response:
 * {
 *   success: true,
 *   data: Array<{
 *     userId: string,
 *     projectId?: string,
 *     entities?: string[],
 *     connectedAt: string,
 *     connectionDurationMs: number
 *   }>
 * }
 */
router.get('/events/clients', ensureAuthForSse, (req: AuthenticatedRequest, res) => {
  // Only allow admin users to see all clients
  if (req.user?.role !== 'admin') {
    res.status(403).json({
      success: false,
      error: 'Forbidden',
      message: 'Only admin users can view client connections'
    });
    return;
  }

  const clients = sseService.getClients();
  res.json({
    success: true,
    data: clients
  });
});

export default router;
