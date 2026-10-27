/**
 * /api/api-tokens — Settings → API tokens.
 *
 * The ONLY way a hosted customer gets a loop token (MANDREL_TOKEN): mint one here from
 * their own logged-in dashboard. Never email.
 *
 *   GET    /api/api-tokens        list the caller's tokens (never the token, never its hash)
 *   POST   /api/api-tokens        create; the plaintext is in THIS response and nowhere else
 *   DELETE /api/api-tokens/:id    revoke one of the caller's tokens
 *
 * The whole family is behind `authenticateToken` (one `router.use`, so no route here can be
 * born public), every service call is scoped by `req.user.id`, and create is rate-limited
 * per user and capped per user (config/apiTokens.ts).
 *
 * ADMIN-ONLY (Reviewer F1, round 1; the coordinator's fail-closed call). An mdl_ token opens /mcp and
 * /mcp/tools/* with FULL read/write access to every project — the model routes/mcp.ts
 * deliberately took away from non-admin browser users, who are confined to
 * a read-only allow-list plus their project grants. So only an admin may mint, list or
 * revoke, and the mcp-server verifier ALSO requires the owner to still be an admin at
 * check time (a demoted admin's tokens stop on the next request). Grant-scoped tokens for
 * non-admins are a possible future option — the operator decides; nothing here implements them.
 *
 * The create response carries `Cache-Control: no-store` so no intermediary or browser cache
 * keeps the plaintext. requestLogger never logs a 2xx body; nothing here logs the token.
 */

import { Router, Response, NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import { authenticateToken, requireAdmin } from '../middleware/auth';
import { AuthenticatedRequest } from '../types/auth';
import { API_TOKEN_CONFIG } from '../config/apiTokens';
import { ApiTokenService, validateExpiresInDays, validateTokenName } from '../services/apiTokens';
import { isValidUuid } from '../utils/uuid';
import { logger } from '../config/logger';

const router = Router();

router.use(authenticateToken);
// requireAdmin sits on EACH route, not in a router.use: the authz coverage guard
// (mutatingRouteAuthzCoverage.test.ts) deliberately refuses an inherited classification.

/**
 * Keyed by the AUTHENTICATED USER, not the IP: minting is the act being spent, and it is
 * the user's own cap/budget. (Contrast PROFILE_UPDATE_RATE_LIMIT, keyed by IP because the
 * attacker there chooses which account to act as.) Runs after authenticateToken, so
 * req.user is always set here.
 */
const createLimiter = rateLimit({
  windowMs: API_TOKEN_CONFIG.createRateLimit.windowMs,
  max: API_TOKEN_CONFIG.createRateLimit.max,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `api-token-create:${(req as AuthenticatedRequest).user?.id ?? 'unknown'}`,
  handler: (req, res) => {
    logger.warn('API token create rate limit reached', { userId: (req as AuthenticatedRequest).user?.id });
    res.status(429).json({
      success: false,
      error: 'Too Many Requests',
      message: 'Too many tokens created. Please try again later.',
    });
  },
});

const userIdOf = (req: AuthenticatedRequest, res: Response): string | null => {
  const id = req.user?.id;
  if (!id) {
    res.status(401).json({ success: false, error: 'Unauthorized', message: 'User not authenticated' });
    return null;
  }
  return id;
};

/**
 * @swagger
 * /api-tokens:
 *   get:
 *     summary: List the current user's API tokens
 *     description: >
 *       Name, display prefix, created, last used and expiry for each un-revoked token the
 *       CALLER owns. Never returns a token or its hash.
 *     tags: [API Tokens]
 *     responses:
 *       200:
 *         description: The caller's tokens, newest first
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: object
 *                   properties:
 *                     tokens:
 *                       type: array
 *                       items:
 *                         $ref: '#/components/schemas/ApiToken'
 *       401:
 *         description: Not logged in
 *       403:
 *         description: Not an admin — API tokens carry full MCP access, so only admins may hold them
 */
router.get('/', requireAdmin, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const userId = userIdOf(req, res);
    if (!userId) return;
    const tokens = await ApiTokenService.list(userId);
    res.json({ success: true, data: { tokens } });
  } catch (err) {
    next(err);
  }
});

/**
 * @swagger
 * /api-tokens:
 *   post:
 *     summary: Create an API token for the current user
 *     description: >
 *       Returns the plaintext token exactly once, in this response. Only its SHA-256 is
 *       stored; it cannot be shown again. Rate-limited and capped per user.
 *     tags: [API Tokens]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name]
 *             properties:
 *               name:
 *                 type: string
 *                 maxLength: 100
 *               expiresInDays:
 *                 type: integer
 *                 minimum: 1
 *                 nullable: true
 *     responses:
 *       201:
 *         description: Created. `plaintext` is the token; store it now.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: object
 *                   properties:
 *                     token:
 *                       $ref: '#/components/schemas/ApiToken'
 *                     plaintext:
 *                       type: string
 *       400:
 *         description: Invalid name or expiry
 *       409:
 *         description: The per-user token limit is reached
 *       403:
 *         description: Not an admin
 *       429:
 *         description: Create rate limit reached
 */
router.post('/', requireAdmin, createLimiter, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const userId = userIdOf(req, res);
    if (!userId) return;
    const name = validateTokenName(req.body?.name);
    if (!name.ok) {
      res.status(400).json({ success: false, error: 'Bad Request', message: name.error });
      return;
    }
    const expires = validateExpiresInDays(req.body?.expiresInDays);
    if (!expires.ok) {
      res.status(400).json({ success: false, error: 'Bad Request', message: expires.error });
      return;
    }
    const result = await ApiTokenService.create(userId, name.value, expires.value);
    if (!result.ok) {
      res.status(409).json({
        success: false,
        error: 'Conflict',
        code: 'TOKEN_LIMIT',
        message: `You already have ${result.limit} active tokens. Revoke one before creating another.`,
      });
      return;
    }
    logger.info('API token created', { userId, tokenId: result.token.id });
    res.setHeader('Cache-Control', 'no-store');
    res.status(201).json({ success: true, data: { token: result.token, plaintext: result.plaintext } });
  } catch (err) {
    next(err);
  }
});

/**
 * @swagger
 * /api-tokens/{id}:
 *   delete:
 *     summary: Revoke one of the current user's API tokens
 *     description: >
 *       Takes effect on the next request made with the token. Another user's token id
 *       answers 404, exactly like an id that does not exist.
 *     tags: [API Tokens]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: Revoked
 *       400:
 *         description: Malformed id
 *       403:
 *         description: Not an admin
 *       404:
 *         description: No such un-revoked token for this user
 */
router.delete('/:id', requireAdmin, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const userId = userIdOf(req, res);
    if (!userId) return;
    const tokenId = req.params.id;
    if (!isValidUuid(tokenId)) {
      res.status(400).json({ success: false, error: 'Bad Request', message: 'Invalid token id' });
      return;
    }
    const revoked = await ApiTokenService.revoke(userId, tokenId);
    if (!revoked) {
      res.status(404).json({ success: false, error: 'Not Found', message: 'Token not found' });
      return;
    }
    logger.info('API token revoked', { userId, tokenId });
    res.json({ success: true, data: { id: tokenId, revoked: true } });
  } catch (err) {
    next(err);
  }
});

export default router;
