/**
 * PunchColumn — the rendering half of ONE PunchBoard column (a stage, or the blocked
 * lane). PER-COLUMN PAGING: the DATA half (which `useTaskColumnPage` to
 * run — `stage` vs `status:'blocked'`) lives in `PunchBoard.tsx`, one explicit call per
 * column (8 of them — 7 stages + the blocked lane — a fixed, compile-time-constant set,
 * so calling the hook 8 times at the top of one component is the rules-of-hooks-safe
 * way to do this, unlike mapping the hook over an array). This component is just the
 * presentation, so that render code isn't duplicated 8 times inline.
 */
import React from 'react';
import { Droppable, Draggable } from 'react-beautiful-dnd';
import { Spinner, Button, cx } from '../../components/ui';
import { PunchCard } from './PunchCard';
import { PUNCH_CONFIG, type PunchColumnId } from './config';
import { apiErrorMessage } from '../../api/request';
import type { Task } from '../../types/task';
import styles from './Punch.module.css';
import drag from '../tasks/BoardDrag.module.css';

export interface PunchColumnProps {
  id: PunchColumnId;
  label: string;
  dotVar: string;
  blocked?: boolean;
  tasks: Task[];
  /** The column's REAL total — never the loaded page length (a column header must never
   *  claim a count it cannot reach). */
  total: number;
  isLoading: boolean;
  isError: boolean;
  error: unknown;
  canLoadMore: boolean;
  loadMoreCount: number;
  onLoadMore: () => void;
  selectedId: string | null;
  highlightedId?: string | null;
  projectNames: Record<string, string>;
  thumbs: Record<string, string>;
  onSelect: (id: string) => void;
  onInteractStart: () => void;
}

export const PunchColumn: React.FC<PunchColumnProps> = ({
  id,
  label,
  dotVar,
  blocked = false,
  tasks,
  total,
  isLoading,
  isError,
  error,
  canLoadMore,
  loadMoreCount,
  onLoadMore,
  selectedId,
  highlightedId,
  projectNames,
  thumbs,
  onSelect,
  onInteractStart,
}) => (
  <div className={cx(styles.col, blocked && styles.colBlocked)}>
    <div className={styles.colh}>
      <span className={styles.colDot} style={{ background: `var(${dotVar})` }} aria-hidden="true" />
      {label}
      <span className={styles.colCt}>{total}</span>
    </div>
    <Droppable droppableId={id}>
      {(dropProvided, dropSnapshot) => (
        <div
          ref={dropProvided.innerRef}
          {...dropProvided.droppableProps}
          className={cx(styles.colCards, drag.colCards, dropSnapshot.isDraggingOver && drag.colOver)}
        >
          {isLoading ? (
            <div className={styles.colState}>
              <Spinner size="sm" />
            </div>
          ) : isError ? (
            <div className={styles.colState}>{apiErrorMessage(error, "Couldn't load this column.")}</div>
          ) : (
            tasks.map((t, index) => (
              <Draggable draggableId={t.id} index={index} key={t.id} disableInteractiveElementBlocking>
                {(dragProvided, dragSnapshot) => (
                  <PunchCard
                    task={t}
                    active={t.id === selectedId}
                    highlighted={t.id === highlightedId}
                    projectName={projectNames[t.project_id]}
                    beforeAttachmentId={thumbs[t.id]}
                    onSelect={onSelect}
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
    {!isLoading && !isError && canLoadMore && (
      <Button variant="ghost" size="sm" className={styles.loadMore} onClick={onLoadMore}>
        Load {Math.min(PUNCH_CONFIG.colCardCap, loadMoreCount)} more
      </Button>
    )}
  </div>
);

export default PunchColumn;
