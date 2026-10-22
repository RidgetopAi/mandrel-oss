import { Response, NextFunction } from 'express';
import { randomBytes } from 'crypto';
import { AuthService } from '../services/auth';
import { logger } from '../config/logger';
import { AuthenticatedRequest } from '../types/auth';
import { ProjectAccessService } from '../services/projectAccess';
import { markAuthenticator } from './authz';

/**
 * ─── SSE CONNECT TICKETS ────────────────────────────────────────────────
 *
 * ## Why this exists
 *
 * `EventSource` cannot set an Authorization header, so this middleware used to accept the
 * SESSION JWT as `?token=` in the query string. A credential in a URL is written wherever
 * URLs are written: nginx/traefik access logs (333 and 469 real occurrences were found on
 * 2026-07-30), proxy and CDN logs, browser history, and the `Referer` header of any
 * request the page makes afterwards. Redacting the logs was a mitigation; the credential
 * was still in the URL, and that token lives for MANDREL_JWT_EXPIRES_IN (24h by default).
 *
 * A ticket is the fix rather than an obscuring of it: what travels in the URL is no longer
 * a credential that can be replayed. It is a random 256-bit opaque handle that
 *   - is minted only by an AUTHENTICATED request that carried its JWT in a HEADER,
 *   - never leaves the server except as that one opaque string,
 *   - is SINGLE-USE — redeeming deletes it,
 *   - expires in seconds, not hours.
 * A ticket recovered from a log is therefore worthless: it has already been spent, or it
 * is past its TTL, and in either case it grants nothing.
 *
 * ## The store is per-process and in-memory ON PURPOSE
 *
 * The window between mint and redeem is one page-load's worth of milliseconds and both
 * halves are the same browser talking to the same backend, which today is a single Node
 * process per instance. Persisting a credential that is designed to be worthless in 30
 * seconds would add a durable copy of it — the opposite of the point. The consequence to
 * know: if the backend restarts between mint and redeem, the EventSource gets a 401 and
 * the client mints a fresh ticket on its reconnect. That is the designed behaviour, not a
 * defect.
 */
export const SSE_TICKET_CONFIG = {
  /** How long a minted ticket stays redeemable. Seconds, deliberately. */
  ttlMs: 30_000,
  /** Entropy of the ticket itself. 32 bytes = 256 bits, hex-encoded. */
  byteLength: 32,
  /**
   * Hard ceiling on outstanding tickets, so a caller that mints and never connects cannot
   * grow this map without bound. At the ceiling the oldest entries are dropped first.
   */
  maxOutstanding: 10_000,
} as const;

interface SseTicketRecord {
  userId: string;
  tokenId: string;
  expiresAt: number;
}

/** Insertion-ordered (Map guarantees it), which is what makes the eviction below oldest-first. */
const sseTickets = new Map<string, SseTicketRecord>();

/**
 * Drop everything already expired. Called on mint rather than on a timer: a `setInterval`
 * here would hold the event loop open for the life of the process and in every test that
 * imports this module (see the `_getActiveHandles` note in MEMORY — an open handle is a
 * silent hang), and mint is the only path that can grow the map.
 */
function sweepExpiredTickets(now: number): void {
  for (const [ticket, record] of sseTickets) {
    if (record.expiresAt <= now) {
      sseTickets.delete(ticket);
    }
  }
}

/**
 * Mint a single-use, short-lived SSE connect ticket for an ALREADY-AUTHENTICATED caller.
 * `tokenId` is the caller's session id: the redeeming connection re-checks that the
 * session is still valid, so revoking a session still kills a stream that has a ticket in
 * flight.
 */
export function issueSseTicket(userId: string, tokenId: string): { ticket: string; expiresInMs: number } {
  const now = Date.now();
  sweepExpiredTickets(now);

  while (sseTickets.size >= SSE_TICKET_CONFIG.maxOutstanding) {
    const oldest = sseTickets.keys().next();
    if (oldest.done) break;
    sseTickets.delete(oldest.value);
  }

  const ticket = randomBytes(SSE_TICKET_CONFIG.byteLength).toString('hex');
  sseTickets.set(ticket, { userId, tokenId, expiresAt: now + SSE_TICKET_CONFIG.ttlMs });
  return { ticket, expiresInMs: SSE_TICKET_CONFIG.ttlMs };
}

/**
 * Redeem a ticket. Returns the minting caller's identity, or null if the ticket is
 * unknown, already spent, or expired — the three cases are deliberately indistinguishable
 * to the caller.
 *
 * SINGLE-USE IS ENFORCED HERE, and it is enforced by DELETING BEFORE the expiry check, so
 * that presenting an expired ticket also burns it.
 */
export function redeemSseTicket(ticket: string): { userId: string; tokenId: string } | null {
  const record = sseTickets.get(ticket);
  if (!record) return null;
  sseTickets.delete(ticket);
  if (record.expiresAt <= Date.now()) return null;
  return { userId: record.userId, tokenId: record.tokenId };
}

/** Test-only: outstanding ticket count. Exported so a guard can assert single-use consumed one. */
export function _sseTicketCountForTest(): number {
  return sseTickets.size;
}

/** Test-only: drop every outstanding ticket so suites do not leak state into each other. */
export function _resetSseTicketsForTest(): void {
  sseTickets.clear();
}

/**
 * SSE Authentication Middleware
 *
 * Two accepted credentials, and `?token=` is NOT one of them any more:
 *   1. `Authorization: Bearer <session JWT>` — for ordinary fetch callers
 *      (`/api/events/stats`, `/api/events/clients`), which CAN set headers.
 *   2. `?ticket=<opaque>` — for `EventSource`, which cannot. Minted by
 *      `POST /api/events/ticket`, which itself requires the JWT in a header.
 *
 * Sets req.user on successful authentication.
 */
const ensureAuthForSseImpl = async function ensureAuthForSse(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    // Development mode bypass - use default dev user (matches real user for settings persistence)
    if (process.env.NODE_ENV === 'development') {
      logger.debug('SSE Auth: Development mode bypass');
      req.user = {
        id: 'f7ad70e4-ae50-4c42-9447-7be278023db4',
        username: 'dev',
        email: 'dev@localhost',
        role: 'admin',
        is_active: true,
        created_at: new Date(),
        updated_at: new Date()
      };
      return next();
    }

    const authHeader = req.headers.authorization;
    const token = authHeader?.startsWith('Bearer ')
      ? authHeader.slice(7) // Remove 'Bearer ' prefix
      : undefined;

    // A session JWT presented in the query string is REFUSED, loudly and without a
    // fallback. This is the whole point of the task: the old code read this exact
    // parameter as a credential. Rejecting it (rather than simply not reading it) means a
    // client that was never migrated fails visibly instead of silently degrading, and it
    // makes the removal something a test can PROVE rather than infer from an absence.
    if (!token && typeof req.query.token === 'string' && req.query.token.length > 0) { // rejected-credential-in-query-ok: this is the REFUSAL, not a read of a credential
      logger.warn('SSE Auth: rejected a credential supplied in the query string', {
        ip: req.ip,
        userAgent: req.get('user-agent')
      });
      res
        .status(401)
        .send(
          'A session token may not be supplied in the query string. Mint a connect ticket with POST /api/events/ticket and connect with ?ticket='
        );
      return;
    }

    // The EventSource path: exchange a single-use ticket for the identity that minted it.
    if (!token) {
      const ticket = typeof req.query.ticket === 'string' ? req.query.ticket : undefined;
      if (!ticket) {
        logger.warn('SSE Auth: No credential provided', {
          ip: req.ip,
          userAgent: req.get('user-agent')
        });
        res
          .status(401)
          .send('Authentication required. Provide an Authorization header, or a ?ticket= minted by POST /api/events/ticket');
        return;
      }

      const redeemed = redeemSseTicket(ticket);
      if (!redeemed) {
        logger.warn('SSE Auth: ticket unknown, expired, or already used', { ip: req.ip });
        res.status(401).send('Invalid or expired connect ticket');
        return;
      }

      // Same downstream checks as the header path — a ticket is a pointer to a session,
      // never a bypass of it. A session revoked between mint and connect is refused here.
      const ticketSessionValid = await AuthService.validateSession(redeemed.tokenId);
      if (!ticketSessionValid) {
        logger.warn('SSE Auth: ticket names an invalid session', { userId: redeemed.userId });
        res.status(401).send('Session expired. Please log in again');
        return;
      }

      const ticketUser = await AuthService.findUserById(redeemed.userId);
      if (!ticketUser) {
        logger.warn('SSE Auth: ticket names a user that no longer exists', { userId: redeemed.userId });
        res.status(401).send('User not found');
        return;
      }

      if (!ticketUser.is_active) {
        logger.warn('SSE Auth: Inactive user attempted connection', {
          userId: ticketUser.id,
          username: ticketUser.username
        });
        res.status(403).send('Account is inactive');
        return;
      }

      req.user = ticketUser;
      logger.debug('SSE Auth: authenticated by connect ticket', { userId: ticketUser.id });
      next();
      return;
    }

    // Validate token format (basic check for JWT structure)
    if (token.split('.').length !== 3) {
      logger.warn('SSE Auth: Invalid token format', {
        ip: req.ip,
        tokenPrefix: token.substring(0, 20) + '...'
      });
      res.status(401).send('Invalid token format. Token must be a valid JWT');
      return;
    }

    // Verify JWT token
    const payload = AuthService.verifyJWT(token);
    if (!payload) {
      logger.warn('SSE Auth: Token verification failed', {
        ip: req.ip
      });
      res.status(401).send('Invalid token. Token verification failed');
      return;
    }

    // Validate session is still active
    const isValidSession = await AuthService.validateSession(payload.tokenId);
    if (!isValidSession) {
      logger.warn('SSE Auth: Session expired or invalid', {
        userId: payload.userId,
        tokenId: payload.tokenId
      });
      res.status(401).send('Session expired. Please log in again');
      return;
    }

    // Get user from database
    const user = await AuthService.findUserById(payload.userId);
    if (!user) {
      logger.warn('SSE Auth: User not found', {
        userId: payload.userId
      });
      res.status(401).send('User not found');
      return;
    }

    // Check if user is active
    if (!user.is_active) {
      logger.warn('SSE Auth: Inactive user attempted connection', {
        userId: user.id,
        username: user.username
      });
      res.status(403).send('Account is inactive');
      return;
    }

    // Attach user to request
    req.user = user;

    logger.debug('SSE Auth: Successful authentication', {
      userId: user.id,
      username: user.username
    });

    next();

  } catch (error) {
    logger.error('SSE Auth: Unexpected error', {
      error: error instanceof Error ? error.message : 'Unknown error',
      stack: error instanceof Error ? error.stack : undefined
    });
    res.status(500).send('Authentication error');
  }
};

/**
 * THE SSE authenticator. Marked for the same reason `authenticateToken`
 * is: `/api/events`, `/api/events/stats` and `/api/events/clients` are guarded by THIS,
 * not by `authenticateToken`, and a name-keyed census reported all three as OPEN. The
 * mark is what makes the census read the served surface instead of a naming convention.
 */
export const ensureAuthForSse = markAuthenticator(
  ensureAuthForSseImpl,
  'validates a user JWT from the Authorization header, or a single-use short-lived ?ticket= minted by POST /api/events/ticket (EventSource cannot set headers); a JWT in the query string is refused; responds 401 when absent or malformed'
);

/**
 * SSE project scope.
 *
 * ── WHAT THIS USED TO BE ─────────────────────────────────────────────────────────────
 * The ORIGINAL pre-F-04 pattern, verbatim and still live: read `req.query.projectId`,
 * check the UUID SHAPE, attach it, no authorization. Any authenticated user could
 * subscribe to any project's event stream by naming it.
 *
 * ── WHAT IT IS NOW ───────────────────────────────────────────────────────────────────
 * Two things, neither of which is a second authorization implementation:
 *
 * 1. It READS the scope that projectContextMiddleware already resolved and authorized.
 *    `/api/events` is mounted under `/api`, and `query.projectId` is one of
 *    PROJECT_SCOPE_SOURCES, so a client that names a project it cannot access is already
 *    403'd upstream. This middleware only re-attaches the result in the `req.project`
 *    shape services/sse.ts reads. It FAILS CLOSED if the scope is missing (the mount
 *    order changed, or someone wired this router outside /api) rather than falling back
 *    to the old trust-the-query-param behaviour.
 *
 * 2. It computes the caller's AUTHORIZED PROJECT SET, which services/sse.ts needs and
 *    could not compute itself (handleSubscribe is synchronous). See the decision recorded
 *    on services/sse.ts:broadcastDbEvent — a client that names NO project used to receive
 *    the CROSS-PROJECT stream; it now receives only its own authorized projects.
 *    admin → null, meaning "all projects" (the pre-existing admin semantics, unchanged).
 *
 * ── KNOWN, ACCEPTED TOCTOU: THIS SET IS A CONNECT-TIME SNAPSHOT ──────────────────────
 * `sseAuthorizedProjectIds` is computed ONCE, when the EventSource connects, and then
 * lives for the life of that connection. So if a grant is REVOKED mid-stream, that client
 * keeps receiving the revoked project's events until it disconnects — and an SSE
 * connection is deliberately long-lived (15s heartbeat, 5s client retry, no server-side
 * max age). Every other door in this system re-reads authorization per request; this one
 * cannot, because there is no per-event request to hang it off.
 *
 * WHY IT IS ACCEPTED RATHER THAN FIXED: the event payload is metadata —
 * entity, action, id, projectId, timestamp — never content, so the exposure is "which
 * records changed", not the records. Re-authorizing per broadcast would put a DB query on
 * every event for every connected client. The honest fixes are a bounded connection TTL
 * that forces a reconnect (and therefore a re-check), or invalidating live connections
 * from ProjectAccessService.revokeAccess. Both are real work and neither is this task.
 *
 * THIS PARAGRAPH IS THE POINT: an undocumented, defensible tradeoff becomes an
 * undocumented BUG the moment its author stops being the person reading this file. If you
 * are here because a revoked user kept seeing events — that is this, it is known, and it
 * is not a regression.
 */
export const extractSseProjectContext = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const scope = req.projectScope;
    if (!scope) {
      // Fail closed. The old code's answer here was "trust req.query.projectId", which is
      // precisely the defect. If this fires, the mount order is wrong — that is a bug to
      // fix, not a case to degrade gracefully through.
      logger.error('SSE Project: no resolved project scope on the request', {
        path: req.path,
        userId: req.user?.id,
      });
      res.status(500).send('Project scope was not resolved for this request');
      return;
    }

    if (scope.projectId) {
      (req as unknown as { project?: { id: string } }).project = { id: scope.projectId };
    }

    const user = req.user;
    if (!user) {
      res.status(401).send('Authentication required');
      return;
    }

    // The authorized-project SET for the no-project-named case. Deny-by-default for
    // everyone who is not an admin; a DB failure here is a 500, never "and therefore
    // everything" (C1).
    if (user.role === 'admin') {
      (req as unknown as SseScopedRequest).sseAuthorizedProjectIds = null;
    } else {
      try {
        const ids = await ProjectAccessService.listAccessibleProjectIds(user.id);
        (req as unknown as SseScopedRequest).sseAuthorizedProjectIds = new Set(ids);
      } catch (error) {
        logger.error('SSE Project: authorized-project lookup failed', {
          userId: user.id,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
        res.status(500).send('Project authorization check failed');
        return;
      }
    }

    logger.debug('SSE Project: scope resolved', {
      projectId: scope.projectId,
      userId: user.id,
    });

    next();

  } catch (error) {
    logger.error('SSE Project: Unexpected error', {
      error: error instanceof Error ? error.message : 'Unknown error'
    });
    res.status(500).send('Project context error');
  }
};

/**
 * The set of project ids this SSE connection may receive events for.
 * `null` = all projects (admin). `undefined` = not computed → services/sse.ts refuses
 * the subscription rather than guessing.
 */
export interface SseScopedRequest {
  sseAuthorizedProjectIds?: Set<string> | null;
}
