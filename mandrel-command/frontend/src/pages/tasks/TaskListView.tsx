/**
 * TaskListView — the mock's "List" view: the SAME tasks as the board, rendered as dense
 * rows (type, title, status, priority, assignee, when). Clicking a row selects the task
 * (opens the thread detail). Owns its loading / empty / error state.
 */
import React from 'react';
import { Badge, Spinner, Empty, Alert, cx } from '../../components/ui';
import { typeTint, statusTone, priorityDotVar, priorityLabel, STATUS_LABEL } from './config';
import { formatRelative, taskTitle, id8, actorDotVar } from './parts';
import type { Task } from '../../types/task';
import styles from './Tasks.module.css';
import { apiErrorMessage } from '../../api/request';

export interface TaskListViewProps {
  tasks: Task[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  isLoading: boolean;
  isError: boolean;
  error: unknown;
}

const TaskRow: React.FC<{ task: Task; active: boolean; onSelect: (id: string) => void }> = ({
  task,
  active,
  onSelect,
}) => (
  <button
    type="button"
    className={cx(styles.row, active && styles.rowOn)}
    aria-current={active}
    onClick={() => onSelect(task.id)}
  >
    <span className={styles.rowType}>
      <Badge variant={typeTint(task.type)}>{task.type}</Badge>
    </span>
    <span className={styles.rowTitle}>{taskTitle(task.title)}</span>
    <span className={styles.rowStatus}>
      <Badge variant={statusTone(task.status)}>{STATUS_LABEL[task.status] ?? task.status}</Badge>
    </span>
    <span className={styles.rowPrio}>
      <span
        className={styles.prioDot}
        style={{ background: `var(${priorityDotVar(task.priority)})` }}
        aria-hidden="true"
      />
      {priorityLabel(task.priority)}
    </span>
    <span className={styles.rowActor}>
      {task.assigned_to ? (
        <span className={styles.actorChip}>
          <span
            className={styles.actorDot}
            style={{ background: `var(${actorDotVar(task.assigned_to)})` }}
            aria-hidden="true"
          />
          {task.assigned_to}
        </span>
      ) : (
        <span className={styles.rowUnassigned}>—</span>
      )}
    </span>
    <span className={styles.rowWhen}>{formatRelative(task.updated_at ?? task.created_at)}</span>
    <span className={styles.rowId}>{id8(task.id)}</span>
  </button>
);

export const TaskListView: React.FC<TaskListViewProps> = ({
  tasks,
  selectedId,
  onSelect,
  isLoading,
  isError,
  error,
}) => {
  if (isLoading) {
    return (
      <div className={styles.boardState}>
        <Spinner size="lg" />
      </div>
    );
  }
  if (isError) {
    return (
      <div className={styles.boardState}>
        <Alert variant="error" title="Couldn't load tasks">
          {apiErrorMessage(error, 'Failed to load tasks.')}
        </Alert>
      </div>
    );
  }
  if (tasks.length === 0) {
    return (
      <div className={styles.boardState}>
        <Empty title="No tasks" description="No tasks in this project yet." />
      </div>
    );
  }

  return (
    <div className={styles.list} role="listbox" aria-label="Tasks">
      {tasks.map((t) => (
        <TaskRow key={t.id} task={t} active={t.id === selectedId} onSelect={onSelect} />
      ))}
    </div>
  );
};

export default TaskListView;
