import { Router , type RequestParamHandler } from 'express';
import { TaskController } from '../controllers/task';
import { authenticateToken } from '../middleware/auth';
import {
  validateBody,
  validateUUIDParam,
  validatePagination,
  contractEnforcementMiddleware
} from '../middleware/validation';
import { declareAnyAuthenticatedMayWrite } from '../middleware/authz';
import { authorizeEntityPathParam } from '../services/entityProjectScope';

/**
 * Task Management Routes
 * Complete CRUD operations and advanced task management endpoints
 */

const router = Router();

// Apply authentication middleware to all task routes
router.use(authenticateToken);

/**
 * AUTHORIZE THE ENTITY PATH PARAM (an earlier task — the entity-detail half).
 *
 * Covers GET /:id, /:id/dependencies, /:id/links (+ every future /:id route).
 * Registered as `router.param`, so it runs during ROUTING for every route on this router
 * that carries `:id` — including ones nobody has written yet. That inheritance is the
 * whole point; the list-shaped alternative is what left these open while
 * `/api/projects/:id` next door was tight.
 *
 * Fail-closed and NON-DISCLOSING: a row that does not exist and a row the caller may not
 * have both answer 403, matching authorizeProjectPathParam. See services/entityProjectScope.ts.
 */
const authorizeIdParam: RequestParamHandler = (req, res, next, value) =>
  authorizeEntityPathParam('task')(
    req as unknown as Parameters<ReturnType<typeof authorizeEntityPathParam>>[0],
    res as unknown as Parameters<ReturnType<typeof authorizeEntityPathParam>>[1],
    next,
    String(value)
  );
router.param('id', authorizeIdParam);


// TR004-6: Apply contract enforcement middleware
router.use(contractEnforcementMiddleware);

// Core CRUD operations
router.get('/', validatePagination(), TaskController.getTasks);               // GET /tasks - List tasks with filtering
router.get('/stats', TaskController.getTaskStats);     // GET /tasks/stats - Get statistics
router.get('/lead-time', TaskController.getLeadTimeDistribution); // GET /tasks/lead-time - Lead time analytics
router.get('/throughput', TaskController.getThroughputSeries); // GET /tasks/throughput - Per-day completed vs created series
router.get('/completed-by-actor', TaskController.getCompletedByActor); // GET /tasks/completed-by-actor - Completed counts by assignee
// Registered ABOVE the `/:id` routes: Express matches in registration order, so a literal
// path declared after `/:id` would be swallowed by it.
router.get('/actor-options', TaskController.getActorOptions); // GET /tasks/actor-options - Assignee suggestions (registry ∪ session actors ∪ assignees in use)
router.post('/', declareAnyAuthenticatedMayWrite('creating a task is additive'), validateBody('CreateTask'), TaskController.createTask);           // POST /tasks - Create task
router.post('/bulk-update', declareAnyAuthenticatedMayWrite('bulk field edits are reversible — no rows destroyed'), TaskController.bulkUpdateTasks); // POST /tasks/bulk-update - Bulk updates
router.post('/bulk/move', declareAnyAuthenticatedMayWrite('moving tasks between projects is reversible'), validateBody('TaskBulkMove'), TaskController.bulkMoveToProject); // POST /tasks/bulk/move - Bulk move to project

// Individual task operations
router.get('/:id', validateUUIDParam(), TaskController.getTask);                    // GET /tasks/:id - Get task by ID
router.put('/:id', declareAnyAuthenticatedMayWrite('editing a task is reversible'), validateUUIDParam(), validateBody('UpdateTask'), TaskController.updateTask);                 // PUT /tasks/:id - Update task
// DELETE is a SOFT-delete since an earlier task — it sets `archived_at` (matching MCP
// `task_delete`), it does NOT destroy the row, and POST /:id/restore undoes it. The authz
// reason is updated to say so: the blast radius is now not just single-row, it is reversible.
router.delete('/:id', declareAnyAuthenticatedMayWrite('soft-deleting ONE task — sets archived_at, row survives, /restore undoes it'), validateUUIDParam(), TaskController.deleteTask);              // DELETE /tasks/:id - Soft-delete (archive) task
router.post('/:id/restore', declareAnyAuthenticatedMayWrite('restoring a soft-deleted task is additive — it destroys nothing'), validateUUIDParam(), TaskController.restoreTask); // POST /tasks/:id/restore - Un-archive task

// Task management operations
router.get('/:id/dependencies', validateUUIDParam(), TaskController.getTaskDependencies); // GET /tasks/:id/dependencies - Get dependencies
router.get('/:id/links', validateUUIDParam(), TaskController.getTaskLinks);               // GET /tasks/:id/links - Typed graph edges (thread box)
router.post('/:id/assign', declareAnyAuthenticatedMayWrite('assigning a task is reversible'), validateUUIDParam(), TaskController.assignTask);               // POST /tasks/:id/assign - Assign task
router.post('/:id/status', declareAnyAuthenticatedMayWrite('changing task status is reversible'), validateUUIDParam(), TaskController.updateTaskStatus);         // POST /tasks/:id/status - Update status

export default router;
