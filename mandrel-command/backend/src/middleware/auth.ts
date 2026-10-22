import { Response, NextFunction } from 'express';
import { AuthService } from '../services/auth';
import { AuthenticatedRequest } from '../types/auth';
import { logger } from '../config/logger';
import { classifyAuthz, markAuthenticator, ClassifiedHandler } from './authz';

// NAMED function expression, not an arrow: `fn.name` is what router introspection and
// stack traces show, and the coverage guard reports it in its failure messages. It is
// wrapped by `markAuthenticator` below, which mutates the SAME object, so the exported
// `authenticateToken` still reports the name `authenticateToken`.
const authenticateTokenImpl = async function authenticateToken(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    // Allow CORS pre-flight to pass straight through
    if (req.method === 'OPTIONS') {
      return next();
    }

    // Local-dev auth bypass — fail-closed. This is OFF unless BOTH an explicit
    // opt-in flag is set AND NODE_ENV is development, so it can never trigger by
    // NODE_ENV alone (e.g. an instance accidentally started in development).
    // Default behavior in every environment: no valid token -> 401.
    if (
      process.env.ALLOW_DEV_AUTH_BYPASS === 'true' &&
      process.env.NODE_ENV === 'development'
    ) {
      logger.warn('Dev auth bypass active (ALLOW_DEV_AUTH_BYPASS=true) — request authenticated as default dev user', {
        path: req.path,
        method: req.method
      });
      req.user = {
        id: 'f7ad70e4-ae50-4c42-9447-7be278023db4',
        username: 'dev',
        email: 'dev@localhost',
        role: 'admin',
        theme: 'dark',
        is_active: true,
        created_at: new Date(),
        updated_at: new Date()
      };
      return next();
    }

    const authHeader = req.headers.authorization;

    // Validate authorization header format
    if (!authHeader) {
      res.status(401).json({
        success: false,
        error: 'Authentication required',
        message: 'Authorization header is required'
      });
      return;
    }

    if (!authHeader.startsWith('Bearer ')) {
      res.status(401).json({
        success: false,
        error: 'Invalid authorization format',
        message: 'Authorization header must use Bearer token format'
      });
      return;
    }

    const token = authHeader.split(' ')[1];

    // Validate token presence
    if (!token || token.trim().length === 0) {
      res.status(401).json({
        success: false,
        error: 'Access denied',
        message: 'No token provided'
      });
      return;
    }

    // Validate token format (basic check for JWT structure)
    if (token.split('.').length !== 3) {
      res.status(401).json({
        success: false,
        error: 'Invalid token format',
        message: 'Token must be a valid JWT'
      });
      return;
    }

    // Verify JWT token
    const payload = AuthService.verifyJWT(token);
    if (!payload) {
      res.status(401).json({
        success: false,
        error: 'Invalid token',
        message: 'Token verification failed'
      });
      return;
    }

    // Validate session is still active
    const isValidSession = await AuthService.validateSession(payload.tokenId);
    if (!isValidSession) {
      res.status(401).json({
        success: false,
        error: 'Session expired',
        message: 'Please log in again'
      });
      return;
    }

    // Get user from database
    const user = await AuthService.findUserById(payload.userId);
    if (!user) {
      res.status(401).json({
        success: false,
        error: 'User not found',
        message: 'User account no longer exists'
      });
      return;
    }

    // Check if user account is still active
    if (!user.is_active) {
      res.status(403).json({
        success: false,
        error: 'Account disabled',
        message: 'Your account has been deactivated'
      });
      return;
    }

    // Attach user and token info to request
    req.user = user;
    req.tokenId = payload.tokenId;

    next();
  } catch (error) {
    logger.error('Authentication error', {
      error: error instanceof Error ? error.message : error,
      stack: error instanceof Error ? error.stack : undefined,
      timestamp: new Date().toISOString(),
      path: req.path,
      method: req.method,
      ip: req.ip
    });

    res.status(401).json({
      success: false,
      error: 'Authentication failed',
      message: 'Invalid or expired token'
    });
  }
};

/**
 * THE user authenticator. Marked so the whole-route authz
 * coverage guard can see, without matching on a name, that every route beneath a
 * `router.use(authenticateToken)` carries a credential requirement.
 */
export const authenticateToken = markAuthenticator(
  authenticateTokenImpl,
  'validates a user JWT from the Authorization header; responds 401 when absent or invalid'
);

const requireRole = (requiredRoles: string | string[]) => {
  const roles = Array.isArray(requiredRoles) ? requiredRoles : [requiredRoles];

  // NAMED, not an anonymous arrow. Express records the handler function on the router
  // layer, so this name is what appears in stack traces and in any router introspection.
  // While it was anonymous, `requireAdmin` was literally invisible to anything reading the
  // real router — see routes/index.ts introspection in mutatingRouteAuthzCoverage.test.ts.
  return function requireRoleMiddleware(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ): void {
    if (!req.user) {
      res.status(401).json({
        success: false,
        error: 'Authentication required',
        message: 'Please authenticate first to access this resource'
      });
      return;
    }

    // Validate user role
    if (!req.user.role) {
      res.status(403).json({
        success: false,
        error: 'Access denied',
        message: 'User role not assigned'
      });
      return;
    }

    if (!roles.includes(req.user.role)) {
      logger.warn('Role access denied', {
        userId: req.user.id,
        userRole: req.user.role,
        requiredRoles: roles,
        path: req.path,
        method: req.method,
        timestamp: new Date().toISOString()
      });

      res.status(403).json({
        success: false,
        error: 'Insufficient permissions',
        message: `Required role: ${roles.join(' or ')}. Your role: ${req.user.role}`
      });
      return;
    }

    next();
  };
};

/**
 * Enforcing guard: refuses anything whose `req.user.role` is not `admin` with 403.
 *
 * Carries an authz CLASSIFICATION so the coverage guard over the real
 * router can SEE that a route is gated. Read middleware/authz.ts for why the channel
 * exists — short version: `requireAdmin` existed for the whole life of this repo and was
 * used on one route, because nowhere made its absence visible.
 */
export const requireAdmin: ClassifiedHandler = classifyAuthz(requireRole('admin'), {
  kind: 'admin',
  reason: 'privileged or irreversible operation — admin role required',
});
