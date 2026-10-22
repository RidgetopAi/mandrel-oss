import { Router , type RequestParamHandler } from 'express';
import { DecisionController } from '../controllers/decision';
import { authenticateToken } from '../middleware/auth';
import { validateUUIDParam } from '../middleware/validation';
import { declareAnyAuthenticatedMayWrite } from '../middleware/authz';
import { authorizeEntityPathParam } from '../services/entityProjectScope';

const router = Router();

// Apply authentication to all decision routes
router.use(authenticateToken);

/**
 * AUTHORIZE THE ENTITY PATH PARAM (an earlier task — the entity-detail half).
 *
 * Covers GET /:id, /:id/links.
 * Registered as `router.param`, so it runs during ROUTING for every route on this router
 * that carries `:id` — including ones nobody has written yet. That inheritance is the
 * whole point; the list-shaped alternative is what left these open while
 * `/api/projects/:id` next door was tight.
 *
 * Fail-closed and NON-DISCLOSING: a row that does not exist and a row the caller may not
 * have both answer 403, matching authorizeProjectPathParam. See services/entityProjectScope.ts.
 */
const authorizeIdParam: RequestParamHandler = (req, res, next, value) =>
  authorizeEntityPathParam('decision')(
    req as unknown as Parameters<ReturnType<typeof authorizeEntityPathParam>>[0],
    res as unknown as Parameters<ReturnType<typeof authorizeEntityPathParam>>[1],
    next,
    String(value)
  );
router.param('id', authorizeIdParam);


// Decision routes

/**
 * @swagger
 * /decisions:
 *   get:
 *     summary: Search technical decisions
 *     tags: [Decisions]
 *     parameters:
 *       - in: query
 *         name: query
 *         schema:
 *           type: string
 *         description: Free-text search term to locate decisions
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *           enum: [active, under_review, superseded, deprecated]
 *         description: Filter decisions by lifecycle status
 *       - in: query
 *         name: project_id
 *         schema:
 *           type: string
 *           format: uuid
 *         description: Scope search to a specific project
 *       - in: query
 *         name: created_by
 *         schema:
 *           type: string
 *         description: Filter by author username
 *       - in: query
 *         name: date_from
 *         schema:
 *           type: string
 *           format: date-time
 *         description: Inclusive lower bound for creation date
 *       - in: query
 *         name: date_to
 *         schema:
 *           type: string
 *           format: date-time
 *         description: Inclusive upper bound for creation date
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 20
 *       - in: query
 *         name: offset
 *         schema:
 *           type: integer
 *           default: 0
 *     responses:
 *       200:
 *         description: Decisions retrieved
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/ApiSuccessResponse'
 *                 - type: object
 *                   properties:
 *                     data:
 *                       $ref: '#/components/schemas/DecisionSearchResponse'
 */
router.get('/', DecisionController.searchDecisions);

/**
 * @swagger
 * /decisions:
 *   post:
 *     summary: Record a new technical decision
 *     tags: [Decisions]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/CreateDecisionRequest'
 *     responses:
 *       201:
 *         description: Decision recorded successfully
 */
router.post(
  '/',
  declareAnyAuthenticatedMayWrite('recording a decision is core user write work'),
  DecisionController.recordDecision
);

/**
 * @swagger
 * /decisions/stats:
 *   get:
 *     summary: Retrieve decision statistics
 *     tags: [Decisions]
 *     parameters:
 *       - in: query
 *         name: project_id
 *         schema:
 *           type: string
 *           format: uuid
 *         description: Optional project scope for statistics
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
 *                       $ref: '#/components/schemas/DecisionStats'
 */
router.get('/stats', DecisionController.getDecisionStats);

/**
 * @swagger
 * /decisions/{id}:
 *   get:
 *     summary: Get a decision by ID
 *     tags: [Decisions]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: Decision retrieved
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/ApiSuccessResponse'
 *                 - type: object
 *                   properties:
 *                     data:
 *                       $ref: '#/components/schemas/DecisionEntity'
 *       404:
 *         description: Decision not found
 *   put:
 *     summary: Update a decision
 *     tags: [Decisions]
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
 *             $ref: '#/components/schemas/UpdateDecisionRequest'
 *     responses:
 *       200:
 *         description: Decision updated successfully
 *   delete:
 *     summary: Delete a decision
 *     tags: [Decisions]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: Decision deleted successfully
 */
router.get('/:id', validateUUIDParam(), DecisionController.getDecision);
router.put(
  '/:id',
  declareAnyAuthenticatedMayWrite('editing a decision is reversible'),
  validateUUIDParam(),
  DecisionController.updateDecision
);
// DELETE is a SOFT-delete since an earlier task — it sets `archived_at` (matching MCP
// `decision_delete` on the same table) and POST /:id/restore below undoes it.
router.delete(
  '/:id',
  declareAnyAuthenticatedMayWrite('soft-deleting ONE decision — sets archived_at, row survives, /restore undoes it'),
  validateUUIDParam(),
  DecisionController.deleteDecision
);

/**
 * @swagger
 * /decisions/{id}/restore:
 *   post:
 *     summary: Restore (un-archive) a soft-deleted decision
 *     tags: [Decisions]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: Decision restored successfully
 *       404:
 *         description: Decision not found
 */
router.post(
  '/:id/restore',
  declareAnyAuthenticatedMayWrite('restoring a soft-deleted decision is additive — it destroys nothing'),
  validateUUIDParam(),
  DecisionController.restoreDecision
);

/**
 * @swagger
 * /decisions/{id}/answer:
 *   post:
 *     summary: Answer an open/discussing decision by picking an option
 *     tags: [Decisions]
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
 *             type: object
 *             required: [option]
 *             properties:
 *               option:
 *                 type: string
 *               note:
 *                 type: string
 *     responses:
 *       200:
 *         description: Decision answered successfully
 *       409:
 *         description: The decision is already decided
 */
router.post(
  '/:id/answer',
  declareAnyAuthenticatedMayWrite('the decision inbox: picking an option is core user write work'),
  validateUUIDParam(),
  DecisionController.answerDecision
);

/**
 * @swagger
 * /decisions/{id}/discuss:
 *   post:
 *     summary: Send an open decision back for more discussion (stays open)
 *     tags: [Decisions]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               note:
 *                 type: string
 *     responses:
 *       200:
 *         description: Decision sent back for discussion
 *       409:
 *         description: The decision is already decided
 */
router.post(
  '/:id/discuss',
  declareAnyAuthenticatedMayWrite('the decision inbox: the escape hatch is core user write work'),
  validateUUIDParam(),
  DecisionController.discussDecision
);

/**
 * @swagger
 * /decisions/{id}/links:
 *   get:
 *     summary: Get the typed graph edges (thread box) touching a decision
 *     description: >
 *       Returns the real `links`-table edges in BOTH directions, resolved to each other
 *       endpoint's title + kind. This is the TreeWalker moat surface — structure, not the
 *       semantic related list.
 *     tags: [Decisions]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: Typed edges retrieved
 */
router.get('/:id/links', validateUUIDParam(), DecisionController.getDecisionLinks);

export default router;
