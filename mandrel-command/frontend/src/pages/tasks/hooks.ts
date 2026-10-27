/**
 * Tasks data hooks — every read/write rides the UNIFIED client (`api.tasks.*` /
 * `api.projects.*`) through react-query, mirroring the Contexts reference. The list feeds
 * the board columns + list view; stats feed the progress ops bar; the detail lazy-loads
 * the selected task; the typed-edge links feed the build-story box (the moat) from REAL
 * graph edges. NO axios/generated clients here.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api';
import type { UsePageProject } from '../../hooks/usePageProject';
import type { CreateTaskRequest } from '../../api/generated/models/CreateTaskRequest';
import type {
  Task,
  TaskStage,
  PunchMeta,
  TaskLink,
  TaskStats,
  TaskLeadTime,
  ThroughputPoint,
  CompletedByActor,
  ActorOption,
} from '../../types/task';
import { TASKS_CONFIG, ASSIGNEE_COMBOBOX_CONFIG, type RangeValue } from './config';
import { isServerResolvableId, normalizeSearchId } from './idSearch';
import type { ResolveResult } from '../../api/resolveClient';

/**
 * The page's request scope, as a function. Derived from `usePageProject`'s own contract
 * rather than re-declaring the axios-config signature here, for two reasons: it cannot
 * drift from the hook that produces it, and these page modules are guarded against
 * importing `axios` directly (Contexts/Decisions/Tasks `*.wiring.test.ts` — everything
 * goes through the unified `api` client, and a type-only import would still have tripped
 * a guard whose intent is exactly right).
 */
export type RequestScope = UsePageProject['scope'];

/**
 * The editable CORE fields of a task, mapped 1:1 to the backend UpdateTaskRequest (zod
 * `UpdateTaskSchema`). `status` uses the REAL enum (`todo | …`), not the stale generated
 * `TaskEntity.status` union — so it's typed here rather than reusing `Partial<TaskEntity>`.
 * A full update sends only the CHANGED subset (the drawer computes the diff).
 */
export type TaskUpdateInput = Partial<{
  title: string;
  description: string;
  type: CreateTaskRequest['type'];
  status: Task['status'];
  priority: CreateTaskRequest['priority'];
  assigned_to: string;
  tags: string[];
  /** Punch-list stage — the board's drag target. */
  stage: TaskStage;
  /** Shallow-merged into `metadata.punch` server-side. */
  punch: PunchMeta;
}>;

/**
 * GET /api/tasks — the board/list source. Pass a projectId to scope to one project
 * (server-side `project_id`); 'all' loads every project's tasks. Ordered by the backend
 * (priority, then newest). Cast to the real `Task` type (real status enum).
 *
 * `opts.status` runs a SERVER-SIDE status-filtered read (the backend `/api/tasks` accepts a
 * single `status` value) — used for the List-view status filter, where a
 * status set like Done can exceed the 2000-row list cap, so client-side filtering the shared
 * (capped, mixed) list would show an incomplete set. When `status` is set it joins BOTH the
 * react-query key (so switching status refetches, cached per status) AND the request params.
 * `opts.enabled` (default true) lets the caller gate the query so it only fires when a
 * specific status is actually selected on the List view. Called with NO opts, this behaves
 * EXACTLY as before (the shared unfiltered list that feeds the Board / OpsBar / Analytics).
 */
export function useTaskList(
  projectId: string | undefined,
  scope: RequestScope,
  opts?: { status?: Task['status']; archived?: boolean; enabled?: boolean },
) {
  const scoped = Boolean(projectId) && projectId !== 'all';
  const status = opts?.status;
  // ARCHIVED VIEW. Since Delete became a SOFT delete, the backend hides
  // `archived_at IS NOT NULL` rows from every default read — so this flag is the ONLY way
  // to see deleted tasks, and it must ride in the query KEY as well as the params or the
  // Archived view would render the cached live list. Omitted entirely when false, so an
  // ordinary list request is byte-identical to what it always sent.
  const archived = opts?.archived ?? false;
  const enabled = opts?.enabled ?? true;
  return useQuery<Task[]>({
    queryKey: ['tasks', 'list', projectId, status ?? null, archived ? 'archived' : null],
    queryFn: async () => {
      const { tasks } = await api.tasks.list(
        {
          limit: TASKS_CONFIG.listLimit,
          ...(scoped ? { project_id: projectId } : {}),
          ...(status ? { status } : {}),
          ...(archived ? { archived: 'only' } : {}),
        },
        scope(),
      );
      return tasks as unknown as Task[];
    },
    enabled,
    staleTime: TASKS_CONFIG.staleTimeMs,
  });
}

/** One board column's page: the rows loaded so far, plus the column's REAL total. */
export interface TaskColumnPage {
  tasks: Task[];
  total: number;
}

/**
 * GET /api/tasks, scoped to ONE board column — PER-COLUMN PAGING.
 *
 * ── WHY THIS EXISTS, SEPARATELY FROM `useTaskList` ──────────────────────────────────
 * The Board/PunchBoard used to split ONE shared, LIMIT-bound list into columns
 * client-side. Once a project passed the list cap, the terminal-order fix
 * sorts every `completed`-implying row after every open one, so the LIMIT cuts the tail
 * off the fetch — and the tail is EXCLUSIVELY the terminal columns (Done / Merged /
 * Deployed). A shared cap can only ever protect the columns lucky enough to sort first.
 *
 * Fetching one column at a time (server-side `status` or `stage`, an independent
 * `limit`) means one column's volume can never spend another column's budget — each
 * gets its own page, on its own axis. `total` rides the SAME query (`COUNT(*) OVER()`,
 * services/task.ts) so a column header can show a REAL count and a "load more" that
 * knows when it has genuinely reached the end, never a number it cannot back up.
 *
 * The query key is prefixed `['tasks','list', …]`, same as `useTaskList` — so the ONE
 * existing invalidation set (`invalidateTaskCaches`) already covers it; a write refreshes
 * every column exactly the way it already refreshes the shared list. `excludeStatus`
 * exists for the Punch board's stage columns, which must exclude the BLOCKED lane's
 * rows (`columnFor`, pages/punch/stage.ts renders a `status==='blocked'` task in the
 * blocked lane regardless of its stage).
 */
export function useTaskColumnPage(
  projectId: string | undefined,
  scope: RequestScope,
  opts: {
    status?: Task['status'];
    stage?: TaskStage;
    excludeStatus?: Task['status'];
    limit: number;
    enabled?: boolean;
  },
) {
  const scoped = Boolean(projectId) && projectId !== 'all';
  const { status, stage, excludeStatus, limit } = opts;
  const enabled = opts.enabled ?? true;
  return useQuery<TaskColumnPage>({
    queryKey: [
      'tasks',
      'list',
      'col',
      projectId,
      status ?? null,
      stage ?? null,
      excludeStatus ?? null,
      limit,
    ],
    queryFn: async () => {
      const { tasks, total } = await api.tasks.list(
        {
          limit,
          ...(scoped ? { project_id: projectId } : {}),
          ...(status ? { status } : {}),
          ...(stage ? { stage } : {}),
          ...(excludeStatus ? { exclude_status: excludeStatus } : {}),
        },
        scope(),
      );
      return { tasks: tasks as unknown as Task[], total };
    },
    enabled,
    staleTime: TASKS_CONFIG.staleTimeMs,
  });
}

/** GET /api/tasks/stats — the by-status/priority/type counts for the ops bar (real). */
export function useTaskStats(
  projectId: string | undefined,
  scope: RequestScope,
  enabled = true,
) {
  const scoped = Boolean(projectId) && projectId !== 'all';
  return useQuery<TaskStats>({
    queryKey: ['tasks', 'stats', projectId],
    queryFn: () => api.tasks.stats(scoped ? { project_id: projectId } : undefined, scope()),
    enabled,
    staleTime: TASKS_CONFIG.staleTimeMs,
  });
}

/**
 * GET /api/tasks/lead-time — the cycle-time (lead-time) analytics for the Analytics
 * view's "Avg cycle time" KPI. Scoped to a project the same way as the list/stats, and
 * RANGE-AWARE: the 7d/30d/90d/all selector drives the completion window server-side (the
 * `range` is part of the query key so switching the range refetches). REAL server-side
 * computation over completed tasks (`completed_at - created_at`).
 */
export function useTaskLeadTime(
  projectId: string | undefined,
  scope: RequestScope,
  range: RangeValue,
  enabled = true,
) {
  const scoped = Boolean(projectId) && projectId !== 'all';
  return useQuery<TaskLeadTime>({
    queryKey: ['tasks', 'leadTime', projectId, range],
    queryFn: () =>
      api.tasks.leadTime({ range, ...(scoped ? { project_id: projectId } : {}) }, scope()),
    enabled,
    staleTime: TASKS_CONFIG.staleTimeMs,
  });
}

/**
 * GET /api/tasks/throughput — the per-day throughput trend (completed vs created / day)
 * over the selected range window. Feeds the Analytics "Throughput vs created" chart + the
 * Throughput KPI. Only fetched when the Analytics view is active (`enabled`); the `range`
 * is in the query key so changing it refetches. REAL server-side series; `[]` = no activity.
 */
export function useTaskThroughput(
  projectId: string | undefined,
  scope: RequestScope,
  range: RangeValue,
  enabled = true,
) {
  const scoped = Boolean(projectId) && projectId !== 'all';
  return useQuery<ThroughputPoint[]>({
    queryKey: ['tasks', 'throughput', projectId, range],
    queryFn: () =>
      api.tasks.throughput({ range, ...(scoped ? { project_id: projectId } : {}) }, scope()),
    enabled,
    staleTime: TASKS_CONFIG.staleTimeMs,
  });
}

/**
 * GET /api/tasks/completed-by-actor — completed-task counts grouped by assignee over the
 * selected range window. Feeds the Analytics "Completed by actor" bars. Analytics-only
 * (`enabled`); range in the query key → range change refetches. REAL GROUP BY; `[]` = none.
 */
export function useTaskCompletedByActor(
  projectId: string | undefined,
  scope: RequestScope,
  range: RangeValue,
  enabled = true,
) {
  const scoped = Boolean(projectId) && projectId !== 'all';
  return useQuery<CompletedByActor[]>({
    queryKey: ['tasks', 'completedByActor', projectId, range],
    queryFn: () =>
      api.tasks.completedByActor({ range, ...(scoped ? { project_id: projectId } : {}) }, scope()),
    enabled,
    staleTime: TASKS_CONFIG.staleTimeMs,
  });
}

/**
 * SERVER-SIDE search-by-id. When the search box holds an id-SHAPED query
 * (`isServerResolvableId` — a full UUID or a ≥8-hex short id), resolve it against the
 * whole database via the SAME navigation resolver the `/r/<id8>` permalink uses
 * (`api.resolve.record` → GET /api/resolve/:id → backend `resolveNavId`), so the task is
 * found REGARDLESS of the header's project scope or the list page cap. For any non-id
 * query the hook stays disabled (never fires) and the existing client-side substring
 * filter (`matchesSearch`) handles prose/tags exactly as before.
 *
 * `api.resolve.record` never throws — it maps every outcome (unique / ambiguous / invalid
 * / notfound) to a discriminated `ResolveResult`, so the caller renders a clean state and
 * an id that resolves to nothing is a graceful "no task", never a crash or a misleading
 * unrelated row. The query key is the NORMALIZED id (dashes stripped) so the dashed and
 * undashed forms of one id share a cache entry.
 */
export function useResolveTaskSearch(query: string) {
  const enabled = isServerResolvableId(query);
  const id = enabled ? normalizeSearchId(query) : '';
  return useQuery<ResolveResult>({
    queryKey: ['tasks', 'idResolve', id],
    queryFn: () => api.resolve.record(id),
    enabled,
    retry: false,
    staleTime: TASKS_CONFIG.staleTimeMs,
  });
}

/** GET /api/tasks/:id — the full record for the thread detail (lazy; only when selected). */
export function useTask(id: string | null) {
  return useQuery<Task>({
    queryKey: ['tasks', 'detail', id],
    queryFn: () => api.tasks.get(id as string) as unknown as Promise<Task>,
    enabled: Boolean(id),
    staleTime: TASKS_CONFIG.staleTimeMs,
  });
}

/**
 * GET /api/tasks/actor-options — assignee SUGGESTIONS for the Assignee combobox
 *. Project-scoped like every other read on this page.
 *
 * `enabled` gates it to when the drawer is actually open in an editing mode, so simply
 * browsing the board does not fetch it. Failure is NON-FATAL by design: the caller falls
 * back to `[]` and the combobox degrades to a plain free-text input, which is exactly the
 * behaviour that shipped before this feature. Losing suggestions must never block a save.
 */
export function useTaskActorOptions(
  projectId: string | undefined,
  scope: RequestScope,
  enabled = true,
) {
  const scoped = Boolean(projectId) && projectId !== 'all';
  return useQuery<ActorOption[]>({
    queryKey: ['tasks', 'actorOptions', projectId],
    queryFn: () =>
      api.tasks.actorOptions({ ...(scoped ? { project_id: projectId } : {}) }, scope()),
    enabled,
    staleTime: ASSIGNEE_COMBOBOX_CONFIG.staleTimeMs,
  });
}

/**
 * GET /api/tasks/:id/links — the TYPED graph edges (the build-story moat), lazy per
 * selected task. REAL `links`-table rows — distinct from the task's `dependencies` array
 * and from any semantic list.
 */
export function useTaskLinks(id: string | null) {
  return useQuery<TaskLink[]>({
    queryKey: ['tasks', 'links', id],
    queryFn: () => api.tasks.links(id as string),
    enabled: Boolean(id),
    staleTime: TASKS_CONFIG.staleTimeMs,
  });
}

/**
 * Invalidate every task-derived read so the whole screen refreshes LIVE after a mutation:
 * the board/list (`list`), the progress bar + ops-bar + Building-now (`stats`), the analytics
 * (`leadTime` / `throughput` / `completedByActor`), and — when an `id` is given — that
 * record's detail + typed-edge links. One place so create/update/delete can't drift on which
 * caches they refresh. (Broad key prefixes → all project scopes of each read invalidate.)
 */
function invalidateTaskCaches(qc: ReturnType<typeof useQueryClient>, id?: string): void {
  qc.invalidateQueries({ queryKey: ['tasks', 'list'] });
  qc.invalidateQueries({ queryKey: ['tasks', 'stats'] });
  qc.invalidateQueries({ queryKey: ['tasks', 'leadTime'] });
  qc.invalidateQueries({ queryKey: ['tasks', 'throughput'] });
  qc.invalidateQueries({ queryKey: ['tasks', 'completedByActor'] });
  if (id) {
    qc.invalidateQueries({ queryKey: ['tasks', 'detail', id] });
    qc.invalidateQueries({ queryKey: ['tasks', 'links', id] });
  }
}

/**
 * POST /api/tasks — create a task from the CRUD drawer's create mode.
 *
 * ── THE WRITE SCOPE (an earlier epic §A1) ─────────────────────────────────────────────
 * `controllers/task.ts` reads `project_id` from the BODY, so this write was never going to
 * land in the ambient project the way `decision_record`/`decision_update`/`context_store`
 * would. It is scoped anyway, and the scope is derived from the SAME `project_id` the
 * payload carries (see TaskDrawer), for one measured reason: the backend's
 * projectScopeResolver AUTHORIZES EVERY project a request names. A body naming B under an
 * ambient header naming A is a request that names two projects, and a caller who has lost
 * access to the ambient default gets a 403 on a create that has nothing to do with it.
 * One project per request, and it is the one the form is filing into.
 *
 * On success, refreshes every task-derived read so the board, progress bar, Building-now
 * and analytics all reflect the new task immediately.
 */
export function useCreateTask(scope: RequestScope) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: Parameters<typeof api.tasks.create>[0]) =>
      api.tasks.create(payload, scope()),
    onSuccess: (task) => invalidateTaskCaches(qc, task?.id),
  });
}

/**
 * PUT /api/tasks/:id — FULL core-field update.
 *
 * UNSCOPED ON PURPOSE. This addresses the record by id; the controller never consults the
 * request's project, and the route is authorized against the RECORD's project by the
 * router.param choke point (backend/src/services/entityProjectScope.ts). The task on
 * screen may legitimately belong to another project when the drawer was opened from a
 * `/r/<id8>` link, so pinning the page's project here would name a project unrelated to
 * the row being written. Same for `useDeleteTask` / `useRestoreTask` below.
 *
 * Driven by the drawer's edit form. `updates` is the CHANGED subset the
 * drawer computed (a diff), so an unchanged field is never sent. Refreshes the same caches as
 * a status change PLUS this record's detail + links.
 */
export function useUpdateTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, updates }: { id: string; updates: TaskUpdateInput }) =>
      // The real status enum widens the stale generated union — cast to the endpoint's own
      // param type rather than the generated model.
      api.tasks.update(id, updates as Parameters<typeof api.tasks.update>[1]),
    onSuccess: (_data, { id }) => invalidateTaskCaches(qc, id),
  });
}

/**
 * DELETE /api/tasks/:id — the drawer's delete-confirm. A SOFT delete since an earlier task:
 * the backend sets `archived_at` (matching MCP `task_delete`), so the card drops off the
 * board and the counts fall, but the record survives in the Archived view and can be
 * restored. Refreshes every task-derived read on success.
 */
export function useDeleteTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.tasks.remove(id),
    onSuccess: (_data, id) => invalidateTaskCaches(qc, id),
  });
}

/**
 * POST /api/tasks/:id/restore — the UNDO for a soft delete, driven by the
 * drawer's Restore button on an archived task. Clears `archived_at` server-side; the same
 * cache sweep as delete puts the card back on the board and returns it to the counts.
 */
export function useRestoreTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.tasks.restore(id),
    onSuccess: (_data, id) => invalidateTaskCaches(qc, id),
  });
}
