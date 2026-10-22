import { Router , type RequestParamHandler } from 'express';
import { ContextController } from '../controllers/context';
import { authenticateToken } from '../middleware/auth';
import {
  contractEnforcementMiddleware,
  validateBody,
  validateQuery,
  validateUUIDParam,
} from '../middleware/validation';
import { ContextSearchQuerySchema } from '../validation/schemas';
import { declareAnyAuthenticatedMayWrite } from '../middleware/authz';
import { authorizeEntityPathParam } from '../services/entityProjectScope';

const router = Router();

// Apply authentication to all context routes
router.use(authenticateToken);

/**
 * AUTHORIZE THE ENTITY PATH PARAM (an earlier task — the entity-detail half).
 *
 * Covers GET /:id, /:id/links, /:id/related (+ PUT/DELETE /:id).
 * Registered as `router.param`, so it runs during ROUTING for every route on this router
 * that carries `:id` — including ones nobody has written yet. That inheritance is the
 * whole point; the list-shaped alternative is what left these open while
 * `/api/projects/:id` next door was tight.
 *
 * Fail-closed and NON-DISCLOSING: a row that does not exist and a row the caller may not
 * have both answer 403, matching authorizeProjectPathParam. See services/entityProjectScope.ts.
 */
const authorizeIdParam: RequestParamHandler = (req, res, next, value) =>
  authorizeEntityPathParam('context')(
    req as unknown as Parameters<ReturnType<typeof authorizeEntityPathParam>>[0],
    res as unknown as Parameters<ReturnType<typeof authorizeEntityPathParam>>[1],
    next,
    String(value)
  );
router.param('id', authorizeIdParam);

router.use(contractEnforcementMiddleware);

// Context routes

/**
 * @swagger
 * /contexts:
 *   get:
 *     summary: Search contexts with filters
 *     tags: [Contexts]
 *     parameters:
 *       - in: query
 *         name: query
 *         schema:
 *           type: string
 *         description: Free-text search query
 *       - in: query
 *         name: project_id
 *         schema:
 *           type: string
 *           format: uuid
 *         description: Filter by project ID (falls back to X-Project-ID header)
 *       - in: query
 *         name: session_id
 *         schema:
 *           type: string
 *           format: uuid
 *       - in: query
 *         name: type
 *         schema:
 *           type: string
 *           enum: [code, decision, research, issue, note, error, test]
 *       - in: query
 *         name: tags
 *         schema:
 *           type: string
 *         description: Comma-separated tags filter
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
 *         description: Contexts retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/ApiSuccessResponse'
 *                 - type: object
 *                   properties:
 *                     data:
 *                       $ref: '#/components/schemas/ContextSearchResponse'
 */
router.get('/', validateQuery(ContextSearchQuerySchema, { required: false }), ContextController.searchContexts);

/**
 * @swagger
 * /contexts:
 *   post:
 *     summary: Create a new context
 *     tags: [Contexts]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - content
 *             properties:
 *               content:
 *                 type: string
 *                 description: The context content
 *               type:
 *                 type: string
 *                 enum: [code, decision, error, discussion, planning, completion, milestone, reflections, handoff, lessons, note]
 *                 default: discussion
 *               tags:
 *                 type: array
 *                 items:
 *                   type: string
 *               metadata:
 *                 type: object
 *               projectId:
 *                 type: string
 *                 format: uuid
 *     responses:
 *       201:
 *         description: Context created successfully
 *       400:
 *         description: Invalid request body
 *       500:
 *         description: Server error
 */
router.post(
  '/',
  declareAnyAuthenticatedMayWrite('recording a context is the core user write of the product'),
  ContextController.createContext
);

/**
 * @swagger
 * /contexts/stats:
 *   get:
 *     summary: Retrieve context statistics for the current project
 *     tags: [Contexts]
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
 *                       $ref: '#/components/schemas/ContextStats'
 */
router.get('/stats', ContextController.getContextStats);
router.get('/weekly-velocity', ContextController.getWeeklyVelocity);
router.get('/export', ContextController.exportContexts);

// REMOVED (search consolidation): POST /contexts/search. It was
// labeled "semantic" but ran the LITERAL matcher — one of the three lying paths.
// All context search now flows through GET /contexts (2-mode dispatch: query →
// canonical engine proxy; no query → browse). No non-generated frontend caller.

/**
 * @swagger
 * /contexts/{id}:
 *   get:
 *     summary: Get a context by ID
 *     tags: [Contexts]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: Context retrieved
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/ApiSuccessResponse'
 *                 - type: object
 *                   properties:
 *                     data:
 *                       $ref: '#/components/schemas/ContextEntity'
 *       404:
 *         description: Context not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiErrorResponse'
 *   put:
 *     summary: Update an existing context
 *     tags: [Contexts]
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
 *             additionalProperties: true
 *     responses:
 *       200:
 *         description: Context updated
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/ApiSuccessResponse'
 *                 - type: object
 *                   properties:
 *                     data:
 *                       $ref: '#/components/schemas/ContextEntity'
 *       404:
 *         description: Context not found
 *   delete:
 *     summary: Delete a context
 *     tags: [Contexts]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: Context deleted successfully
 *       404:
 *         description: Context not found
 */
router.get('/:id', validateUUIDParam(), ContextController.getContext);
router.put(
  '/:id',
  declareAnyAuthenticatedMayWrite('editing a context is reversible'),
  validateUUIDParam(),
  validateBody('UpdateContext'),
  ContextController.updateContext
);
// DELETE is a SOFT-delete since an earlier task — it sets `archived_at` (matching MCP
// `context_delete` on the same table) and POST /:id/restore below undoes it. The row
// survives, and so does every typed edge pointing at it.
router.delete(
  '/:id',
  declareAnyAuthenticatedMayWrite('soft-deleting ONE context — sets archived_at, row survives, /restore undoes it'),
  validateUUIDParam(),
  ContextController.deleteContext
);

/**
 * @swagger
 * /contexts/{id}/restore:
 *   post:
 *     summary: Restore (un-archive) a soft-deleted context
 *     tags: [Contexts]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: Context restored successfully
 *       404:
 *         description: Context not found
 */
router.post(
  '/:id/restore',
  declareAnyAuthenticatedMayWrite('restoring a soft-deleted context is additive — it destroys nothing'),
  validateUUIDParam(),
  ContextController.restoreContext
);

/**
 * @swagger
 * /contexts/bulk/delete:
 *   delete:
 *     summary: Bulk delete contexts by ID
 *     tags: [Contexts]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/ContextBulkDelete'
 *     responses:
 *       200:
 *         description: Contexts deleted successfully
 */
// ⚠️ FLAGGED: the widest path on this surface — an arbitrary-length id
// array with no count gate and no `?confirm`, unlike the project delete one file over.
// TWO of the three teeth are now pulled: it SOFT-deletes, so nothing it
// touches is destroyed and every row it archives is restorable; and it is PROJECT-SCOPED,
// so it can no longer reach a row in a project the caller holds no grant on — it had NO
// project predicate at all, while the MCP archive path on the same table always had one.
// STILL UNBOUNDED IN COUNT, deliberately: a count gate is a product decision for
// The coordinator/the operator, and it is no longer the dangerous half now that the writes are reversible.
router.delete(
  '/bulk/delete',
  declareAnyAuthenticatedMayWrite('bulk SOFT-delete, project-scoped — reversible; count still unbounded pending a product decision'),
  validateBody('ContextBulkDelete'),
  ContextController.bulkDeleteContexts
);

/**
 * @swagger
 * /contexts/bulk/update:
 *   post:
 *     summary: Bulk update contexts by ID
 *     tags: [Contexts]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/ContextBulkUpdate'
 *     responses:
 *       200:
 *         description: Contexts updated successfully
 */
router.post(
  '/bulk/update',
  declareAnyAuthenticatedMayWrite('bulk field edits are reversible — no rows are destroyed'),
  validateBody('ContextBulkUpdate'),
  ContextController.bulkUpdateContexts
);

/**
 * @swagger
 * /contexts/{id}/related:
 *   get:
 *     summary: Get contexts related to the supplied context
 *     tags: [Contexts]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: Related contexts returned
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/ApiSuccessResponse'
 *                 - type: object
 *                   properties:
 *                     data:
 *                       type: array
 *                       items:
 *                         $ref: '#/components/schemas/ContextEntity'
 */
router.get('/:id/related', validateUUIDParam(), ContextController.getRelatedContexts);

/**
 * @swagger
 * /contexts/{id}/links:
 *   get:
 *     summary: Get the typed graph edges (thread) touching a context
 *     tags: [Contexts]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: Typed edges returned (both directions), resolved to each target's title/kind
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/ApiSuccessResponse'
 *                 - type: object
 *                   properties:
 *                     data:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           edgeType: { type: string }
 *                           direction: { type: string, enum: [outgoing, incoming] }
 *                           otherId: { type: string, format: uuid }
 *                           otherType: { type: string, enum: [context, decision, task] }
 *                           otherTitle: { type: string }
 *                           otherKind: { type: string }
 */
router.get('/:id/links', validateUUIDParam(), ContextController.getContextLinks);

export default router;
