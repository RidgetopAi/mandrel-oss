/**
 * TaskCard — one board card (the mock's `.tcard`): a type badge, a priority dot, an
 * optional typed-edge link-count glyph, the title, and a footer with the assignee actor
 * chip (or an "unassigned" chip) + a relative timestamp. Clicking it opens the task
 * thread detail (selection is driven by the parent via the route).
 *
 * DATA-GAP POLICY (10397f65): an in-progress task honestly shows its assignee + an "in
 * progress" affordance from REAL columns (status + assigned_to). It does NOT fabricate a
 * "builder building on branch builder/xxxx" substate — that live-build/branch data is not
 * in the Command DB. The link-count glyph is shown only when a REAL count is known (the
 * selected card, whose edges are fetched); other cards omit it rather than guess.
 */
import React from 'react';
import type {
  DraggableProvidedDraggableProps,
  DraggableProvidedDragHandleProps,
} from 'react-beautiful-dnd';
import { Badge, cx } from '../../components/ui';
import { LinkIcon } from './icons';
import { typeTint, priorityDotVar, priorityLabel } from './config';
import { formatRelative, taskTitle, actorDotVar } from './parts';
import type { Task } from '../../types/task';
import styles from './Tasks.module.css';
import drag from './BoardDrag.module.css';

export interface TaskCardProps {
  task: Task;
  active: boolean;
  onSelect: (id: string) => void;
  /** REAL typed-edge count — only defined for the selected card (its links are loaded). */
  linkCount?: number;
  /**
   * ── THE DRAG BINDINGS ──────────────────────────────────────────────
   * Supplied by the Board's <Draggable>; all absent when the card is not inside one, which
   * is why every one is optional and the card renders identically without them.
   *
   * They go on the <button> ITSELF rather than a wrapping div, deliberately. The card was
   * already a button — focusable, activatable by keyboard, announced as a control — and
   * demoting it to a div with a drag handle bolted on would have traded a working
   * keyboard/screen-reader affordance for a mouse one. rbd's handle props carry their own
   * `tabIndex` and `aria-describedby` (its instructions), so the element stays reachable
   * and stays announced. Measured tradeoff, not a free win: Enter activates the card,
   * Space now LIFTS it for a drag — rbd's keyboard sensor preventDefaults Space.
   */
  innerRef?: (el: HTMLElement | null) => void;
  draggableProps?: DraggableProvidedDraggableProps;
  dragHandleProps?: DraggableProvidedDragHandleProps | null;
  isDragging?: boolean;
  /**
   * Fires when the user begins an interaction with this card (pointer down, or a key
   * press). The Board uses it to know that whatever happened before was finished — see the
   * click-suppression note there.
   */
  onInteractStart?: () => void;
}

export const TaskCard: React.FC<TaskCardProps> = ({
  task,
  active,
  onSelect,
  linkCount,
  innerRef,
  draggableProps,
  dragHandleProps,
  isDragging = false,
  onInteractStart,
}) => {
  const assignee = task.assigned_to;
  const inProgress = task.status === 'in_progress';
  const draggable = Boolean(dragHandleProps);

  return (
    <button
      type="button"
      ref={innerRef}
      {...draggableProps}
      {...dragHandleProps}
      className={cx(
        styles.tcard,
        active && styles.tcardActive,
        draggable && drag.draggable,
        isDragging && drag.dragging,
      )}
      aria-current={active}
      /* Safe to set outright: rbd v13 binds its mouse and keyboard sensors at the window
         and finds this element by the `data-rbd-drag-handle-*` attributes that
         `dragHandleProps` spreads above — the handle props carry no mouse or key handler
         of their own for these to shadow. */
      onMouseDown={onInteractStart}
      onKeyDown={onInteractStart}
      onClick={() => onSelect(task.id)}
    >
      <span className={styles.tcR1}>
        <Badge variant={typeTint(task.type)}>{task.type}</Badge>
        <span className={styles.prio}>
          <span
            className={styles.prioDot}
            style={{ background: `var(${priorityDotVar(task.priority)})` }}
            aria-hidden="true"
          />
          {priorityLabel(task.priority)}
        </span>
        {linkCount != null && linkCount > 0 && (
          <span className={styles.linkGlyph} title={`${linkCount} typed edges`}>
            <LinkIcon size={11} />
            {linkCount}
          </span>
        )}
      </span>

      <span className={styles.tcTitle}>{taskTitle(task.title)}</span>

      <span className={styles.tcFoot}>
        {assignee ? (
          <span className={styles.actorChip}>
            <span
              className={styles.actorDot}
              style={{ background: `var(${actorDotVar(assignee)})` }}
              aria-hidden="true"
            />
            {assignee}
          </span>
        ) : (
          <span className={cx(styles.actorChip, styles.actorUnassigned)}>
            <span className={styles.actorDot} aria-hidden="true" />
            unassigned
          </span>
        )}
        {inProgress ? (
          <span className={styles.liveBuild}>
            <span className={styles.pulse} aria-hidden="true" />
            in progress
          </span>
        ) : (
          <span className={styles.when}>{formatRelative(task.updated_at ?? task.created_at)}</span>
        )}
      </span>
    </button>
  );
};

export default TaskCard;
