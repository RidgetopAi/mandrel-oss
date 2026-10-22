/**
 * Punch List data hooks — every read/write rides the UNIFIED client (`api.tasks.*` /
 * `api.attachments.*`) through react-query. The board's task list is the SAME
 * `useTaskList` read the Tasks screen uses (one cache, one invalidation set), so a stage
 * drag here and a status drag there never disagree. NO axios/generated clients here.
 */
import React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api';
import { useUpdateTask, type TaskUpdateInput } from '../tasks/hooks';
import { patchTaskListEntry, type TaskListCacheEntry, type TaskListSnapshot } from '../tasks/taskListCache';
import type { Task } from '../../types/task';
import type { TaskAttachment, AttachmentKind } from '../../types/attachment';
import { PUNCH_CONFIG } from './config';
import { isPunch } from './stage';

export {
  useTaskList,
  useTaskColumnPage,
  useTask,
  useCreateTask,
  useUpdateTask,
  useResolveTaskSearch,
} from '../tasks/hooks';
export type { RequestScope, TaskColumnPage } from '../tasks/hooks';

const attachmentsKey = (taskId: string | null) => ['attachments', 'list', taskId] as const;

/** GET /api/tasks/:id/attachments — lazy per task; `[]` is an honest empty. */
export function useAttachments(taskId: string | null) {
  return useQuery<TaskAttachment[]>({
    queryKey: attachmentsKey(taskId),
    queryFn: () => api.attachments.list(taskId as string),
    enabled: Boolean(taskId),
    staleTime: PUNCH_CONFIG.attachmentsStaleTimeMs,
  });
}

/**
 * The `before` thumbnail per card — ONE bulk read per board load (lane B's
 * `GET /api/attachments?taskIds=…`, chunked at 100 inside the domain method). Only tasks
 * carrying punch metadata are asked; a legacy task has no attachments to show. Returns a
 * map taskId → FIRST `before` attachment id (the route orders by taskId, createdAt), absent
 * when there is none. Pure over the response — `pickFirstBefore` — so it is testable alone.
 */
export function pickFirstBefore(rows: ReadonlyArray<TaskAttachment>): Record<string, string> {
  const map: Record<string, string> = {};
  for (const a of rows) {
    // Only an image can be a thumbnail — a text/json `before` would render as a broken glyph
    // on the card (the reviewer A); the gallery already tiles those by mime.
    if (a.kind === 'before' && a.mime.startsWith('image/') && !(a.taskId in map)) map[a.taskId] = a.id;
  }
  return map;
}

export function useBeforeThumbnails(tasks: Task[]): Record<string, string> {
  const ids = React.useMemo(() => tasks.filter(isPunch).map((t) => t.id).sort(), [tasks]);
  const q = useQuery<TaskAttachment[]>({
    queryKey: ['attachments', 'bulk', ids],
    queryFn: () => api.attachments.listForTasks(ids),
    enabled: ids.length > 0,
    staleTime: PUNCH_CONFIG.attachmentsStaleTimeMs,
  });
  return React.useMemo(() => pickFirstBefore(q.data ?? []), [q.data]);
}

/** POST /api/tasks/:id/attachments — one file. Refreshes that task's attachment list. */
export function useUploadAttachment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ taskId, file, kind }: { taskId: string; file: File; kind?: AttachmentKind }) =>
      api.attachments.upload(taskId, file, kind),
    onSuccess: (_a, { taskId }) => {
      qc.invalidateQueries({ queryKey: attachmentsKey(taskId) });
      qc.invalidateQueries({ queryKey: ['attachments', 'bulk'] });
    },
  });
}

/** DELETE /api/attachments/:id — refreshes the owning task's list. */
export function useDeleteAttachment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id }: { id: string; taskId: string }) => api.attachments.remove(id),
    onSuccess: (_v, { taskId }) => {
      qc.invalidateQueries({ queryKey: attachmentsKey(taskId) });
      qc.invalidateQueries({ queryKey: ['attachments', 'bulk'] });
    },
  });
}

export interface StageDrag {
  /** Apply a drop's updates optimistically; rolled back if the request fails. */
  move: (id: string, updates: TaskUpdateInput) => void;
  isError: boolean;
  error: unknown;
  reset: () => void;
}

/**
 * The board's drag write — the stage twin of `useBoardStatusDrag`. Optimistic on every
 * cached task list (the same task sits in several), snapshot-restored on failure so a
 * rejected move (a `PUNCH_INCOMPLETE` draft dragged to Ready) snaps back rather than
 * leaving the board claiming a stage the server refused. `onError` is exposed so the
 * board can open the card with the missing fields highlighted.
 */
export function useStageDrag(onError?: (err: unknown, id: string, updates: TaskUpdateInput) => void): StageDrag {
  const qc = useQueryClient();
  const update = useUpdateTask();

  const move = React.useCallback(
    (id: string, updates: TaskUpdateInput) => {
      qc.cancelQueries({ queryKey: ['tasks', 'list'] });
      const snapshot = qc.getQueriesData<TaskListCacheEntry>({
        queryKey: ['tasks', 'list'],
      }) as TaskListSnapshot;
      qc.setQueriesData<TaskListCacheEntry>({ queryKey: ['tasks', 'list'] }, (entry) =>
        patchTaskListEntry(entry, id, (t) => ({ ...t, ...updates })),
      );
      update.mutate(
        { id, updates },
        {
          onError: (err) => {
            for (const [key, data] of snapshot) qc.setQueryData(key, data);
            onError?.(err, id, updates);
          },
        },
      );
    },
    [qc, update, onError],
  );

  return { move, isError: update.isError, error: update.error, reset: update.reset };
}
