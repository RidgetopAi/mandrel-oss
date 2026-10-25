/**
 * Projects configuration — the single, named home for every Projects-screen tunable
 * (house rule configs-not-hardcoded). Query staleness, the active/dormant recency
 * threshold, the stat trio's colours, the toolbar segments + sort options, and the
 * project-dot palette all live here so the parts stay declarative.
 *
 * DATA-GAP NOTES (the data-gap policy — show what's REAL, never fabricate):
 *  - The `/api/projects` list serves context_count / session_count / last_activity /
 *    status / metadata; task + decision counts come from `/api/projects/:id/insights`.
 *  - There is NO per-project daily-activity series served, so the mock's 30-day
 *    sparkline is OMITTED (not faked).
 *  - There is NO per-project git-branch telemetry, so the mock's "N active branches"
 *    footer is rendered as the honest in-progress-task "active work" signal instead of
 *    fabricated branch names (see ACTIVE_WORK_GAP_NOTE).
 */
import type { BadgeVariant } from '../../components/ui';
import type { ProjectEntity } from '../../api/generated';

export const PROJECTS_CONFIG = {
  /** react-query staleTime for the portfolio list read. */
  listStaleMs: 1000 * 60 * 2,
  /** react-query staleTime for the per-project insights reads (task/decision counts). */
  insightsStaleMs: 1000 * 60 * 2,
  /**
   * A project counts as "active" only if its last recorded activity is within this
   * window (and its status is not archived/inactive). Recency-driven, matching the mock
   * (recent = active, stale = dormant). Tunable here — never hardcoded in the parts.
   */
  dormantAfterMs: 1000 * 60 * 60 * 24,
} as const;

/** The stat trio shown on each card, in mock order (contexts / tasks / decisions). */
export const STAT_COLORS = {
  contexts: '--violet',
  tasks: '--green',
  decisions: '--blue',
} as const;

/**
 * Derive active-vs-dormant from REAL fields: an archived/inactive project is always
 * dormant; otherwise it's active only if it has recent activity within the window.
 */
export function isProjectActive(project: ProjectEntity, now: number = Date.now()): boolean {
  if (project.status !== 'active') return false;
  const last = project.last_activity ? Date.parse(project.last_activity) : NaN;
  if (Number.isNaN(last)) return false;
  return now - last <= PROJECTS_CONFIG.dormantAfterMs;
}

/** True when the project carries the real `metadata.is_primary` flag. */
export function isPrimaryProject(project: ProjectEntity): boolean {
  const meta = project.metadata as Record<string, unknown> | undefined;
  return meta?.is_primary === true || meta?.is_primary === 'true';
}

/**
 * The accent palette for ACTIVE, non-primary project dots. Deterministic per project
 * (stable hash of id) so a card keeps its colour across renders. Primary → teal;
 * dormant → muted.
 */
export const ACTIVE_DOT_PALETTE = ['--blue', '--violet', '--green', '--teal'] as const;

function hashId(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i += 1) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return h;
}

export function projectDotVar(project: ProjectEntity, active: boolean): string {
  if (isPrimaryProject(project)) return '--teal';
  if (!active) return '--tx-4';
  return ACTIVE_DOT_PALETTE[hashId(project.id) % ACTIVE_DOT_PALETTE.length];
}

/** StatusPill tone for the active/dormant chip. */
export function statusTone(active: boolean): 'active' | 'dormant' {
  return active ? 'active' : 'dormant';
}
export function statusLabel(active: boolean): string {
  return active ? 'active' : 'dormant';
}

/**
 * The footer "active work" signal. The literal "active branches" telemetry is NOT
 * served (data gap); we surface the REAL in-progress-task count as the active-work
 * proxy, and this note explains the substitution on-screen (Tooltip).
 */
export const ACTIVE_WORK_GAP_NOTE =
  'Per-branch git telemetry is not wired yet — showing in-progress tasks as the active-work signal.';

export function activeWorkLabel(inProgress: number | undefined): string {
  if (!inProgress || inProgress <= 0) return 'no active work';
  return `${inProgress} in progress`;
}

/** The toolbar segment filter (All / Active / Dormant). */
export type SegmentValue = 'all' | 'active' | 'dormant';
export const SEGMENTS: { value: SegmentValue; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'active', label: 'Active' },
  { value: 'dormant', label: 'Dormant' },
];

/** The sort dropdown options (the mock's "Last active" select). */
export type SortValue = 'last_active' | 'name' | 'contexts';
export const SORT_OPTIONS: { value: SortValue; label: string }[] = [
  { value: 'last_active', label: 'Last active' },
  { value: 'name', label: 'Name (A–Z)' },
  { value: 'contexts', label: 'Most contexts' },
];

/** A Badge tint for optional status echoes (kept for parity with the sibling modules). */
export const STATUS_BADGE: Record<'active' | 'dormant', BadgeVariant> = {
  active: 'ok',
  dormant: 'neutral',
};
