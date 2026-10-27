import { Response } from 'express';
import { AuthenticatedRequest } from '../types/auth';
import { resolveListScope, resolveCallerScope } from '../services/projectListScope';
import { TaskService, CreateTaskRequest, UpdateTaskRequest, TaskFilter, PunchIncompleteRequestError } from '../services/task';
import { sseService } from '../services/sse';
import { AidisDbEvent } from '../types/events';
import { logger } from '../config/logger';
import { clampListLimit, parseOffset, parseRangeDays } from '../config/taskAnalytics';
import { resolveAggTimeZone } from '../config/analyticsTime';
import { normalizeActor } from '../config/sessionActor';

/**
 * Task Controller
 * Handles all task management HTTP endpoints
 */

export class TaskController {
  /**
   * The session actor performing this request. It is forwarded to the mcp-server as
   * `X-Actor-ID` on every delegated task write, and the tool applies the assignee
   * TRANSITION STAMP from it (an earlier task Phase 2). Since an earlier task the rule itself
   * lives in ONE place — `mcp-server/src/config/assigneeStamp.ts` — and this backend no
   * longer carries a mirror of it to keep in sync.
   *
   * NOT A NEW DERIVATION. `req.user?.username` is the same principal `createTask` already
   * forwards as `X-Actor-ID` on its delegated `task_create`; `normalizeActor` is the
   * existing `config/sessionActor.ts` rule that exists precisely so this surface and the
   * mcp-server cannot diverge on casing — which is what collapses `Operator` and `operator` into
   * one actor instead of two buckets on the board.
   *
   * `undefined` when there is no derivable principal, and the stamp rule's answer to that
   * is to leave `assigned_to` empty rather than write a placeholder.
   */
  private static stampActor(req: AuthenticatedRequest): string | undefined {
    return normalizeActor(req.user?.username);
  }

  /**
   * GET /tasks - Get all tasks with optional filtering
   */
  static async getTasks(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      // UNSCOPED MEANS "THE CALLER'S PROJECTS", NEVER "ALL PROJECTS" (an earlier task
      // item 7). This was `const projectId = getRequestProjectId(req); if (projectId)
      // filter.project_id = projectId;` — so omitting the project returned every project's
      // tasks to any authenticated user. `scope` is a required field of TaskFilter now.
      const filter: TaskFilter = { scope: await resolveListScope(req) };
      if (req.query.assigned_to) filter.assigned_to = req.query.assigned_to as string;
      if (req.query.status) {
        filter.status = Array.isArray(req.query.status) 
          ? req.query.status as string[]
          : [req.query.status as string];
      }
      if (req.query.priority) {
        filter.priority = Array.isArray(req.query.priority)
          ? req.query.priority as string[]
          : [req.query.priority as string];
      }
      // THE PUNCH LIST LANE FILTER (migration 101). Accepts either
      // `?stage=ready` / repeated `?stage=ready&stage=claimed` (the Array.isArray branch,
      // same shape as `status`/`priority` above) OR one comma-separated value
      // `?stage=ready,claimed` — the second form is this param's own addition, since a
      // board filter link is naturally built as one query string.
      if (req.query.stage) {
        filter.stage = Array.isArray(req.query.stage)
          ? (req.query.stage as string[]).flatMap((s) => s.split(','))
          : (req.query.stage as string).split(',');
      }
      if (req.query.type) filter.type = req.query.type as string;
      if (req.query.tags) {
        filter.tags = Array.isArray(req.query.tags)
          ? req.query.tags as string[]
          : [req.query.tags as string];
      }
      if (req.query.search) filter.search = req.query.search as string;

      // ARCHIVE SCOPE — `?archived=only` is the Archived view,
      // `?archived=include` shows both; ANY other value (including absent, empty, or a
      // typo) falls through to the DEFAULT of live-rows-only. Fail-closed on purpose: a
      // malformed query param must never be the thing that leaks soft-deleted rows back
      // onto the board.
      const archivedScope = typeof req.query.archived === 'string' ? req.query.archived : '';
      if (archivedScope === 'only') filter.archived_only = true;
      else if (archivedScope === 'include') filter.include_archived = true;

      // PER-COLUMN PAGING exclusion — see TaskFilter.excludeStatus. Same
      // shape as `status`/`stage` above (repeated param or one comma-separated value).
      if (req.query.exclude_status) {
        filter.excludeStatus = Array.isArray(req.query.exclude_status)
          ? (req.query.exclude_status as string[]).flatMap((s) => s.split(','))
          : (req.query.exclude_status as string).split(',');
      }

      // Pagination — bounded server-side from named config (was dead: config.ts sent
      // limit:500 but the list ignored it → unbounded rows). clamp/parse default + cap.
      filter.limit = clampListLimit(req.query.limit);
      filter.offset = parseOffset(req.query.offset);

      // `total` is the TRUE count matching every filter above (a `COUNT(*) OVER()` in the
      // same query) — was `tasks.length` (the CAPPED page length), which a
      // per-column "N of TOTAL" / load-more affordance cannot tell apart from "there are no
      // more rows". A column header must never claim a count it cannot reach.
      const { tasks, total } = await TaskService.getTasks(filter);

      res.json({
        success: true,
        data: {
          tasks,
          total
        }
      });
    } catch (error) {
      logger.error('Get tasks error', { error });
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get tasks'
      });
    }
  }

  /**
   * GET /tasks/:id - Get single task by ID
   */
  static async getTask(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const task = await TaskService.getTaskById(id);

      if (!task) {
        res.status(404).json({
          success: false,
          error: 'Task not found'
        });
        return;
      }

      res.json({
        success: true,
        data: { task }
      });
    } catch (error) {
      logger.error('Get task error', { error });
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get task'
      });
    }
  }

  /**
   * POST /tasks - Create new task
   */
  static async createTask(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const taskData: CreateTaskRequest = req.body;

      // Validation
      if (!taskData.title || taskData.title.trim() === '') {
        res.status(400).json({
          success: false,
          error: 'Task title is required'
        });
        return;
      }

      // the project a record is CREATED IN / MOVED TO — the subject of
      // the write, not the viewer's current scope, so getRequestProjectId() is the wrong value
      // (the header names the project being viewed and would win over the body). Authorized
      // before this line because the resolver authorizes EVERY candidate and body.project_id
      // is a PROJECT_SCOPE_SOURCE, so a cross-project write needs access to both ends.
      if (!taskData.project_id) {
        res.status(400).json({
          success: false,
          error: 'Project ID is required'
        });
        return;
      }

      // Forward the logged-in principal as the actor (X-Actor-ID) so the delegated
      // task_create attributes the task to the human who clicked — same pattern as the
      // naming controller (req.user?.username).
      const task = await TaskService.createTask(taskData, req.user?.username);

      // Broadcast task creation via SSE
      const taskCreatedEvent: AidisDbEvent = {
        entity: 'tasks',
        action: 'insert',
        id: task.id,
        projectId: task.project_id,
        at: new Date().toISOString()
      };
      sseService.broadcastDbEvent(taskCreatedEvent);

      res.status(201).json({
        success: true,
        data: { task }
      });
    } catch (error) {
      // THE PUNCH LIST LANE (migration 101): a caller-fixable input
      // error is a 400 with the SAME code/missing the mcp-server tool refused with —
      // never the generic 500 below.
      if (error instanceof PunchIncompleteRequestError) {
        res.status(400).json({
          success: false,
          error: error.message,
          code: error.code,
          missing: error.missing,
        });
        return;
      }
      logger.error('Create task error', { error });
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to create task'
      });
    }
  }

  /**
   * PUT /tasks/:id - Update task
   */
  static async updateTask(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const updates: UpdateTaskRequest = req.body;

      const task = await TaskService.updateTask(id, updates, TaskController.stampActor(req));

      if (!task) {
        res.status(404).json({
          success: false,
          error: 'Task not found'
        });
        return;
      }

      // Broadcast task update via SSE
      const taskUpdatedEvent: AidisDbEvent = {
        entity: 'tasks',
        action: 'update',
        id: task.id,
        projectId: task.project_id,
        at: new Date().toISOString()
      };
      sseService.broadcastDbEvent(taskUpdatedEvent);

      res.json({
        success: true,
        data: { task }
      });
    } catch (error) {
      // THE PUNCH LIST LANE (migration 101) — see createTask's catch.
      if (error instanceof PunchIncompleteRequestError) {
        res.status(400).json({
          success: false,
          error: error.message,
          code: error.code,
          missing: error.missing,
        });
        return;
      }
      logger.error('Update task error', { error });
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to update task'
      });
    }
  }

  /**
   * DELETE /tasks/:id — SOFT-delete (archive) a task.
   *
   * The row is NOT destroyed: `archived_at` is set, matching MCP `task_delete` on the
   * same table. It leaves the default list/board/counts and is recoverable via
   * POST /tasks/:id/restore. Idempotent — a repeat delete is 200, not an error.
   */
  static async deleteTask(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const result = await TaskService.deleteTask(id);

      if (!result.found) {
        res.status(404).json({
          success: false,
          error: 'Task not found'
        });
        return;
      }

      // Broadcast via SSE. The action stays `delete` — from every listener's point of
      // view the task has left the board, which is exactly what a soft delete means to a
      // reader; renaming it would break existing SSE consumers for no gain.
      const taskDeletedEvent: AidisDbEvent = {
        entity: 'tasks',
        action: 'delete',
        id: id,
        // Note: We don't have project_id for deleted tasks, so no projectId filter
        at: new Date().toISOString()
      };
      sseService.broadcastDbEvent(taskDeletedEvent);

      res.json({
        success: true,
        data: {
          message: result.alreadyArchived
            ? 'Task was already deleted'
            : 'Task deleted successfully',
          archived: true,
          archived_at: result.archivedAt,
          already_archived: result.alreadyArchived
        }
      });
    } catch (error) {
      logger.error('Delete task error', { error });
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to delete task'
      });
    }
  }

  /**
   * POST /tasks/:id/restore — UNDO a soft delete.
   *
   * Clears `archived_at`, returning the task to the default list/board/counts with its
   * status and every typed edge intact. The counterpart the hard delete could never have.
   * Idempotent — restoring a live task is a 200 no-op.
   */
  static async restoreTask(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const result = await TaskService.restoreTask(id);

      if (!result.found) {
        res.status(404).json({
          success: false,
          error: 'Task not found'
        });
        return;
      }

      const task = await TaskService.getTaskById(id);

      // `update` (not a new action) so existing SSE consumers put the row back on the
      // board without needing to learn a verb — a restore IS the task changing state.
      const taskRestoredEvent: AidisDbEvent = {
        entity: 'tasks',
        action: 'update',
        id: id,
        projectId: task?.project_id,
        at: new Date().toISOString()
      };
      sseService.broadcastDbEvent(taskRestoredEvent);

      res.json({
        success: true,
        data: { task, message: 'Task restored successfully' }
      });
    } catch (error) {
      logger.error('Restore task error', { error });
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to restore task'
      });
    }
  }

  /**
   * GET /tasks/stats - Get task statistics
   */
  static async getTaskStats(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      // Oracle Phase 1: Unified project filtering - header takes priority over query param
      // Range-aware (item 4) through the SAME `parseRangeDays` the sibling
      // `getLeadTimeDistribution` uses — not a second mechanism. Absent `?range=` resolves
      // to the `all` default, so every existing caller keeps its unbounded answer.
      const rangeDays = parseRangeDays(req.query.range);
      const stats = await TaskService.getTaskStats(await resolveListScope(req), rangeDays);

      res.json({
        success: true,
        data: { stats }
      });
    } catch (error) {
      logger.error('Get task stats error', { error });
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get task statistics'
      });
    }
  }

  /**
   * GET /tasks/lead-time - Get lead time distribution analytics
   */
  static async getLeadTimeDistribution(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      // Oracle Phase 1: Unified project filtering - header takes priority over query param
      // Range-aware (Analytics 7d/30d/90d/all selector) — resolve to a window in days
      // (null = "All"). Defaults safely when absent/invalid (named config).
      const rangeDays = parseRangeDays(req.query.range);
      const leadTimeData = await TaskService.getLeadTimeDistribution(
        await resolveListScope(req),
        rangeDays
      );

      res.json({
        success: true,
        data: { leadTimeData }
      });
    } catch (error) {
      logger.error('Get lead time distribution error', { error });
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get lead time distribution'
      });
    }
  }

  /**
   * GET /tasks/throughput - Per-day throughput series (completed vs created) over a range.
   * Feeds the Analytics "Throughput vs created" trend + the Throughput KPI. Honest empty
   * (`[]`) when no completions in the window.
   */
  static async getThroughputSeries(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      // Unified project filtering — header takes priority over query param.
      const rangeDays = parseRangeDays(req.query.range);
      // Bucket per-day in the viewer's tz (an earlier task — Throughput chart); default UTC.
      const tz = resolveAggTimeZone(req.query.tz);
      const series = await TaskService.getThroughputSeries(
        await resolveListScope(req),
        rangeDays,
        tz
      );

      res.json({
        success: true,
        data: { series }
      });
    } catch (error) {
      logger.error('Get throughput series error', { error });
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get throughput series'
      });
    }
  }

  /**
   * GET /tasks/completed-by-actor - Completed-task counts grouped by assignee over a range.
   * Feeds the Analytics "Completed by actor" bars. Honest empty (`[]`) when nothing
   * completed in the window; tasks with no assignee count as `unassigned` (real bucket).
   */
  static async getCompletedByActor(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      // Unified project filtering — header takes priority over query param.
      const rangeDays = parseRangeDays(req.query.range);
      const actors = await TaskService.getCompletedByActor(
        await resolveListScope(req),
        rangeDays
      );

      res.json({
        success: true,
        data: { actors }
      });
    } catch (error) {
      logger.error('Get completed-by-actor error', { error });
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get completed-by-actor breakdown'
      });
    }
  }

  /**
   * GET /tasks/actor-options - Assignee SUGGESTIONS for the caller's project scope.
   *
   * Feeds the Assignee combobox. SUGGESTIONS ONLY — nothing here
   * or downstream rejects an unlisted assignee; `tasks.assigned_to` stays free-form.
   *
   * SCOPE: `resolveListScope(req)`, exactly as the neighbouring multi-row reads on this
   * controller do. Authentication is enforced by `authenticateToken` on the router, and
   * `resolveListScope` throws `ListScopeCallerMissingError` rather than answering
   * "unscoped" if it were ever reached without one.
   */
  static async getActorOptions(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const actors = await TaskService.getActorOptions(await resolveListScope(req));
      res.json({
        success: true,
        data: { actors }
      });
    } catch (error) {
      logger.error('Get actor options error', { error });
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get actor options'
      });
    }
  }

  /**
   * GET /tasks/:id/dependencies - Get task dependencies
   */
  static async getTaskDependencies(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const dependencies = await TaskService.getTaskDependencies(id);
      
      res.json({
        success: true,
        data: { dependencies }
      });
    } catch (error) {
      logger.error('Get task dependencies error', { error });
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get task dependencies'
      });
    }
  }

  /**
   * GET /tasks/:id/links - Get the TYPED GRAPH EDGES touching a task.
   *
   * Returns the real `links`-table edges (both directions) resolved to their other
   * endpoint's title/kind — the TreeWalker "build story" moat. This is DISTINCT from
   * the task's `dependencies` array (and from any semantic list); never conflate them.
   * Mirrors ContextController.getContextLinks exactly.
   */
  static async getTaskLinks(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const links = await TaskService.getTaskLinks(id);

      res.json({
        success: true,
        data: links,
        message: `Found ${links.length} linked records`
      });
    } catch (error) {
      logger.error('Get task links error', { error });
      res.status(500).json({
        success: false,
        message: 'Failed to get task links',
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * POST /tasks/bulk-update - Bulk update tasks (for Kanban drag-and-drop)
   */
  static async bulkUpdateTasks(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { updates } = req.body;

      if (!Array.isArray(updates)) {
        res.status(400).json({
          success: false,
          error: 'Updates must be an array'
        });
        return;
      }

      // Validate update format
      for (const update of updates) {
        if (!update.id || !update.status) {
          res.status(400).json({
            success: false,
            error: 'Each update must have id and status'
          });
          return;
        }
      }

      // PER-ITEM OUTCOMES. bulkUpdateStatus delegates to the mcp-server
      // `task_bulk_update` tool, so it is no longer ONE database transaction and a partial
      // batch is a real outcome — see the doc on the service method for the transactionality
      // decision. `skipped` carries every id that did NOT move, with the reason.
      // CALLER SCOPE (REALIGN step 9): ids come from the body, so no
      // `router.param('id')` authorization runs — the scope resolved here is the whole of it.
      const { tasks: updatedTasks, skipped } = await TaskService.bulkUpdateStatus(
        updates,
        await resolveListScope(req),
        TaskController.stampActor(req)
      );

      // Broadcast individual task updates via SSE
      for (const task of updatedTasks) {
        const taskUpdatedEvent: AidisDbEvent = {
          entity: 'tasks',
          action: 'update',
          id: task.id,
          projectId: task.project_id,
          at: new Date().toISOString()
        };
        sseService.broadcastDbEvent(taskUpdatedEvent);
      }

      res.json({
        success: true,
        data: {
          tasks: updatedTasks,
          updated: updatedTasks.length,
          // ADDITIVE and only when non-empty, so a fully successful batch is byte-identical
          // to the old response. A skip used to be invisible (the raw `WHERE id = $2` just
          // matched nothing); reporting it is the point of the change, not a side effect.
          ...(skipped.length > 0 ? { skipped } : {})
        }
      });
    } catch (error) {
      logger.error('Bulk update tasks error', { error });
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to bulk update tasks'
      });
    }
  }

  /**
   * POST /tasks/:id/assign - Assign task to agent
   */
  static async assignTask(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const { assigned_to } = req.body;

      if (!assigned_to) {
        res.status(400).json({
          success: false,
          error: 'Agent ID is required for assignment'
        });
        return;
      }

      const task = await TaskService.updateTask(id, { assigned_to }, TaskController.stampActor(req));

      if (!task) {
        res.status(404).json({
          success: false,
          error: 'Task not found'
        });
        return;
      }

      // Broadcast task assignment via SSE
      const taskUpdatedEvent: AidisDbEvent = {
        entity: 'tasks',
        action: 'update',
        id: task.id,
        projectId: task.project_id,
        at: new Date().toISOString()
      };
      sseService.broadcastDbEvent(taskUpdatedEvent);

      res.json({
        success: true,
        data: { task }
      });
    } catch (error) {
      logger.error('Assign task error', { error });
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to assign task'
      });
    }
  }

  /**
   * POST /tasks/:id/status - Update task status with automatic status transitions
   */
  static async updateTaskStatus(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const { status, note } = req.body;

      if (!status) {
        res.status(400).json({
          success: false,
          error: 'Status is required'
        });
        return;
      }

      const validStatuses = ['todo', 'in_progress', 'blocked', 'completed', 'cancelled'];
      if (!validStatuses.includes(status)) {
        res.status(400).json({
          success: false,
          error: `Invalid status. Must be one of: ${validStatuses.join(', ')}`
        });
        return;
      }

      // Update metadata with status change note if provided
      const updates: UpdateTaskRequest = { status };
      if (note) {
        // Get current task to preserve metadata
        const currentTask = await TaskService.getTaskById(id);
        if (currentTask) {
          const metadata = { ...currentTask.metadata };
          if (!metadata.status_history) metadata.status_history = [];
          metadata.status_history.push({
            status,
            note,
            timestamp: new Date().toISOString()
          });
          updates.metadata = metadata;
        }
      }

      const task = await TaskService.updateTask(id, updates, TaskController.stampActor(req));

      if (!task) {
        res.status(404).json({
          success: false,
          error: 'Task not found'
        });
        return;
      }

      // Broadcast status change via SSE
      const taskUpdatedEvent: AidisDbEvent = {
        entity: 'tasks',
        action: 'update',
        id: task.id,
        projectId: task.project_id,
        at: new Date().toISOString()
      };
      sseService.broadcastDbEvent(taskUpdatedEvent);

      res.json({
        success: true,
        data: { task }
      });
    } catch (error) {
      logger.error('Update task status error', { error });
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to update task status'
      });
    }
  }

  /**
   * POST /tasks/bulk/move - Bulk move tasks to different project
   */
  static async bulkMoveToProject(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      // `project_id` here is the move DESTINATION, not the scope
      // of the request, so getRequestProjectId() is the wrong value — under the documented
      // precedence the header (the project the user is currently viewing, i.e. the SOURCE)
      // beats the body and would silently move tasks back into the project they came from.
      // Reading it raw is safe because the resolver authorizes EVERY candidate, not just
      // the winner (services/projectScopeResolver.ts): body.project_id is a
      // PROJECT_SCOPE_SOURCE, so this destination has already been authorized for this
      // caller, and a header naming the source has been authorized too. A cross-project
      // move therefore requires access to BOTH ends, which is the correct rule.
      // move DESTINATION (see above), authorized as body.project_id.
      // eslint-disable-next-line no-restricted-syntax -- move DESTINATION, authorized as body.project_id
      const { ids, project_id } = req.body;

      if (!Array.isArray(ids) || ids.length === 0) {
        res.status(400).json({
          success: false,
          error: 'Invalid or empty task IDs array'
        });
        return;
      }

      if (!project_id) {
        res.status(400).json({
          success: false,
          error: 'Target project_id is required'
        });
        return;
      }

      // SOURCE SCOPE (REALIGN step 9). The destination above is authorized;
      // the rows being moved OUT were not — `UPDATE … WHERE id = ANY(ids)` re-homed any task
      // on the box. resolveCallerScope, not resolveListScope: with no header the resolved
      // project IS body.project_id (the destination), which would scope the move to rows
      // already sitting in it.
      const result = await TaskService.bulkMoveToProject(
        ids,
        project_id,
        await resolveCallerScope(req),
        TaskController.stampActor(req)
      );

      // Broadcast task update events via SSE for each task that actually MOVED — not the
      // out-of-scope `skipped` ids and not the `errors` the delegated move refused.
      const notMoved = new Set([...result.skipped, ...result.errors.map((e) => e.id)]);
      for (const id of ids.filter((moved: string) => !notMoved.has(moved))) {
        const taskUpdatedEvent: AidisDbEvent = {
          entity: 'tasks',
          action: 'update',
          id,
          projectId: project_id,
          at: new Date().toISOString()
        };
        sseService.broadcastDbEvent(taskUpdatedEvent);
      }

      res.json({
        success: true,
        data: result,
        message: `${result.updated} tasks moved successfully`
      });
    } catch (error) {
      logger.error('Bulk move tasks error', { error });
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to bulk move tasks'
      });
    }
  }
}