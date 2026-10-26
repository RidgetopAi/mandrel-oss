/**
 * tasks domain — list / CRUD / stats / bulk / assign / status. All Command backend
 * (`/api/tasks/*`). There is NO generated TasksService, so these are the first
 * fully-typed task methods on the unified client (reusing generated TaskEntity /
 * CreateTaskRequest models).
 */
import { http, unwrapData, type ApiEnvelope } from '../request';
import type { AxiosRequestConfig } from 'axios';
import { withParams } from './scopeConfig';
import { getBrowserTimeZone } from '../../utils/browserTimeZone';
import type { TaskEntity } from '../generated/models/TaskEntity';
import type { CreateTaskRequest } from '../generated/models/CreateTaskRequest';
import type {
  TaskLink,
  TaskLeadTime,
  TaskStats,
  ThroughputPoint,
  CompletedByActor,
  ActorOption,
  TaskStage,
  PunchMeta,
} from '../../types/task';

/**
 * The PUNCH-LIST write extras (lane A's contract). Both create and
 * update accept them; `punch` is SHALLOW-MERGED into `metadata.punch` server-side, so an
 * update naming only `doneWhen` leaves `proofKind` alone. Setting `stage:'ready'` with a
 * required punch field missing is answered `400 { code:'PUNCH_INCOMPLETE', missing:[…] }`
 * — see `pages/punch/punchError.ts` for the client-side read of that shape.
 */
export interface TaskPunchWrite {
  stage?: TaskStage;
  punch?: PunchMeta;
}

/**
 * The create-only extras a punch form sends alongside `TaskPunchWrite`:
 * `dependencies` at task-create time, the SAME id shape (full UUID or
 * 8+-hex short id) `task_create` resolves server-side. `task_update` refuses a
 * `dependencies` change (mandrel-command backend `TaskService.updateTask`), so this is
 * declared only on `create`, never folded into `TaskPunchWrite` itself.
 */
export interface TaskCreateExtras extends TaskPunchWrite {
  dependencies?: string[];
}

/** GET /api/tasks stage filter — one stage or a comma-joined set (`ready,claimed`). */
export type TaskStageFilter = TaskStage | string;

/** A task the route did NOT move, with the route's reason. */
export interface BulkUpdateSkip {
  id: string;
  reason?: string;
}

interface TaskListData {
  tasks?: TaskEntity[];
  total?: number;
}

export const tasksApi = {
  /**
   * GET /api/tasks. `params.stage` (a `TaskStageFilter`: `'ready'` or `'ready,claimed'`)
   * runs lane A's server-side stage filter; omitted, the read is byte-identical to before.
   */
  async list(
    params?: Record<string, unknown> & { stage?: TaskStageFilter },
    config?: AxiosRequestConfig
  ): Promise<{ tasks: TaskEntity[]; total: number }> {
    const body = await http.get<ApiEnvelope<TaskListData>>('/tasks', withParams(config, params ?? {}));
    const data = unwrapData(body, 'Failed to list tasks') ?? {};
    return { tasks: (data.tasks ?? []) as TaskEntity[], total: data.total ?? 0 };
  },

  /** GET /api/tasks/:id */
  async get(id: string, config?: AxiosRequestConfig): Promise<TaskEntity> {
    const body = await http.get<ApiEnvelope<{ task?: TaskEntity }>>(
      `/tasks/${encodeURIComponent(id)}`,
      config
    );
    const task = unwrapData(body, 'Failed to fetch task')?.task;
    if (!task) {
      throw new Error('Task payload missing in response');
    }
    return task;
  },

  /**
   * POST /api/tasks — `stage` / `punch` / `dependencies` ride along for a punch
   * (TaskCreateExtras). `Omit<CreateTaskRequest, 'punch'>` drops the generated model's
   * stale `punch: { doneWhen?: string }` shape before `TaskCreateExtras` supplies the
   * real one — an intersection of the two `punch` types would collapse `doneWhen` back
   * down to `string`, silently rejecting the structured clause array.
   */
  async create(
    payload: Omit<CreateTaskRequest, 'punch'> & TaskCreateExtras,
    config?: AxiosRequestConfig
  ): Promise<TaskEntity> {
    const body = await http.post<ApiEnvelope<{ task?: TaskEntity }>>('/tasks', payload, config);
    const task = unwrapData(body, 'Failed to create task')?.task;
    if (!task) {
      throw new Error('Task create payload missing in response');
    }
    return task;
  },

  /** PUT /api/tasks/:id — `stage` / `punch` ride along for a punch (TaskPunchWrite). */
  async update(
    id: string,
    updates: Partial<TaskEntity> & TaskPunchWrite,
    config?: AxiosRequestConfig
  ): Promise<TaskEntity> {
    const body = await http.put<ApiEnvelope<{ task?: TaskEntity }>>(
      `/tasks/${encodeURIComponent(id)}`,
      updates,
      config
    );
    const task = unwrapData(body, 'Failed to update task')?.task;
    if (!task) {
      throw new Error('Task update payload missing in response');
    }
    return task;
  },

  /**
   * DELETE /api/tasks/:id — a SOFT delete since an earlier task. The backend sets
   * `archived_at` (the same column MCP `task_delete` uses); the row is NOT destroyed, it
   * drops out of the default list and is recoverable via `restore` below. Idempotent.
   */
  async remove(id: string, config?: AxiosRequestConfig): Promise<void> {
    const body = await http.del<ApiEnvelope<unknown>>(
      `/tasks/${encodeURIComponent(id)}`,
      config
    );
    unwrapData(body, 'Failed to delete task');
  },

  /**
   * POST /api/tasks/:id/restore — UNDO a soft delete. Clears
   * `archived_at`, so the task returns to the board with its status and typed edges
   * intact. Returns the restored record. Idempotent on a task that is already live.
   */
  async restore(id: string, config?: AxiosRequestConfig): Promise<TaskEntity> {
    const body = await http.post<ApiEnvelope<{ task?: TaskEntity }>>(
      `/tasks/${encodeURIComponent(id)}/restore`,
      {},
      config
    );
    const task = unwrapData(body, 'Failed to restore task')?.task;
    if (!task) {
      throw new Error('Task restore payload missing in response');
    }
    return task;
  },

  /**
   * GET /api/tasks/stats — the by-status/priority/type COUNTS (real, uncapped — a COUNT,
   * never the bounded list). The envelope nests the payload under `data.stats`, so we MUST
   * un-nest `.stats` to return the flat `TaskStats` (`total` / `by_status` at the top level)
   * — mirroring the sibling `projects.stats`. Dropping this un-nest returns `{ stats: {…} }`
   * one level too high, so every stats-fed surface (OpsBar / progress bar / Analytics KPIs)
   * reads `undefined` and silently renders 0. Guarded by tasks.test.ts (mutation-checked).
   */
  async stats(
    params?: Record<string, unknown>,
    config?: AxiosRequestConfig
  ): Promise<TaskStats> {
    const body = await http.get<ApiEnvelope<{ stats?: TaskStats }>>(
      '/tasks/stats',
      withParams(config, params ?? {})
    );
    return (unwrapData(body, 'Failed to fetch task stats')?.stats ?? {}) as TaskStats;
  },

  /**
   * GET /api/tasks/lead-time — the cycle-time (lead-time) analytics: a bucketed
   * distribution + avg/median/p90, computed server-side from `completed_at - created_at`
   * over completed tasks. Feeds the Analytics view's "Avg cycle time" KPI. REAL — an
   * empty `distribution` / `totalTasks: 0` means no completed tasks yet (honest empty).
   * The envelope nests the payload under `data.leadTimeData`.
   */
  async leadTime(
    params?: Record<string, unknown>,
    config?: AxiosRequestConfig
  ): Promise<TaskLeadTime> {
    const body = await http.get<ApiEnvelope<{ leadTimeData?: TaskLeadTime }>>(
      '/tasks/lead-time',
      withParams(config, params ?? {})
    );
    const data = unwrapData(body, 'Failed to fetch task lead time');
    return (
      data?.leadTimeData ?? {
        distribution: [],
        stats: { totalTasks: 0, averageLeadTime: 0, medianLeadTime: 0, p90LeadTime: 0 },
      }
    );
  },

  /**
   * GET /api/tasks/throughput — the per-day throughput trend (tasks completed vs created
   * per day) over the selected `range` window (7d/30d/90d/all), zero-filled + project-scoped.
   * Feeds the Analytics "Throughput vs created" chart + the Throughput KPI. REAL — an empty
   * `series` means no task activity of EITHER kind in the window (honest empty). The envelope
   * nests the payload under `data.series`.
   */
  async throughput(
    params?: Record<string, unknown>,
    config?: AxiosRequestConfig
  ): Promise<ThroughputPoint[]> {
    // Send the viewer's tz so per-day completed/created buckets align with the local
    // calendar — an 8pm-local completion must not slip to the next day.
    // Absent → the backend defaults to UTC (unchanged behaviour).
    const tz = getBrowserTimeZone();
    const body = await http.get<ApiEnvelope<{ series?: ThroughputPoint[] }>>(
      '/tasks/throughput',
      withParams(config, { ...(params ?? {}), ...(tz ? { tz } : {}) })
    );
    const data = unwrapData(body, 'Failed to fetch task throughput');
    return (data?.series ?? []) as ThroughputPoint[];
  },

  /**
   * GET /api/tasks/completed-by-actor — completed-task counts grouped by assignee over the
   * selected `range` window, count DESC (project-scoped). Feeds the Analytics "Completed by
   * actor" bars. REAL — a null assignee is a real `"unassigned"` bucket; an empty `actors`
   * means nothing completed in the window (honest empty). Nested under `data.actors`.
   */
  async completedByActor(
    params?: Record<string, unknown>,
    config?: AxiosRequestConfig
  ): Promise<CompletedByActor[]> {
    const body = await http.get<ApiEnvelope<{ actors?: CompletedByActor[] }>>(
      '/tasks/completed-by-actor',
      withParams(config, params ?? {})
    );
    const data = unwrapData(body, 'Failed to fetch completed-by-actor breakdown');
    return (data?.actors ?? []) as CompletedByActor[];
  },

  /**
   * GET /api/tasks/actor-options — assignee SUGGESTIONS for the caller's project scope
   *. Feeds the Assignee combobox.
   *
   * SUGGESTIONS ONLY: nothing here or downstream rejects an unlisted assignee. An empty
   * `actors` is an honest empty (a brand-new project with no history), not an error.
   * Nested under `data.actors`.
   */
  async actorOptions(
    params?: Record<string, unknown>,
    config?: AxiosRequestConfig
  ): Promise<ActorOption[]> {
    const body = await http.get<ApiEnvelope<{ actors?: ActorOption[] }>>(
      '/tasks/actor-options',
      withParams(config, params ?? {})
    );
    const data = unwrapData(body, 'Failed to fetch assignee suggestions');
    return (data?.actors ?? []) as ActorOption[];
  },

  /**
   * POST /api/tasks/bulk-update — move N tasks to a status each (the Kanban drag shape).
   *
   * THE SHAPE IS PER-ITEM, AND THAT IS THE ROUTE'S CHOICE, NOT THIS CLIENT'S.
   * This method used to post `{ ids, updates: {...} }` — one field set applied
   * to many ids, copied by analogy from `contexts.bulkUpdate`, whose route genuinely takes
   * that. THIS route does not: it answers the object form with `400 Updates must be an
   * array`, so the UI's only bulk-update affordance could not succeed. The route is the
   * deployed contract (it broadcasts one SSE event per moved task and only ever meant
   * per-item status moves), so the client was corrected to it, both ends asserted:
   * `tasksBulkUpdateShape.seam.test.ts` here, `bulkUpdateWireContract.test.ts` there.
   *
   * `skipped` is surfaced rather than swallowed: a task held by a live claim is NOT moved
   * and the route reports it. A caller that reads only `updated` would
   * re-hide exactly what that change existed to reveal.
   */
  async bulkUpdate(
    updates: ReadonlyArray<{ id: string; status: NonNullable<TaskEntity['status']> }>,
    config?: AxiosRequestConfig
  ): Promise<{ updated: number; skipped: BulkUpdateSkip[] }> {
    const body = await http.post<ApiEnvelope<{ updated?: number; skipped?: BulkUpdateSkip[] }>>(
      '/tasks/bulk-update',
      { updates },
      config
    );
    const data = unwrapData(body, 'Failed to bulk update tasks');
    return { updated: data?.updated ?? 0, skipped: data?.skipped ?? [] };
  },

  /** POST /api/tasks/bulk/move */
  async bulkMove(
    ids: string[],
    projectId: string,
    config?: AxiosRequestConfig
  ): Promise<{ moved: number }> {
    // The backend answers `{ updated, skipped, errors }` — it never sent `moved`, so this
    // read reported 0 for every successful move until punch fix round 1.
    const body = await http.post<ApiEnvelope<{ updated?: number; moved?: number }>>(
      '/tasks/bulk/move',
      { ids, project_id: projectId },
      config
    );
    const data = unwrapData(body, 'Failed to move tasks');
    return { moved: data?.updated ?? data?.moved ?? 0 };
  },

  /** POST /api/tasks/:id/assign */
  async assign(
    id: string,
    assignedTo: string,
    config?: AxiosRequestConfig
  ): Promise<TaskEntity> {
    const body = await http.post<ApiEnvelope<{ task?: TaskEntity }>>(
      `/tasks/${encodeURIComponent(id)}/assign`,
      { assigned_to: assignedTo },
      config
    );
    const task = unwrapData(body, 'Failed to assign task')?.task;
    if (!task) {
      throw new Error('Task assign payload missing in response');
    }
    return task;
  },

  /** POST /api/tasks/:id/status — used by the kanban drag. */
  async setStatus(
    id: string,
    status: TaskEntity['status'],
    config?: AxiosRequestConfig
  ): Promise<TaskEntity> {
    const body = await http.post<ApiEnvelope<{ task?: TaskEntity }>>(
      `/tasks/${encodeURIComponent(id)}/status`,
      { status },
      config
    );
    const task = unwrapData(body, 'Failed to update task status')?.task;
    if (!task) {
      throw new Error('Task status payload missing in response');
    }
    return task;
  },

  /**
   * GET /api/tasks/:id/links — the TYPED graph edges (the TreeWalker "build story" box)
   * touching a task, both directions, resolved to each target's title + kind. This is
   * STRUCTURE (real `links` rows), NOT the task's `dependencies` array and NOT any
   * semantic list — never conflate them. Mirrors `api.contexts.links` exactly.
   */
  async links(id: string, config?: AxiosRequestConfig): Promise<TaskLink[]> {
    const body = await http.get<ApiEnvelope<TaskLink[]>>(
      `/tasks/${encodeURIComponent(id)}/links`,
      config
    );
    return (unwrapData(body, 'Failed to fetch task links') ?? []) as TaskLink[];
  },
};

export type TasksApi = typeof tasksApi;
