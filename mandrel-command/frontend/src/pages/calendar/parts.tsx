/**
 * Calendar building blocks — the pure data-derivation (bucket trends, group tasks
 * onto their scheduled day) plus the small presentational pieces (task card, day
 * activity summary). Derivation lives here so it is unit-testable and the grid
 * components stay presentational.
 */
import React from 'react';
import type { MomentumSeriesPoint } from '../../api/domains/momentumSeries';
import type { TaskEntity } from '../../api/generated/models/TaskEntity';
import { priorityVar, isDone } from './config';
import { apiDateKey } from './dates';
import { CheckIcon } from './icons';
import styles from './Calendar.module.css';

/** Index momentum-series points by their `YYYY-MM-DD` day key for O(1) day lookup. */
export function bucketMomentum(
  points: MomentumSeriesPoint[] | undefined,
): Map<string, MomentumSeriesPoint> {
  const m = new Map<string, MomentumSeriesPoint>();
  for (const p of points ?? []) {
    const key = apiDateKey(p.date);
    if (key) m.set(key, p);
  }
  return m;
}

/**
 * Group tasks that carry a `due_date` onto that day's `YYYY-MM-DD` key. Tasks with
 * no `due_date` are simply not placed (the old "Unscheduled" backlog rail is gone —
 * this is a daily-activity tool, not a planning board). `due_date` IS the
 * scheduled-date field the calendar renders against.
 */
export function tasksByDay(tasks: TaskEntity[] | undefined): Map<string, TaskEntity[]> {
  const byDay = new Map<string, TaskEntity[]>();
  for (const t of tasks ?? []) {
    const key = apiDateKey(t.due_date);
    if (!key) continue;
    const arr = byDay.get(key);
    if (arr) arr.push(t);
    else byDay.set(key, [t]);
  }
  return byDay;
}

/** Short id (first 8) for the mono id chip on a card. */
function short(id: string | undefined): string | undefined {
  return id ? id.slice(0, 8) : undefined;
}

/** A single task card placed on a day (priority stripe + title + id/priority). */
export const TaskCard: React.FC<{ task: TaskEntity }> = ({ task }) => {
  const done = isDone(task.status);
  return (
    <div
      className={done ? `${styles.card} ${styles.cardDone}` : styles.card}
      style={{ borderLeftColor: `var(${priorityVar(task.priority)})` }}
    >
      <div className={styles.cardTitle}>{task.title}</div>
      <div className={styles.cardMeta}>
        {done ? (
          <span className={styles.cardCheck} aria-hidden="true">
            <CheckIcon size={9} />
          </span>
        ) : (
          <span
            className={styles.cardPrio}
            style={{ background: `var(${priorityVar(task.priority)})` }}
            aria-hidden="true"
          />
        )}
        <span className={styles.cardId}>{short(task.id)}</span>
        <span className={styles.cardPriTxt}>{task.priority}</span>
      </div>
    </div>
  );
};
