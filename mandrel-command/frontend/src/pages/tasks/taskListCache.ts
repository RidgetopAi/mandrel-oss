/**
 * Shared shape-aware patch for every cached `['tasks','list', …]` react-query entry
 *. Two shapes now live under that one prefix:
 *   - `Task[]` — the original shared/status-filtered list (`useTaskList`).
 *   - `TaskColumnPage` (`{ tasks, total }`) — a per-column page (`useTaskColumnPage`,
 *     PER-COLUMN PAGING). `total` must survive a patch untouched — it is the column's
 *     REAL count, and an in-place field edit neither adds nor removes a row.
 *
 * The board drags (`boardDrag.ts`, `pages/punch/hooks.ts`) rewrite EVERY cached list
 * entry a moved task might sit in, so a status/stage change reflects instantly no
 * matter which view is looking. Before per-column paging that was always a `Task[]`;
 * now it can be either, and a bare `rows.map(...)` would throw on the object shape.
 */
import type { Task } from '../../types/task';
import type { TaskColumnPage } from './hooks';

export type TaskListCacheEntry = Task[] | TaskColumnPage;

/** The `['tasks','list', …]` cache entries as they were before an optimistic write. */
export type TaskListSnapshot = Array<[readonly unknown[], TaskListCacheEntry | undefined]>;

/**
 * Apply `patch` to the one row matching `id`, in whichever shape `entry` is. `undefined`
 * (no cached data yet) passes through unchanged — there is nothing to rewrite.
 */
export function patchTaskListEntry(
  entry: TaskListCacheEntry | undefined,
  id: string,
  patch: (task: Task) => Task,
): TaskListCacheEntry | undefined {
  if (!entry) return entry;
  if (Array.isArray(entry)) {
    return entry.map((t) => (t.id === id ? patch(t) : t));
  }
  return { ...entry, tasks: entry.tasks.map((t) => (t.id === id ? patch(t) : t)) };
}
