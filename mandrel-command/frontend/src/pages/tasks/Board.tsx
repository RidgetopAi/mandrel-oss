/**
 * Board — the mock's 4-column kanban (To do / In progress / Blocked / Done). PER-COLUMN
 * PAGING: each column fetches its OWN rows (`BoardColumn` →
 * `useTaskColumnPage`), server-side `status`-filtered and independently paged, so one
 * column's volume can never spend the row budget another column needed. The header count
 * is each column's REAL total, never a page length. See `useTaskColumnPage` for why this
 * replaced the single shared fetch this file used to split client-side.
 *
 * The board's own gate (loading / empty / error) reads the project's real, uncapped
 * `/tasks/stats` total (`totalTasks`) rather than any one column's fetch — a column can be
 * independently slow or erroring without blanking the whole board (see `BoardColumn`).
 *
 * ── DRAG TO CHANGE STATUS ─────────────────────────────────────────────
 * Dragging a card into another column is the status change; the drop target IS the new
 * status, since a column's `droppableId` is its `TaskStatus`. The write is optimistic and
 * rolls back on failure (see `boardDrag.ts`), and a rejected move says so rather than
 * silently reverting. Optimism now patches the field IN PLACE on whichever cached column
 * page the row is currently sitting in (`taskListCache.ts`) — the card leaves its old
 * column instantly (it no longer matches that column's predicate) but only appears in the
 * new one once the write's cache invalidation refetches, since it was never in that
 * column's page to begin with.
 *
 * A drag and a click share the same element, so the board has to tell them apart — see
 * the click-suppression note on `dragEndedRef` below.
 */
import React from 'react';
import { DragDropContext, type DropResult } from 'react-beautiful-dnd';
import { Spinner, Empty, Alert } from '../../components/ui';
import { BoardColumn } from './BoardColumn';
import { STATUS_COLUMNS } from './config';
import { useBoardStatusDrag } from './boardDrag';
import type { RequestScope } from './hooks';
import type { TaskStatus } from '../../types/task';
import styles from './Tasks.module.css';
import drag from './BoardDrag.module.css';
import { apiErrorMessage } from '../../api/request';

export interface BoardProps {
  projectId: string | undefined;
  scope: RequestScope;
  enabled: boolean;
  search: string;
  /** The project's REAL, uncapped task total (`/tasks/stats`) — the board's own
   *  loading/empty gate, independent of any one column's fetch. */
  totalTasks: number | undefined;
  totalTasksLoading: boolean;
  totalTasksError: boolean;
  totalTasksErrorObj?: unknown;
  selectedId: string | null;
  onSelect: (id: string) => void;
  selectedLinkCount?: number;
}

/** The statuses a card can be dropped onto — exactly the columns that exist. */
const COLUMN_STATUSES = new Set<string>(STATUS_COLUMNS.map((c) => c.status));

/**
 * What a completed drag means, as a pure function, so the decision is testable without a
 * DOM or a drag: a drop is a status change only when it landed on a real column that is a
 * DIFFERENT status from where it started. Everything else (cancelled mid-air, dropped back
 * on its own column, dropped on something that is not a column) is a no-op — and a no-op
 * must not fire a request, or dropping a card where you found it would write to the server.
 */
export function statusChangeFromDrop(result: DropResult): { id: string; status: TaskStatus } | null {
  const destination = result.destination?.droppableId;
  if (!destination) return null;
  if (destination === result.source.droppableId) return null;
  if (!COLUMN_STATUSES.has(destination)) return null;
  return { id: result.draggableId, status: destination as TaskStatus };
}

export const Board: React.FC<BoardProps> = ({
  projectId,
  scope,
  enabled,
  search,
  totalTasks,
  totalTasksLoading,
  totalTasksError,
  totalTasksErrorObj,
  selectedId,
  onSelect,
  selectedLinkCount,
}) => {
  const { moveStatus, isError: moveFailed, error: moveError, reset } = useBoardStatusDrag();

  /**
   * ── DRAG vs CLICK ──────────────────────────────────────────────────────────────────
   * The card is one element serving both gestures, and a completed drag must NOT also
   * open the task. This flag is the arbiter: a finished drag sets it, and the next click
   * is spent clearing it instead of opening the drawer.
   *
   * It is cleared at the START of each interaction rather than on a timer, so it cannot
   * go stale: a drag that produces no click (every keyboard drag, and a cancelled one)
   * leaves the flag set, and the next mousedown or keydown on any card resets it before
   * that interaction can be misread as the tail of the old drag.
   */
  const dragEndedRef = React.useRef(false);

  const noteInteractionStart = React.useCallback(() => {
    dragEndedRef.current = false;
  }, []);

  const handleSelect = React.useCallback(
    (id: string) => {
      if (dragEndedRef.current) {
        dragEndedRef.current = false;
        return;
      }
      onSelect(id);
    },
    [onSelect],
  );

  const handleDragEnd = React.useCallback(
    (result: DropResult) => {
      dragEndedRef.current = true;
      const change = statusChangeFromDrop(result);
      if (change) moveStatus(change.id, change.status);
    },
    [moveStatus],
  );

  if (totalTasksLoading) {
    return (
      <div className={styles.boardState}>
        <Spinner size="lg" />
      </div>
    );
  }
  if (totalTasksError) {
    return (
      <div className={styles.boardState}>
        <Alert variant="error" title="Couldn't load tasks">
          {apiErrorMessage(totalTasksErrorObj, 'Failed to load tasks.')}
        </Alert>
      </div>
    );
  }
  if ((totalTasks ?? 0) === 0) {
    return (
      <div className={styles.boardState}>
        <Empty title="No tasks" description="No tasks in this project yet." />
      </div>
    );
  }

  return (
    <>
      {/* The optimistic write has already been undone by the time this renders, so the
          board below is showing the REAL status again — this says why it moved back. */}
      {moveFailed && (
        <Alert
          variant="error"
          title="Couldn't move the task"
          className={drag.moveError}
          onClose={reset}
        >
          {apiErrorMessage(moveError, 'The request failed.')} The card has been put back.
        </Alert>
      )}

      <DragDropContext onDragEnd={handleDragEnd}>
        <div className={styles.board}>
          {STATUS_COLUMNS.map((col) => (
            <BoardColumn
              key={col.status}
              status={col.status}
              label={col.label}
              dotVar={col.dotVar}
              projectId={projectId}
              scope={scope}
              search={search}
              enabled={enabled}
              selectedId={selectedId}
              onSelect={handleSelect}
              selectedLinkCount={selectedLinkCount}
              onInteractStart={noteInteractionStart}
            />
          ))}
        </div>
      </DragDropContext>
    </>
  );
};

export default Board;
