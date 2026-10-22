/**
 * Dashboard data hooks — every read rides the UNIFIED client (`api.<domain>.*`)
 * through react-query. NO axios/generated clients here: this is the reference
 * wiring the later screen rebuilds copy. Each hook owns one card's data + its
 * own loading/error/empty surface (the components render the P0.3 states).
 *
 * ════════════════════════════════════════════════════════════════════════════════════
 *  EVERY HOOK TAKES THE PAGE'S SCOPE, AND IT IS NOT OPTIONAL (epic 41293984)
 * ════════════════════════════════════════════════════════════════════════════════════
 * The Dashboard used to send NO project on any of these reads and describe itself as
 * "Mandrel-wide". Both halves were wrong. `/api/dashboard/stats`, `/api/sessions`,
 * `/api/sessions/trends`, `/api/tasks/throughput` and `/api/projects` all resolve a
 * `ProjectListScope` on the backend before they count or list anything, so a request
 * naming nothing is scoped by the ambient `X-Project-ID` header — which this epic pins
 * to the user's DEFAULT project. The screen therefore showed one project's numbers under
 * a "Mandrel-wide" heading, and changed meaning when the default changed, with no visible
 * control moving. That is the precise dishonesty this work exists to remove.
 *
 * So every hook takes the page's scope and NAMES it on the request, two ways, because the
 * two mechanisms cover different failures:
 *
 *   • `project.scope()` — the shared primitive. Pins `X-Project-ID` to the page's project
 *     for THAT request, overriding the ambient default, and THROWS rather than falling
 *     back. This is the one that is not optional.
 *   • the `project_id` query param, where the endpoint takes one. Query beats header in
 *     the backend's precedence (services/projectScopeResolver.ts), and it is the only
 *     spelling that can carry the `'all'` sentinel — the header refuses it by design.
 *
 * `'all'` is passed through VERBATIM, never translated to "send nothing". The resolver
 * reads that literal as EXPLICITLY unscoped, which is a different thing from an omission,
 * and the difference is the whole point: an omission is what the ambient header silently
 * fills in.
 */
import { useQuery } from '@tanstack/react-query';
import { api } from '../../api';
import type { UsePageProject } from '../../hooks/usePageProject';
import type { DashboardStatsData } from '../../api/domains/dashboard';
import type { SessionTrendPoint } from '../../api/domains/sessions';
import type { ProjectEntity } from '../../api/generated/models/ProjectEntity';
import type { ThroughputPoint } from '../../types/task';
import { DASHBOARD_CONFIG } from './config';
import { aggregateByActor, type ActorActivity, type SessionActorRow } from './parts';

/**
 * The scope every card on this page reads. `undefined` only while the project list is
 * still loading — each hook is gated off in that window rather than firing an unscoped
 * request (`enabled`), because an unscoped read here is not "no data", it is EVERY
 * project's data for an admin.
 */
export type DashboardScope = string | undefined;

/**
 * `usePageProject().scope` — passed as the FUNCTION, not a prebuilt config, because it
 * throws when there is no project and must therefore be called inside `queryFn` (where
 * react-query turns a throw into an error state) rather than during render.
 *
 * Derived from the hook's own type rather than restated as `(base?: AxiosRequestConfig)
 * => AxiosRequestConfig`. Two reasons, and the second is the load-bearing one: a restated
 * signature is a second copy that can drift from the primitive it describes, and naming
 * `axios` here would trip the wiring guard (Dashboard.wiring.test.ts) that forbids a page
 * from reaching for the HTTP client directly. That guard is right to fire — the fix is to
 * not name the transport, not to carve an exception into a rule that is doing its job.
 */
export type ScopeFn = UsePageProject['scope'];

/** Fire only once the page actually has a scope to name. */
const scoped = (projectId: DashboardScope) => Boolean(projectId);

/** GET /api/dashboard/stats — the KPI bundle (contexts/tasks/projects counts). */
export function useDashboardStats(projectId: DashboardScope, scope: ScopeFn) {
  return useQuery<DashboardStatsData>({
    queryKey: ['dashboard', 'stats', projectId ?? null],
    queryFn: () => api.dashboard.stats(scope()),
    enabled: scoped(projectId),
    staleTime: DASHBOARD_CONFIG.staleTimeMs,
  });
}

/**
 * Total decision count — the KPI bundle omits decisions, so we read the REAL
 * full-corpus count from `api.decisions.stats()` (`total_decisions`). We do NOT
 * use `decisions.search({limit:1}).total`: the MCP `decision_search` `total` is the
 * returned page size (=1 for a limit-1 page), not the corpus count — reading it made
 * the card show only 1. Stats is the same real-count source the Decisions screen uses.
 */
export function useDecisionCount(projectId: DashboardScope, scope: ScopeFn) {
  return useQuery<number>({
    queryKey: ['dashboard', 'decisionCount', projectId ?? null],
    queryFn: async () => {
      const stats = await api.decisions.stats(projectId, scope());
      return stats.total_decisions ?? 0;
    },
    enabled: scoped(projectId),
    staleTime: DASHBOARD_CONFIG.staleTimeMs,
  });
}

/** GET /api/sessions/trends — per-day activity totals for the workspace chart. */
export function useActivityTrends(projectId: DashboardScope, scope: ScopeFn) {
  return useQuery<SessionTrendPoint[]>({
    queryKey: ['dashboard', 'trends', DASHBOARD_CONFIG.trendDays, projectId ?? null],
    queryFn: () =>
      api.sessions.trends({ days: DASHBOARD_CONFIG.trendDays, projectId }, scope()),
    enabled: scoped(projectId),
    staleTime: DASHBOARD_CONFIG.staleTimeMs,
  });
}

/**
 * GET /api/sessions → rolled up by `actor` for the "Sessions by actor" panel.
 * Reads the real serialised `actor` and aggregates client-side —
 * session count / contexts / tasks / tokens / projects per actor. Not time-windowed
 * (the list endpoint has no `since`); a "last 24h" slice is a follow-up.
 */
export function useSessionsByActor(projectId: DashboardScope, scope: ScopeFn) {
  return useQuery<ActorActivity[]>({
    queryKey: ['dashboard', 'byActor', DASHBOARD_CONFIG.byActorScanLimit, projectId ?? null],
    queryFn: async () => {
      const rows = (await api.sessions.list(
        { limit: DASHBOARD_CONFIG.byActorScanLimit, project_id: projectId },
        scope(),
      )) as unknown as SessionActorRow[];
      return aggregateByActor(rows);
    },
    enabled: scoped(projectId),
    staleTime: DASHBOARD_CONFIG.staleTimeMs,
  });
}

/**
 * GET /api/tasks/throughput — the per-day throughput trend (tasks completed vs created
 * per day) over the configured window, for the project this page is scoped to. REAL
 * server-side series; `[]` ⇒ no task activity of either kind in the window → the card
 * renders an honest empty state.
 */
export function useDashboardThroughput(projectId: DashboardScope, scope: ScopeFn) {
  return useQuery<ThroughputPoint[]>({
    queryKey: ['dashboard', 'throughput', DASHBOARD_CONFIG.throughputRange, projectId ?? null],
    queryFn: () =>
      api.tasks.throughput(
        { range: DASHBOARD_CONFIG.throughputRange, project_id: projectId },
        scope(),
      ),
    enabled: scoped(projectId),
    staleTime: DASHBOARD_CONFIG.staleTimeMs,
  });
}

/**
 * GET /api/projects — projects sorted by last activity, capped to the rail size.
 * Sorting/capping is derived here so the component stays presentational.
 *
 * THE COUNTER-INTUITIVE ONE, and it is why this hook scopes rather than sending nothing:
 * the PROJECT LIST is itself project-scoped on the backend (`ProjectService.getAllProjects`
 * takes a `ProjectListScope`), so naming nothing does not mean "every project" — it means
 * the ambient header's single project. Measured on a migrated DB with two seeded projects:
 * `GET /api/projects` with `X-Project-ID: A` returns A only; the same call with no header
 * returns both. So the rail names the page's scope like every other card, and shows the
 * whole inventory only when the page is on "All projects" (where `scope()` deliberately
 * sends no header at all).
 */
export function useRecentProjects(projectId: DashboardScope, scope: ScopeFn) {
  return useQuery<ProjectEntity[]>({
    queryKey: ['dashboard', 'recentProjects', projectId ?? null],
    queryFn: () => api.projects.list(scope()),
    enabled: scoped(projectId),
    staleTime: DASHBOARD_CONFIG.staleTimeMs,
    select: (projects) =>
      [...projects]
        .sort((a, b) => {
          const ta = a.last_activity ? Date.parse(a.last_activity) : 0;
          const tb = b.last_activity ? Date.parse(b.last_activity) : 0;
          return tb - ta;
        })
        .slice(0, DASHBOARD_CONFIG.recentProjectsLimit),
  });
}
