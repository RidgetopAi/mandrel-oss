import { Router , type RequestParamHandler } from 'express';
import { SessionController } from '../controllers/session';
import { authenticateToken } from '../middleware/auth';
import {
  contractEnforcementMiddleware,
  validateBody,
  validateUUIDParam,
} from '../middleware/validation';
import { declareAnyAuthenticatedMayWrite } from '../middleware/authz';
import { authorizeEntityPathParam } from '../services/entityProjectScope';

const router = Router();

// Current session route for session recovery.
// SECURITY: this route returns real session data (id, display_id,
// project_name, timestamps) and was previously left UNAUTHENTICATED ("no auth for
// development"), exposing it to the public internet. It is now gated with the SAME
// `authenticateToken` guard as the rest of /api. Applied inline (rather than reordering
// under the `router.use(authenticateToken)` block below) so it is NOT swept into the
// `contractEnforcementMiddleware` that block also installs — behavior-preserving except
// for the auth requirement. The frontend already sends the JWT on this call (axios
// interceptor + OpenAPI.TOKEN resolver), so the logged-in UI is unaffected.

/**
 * @swagger
 * /sessions/current:
 *   get:
 *     summary: Retrieve the currently active session from MCP
 *     tags: [Sessions]
 *     responses:
 *       200:
 *         description: Current session information or null
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/ApiSuccessResponse'
 *                 - type: object
 *                   properties:
 *                     data:
 *                       $ref: '#/components/schemas/SessionCurrentResponse'
 */
router.get('/current', authenticateToken, SessionController.getCurrentSession);

// Apply authentication to all other session routes
router.use(authenticateToken);

/**
 * AUTHORIZE THE ENTITY PATH PARAM (an earlier task — the entity-detail half).
 *
 * Covers GET /:id (+ PUT /:id).
 * Registered as `router.param`, so it runs during ROUTING for every route on this router
 * that carries `:id` — including ones nobody has written yet. That inheritance is the
 * whole point; the list-shaped alternative is what left these open while
 * `/api/projects/:id` next door was tight.
 *
 * Fail-closed and NON-DISCLOSING: a row that does not exist and a row the caller may not
 * have both answer 403, matching authorizeProjectPathParam. See services/entityProjectScope.ts.
 */
const authorizeIdParam: RequestParamHandler = (req, res, next, value) =>
  authorizeEntityPathParam('session')(
    req as unknown as Parameters<ReturnType<typeof authorizeEntityPathParam>>[0],
    res as unknown as Parameters<ReturnType<typeof authorizeEntityPathParam>>[1],
    next,
    String(value)
  );
router.param('id', authorizeIdParam);

router.use(contractEnforcementMiddleware);

// Sessions list and stats routes (place before /:id to avoid conflicts)

/**
 * @swagger
 * /sessions/stats:
 *   get:
 *     summary: Retrieve session statistics
 *     tags: [Sessions]
 *     parameters:
 *       - in: query
 *         name: project_id
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: Statistics returned
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/ApiSuccessResponse'
 *                 - type: object
 *                   properties:
 *                     data:
 *                       $ref: '#/components/schemas/SessionStats'
 */
router.get('/stats', SessionController.getSessionStats);

/**
 * @swagger
 * /sessions:
 *   get:
 *     summary: List sessions with optional filters
 *     tags: [Sessions]
 *     parameters:
 *       - in: query
 *         name: project_id
 *         schema:
 *           type: string
 *           format: uuid
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *       - in: query
 *         name: actor
 *         description: Slice by the owning principal (the "who" dimension) — e.g. coordinator, tick, builder-<id8>
 *         schema:
 *           type: string
 *       - in: query
 *         name: limit
 *         description: Max number of sessions to return (end-to-end pagination)
 *         schema:
 *           type: integer
 *       - in: query
 *         name: offset
 *         description: Number of sessions to skip
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Sessions returned
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/ApiSuccessResponse'
 *                 - type: object
 *                   properties:
 *                     data:
 *                       $ref: '#/components/schemas/SessionListResponse'
*/
router.get('/', SessionController.getSessionsList);

// Session analytics routes (place before /:id to avoid conflicts)
router.get('/analytics', SessionController.getSessionAnalytics);
router.get('/trends', SessionController.getSessionTrends);
router.get('/contexts-by-actor', SessionController.getContextsByActor);
router.get('/productive', SessionController.getProductiveSessions);
router.get('/token-patterns', SessionController.getTokenUsagePatterns);
router.get('/summaries', SessionController.getSessionSummaries);
router.get('/stats-by-period', SessionController.getSessionStatsByPeriod);

// Session assignment route

/**
 * @swagger
 * /sessions/assign:
 *   post:
 *     summary: (REMOVED) Assign session to project - use project_switch MCP tool instead
 *     tags: [Sessions]
 *     deprecated: true
 *     responses:
 *       410:
 *         description: Endpoint removed - sessions auto-inherit project from project_switch
 */
router.post(
  '/assign',
  declareAnyAuthenticatedMayWrite('assigning the caller session to a project is reversible'),
  SessionController.assignCurrentSession
);

/**
 * @swagger
 * /sessions/{id}:
 *   put:
 *     summary: Update session metadata
 *     tags: [Sessions]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/UpdateSession'
 *     responses:
 *       200:
 *         description: Session updated successfully
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/ApiSuccessResponse'
 *                 - type: object
 *                   properties:
 *                     data:
 *                       type: object
 *                       properties:
 *                         session:
 *                           $ref: '#/components/schemas/SessionEntity'
 *       400:
 *         description: Invalid session data
 *       404:
 *         description: Session not found
 */
router.put(
  '/:id',
  declareAnyAuthenticatedMayWrite('editing session metadata is reversible'),
  validateUUIDParam(),
  validateBody('UpdateSession'),
  SessionController.updateSession
);

/**
 * @swagger
 * /sessions/{id}:
 *   get:
 *     summary: Get detailed session information
 *     tags: [Sessions]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Detailed session returned
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/ApiSuccessResponse'
 *                 - type: object
 *                   properties:
 *                     data:
 *                       $ref: '#/components/schemas/SessionDetailResponse'
*       404:
*         description: Session not found
*/
// Session detail route (must be last to avoid conflicts)
router.get('/:id', validateUUIDParam(), SessionController.getSessionDetail);

export default router;
