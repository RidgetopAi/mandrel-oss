/**
 * Analytics data hooks — every read rides the UNIFIED client (`api.sessions.*` /
 * `api.tasks.*` / `api.projects.*`) through react-query, mirroring the Decisions/Contexts
 * reference. NO axios / generated clients here.
 *
 * Data policy: wire ONLY to live/built endpoints. The KPI strip + hero
 * both DERIVE from the single LIVE `/api/sessions/trends` series (one source, no fabricated
 * baseline); work-mix from LIVE `/api/tasks/stats`; productive + token-rhythm from their
 * BUILT endpoints; "Activity by actor" from LIVE `/api/sessions/contexts-by-actor`, which
 * returns the bars AND their coverage totals in ONE payload so the two cannot disagree.
 */
import { useQuery } from '@tanstack/react-query';
import type { AxiosRequestConfig } from 'axios';
import { api } from '../../api';
import type {
  SessionTrendPoint,
  ProductiveSession,
  TokenUsagePattern,
  ContextsByActor,
} from '../../api/domains/sessions';
import type { TaskStats, TaskLeadTime } from '../../types/task';
import { ANALYTICS_CONFIG, type RangeValue } from './config';

/**
 * THE PAGE'S PROJECT SCOPE, passed to every hook below (epic 41293984 §A1/§E).
 *
 * `projectId` is sent RAW as the endpoint's `project_id` query param, the literal `'all'`
 * included: the backend reads `'all'` on a query source as EXPLICITLY UNSCOPED
 * (projectScopeResolver's `UNSCOPED_SENTINEL`), which is a deliberate, different request
 * from omitting the param — omitting it means "scope me by the ambient X-Project-ID
 * header", i.e. the user's default project, which is not necessarily what this page shows.
 *
 * `scope()` pins that header per request and THROWS rather than falling back, so every
 * query below is gated on `enabled` (the caller's `project.ready`).
 */
export interface PageScope {
  /** A project uuid, or the literal `'all'`. `undefined` while the list is loading. */
  projectId: string | undefined;
  /** `usePageProject().scope` — the per-request header pin. */
  scope: () => AxiosRequestConfig;
  /** `usePageProject().ready` — false until `scope()` can succeed. */
  enabled: boolean;
}

export interface AnalyticsScope extends PageScope {
  /** Pivot window in days (the Range segmented control). */
  days: RangeValue;
  /**
   * The pivot bar's actor slice, when one is chosen (item 6). Only reads
   * that ACCEPT an actor carry it; the rest take the same scope object without it, so a
   * hook cannot silently claim a filter its endpoint does not apply.
   */
  actor?: string;
}

/**
 * GET /api/sessions/trends — the per-day activity series (LIVE). The ONE source the KPI
 * strip + the hero chart share; scoped by window + project.
 */
export function useActivityTrends(scope: AnalyticsScope) {
  return useQuery<SessionTrendPoint[]>({
    // `actor` is IN THE KEY as well as in the request. A filter that changes the answer
    // but not the cache key draws the previous actor's series under the new actor's label.
    queryKey: ['analytics', 'trends', scope.days, scope.projectId ?? null, scope.actor ?? null],
    enabled: scope.enabled,
    queryFn: () =>
      api.sessions.trends(
        { days: scope.days, projectId: scope.projectId, actor: scope.actor },
        scope.scope(),
      ),
    staleTime: ANALYTICS_CONFIG.staleTimeMs,
  });
}

/**
 * GET /api/tasks/stats — the work-mix status counts (LIVE), WINDOWED.
 *
 * `days` was in neither the key nor the request, so this panel answered all-time under
 * the range control and was not even re-fetched when the control moved. The window goes
 * on the wire as `range=<n>d` — the vocabulary `/api/tasks/*` already speaks
 * (`config/taskAnalytics.ts` TASK_RANGE_DAYS, as used by the lead-time sibling), rather
 * than a second day-count spelling invented for this one caller.
 */
export function useTaskStats({ projectId, scope, enabled, days }: AnalyticsScope) {
  const range = taskRangeParam(days);
  return useQuery<TaskStats>({
    queryKey: ['analytics', 'taskStats', projectId ?? null, range],
    enabled,
    queryFn: () =>
      api.tasks.stats(
        { range, ...(projectId ? { project_id: projectId } : {}) },
        scope()
      ) as Promise<TaskStats>,
    staleTime: ANALYTICS_CONFIG.staleTimeMs,
  });
}

/**
 * GET /api/tasks/lead-time — the completed-task lead-time analytics, WINDOWED.
 * Feeds TWO of the Work-mix flow figures from ONE read:
 *   • `stats.totalTasks` — the count of tasks whose `completed_at` falls in the window,
 *     which is the COMPLETED-PER-DAY numerator;
 *   • `stats.medianLeadTime` — median days from created to done.
 *
 * WHY THIS ENDPOINT RATHER THAN A NEW ONE, AND WHY NOT `/tasks/throughput`. The task's
 * standing warning is that two definitions of one quantity is the drift we keep paying
 * for, and `getLeadTimeDistribution` (backend services/task.ts) already computes lead time
 * with `parseRangeDays`. Its population is exactly the one the flow block needs — `status
 * = 'completed' AND completed_at IS NOT NULL` filtered by `completed_at >= NOW() -
 * make_interval(days => n)` — so the median and the count come from the SAME rows and
 * cannot disagree. It is also the same `NOW() - make_interval` window predicate that
 * `getTaskStats` uses for the cohort bar, so the two halves of this panel are cut on the
 * same window boundary. `/tasks/throughput` also carries a completed count, but it buckets
 * by LOCAL CALENDAR DAY (`(completed_at AT TIME ZONE $tz)::date >= today - (n-1)`), which
 * is a materially different window — 284 vs 288 rows on prod for the same "30 days" — and
 * mixing the two boundaries inside one panel is precisely the mismatch being avoided.
 *
 * The `completed_at IS NOT NULL` guard is the endpoint's own, and it matters: 207 rows on
 * prod are `status = 'completed'` with no completion stamp, and they must not be counted
 * into a per-day rate at a date nobody knows.
 */
export function useTaskLeadTime({ projectId, scope, enabled, days }: AnalyticsScope) {
  const range = taskRangeParam(days);
  return useQuery<TaskLeadTime>({
    queryKey: ['analytics', 'taskLeadTime', projectId ?? null, range],
    enabled,
    queryFn: () =>
      api.tasks.leadTime({ range, ...(projectId ? { project_id: projectId } : {}) }, scope()),
    staleTime: ANALYTICS_CONFIG.staleTimeMs,
  });
}

/**
 * GET /api/tasks/stats with NO window — the ALL-TIME status counts, for "Open now".
 *
 * This is a second call to the same endpoint as `useTaskStats` ON PURPOSE, and the
 * difference is the whole point of the figure. "Open now" is a statement about the board
 * as it stands, not about a window: a task filed 200 days ago and still blocked is open
 * today, and the windowed read cannot see it. Measured on prod 2026-08-10: the 30d cohort
 * holds 114 open tasks while the board holds 163. Reading the windowed payload for this
 * would silently print the smaller number under a label that says "now".
 *
 * `UNWINDOWED_RANGE` is sent EXPLICITLY rather than by omitting the param. The backend's
 * `parseRangeDays` resolves an absent/unknown value to the same `all`, so the wire result
 * is identical — but an explicit token says in the request that unbounded is the intent,
 * and it keeps this query's cache key distinguishable from the windowed one (the range
 * control only ever produces `7d`/`30d`/`90d`, so the two can never collide).
 */
export const UNWINDOWED_RANGE = 'all';

export function useOpenTaskCounts({ projectId, scope, enabled }: PageScope) {
  return useQuery<TaskStats>({
    queryKey: ['analytics', 'taskStats', projectId ?? null, UNWINDOWED_RANGE],
    enabled,
    queryFn: () =>
      api.tasks.stats(
        { range: UNWINDOWED_RANGE, ...(projectId ? { project_id: projectId } : {}) },
        scope(),
      ) as Promise<TaskStats>,
    staleTime: ANALYTICS_CONFIG.staleTimeMs,
  });
}

/**
 * The Analytics range value (a NUMBER of days) as the `/api/tasks/*` `range` token.
 *
 * The two families spell the same window differently — `/api/sessions/*` takes `days=30`,
 * `/api/tasks/*` takes `range=30d` — and this is the single translation point. An
 * unrecognised token is not an error at the backend: `parseRangeDays` falls back to the
 * `all` default, i.e. NO window, which is exactly the bug this hook is fixing. The
 * translation is therefore pinned by a test rather than trusted.
 */
export function taskRangeParam(days: RangeValue): string {
  return `${days}d`;
}

/**
 * GET /api/sessions/productive — the sessions that produced the most contexts, WINDOWED
 * (item 3a). `days` was in neither the key nor the request; the panel
 * ranked all time under the range control, and its top row was 213 days old.
 */
export function useProductiveSessions({ projectId, scope, enabled, days }: AnalyticsScope) {
  return useQuery<ProductiveSession[]>({
    queryKey: ['analytics', 'productive', projectId ?? null, days],
    enabled,
    queryFn: () =>
      api.sessions.productive(
        { limit: ANALYTICS_CONFIG.productiveLimit, projectId, days },
        scope(),
      ),
    staleTime: ANALYTICS_CONFIG.staleTimeMs,
  });
}

/**
 * GET /api/sessions/contexts-by-actor — contexts created in the window, grouped by the
 * owning session's actor, WITH that window's coverage totals (LIVE).
 *
 * Keyed on the window AND the project like `useActivityTrends`, because it is scoped by
 * both — a by-actor payload cached across a range change would draw last window's bars
 * under this window's label.
 */
export function useContextsByActor(scope: AnalyticsScope) {
  return useQuery<ContextsByActor>({
    queryKey: ['analytics', 'contextsByActor', scope.days, scope.projectId ?? null],
    enabled: scope.enabled,
    queryFn: () =>
      api.sessions.contextsByActor(
        { days: scope.days, projectId: scope.projectId },
        scope.scope()
      ),
    staleTime: ANALYTICS_CONFIG.staleTimeMs,
  });
}

/**
 * GET /api/sessions/token-patterns — the 24-hour session-start histogram (BUILT).
 *
 * Keyed on the WINDOW as well as the project. It was keyed on the project
 * alone while the request sent no `days` at all, so the panel was an all-time chart
 * sitting under a 7d/30d/90d control that changed neither the request nor the cache key —
 * the range buttons moved every other panel on the page and left this one untouched.
 */
export function useTokenPatterns(scope: AnalyticsScope) {
  return useQuery<TokenUsagePattern[]>({
    queryKey: ['analytics', 'tokenPatterns', scope.days, scope.projectId ?? null],
    enabled: scope.enabled,
    queryFn: () =>
      api.sessions.tokenPatterns({ days: scope.days, projectId: scope.projectId }, scope.scope()),
    staleTime: ANALYTICS_CONFIG.staleTimeMs,
  });
}

/*
 * There is deliberately NO `useProjectsForFilter` here any more. The project filter's
 * options come from contexts/ProjectContext through `usePageProject` — the ONE central
 * project list and the ONE central sort, shared by every page's selector. A per-page
 * `/api/projects` fetch was a second copy of both, and a second copy of a list is how two
 * screens end up ordering the same projects differently.
 */
