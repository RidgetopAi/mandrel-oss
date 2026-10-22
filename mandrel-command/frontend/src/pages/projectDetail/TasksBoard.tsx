/**
 * TasksBoard — the task mini-board: one lane per real status (todo / in-progress /
 * blocked / done) from insights.tasks, each with a proportional bar. Owns its own
 * loading (Skeleton) / error (honest dash) state; never fabricates a count.
 */
import React from 'react';
import { Card, CardHeader, Skeleton } from '../../components/ui';
import type { ProjectDetailInsights } from './hooks';
import { TASK_LANES } from './config';
import { TasksIcon } from './icons';
import styles from './ProjectDetail.module.css';

export interface TasksBoardProps {
  insights: ProjectDetailInsights | undefined;
  loading: boolean;
  error: boolean;
}

export const TasksBoard: React.FC<TasksBoardProps> = ({ insights, loading, error }) => {
  const tasks = insights?.tasks;
  const total = tasks?.total ?? 0;

  return (
    <Card>
      <CardHeader className={styles.ch}>
        <TasksIcon size={15} className={styles.chIco} />
        <span>Tasks</span>
        {!loading && !error && total > 0 && <span className={styles.chCt}>{total} total</span>}
      </CardHeader>
      {error ? (
        <div className={styles.boardEmpty}>Task breakdown unavailable.</div>
      ) : (
        <div className={styles.miniboard}>
          {TASK_LANES.map((lane) => {
            const value = tasks?.[lane.key];
            const pct = total > 0 && value != null ? Math.round((value / total) * 100) : 0;
            return (
              <div key={lane.key} className={styles.mb}>
                <div className={styles.mv} style={{ color: `var(${lane.colorVar})` }}>
                  {loading ? <Skeleton width={28} height={20} /> : (value ?? 0).toLocaleString()}
                </div>
                <div className={styles.mk}>{lane.label}</div>
                <div
                  className={styles.mbar}
                  style={{
                    background: `var(${lane.colorVar})`,
                    width: `${loading ? 0 : Math.max(pct, value && value > 0 ? 8 : 0)}%`,
                  }}
                  aria-hidden="true"
                />
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
};

export default TasksBoard;
