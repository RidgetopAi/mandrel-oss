/**
 * BoardColumn — ONE status column of the Tasks board, paged on its OWN axis
 * (PER-COLUMN PAGING). See `useTaskColumnPage` for the full mechanism note:
 * each column runs its own server-side `status`-filtered, `limit`-bound read, so one
 * column's row volume can never spend the budget another column needed — the failure
 * mode of the old single shared fetch once a project passed the list cap (the
 * terminal-order fix, an earlier change, made that starvation land EXCLUSIVELY on Done).
 *
 * A column's OWN query failing does not take the rest of the board down with it — each
 * renders its loading/error/card state independently.
 */
import React from 'react';
import { Droppable, Draggable } from 'react-beautiful-dnd';
import { Spinner, Button, cx } from '../../components/ui';
import { TaskCard } from './TaskCard';
import { useTaskColumnPage, type RequestScope } from './hooks';
import { TASKS_CONFIG } from './config';
import { matchesSearch } from './search';
import { apiErrorMessage } from '../../api/request';
import type { Task, TaskStatus } from '../../types/task';
import styles from './Tasks.module.css';
import drag from './BoardDrag.module.css';

export interface BoardColumnProps {
  status: TaskStatus;
  label: string;
  dotVar: string;
  projectId: string | undefined;
  scope: RequestScope;
  /** The Toolbar search box — filters this column's LOADED page (client-side, same rule
   *  as everywhere else: `matchesSearch` never hides a row the server didn't send). */
  search: string;
  enabled: boolean;
  selectedId: string | null;
  onSelect: (id: string) => void;
  selectedLinkCount?: number;
  onInteractStart: () => void;
}

export const BoardColumn: React.FC<BoardColumnProps> = ({
  status,
  label,
  dotVar,
  projectId,
  scope,
  search,
  enabled,
  selectedId,
  onSelect,
  selectedLinkCount,
  onInteractStart,
}) => {
  const [limit, setLimit] = React.useState<number>(TASKS_CONFIG.colCardCap);
  const query = useTaskColumnPage(projectId, scope, { status, limit, enabled });

  const loaded = query.data?.tasks ?? [];
  const total = query.data?.total ?? 0;
  const searching = search.trim().length > 0;
  const visible = searching ? loaded.filter((t: Task) => matchesSearch(t, search)) : loaded;
  // Honest header count (never a number the column cannot back up): the REAL total when
  // idle, or — while searching — what actually matched within the loaded page, since a
  // server-side search count for the un-loaded remainder does not exist to report.
  const count = searching ? visible.length : total;
  const canLoadMore = loaded.length < total;

  return (
    <div className={styles.col}>
      <div className={styles.colh}>
        <span className={styles.colDot} style={{ background: `var(${dotVar})` }} aria-hidden="true" />
        {label}
        <span className={styles.colCt}>{count}</span>
      </div>
      <Droppable droppableId={status}>
        {(dropProvided, dropSnapshot) => (
          <div
            ref={dropProvided.innerRef}
            {...dropProvided.droppableProps}
            className={cx(
              styles.colCards,
              drag.colCards,
              dropSnapshot.isDraggingOver && drag.colOver,
            )}
          >
            {query.isLoading ? (
              <div className={styles.colState}>
                <Spinner size="sm" />
              </div>
            ) : query.isError ? (
              <div className={styles.colState}>{apiErrorMessage(query.error, "Couldn't load this column.")}</div>
            ) : (
              visible.map((t, index) => (
                <Draggable
                  draggableId={t.id}
                  index={index}
                  key={t.id}
                  // Same reasoning as the pre-split Board — see its removed note:
                  // the card is a <button>, so rbd's own interactive-element
                  // guard would otherwise refuse to start a drag from it.
                  disableInteractiveElementBlocking
                >
                  {(dragProvided, dragSnapshot) => (
                    <TaskCard
                      task={t}
                      active={t.id === selectedId}
                      onSelect={onSelect}
                      linkCount={t.id === selectedId ? selectedLinkCount : undefined}
                      innerRef={dragProvided.innerRef}
                      draggableProps={dragProvided.draggableProps}
                      dragHandleProps={dragProvided.dragHandleProps}
                      isDragging={dragSnapshot.isDragging}
                      onInteractStart={onInteractStart}
                    />
                  )}
                </Draggable>
              ))
            )}
            {dropProvided.placeholder}
          </div>
        )}
      </Droppable>
      {!query.isLoading && !query.isError && canLoadMore && (
        <Button
          variant="ghost"
          size="sm"
          className={styles.loadMore}
          onClick={() => setLimit((n) => n + TASKS_CONFIG.colCardCap)}
        >
          Load {Math.min(TASKS_CONFIG.colCardCap, total - loaded.length)} more
        </Button>
      )}
    </div>
  );
};

export default BoardColumn;
