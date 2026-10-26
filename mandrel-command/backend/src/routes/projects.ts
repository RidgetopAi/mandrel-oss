import { Router, type RequestParamHandler } from 'express';
import { ProjectController } from '../controllers/project';
import { authenticateToken, requireAdmin } from '../middleware/auth';
import { declareAnyAuthenticatedMayWrite } from '../middleware/authz';
import { authorizeProjectPathParam } from '../services/projectScopeResolver';
import {
  validateBody,
  validateUUIDParam,
  validatePagination,
  contractEnforcementMiddleware
} from '../middleware/validation';

/**
 * @swagger
 * components:
 *   schemas:
 *     Project:
 *       $ref: '#/components/schemas/ProjectEntity'
 *     CreateProject:
 *       $ref: '#/components/schemas/CreateProjectRequest'
 *     UpdateProject:
 *       $ref: '#/components/schemas/UpdateProjectRequest'
 */

const router = Router();

// Apply authentication to ALL project routes, including /watchable.
//
// /watchable used to be registered ABOVE this line with `security: []` and the comment
// "Unauthenticated - used by local mandrel-watcher daemon". It was
// therefore reachable with no credential on prod and all 7 tenants, and it returns
// project `name` + `root_directory` — customer project names and absolute host
// filesystem paths. The comment was accurate about the CONSUMER but that never made the
// disclosure acceptable: the same response goes to anyone who asks.
//
// The consumer is real and still running (mandrel-watcher, polling every ~5 min), and it
// already sends `Authorization: Bearer <auth_token>` when one is set in its config, so
// the supported fix is to credential the watcher rather than to keep the route open.
//
// KNOWN AND ACCEPTED as of this change: the watcher has NO durable credential, and none
// currently exists to give it — authenticateToken takes only JWTs, and both the JWT and
// its auth_tokens row expire per MANDREL_JWT_EXPIRES_IN (default 24h), so a hand-issued
// token would break within a day. Until a service-credential path is built, THE WATCHER
// WILL DEGRADE TO CACHED PROJECT DISCOVERY rather than break: it keeps watching the
// projects it already knows and simply stops picking up new ones.
//
// That fail-soft behaviour is MEASURED, not assumed, and the watcher lives in a different
// repo ON A DIFFERENT BOX, so here is the instrument — grep it there, not here:
//   host: prod-host (the prod box; the watcher source is NOT on the control host control box)
//   file: /home/user/projects/mandrel-watcher/src/core/ConfigManager.ts
//   ConfigManager.fetchProjects: throws on a non-2xx at :110-112, and its own catch at
//   :139-141 logs "Failed to fetch projects from API, using cached/static config" and
//   returns this.config.projects (the cached/static list).
//
// This is a deliberate trade — shipping the leak fix now beats leaving customer
// project names and absolute host paths world-readable, and building a long-lived
// credential path was declined here because it is an auth-system change landing
// alongside an in-flight better-auth upgrade.
//
// Do NOT "fix" the degradation by widening MANDREL_JWT_EXPIRES_IN: that downgrades token
// expiry for every human user to serve one daemon. The follow-up is a scoped service
// credential.
router.use(authenticateToken);

/**
 * AUTHORIZE THE PROJECT PATH PARAM (an earlier task item 7).
 *
 * `GET /api/projects/:id`, `/:id/insights` and `/:id/sessions` took a project id in the
 * PATH, which is not one of PROJECT_SCOPE_SOURCES — projectContextMiddleware runs before
 * routing, so `req.params` is empty there and it never saw them. `validateUUIDParam()`
 * checked the SHAPE and nothing else. Measured at the real surface: a zero-grant non-admin
 * read another project's name, description and full insights with a 200.
 *
 * This is the same `router.param` + ProjectAccessService choke point the project-by-id routes
 * already use, so there is one authorization decision, not two.
 */
const authorizeProjectIdParam: RequestParamHandler = (req, res, next, value) =>
  authorizeProjectPathParam(
    req as unknown as Parameters<typeof authorizeProjectPathParam>[0],
    res as unknown as Parameters<typeof authorizeProjectPathParam>[1],
    next,
    String(value)
  );
router.param('id', authorizeProjectIdParam);

// TR004-6: Apply contract enforcement middleware
router.use(contractEnforcementMiddleware);

/**
 * @swagger
 * /projects/watchable:
 *   get:
 *     summary: Get projects with root_directory for mandrel-watcher
 *     description: >
 *       Returns projects that have a local path configured. Used by the mandrel-watcher
 *       daemon, which must authenticate: the response carries project names and absolute
 *       host filesystem paths.
 *     tags: [Projects]
 *     responses:
 *       200:
 *         description: Watchable projects retrieved successfully
 *       401:
 *         description: Authentication required
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiErrorResponse'
 */
router.get('/watchable', ProjectController.getWatchableProjects);

/**
 * @swagger
 * /projects:
 *   get:
 *     summary: Get all projects
 *     tags: [Projects]
 *     parameters:
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           minimum: 1
 *           default: 1
 *         description: Page number
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 100
 *           default: 20
 *         description: Items per page
 *       - in: query
 *         name: sortBy
 *         schema:
 *           type: string
 *         description: Field to sort by
 *       - in: query
 *         name: sortOrder
 *         schema:
 *           type: string
 *           enum: [asc, desc]
 *           default: asc
 *         description: Sort order
 *     responses:
 *       200:
 *         description: Projects retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/ApiSuccessResponse'
 *                 - type: object
 *                   properties:
 *                     data:
 *                       $ref: '#/components/schemas/ProjectListResponse'
 *       400:
 *         description: Invalid query parameters
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiErrorResponse'
 *   post:
 *     summary: Create a new project
 *     tags: [Projects]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/CreateProjectRequest'
 *     responses:
 *       201:
 *         description: Project created successfully
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/ApiSuccessResponse'
 *                 - type: object
 *                   properties:
 *                     data:
 *                       $ref: '#/components/schemas/ProjectDetailResponse'
 *       400:
 *         description: Invalid project data
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiErrorResponse'
 */
router.get('/', validatePagination(), ProjectController.getAllProjects);
router.post(
  '/',
  declareAnyAuthenticatedMayWrite('creating a project is additive and destroys nothing'),
  validateBody('CreateProject'),
  ProjectController.createProject
);

/**
 * @swagger
 * /projects/stats:
 *   get:
 *     summary: Get project statistics
 *     tags: [Projects]
 *     responses:
 *       200:
 *         description: Project statistics retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/ApiSuccessResponse'
 *                 - type: object
 *                   properties:
 *                     data:
 *                       $ref: '#/components/schemas/ProjectStats'
 */
router.get('/stats', ProjectController.getProjectStats);

/**
 * @swagger
 * /projects/sessions/all:
 *   get:
 *     summary: Get all sessions across projects
 *     tags: [Projects]
 *     parameters:
 *       - in: query
 *         name: project_id
 *         schema:
 *           type: string
 *           format: uuid
 *         required: false
 *         description: Filter sessions to a single project (UUID). Ignored if not a valid UUID.
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           minimum: 1
 *         required: false
 *         description: Maximum number of sessions to return (most recent first).
 *     responses:
 *       200:
 *         description: Sessions retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/ApiSuccessResponse'
 *                 - type: object
 *                   properties:
 *                     data:
 *                       $ref: '#/components/schemas/ProjectSessionsResponse'
 */
router.get('/sessions/all', ProjectController.getAllSessions);

/**
 * @swagger
 * /projects/{id}/set-primary:
 *   post:
 *     summary: Set project as primary/default
 *     tags: [Projects]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: Project ID
 *     responses:
 *       200:
 *         description: Project set as primary successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiSuccessResponse'
 *       404:
 *         description: Project not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiErrorResponse'
 */
router.post(
  '/:id/set-primary',
  declareAnyAuthenticatedMayWrite('changing which project is primary is a reversible preference, not a destructive act'),
  validateUUIDParam(),
  ProjectController.setPrimary
);

/**
 * @swagger
 * /projects/clear-primary:
 *   post:
 *     summary: Clear the primary/default flag from all projects
 *     tags: [Projects]
 *     responses:
 *       200:
 *         description: Primary flag cleared successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiSuccessResponse'
 */
router.post(
  '/clear-primary',
  declareAnyAuthenticatedMayWrite('clearing the primary flag is a reversible preference, not a destructive act'),
  ProjectController.clearPrimary
);

/**
 * @swagger
 * /projects/{id}:
 *   get:
 *     summary: Get project by ID
 *     tags: [Projects]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: Project ID
 *     responses:
 *       200:
 *         description: Project retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/ApiSuccessResponse'
 *                 - type: object
 *                   properties:
 *                     data:
 *                       $ref: '#/components/schemas/ProjectDetailResponse'
 *       404:
 *         description: Project not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiErrorResponse'
 *   put:
 *     summary: Update project
 *     tags: [Projects]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: Project ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/UpdateProjectRequest'
 *     responses:
 *       200:
 *         description: Project updated successfully
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/ApiSuccessResponse'
 *                 - type: object
 *                   properties:
 *                     data:
 *                       $ref: '#/components/schemas/ProjectDetailResponse'
 *       400:
 *         description: Invalid project data
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiErrorResponse'
 *       404:
 *         description: Project not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiErrorResponse'
 *   delete:
 *     summary: Delete project (irreversible — cascades into every project-owned table)
 *     description: >
 *       Gated by the mcp-server `project_delete` safety survey. Without
 *       `confirm=true` a project with owned rows — or one whose blast radius cannot be
 *       measured — is REFUSED with 409 and the impact counts, and nothing is destroyed.
 *     tags: [Projects]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: Project ID
 *       - in: query
 *         name: confirm
 *         required: false
 *         schema:
 *           type: string
 *           enum: ['true']
 *         description: >
 *           Explicit confirmation. Only the exact string `true` confirms; anything else
 *           (absent, `false`, empty) leaves the delete gated.
 *     responses:
 *       200:
 *         description: Project deleted successfully
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/ApiSuccessResponse'
 *                 - type: object
 *                   properties:
 *                     data:
 *                       $ref: '#/components/schemas/ProjectSessionsResponse'
 *       404:
 *         description: Project not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiErrorResponse'
 *       409:
 *         description: >
 *           Refused — confirmation required. Nothing was deleted. `error` carries the
 *           gate's blast-radius sentence; `data.impact` carries the measured counts
 *           (`byTable`, `total`, `unmeasurable`) and `data.requiresConfirmation` is true.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiErrorResponse'
 */
router.get('/:id', validateUUIDParam(), ProjectController.getProject);
router.put(
  '/:id',
  validateUUIDParam(),
  declareAnyAuthenticatedMayWrite(
    'renaming/re-describing a project is ordinary, non-destructive and reversible editing work'
  ),
  validateBody('UpdateProject'),
  ProjectController.updateProject
);
/**
 * SECURITY: `requireAdmin` — this is the Danger Zone delete.
 *
 * It cascades into 24 project-owned tables and is irreversible. Until this line it was
 * gated by `authenticateToken` alone, so ANY authenticated user of ANY role could destroy
 * a whole project. `?confirm=true` gates ACCIDENT; it never gated
 * AUTHORITY — a non-admin who meant it was unimpeded.
 *
 * Order matters: `authenticateToken` (router-level, above) populates `req.user`, then
 * `requireAdmin` reads `req.user.role`. `requireAdmin` sits BEFORE `validateUUIDParam` so
 * a non-admin gets 403 rather than a 400 that leaks which ids are well-formed.
 */
router.delete('/:id', requireAdmin, validateUUIDParam(), ProjectController.deleteProject);

/**
 * @swagger
 * /projects/{id}/insights:
 *   get:
 *     summary: Get project insights
 *     tags: [Projects]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: Project ID
 *     responses:
 *       200:
 *         description: Project insights retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiSuccessResponse'
 */
router.get('/:id/insights', validateUUIDParam(), ProjectController.getProjectInsights);

/**
 * @swagger
 * /projects/{id}/sessions:
 *   get:
 *     summary: Get project sessions
 *     tags: [Projects]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: Project ID
 *     responses:
 *       200:
 *         description: Project sessions retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiSuccessResponse'
 */
router.get('/:id/sessions', validateUUIDParam(), ProjectController.getProjectSessions);

export default router;
