import { Response, NextFunction } from 'express';
import { AuthenticatedRequest } from '../types/auth';
import { AuthService } from '../services/auth';
import { logger } from '../config/logger';
import {
  resolveAndAuthorizeProjectScope,
  ScopingCaller,
} from '../services/projectScopeResolver';

/**
 * Project Context Middleware
 *
 * Resolves the project scope of every /api request from ALL the sources that can name
 * one, AUTHORIZES whatever it resolved, and attaches it. Implements Oracle Phase 1
 * (centralized project scoping), the F-04 AUTHORIZATION closure, and the
 * F-04 COMPLETION.
 *
 * ── WHAT CHANGED IN an earlier change, AND WHY ────────────────────────────────────────────────
 * an earlier change authorized THE HEADER. The check was written `if (projectIdHeader) { … }`, so
 * `?project_id=…`, `?project=…`, `?projectId=…` and `body.projectId` — all of which reach
 * the very same project scope in ~20 controllers — passed with no authorization at all.
 * The authorization now hangs off the RESOLUTION, not off one door: see
 * services/projectScopeResolver.ts for the source list, the precedence decision, and the
 * reason EVERY candidate is authorized rather than only the winner.
 *
 * ── WHY THE CHECK LIVES HERE (the choke point, not the shapes we had in mind) ─────────
 * server.ts mounts this middleware app-wide (`app.use('/api', projectContextMiddleware)`
 * and `app.use('/r', …)`), so EVERY request that could carry a project scope passes
 * through this one function — routes that exist today and routes nobody has written yet.
 * Enforcing per-route would be a list that drifts.
 *
 * ── THE ORDERING PROBLEM, AND HOW IT IS SOLVED ───────────────────────────────────────
 * This runs BEFORE the per-route `authenticateToken`, so req.user does not exist yet.
 * The caller is therefore resolved HERE from the same Authorization JWT that
 * authenticateToken will fully validate later:
 *   - verifyJWT (signature + expiry) → userId;
 *   - findUserById (is_active = true) → fresh role (NOT the JWT's possibly-stale claim).
 * This is a subset of authenticateToken's work (it additionally checks the auth_tokens
 * session row). A revoked-but-unexpired token can pass HERE and still dies at
 * authenticateToken — this middleware only decides project SCOPE, never authentication.
 *
 * ── FAIL CLOSED, EVERY BRANCH ────────────────────────────────────────────────────────
 *   - malformed / ambiguous / non-string project id → 400
 *   - a project named, but no verifiable caller     → 401
 *   - caller lacks access to ANY named project      → 403, nothing attached
 *   - the access check itself THROWS (DB down)      → 500 (never mapped onto allow/deny —
 *     C1: an instrument has three states; "could not measure" gets its own branch)
 *   - no project named anywhere                     → unscoped, pass through (the
 *     pre-existing contract; controllers treat an unscoped read as "all records" where
 *     they choose to). `req.projectScope` is STILL attached in this case, so
 *     getRequestProjectId() can distinguish "resolved, unscoped" from "never resolved".
 *
 * Access model: admin → all projects; everyone else → deny-by-default unless a
 * user_project_access row exists (migration 075; ProjectAccessService).
 */
export const projectContextMiddleware = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    // Allow CORS pre-flight to pass through
    if (req.method === 'OPTIONS') {
      return next();
    }

    // Skip project validation for auth endpoints.
    //
    // EXACT-OR-SEGMENT, not a bare prefix (Reviewer fold-in): `startsWith('/auth')` also
    // matches `/authors`, `/authorize`, `/auth-callback`. A future route under any of those
    // would silently skip scope resolution here and then hit the fail-loud throw inside
    // getRequestProjectId() — a 500 whose cause is three files away. The skip list must
    // match the routes it names and nothing else.
    const path = req.path;
    if (path === '/auth' || path.startsWith('/auth/') || path === '/health' || path === '/db-status') {
      return next();
    }

    const result = await resolveAndAuthorizeProjectScope(req, () => resolveCallerForScoping(req));

    if (!result.ok) {
      const { failure } = result;
      if (failure.status === 403 || failure.status === 500) {
        logger.warn('[project] scope REFUSED', {
          status: failure.status,
          reason: failure.error,
          sourceKey: failure.sourceKey,
          projectId: failure.projectId,
          path: req.path,
          method: req.method,
        });
      }
      res.status(failure.status).json({
        success: false,
        error: failure.error,
        message: failure.message,
      });
      return;
    }

    // Attach the validated AND authorized scope. `req.projectId` is kept as the winning
    // project for back-compat with everything already typed on it; `req.projectScope` is
    // what getRequestProjectId() reads.
    req.projectScope = result.scope;
    req.projectId = result.scope.projectId;

    next();
  } catch (error) {
    logger.error('Project context middleware error', {
      error: error instanceof Error ? error.message : error,
      stack: error instanceof Error ? error.stack : undefined,
      timestamp: new Date().toISOString(),
      path: req.path,
      method: req.method,
    });

    res.status(500).json({
      success: false,
      error: 'Project context validation failed',
      message: 'Internal server error during project validation'
    });
  }
};

/**
 * Resolve the caller (id + fresh role) from the request for SCOPING decisions only.
 * Returns null when there is no verifiable, active caller.
 * Deliberately re-reads the user row rather than trusting the JWT's role claim:
 * a role demotion must take effect on the next request, not at token expiry.
 *
 * TOKEN CHANNELS: the Authorization header, and — because EventSource cannot send
 * headers — the `?token=` query param that middleware/sseAuth.ts already accepts as a
 * first-class authentication channel on /api/events. Accepting it HERE authenticates
 * nothing extra (authenticateToken/ensureAuthForSse still govern access to the route);
 * it only lets us IDENTIFY the caller so their project scope can be authorized. Without
 * it, an SSE client naming a project would resolve to "no caller" → 401, which would
 * break the live event stream rather than secure it.
 */
export async function resolveCallerForScoping(
  req: AuthenticatedRequest
): Promise<ScopingCaller | null> {
  // Mirror middleware/auth.ts's fail-closed local-dev bypass EXACTLY (both conditions),
  // or dev sessions with no Authorization header would 401 on every scoped request.
  if (
    process.env.ALLOW_DEV_AUTH_BYPASS === 'true' &&
    process.env.NODE_ENV === 'development'
  ) {
    return { id: 'f7ad70e4-ae50-4c42-9447-7be278023db4', role: 'admin' };
  }

  const authHeader = req.headers.authorization;
  let token: string | undefined;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.slice('Bearer '.length).trim();
  } else {
    const queryToken = (req.query as Record<string, unknown> | undefined)?.token;
    if (typeof queryToken === 'string') token = queryToken.trim();
  }
  if (!token || token.split('.').length !== 3) return null;

  const payload = AuthService.verifyJWT(token);
  if (!payload) return null;

  const user = await AuthService.findUserById(payload.userId);
  if (!user) return null; // unknown or inactive → no caller

  return { id: user.id, role: (user as { role?: string | null }).role };
}
