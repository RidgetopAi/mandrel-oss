/**
 * Project-detail configuration — the single, named home for every tunable on the
 * project-scoped dashboard screen (house rule configs-not-hardcoded). Query staleness,
 * the active/dormant recency threshold, the vital-tile + task-lane definitions, and the
 * recent-decision fetch size all live here so the parts stay declarative.
 *
 * DATA-GAP NOTES (policy 10397f65 — show what's REAL, never fabricate):
 *  - `api.projects.get(id)` serves name / status / description / metadata.is_primary /
 *    context_count / session_count / last_activity.
 *  - `api.projects.insights(id)` serves the REAL task breakdown (total / in_progress /
 *    todo / blocked / completed / completion %), context + decision totals, and
 *    git_activity (commits / insertions / deletions / files_changed / latest commit).
 *  - `api.projects.sessions(id)` serves the project's context-based sessions
 *    (context_count + first/last activity). It does NOT serve per-session token counts,
 *    actor identity, or a live/ended flag, so the mock's "42 ctx · 6 tasks · 118k tok"
 *    + live pulse + actor avatars are rendered from the REAL fields only (context count
 *    + relative time), never fabricated (see SESSIONS_GAP_NOTE).
 *  - There is NO per-project daily-activity series served, so the mock's 30-day activity
 *    sparkline is OMITTED (not faked).
 *  - There is NO per-branch git telemetry served, so the mock's "active branches →
 *    TreeWalker" card is replaced by the REAL repository-activity signal from
 *    git_activity, with the gap disclosed on-screen (see BRANCH_GAP_NOTE).
 */
import type { ProjectEntity } from '../../api/generated';

export const PROJECT_DETAIL_CONFIG = {
  /** react-query staleTime for the project record read. */
  recordStaleMs: 1000 * 60 * 2,
  /** react-query staleTime for the insights read (task/decision/context/git counts). */
  insightsStaleMs: 1000 * 60 * 2,
  /** react-query staleTime for the sessions read. */
  sessionsStaleMs: 1000 * 60,
  /** react-query staleTime for the recent-decisions read. */
  decisionsStaleMs: 1000 * 60 * 2,
  /** How many recent sessions to surface in the sessions card. */
  sessionsShown: 6,
  /** How many recent decisions to fetch for the decisions card. */
  decisionsShown: 5,
  /**
   * A project counts as "active" only if its last recorded activity is within this
   * window (and its status is active). Recency-driven, matching the portfolio screen so
   * the status pill agrees across both surfaces.
   */
  dormantAfterMs: 1000 * 60 * 60 * 24,
} as const;

/** Derive active-vs-dormant from REAL fields (mirrors projects/config.isProjectActive). */
export function isProjectActive(project: ProjectEntity, now: number = Date.now()): boolean {
  if (project.status !== 'active') return false;
  const last = project.last_activity ? Date.parse(project.last_activity) : NaN;
  if (Number.isNaN(last)) return false;
  return now - last <= PROJECT_DETAIL_CONFIG.dormantAfterMs;
}

/** True when the project carries the real `metadata.is_primary` flag. */
export function isPrimaryProject(project: ProjectEntity): boolean {
  const meta = project.metadata as Record<string, unknown> | undefined;
  return meta?.is_primary === true || meta?.is_primary === 'true';
}

export function statusTone(active: boolean): 'active' | 'dormant' {
  return active ? 'active' : 'dormant';
}
export function statusLabel(active: boolean): string {
  return active ? 'active' : 'dormant';
}

/** The five vital tiles, in mock order. `key` selects the source field in VitalTiles. */
export type VitalKey = 'contexts' | 'tasks' | 'decisions' | 'sessions' | 'commits';
export interface VitalDef {
  key: VitalKey;
  label: string;
  /** The token colour for the tile value (accent === teal-highlighted tile). */
  colorVar: string;
  accent?: boolean;
}
export const VITAL_TILES: VitalDef[] = [
  { key: 'contexts', label: 'Contexts', colorVar: '--violet' },
  { key: 'tasks', label: 'Tasks', colorVar: '--green' },
  { key: 'decisions', label: 'Decisions', colorVar: '--blue' },
  { key: 'sessions', label: 'Sessions', colorVar: '--amber' },
  { key: 'commits', label: 'Commits', colorVar: '--teal', accent: true },
];

/** The task mini-board lanes (real insights.tasks fields), in mock order. */
export type TaskLaneKey = 'todo' | 'in_progress' | 'blocked' | 'completed';
export interface TaskLaneDef {
  key: TaskLaneKey;
  label: string;
  colorVar: string;
}
export const TASK_LANES: TaskLaneDef[] = [
  { key: 'todo', label: 'Todo', colorVar: '--tx-3' },
  { key: 'in_progress', label: 'In progress', colorVar: '--teal' },
  { key: 'blocked', label: 'Blocked', colorVar: '--amber' },
  { key: 'completed', label: 'Done', colorVar: '--green' },
];

/**
 * On-screen disclosure of the sessions data gap: real fields are context count + first/
 * last activity; per-session token counts, actor identity, and a live/ended flag are not
 * served by `api.projects.sessions`.
 */
export const SESSIONS_GAP_NOTE =
  'Per-session token counts, actor identity, and a live/ended flag are not wired yet — ' +
  'showing each session’s real context count and activity time.';

/**
 * On-screen disclosure of the branch-telemetry gap: the literal "active branches" list
 * is not served, so this card shows the REAL repository-activity signal (commits +
 * churn + latest commit) from git_activity instead of fabricated branch names.
 */
export const BRANCH_GAP_NOTE =
  'Per-branch git telemetry is not wired yet — showing real repository activity ' +
  '(commits, churn, latest commit) as the code-activity signal.';
