/**
 * Project ordering — the single source of truth for "most-recently-active first".
 *
 * Every project selector (the global topbar switcher + the Sessions / Analytics /
 * Calendar local filters) orders its options with this comparator so a project the
 * user just touched surfaces at the top. It mirrors the dashboard RecentProjects
 * rail's comparator (pages/dashboard/hooks.ts) — one rule, applied everywhere.
 *
 * A project with no `last_activity` sorts LAST (treated as epoch 0), so freshly
 * created / never-touched projects fall to the bottom instead of the top.
 */
import type { ProjectEntity } from '../api/generated/models/ProjectEntity';

/** Only the field the ordering depends on — keeps the comparator reusable. */
type HasLastActivity = Pick<ProjectEntity, 'last_activity'>;

/**
 * Compare two projects by `last_activity` DESC (most recent first). Missing/empty
 * `last_activity` is treated as epoch 0 → sorts last.
 */
export function compareByRecentActivity(a: HasLastActivity, b: HasLastActivity): number {
  const ta = a.last_activity ? Date.parse(a.last_activity) : 0;
  const tb = b.last_activity ? Date.parse(b.last_activity) : 0;
  return tb - ta;
}

/**
 * Return a NEW array of projects ordered most-recently-active first. Non-mutating —
 * the input array/order is left untouched (safe on React Query / memoized data).
 */
export function sortProjectsByRecentActivity<T extends HasLastActivity>(
  projects: readonly T[],
): T[] {
  return [...projects].sort(compareByRecentActivity);
}
