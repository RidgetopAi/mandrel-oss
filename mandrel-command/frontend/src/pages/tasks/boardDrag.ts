/**
 * The board's drag-to-change-status write.
 *
 * Dropping a card into another column is a status change, and it has to feel instant: the
 * card must sit in the new column before the request resolves, or the user drops it and
 * watches it snap back for a round trip. So the cached list is rewritten OPTIMISTICALLY and
 * the snapshot is restored if the request fails — a failed move must not leave the board
 * claiming a status the server never accepted.
 *
 * The write itself reuses `useUpdateTask` (PUT /api/tasks/:id) rather than restating the
 * request or its cache invalidation here. That matters: the invalidation set is maintained
 * in one place, so a future read added to the page cannot go stale on this path only
 * because this path forgot about it.
 *
 * Every cached `['tasks', 'list', …]` query is rewritten, not just the board's own. The key
 * carries the project, a status filter and an archived flag, so the same task can sit in
 * several cached lists at once and leaving the others alone would show two different
 * statuses for one task depending on which view you switched to. Since PER-COLUMN PAGING
 * that prefix also holds `TaskColumnPage` (`{tasks,total}`) entries —
 * `patchTaskListEntry` (taskListCache.ts) is shape-aware so this rewrite works on both.
 */
import React from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useUpdateTask } from './hooks';
import { patchTaskListEntry, type TaskListCacheEntry, type TaskListSnapshot } from './taskListCache';
import type { TaskStatus } from '../../types/task';

export interface BoardStatusDrag {
  /** Move a task to a new status: optimistic now, rolled back if the request fails. */
  moveStatus: (id: string, status: TaskStatus) => void;
  /** The last move failed and its optimistic write was rolled back. */
  isError: boolean;
  error: unknown;
  /** Clear a surfaced failure (the user dismissed it, or a later move succeeded). */
  reset: () => void;
}

export function useBoardStatusDrag(): BoardStatusDrag {
  const qc = useQueryClient();
  const update = useUpdateTask();

  const moveStatus = React.useCallback(
    (id: string, status: TaskStatus) => {
      // Stop any in-flight list read from landing on top of the optimistic write and
      // resurrecting the old column for a moment.
      qc.cancelQueries({ queryKey: ['tasks', 'list'] });

      const snapshot = qc.getQueriesData<TaskListCacheEntry>({
        queryKey: ['tasks', 'list'],
      }) as TaskListSnapshot;

      qc.setQueriesData<TaskListCacheEntry>({ queryKey: ['tasks', 'list'] }, (entry) =>
        patchTaskListEntry(entry, id, (t) => ({ ...t, status })),
      );

      update.mutate(
        { id, updates: { status } },
        {
          onError: () => {
            // Put every list back exactly as it was. Restoring the snapshot (rather than
            // flipping the status back) also undoes anything else the optimistic pass
            // touched, and is correct even if the row has since left the list.
            for (const [key, data] of snapshot) qc.setQueryData(key, data);
          },
        },
      );
    },
    [qc, update],
  );

  return { moveStatus, isError: update.isError, error: update.error, reset: update.reset };
}
