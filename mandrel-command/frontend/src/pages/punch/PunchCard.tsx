/**
 * PunchCard — one board card: the goal (title), project name, proof-kind badge, a small
 * `before` thumbnail when one exists, a priority tint on the left edge, and the age.
 * A `draft` card says what it is still missing ("missing: done-when, proof") so the
 * reason it cannot move to Ready is on the card, not in an error later. A Ready/Claimed
 * card carries the same amber line for the picker's `reject:*` verdict tag when it has
 * one — read off `task.tags` by `rejectReason`, never recomputed here;
 * no tag means the row is pickable and the card stays clean.
 *
 * Same drag bindings as the Tasks TaskCard (the card IS the button; see that file for why
 * `disableInteractiveElementBlocking` is set on the Draggable).
 */
import React from 'react';
import type {
  DraggableProvidedDraggableProps,
  DraggableProvidedDragHandleProps,
} from 'react-beautiful-dnd';
import { Badge, cx } from '../../components/ui';
import { priorityDotVar } from '../tasks/config';
import { formatRelative, taskTitle } from '../tasks/parts';
import { proofTint } from './config';
import { effectiveStage, punchOf, missingPunchFields, missingLabels, rejectReason } from './stage';
import { AuthedImage } from './AuthedImage';
import type { Task } from '../../types/task';
import styles from './Punch.module.css';
import drag from '../tasks/BoardDrag.module.css';

export interface PunchCardProps {
  task: Task;
  active: boolean;
  /** Just filed — the success highlight. */
  highlighted?: boolean;
  projectName?: string;
  beforeAttachmentId?: string;
  onSelect: (id: string) => void;
  innerRef?: (el: HTMLElement | null) => void;
  draggableProps?: DraggableProvidedDraggableProps;
  dragHandleProps?: DraggableProvidedDragHandleProps | null;
  isDragging?: boolean;
  onInteractStart?: () => void;
}

export const PunchCard: React.FC<PunchCardProps> = ({
  task,
  active,
  highlighted = false,
  projectName,
  beforeAttachmentId,
  onSelect,
  innerRef,
  draggableProps,
  dragHandleProps,
  isDragging = false,
  onInteractStart,
}) => {
  const punch = punchOf(task);
  const stage = effectiveStage(task);
  const missing = stage === 'draft' ? missingPunchFields(punch) : [];
  const reject = stage === 'draft' ? null : rejectReason(task);
  const draggable = Boolean(dragHandleProps);

  return (
    <button
      type="button"
      ref={innerRef}
      {...draggableProps}
      {...dragHandleProps}
      className={cx(
        styles.card,
        active && styles.cardActive,
        highlighted && styles.cardNew,
        draggable && drag.draggable,
        isDragging && drag.dragging,
      )}
      style={{ borderLeftColor: `var(${priorityDotVar(task.priority)})` }}
      aria-current={active}
      data-stage={stage ?? undefined}
      onMouseDown={onInteractStart}
      onKeyDown={onInteractStart}
      onClick={() => onSelect(task.id)}
    >
      <span className={styles.cardRow}>
        {punch.proofKind ? (
          <Badge variant={proofTint(punch.proofKind)}>{punch.proofKind}</Badge>
        ) : (
          <Badge variant="neutral">{task.type}</Badge>
        )}
        <span className={styles.cardAge}>{formatRelative(task.created_at)}</span>
      </span>
      <span className={styles.cardBody}>
        <span className={styles.cardTitle}>{taskTitle(task.title)}</span>
        {beforeAttachmentId && (
          <AuthedImage attachmentId={beforeAttachmentId} alt="before" className={styles.thumb} />
        )}
      </span>
      <span className={styles.cardFoot}>
        <span className={styles.cardProject}>{projectName ?? task.project_name ?? '—'}</span>
        {missing.length > 0 && (
          <span className={styles.cardReason}>missing: {missingLabels(missing)}</span>
        )}
        {reject && <span className={styles.cardReason}>{reject}</span>}
      </span>
    </button>
  );
};

export default PunchCard;
