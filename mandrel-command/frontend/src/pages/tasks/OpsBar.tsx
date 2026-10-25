/**
 * OpsBar — the mock's progress strip + "Building now" panel.
 *
 *  - Progress: a segmented bar (Done / In progress / Blocked / To do) + a legend, ALL
 *    from REAL `api.tasks.stats()` counts (by_status). Percentage = completed / total.
 *    Never fabricated — a status with no count shows 0.
 *  - Building now: the tasks that are ACTUALLY in progress (status = in_progress),
 *    each as its assignee actor chip → the task title. This is REAL (status + assigned_to
 *    columns).
 *
 * DATA-GAP POLICY: the mock's richer "→ builder-<id>" / branch substate
 * is NOT in the Command DB, so it is NOT fabricated here — we show only the real assignee
 * and the real in-progress state. When nothing is in progress, an honest empty line.
 */
import React from 'react';
import { Spinner } from '../../components/ui';
import { PROGRESS_SEGMENTS } from './config';
import { actorDotVar, taskTitle } from './parts';
import type { Task, TaskStats } from '../../types/task';
import styles from './Tasks.module.css';

export interface OpsBarProps {
  stats: TaskStats | undefined;
  statsLoading: boolean;
  buildingTasks: Task[];
  onSelect: (id: string) => void;
}

export const OpsBar: React.FC<OpsBarProps> = ({ stats, statsLoading, buildingTasks, onSelect }) => {
  const byStatus = stats?.by_status ?? {};
  const total = stats?.total ?? 0;
  const done = byStatus.completed ?? 0;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;

  return (
    <div className={styles.opsbar}>
      <div className={styles.progress}>
        <div className={styles.pTop}>
          <b>Progress</b>
          {statsLoading ? (
            <Spinner size="sm" />
          ) : (
            <span className={styles.pPct}>
              {done.toLocaleString()} / {total.toLocaleString()} · {pct}%
            </span>
          )}
        </div>
        <div className={styles.segbar}>
          {PROGRESS_SEGMENTS.map((seg) => {
            const count = byStatus[seg.status] ?? 0;
            const width = total > 0 ? (count / total) * 100 : 0;
            return (
              <i
                key={seg.status}
                style={{ width: `${width}%`, background: `var(${seg.colorVar})` }}
                aria-hidden="true"
              />
            );
          })}
        </div>
        <div className={styles.segLegend}>
          {PROGRESS_SEGMENTS.map((seg) => (
            <span key={seg.status}>
              <span
                className={styles.legendDot}
                style={{ background: `var(${seg.colorVar})` }}
                aria-hidden="true"
              />
              {seg.label} {(byStatus[seg.status] ?? 0).toLocaleString()}
            </span>
          ))}
        </div>
      </div>

      <div className={styles.building}>
        <div className={styles.buildingHead}>
          <span className={styles.pulse} aria-hidden="true" />
          Building now
        </div>
        {buildingTasks.length === 0 ? (
          <div className={styles.buildingEmpty}>Nothing in progress right now</div>
        ) : (
          buildingTasks.slice(0, 4).map((t) => (
            <button
              key={t.id}
              type="button"
              className={styles.buildingRow}
              onClick={() => onSelect(t.id)}
              title={t.title}
            >
              <span className={styles.actorChip}>
                <span
                  className={styles.actorDot}
                  style={{ background: `var(${actorDotVar(t.assigned_to)})` }}
                  aria-hidden="true"
                />
                {t.assigned_to ?? 'unassigned'}
              </span>
              <span className={styles.buildingArrow}>→ {taskTitle(t.title)}</span>
            </button>
          ))
        )}
      </div>
    </div>
  );
};

export default OpsBar;
