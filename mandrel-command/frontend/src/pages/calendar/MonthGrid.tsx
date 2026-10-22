/**
 * MonthGrid — the DEFAULT view: a standard month grid (weekday header + 6×7 day
 * cells). Each cell shows the day's MOMENTUM at a glance (a centered mini-ring +
 * the score bottom-left + the sessions·contexts counts top-right, from
 * `/api/momentum-series`) plus a count of tasks scheduled by due-date on that day.
 * A day with no recorded activity (`hasData=false`) renders a blank cell.
 * Leading/trailing cells spill from the adjacent months (dimmed). Today is
 * highlighted. Every cell is CLICKABLE → `onSelectDate` opens the day-summary card.
 */
import React from 'react';
import { cx } from '../../components/ui';
import type { MomentumSeriesPoint } from '../../api/domains/momentumSeries';
import type { TaskEntity } from '../../api/generated/models/TaskEntity';
import { WEEKDAY_SHORT, toDateKey, dayPosition, isSameMonth } from './dates';
import { MomentumCell } from './MomentumCell';
import styles from './Calendar.module.css';

export interface MonthGridProps {
  /** The 42 grid days (6 rows × 7 cols) — from `monthGridDays`. */
  days: Date[];
  /** The month being displayed (drives in/out-of-month dimming). */
  month: Date;
  momentum: Map<string, MomentumSeriesPoint>;
  tasksByDay: Map<string, TaskEntity[]>;
  onSelectDate: (d: Date) => void;
  selectedKey?: string;
}

export const MonthGrid: React.FC<MonthGridProps> = ({
  days,
  month,
  momentum,
  tasksByDay,
  onSelectDate,
  selectedKey,
}) => {
  const now = new Date();

  return (
    <div className={styles.month}>
      <div className={styles.moHead}>
        {WEEKDAY_SHORT.map((w) => (
          <div key={w} className={styles.moHeadCell}>
            {w}
          </div>
        ))}
      </div>

      <div className={styles.moBody}>
        {days.map((d) => {
          const key = toDateKey(d);
          const pos = dayPosition(d, now);
          const inMonth = isSameMonth(d, month);
          const point = momentum.get(key);
          const hasData = point?.hasData ?? false;
          const taskCount = tasksByDay.get(key)?.length ?? 0;
          return (
            <button
              type="button"
              key={key}
              className={cx(
                styles.moDay,
                styles.dayClickable,
                !inMonth && styles.moDayOut,
                pos === 'today' && styles.moDayToday,
                selectedKey === key && styles.daySelected,
              )}
              onClick={() => onSelectDate(d)}
              aria-label={`Open day summary for ${key}${
                hasData ? ` — momentum ${point!.momentum.score}` : ''
              }`}
              aria-pressed={selectedKey === key}
            >
              <span className={styles.moDayNum}>{d.getDate()}</span>
              {hasData && <MomentumCell point={point!} variant="month" />}
              {taskCount > 0 && (
                <span className={styles.moTasks} aria-hidden="true">
                  {taskCount} {taskCount === 1 ? 'task' : 'tasks'}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
};

export default MonthGrid;
