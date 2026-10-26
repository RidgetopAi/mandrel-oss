import { Router, Response } from 'express';
import { authenticateToken } from '../middleware/auth';
import { AuthenticatedRequest } from '../types/auth';
import { db as pool } from '../database/connection';
import { logger } from '../config/logger';
import { declareAnyAuthenticatedMayWrite } from '../middleware/authz';

const router = Router();

const ALLOWED_TYPES = ['bug', 'idea', 'question'];
const ALLOWED_SEVERITIES = ['low', 'medium', 'high'];
const MAX_MESSAGE_LENGTH = 5000;
const MAX_PAGE_LENGTH = 1000;

/**
 * POST /api/feedback
 * Submit a feedback/issue item from the dashboard. Auth required.
 * Both owner fields are SERVER-DERIVED from `req.user` and NOT trusted from the request
 * body. `user_id` is the OWNERSHIP KEY the read path authorizes on (immutable
 * admin_users.id); `username` is a denormalized human-readable LABEL, kept only because
 * out-of-band feedback reports render it, and it may go stale after a rename. type/severity/message are validated.
 */
router.post('/', authenticateToken,
  declareAnyAuthenticatedMayWrite('submitting feedback is append-only'),
  async (req: AuthenticatedRequest, res: Response) => {
  try {
    const username = req.user?.username;

    if (!req.user?.id) {
      res.status(401).json({
        success: false,
        error: 'Unauthorized',
        message: 'User not authenticated'
      });
      return;
    }

    const { type, severity, message, page } = req.body ?? {};

    // Validate message (the substance) — required, non-empty, length-capped
    if (typeof message !== 'string' || message.trim().length === 0) {
      res.status(400).json({
        success: false,
        error: 'Bad Request',
        message: 'A non-empty message is required'
      });
      return;
    }

    if (message.length > MAX_MESSAGE_LENGTH) {
      res.status(400).json({
        success: false,
        error: 'Bad Request',
        message: `Message must be ${MAX_MESSAGE_LENGTH} characters or fewer`
      });
      return;
    }

    // Validate type
    const finalType = type ?? 'bug';
    if (!ALLOWED_TYPES.includes(finalType)) {
      res.status(400).json({
        success: false,
        error: 'Bad Request',
        message: `Invalid type. Must be one of: ${ALLOWED_TYPES.join(', ')}`
      });
      return;
    }

    // Validate severity
    const finalSeverity = severity ?? 'medium';
    if (!ALLOWED_SEVERITIES.includes(finalSeverity)) {
      res.status(400).json({
        success: false,
        error: 'Bad Request',
        message: `Invalid severity. Must be one of: ${ALLOWED_SEVERITIES.join(', ')}`
      });
      return;
    }

    // Optional page/URL path — cap length, accept only strings
    let finalPage: string | null = null;
    if (typeof page === 'string' && page.trim().length > 0) {
      finalPage = page.slice(0, MAX_PAGE_LENGTH);
    }

    const result = await pool.query(
      `INSERT INTO feedback (user_id, username, type, severity, message, page)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, username, type, severity, message, page, created_at`,
      [req.user.id, username ?? null, finalType, finalSeverity, message.trim(), finalPage]
    );

    res.status(201).json({
      success: true,
      message: 'Thanks — got it',
      data: { feedback: result.rows[0] }
    });
  } catch (error) {
    logger.error('Error submitting feedback', { error });
    res.status(500).json({
      success: false,
      error: 'Internal Server Error',
      message: 'Failed to submit feedback'
    });
  }
});

/**
 * GET /api/feedback
 * Return the CALLER'S OWN feedback rows, newest-first. Auth required.
 * Optional ?limit= (default 100, capped at 500).
 *
 * OWN-ROWS-ONLY. This route previously selected every row in
 * the table for any authenticated caller. The owner key is `user_id` (migration 077),
 * matched against `req.user.id` — an immutable, never-reissued admin_users primary key.
 * It is deliberately NOT `username`: `req.user` is DB-derived, re-read from admin_users
 * on every request by authenticateToken, and any authenticated user may rewrite their
 * own username via PUT /api/users/profile, so a username predicate hands a vacated
 * handle's rows to whoever claims it next and hides a renamed user's own rows from them.
 * There is deliberately NO admin bypass: a feedback inbox is a separate endpoint
 * designed for that purpose, not a role check added to this one.
 */
router.get('/', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user?.id;

    if (typeof userId !== 'string' || userId.length === 0) {
      res.status(401).json({
        success: false,
        error: 'Unauthorized',
        message: 'User not authenticated'
      });
      return;
    }

    const rawLimit = parseInt(String(req.query.limit ?? '100'), 10);
    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 500) : 100;

    const result = await pool.query(
      `SELECT id, username, type, severity, message, page, created_at
       FROM feedback
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [userId, limit]
    );

    res.json({
      success: true,
      data: { feedback: result.rows }
    });
  } catch (error) {
    logger.error('Error fetching feedback', { error });
    res.status(500).json({
      success: false,
      error: 'Internal Server Error',
      message: 'Failed to fetch feedback'
    });
  }
});

export default router;
