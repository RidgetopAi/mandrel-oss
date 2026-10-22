/**
 * WeekGrid — the 7-day view: a header row (weekday + date) over a body row of day
 * columns. Each day leads with its MOMENTUM at a glance (mini-ring + score + the
 * sessions·contexts counts, from `/api/momentum-series`) and then lists any task whose
 * `due_date` lands on that day. A day with no recorded activity shows no momentum block.
 * Every day column is CLICKABLE → `onSelectDate` opens the day-summary card.
 */
import React from 'react';
import { Text, cx } from '../../components/ui';
import type { MomentumSeriesPoint } from '../../api/domains/momentumSeries';
import type { TaskEntity } from '../../api/generated/models/TaskEntity';
import { toDateKey, weekdayShort, dayPosition } from './dates';
import { TaskCard } from './parts';
import { MomentumCell } from './MomentumCell';
import styles from './Calendar.module.css';

export interface WeekGridProps {
  days: Date[];
  momentum: Map<string, MomentumSeriesPoint>;
  tasksByDay: Map<string, TaskEntity[]>;
  /** Open the day-summary card for a clicked day. */
  onSelectDate: (d: Date) => void;
  /** `YYYY-MM-DD` of the currently-open day (highlights its cell), if any. */
  selectedKey?: string;
}

export const WeekGrid: React.FC<WeekGridProps> = ({
  days,
  momentum,
  tasksByDay,
  onSelectDate,
  selectedKey,
}) => {
  const now = new Date();

  return (
    <div className={styles.week}>
      <div className={styles.wkHead}>
        {days.map((d) => {
          const pos = dayPosition(d, now);
          return (
            <div
              key={toDateKey(d)}
              className={cx(styles.dh, pos === 'today' && styles.dhToday, pos === 'past' && styles.dhPast)}
            >
              <div className={styles.dhName}>{weekdayShort(d)}</div>
              <div className={styles.dhNum}>
                {d.getDate()}
                {pos === 'today' && <span className={styles.todayTag}> · today</span>}
              </div>
            </div>
          );
        })}
      </div>

      <div className={styles.wkBody}>
        {days.map((d) => {
          const key = toDateKey(d);
          const pos = dayPosition(d, now);
          const point = momentum.get(key);
          const hasData = point?.hasData ?? false;
          const cards = tasksByDay.get(key) ?? [];
          const empty = !hasData && cards.length === 0;
          return (
            <button
              type="button"
              key={key}
              className={cx(
                styles.day,
                styles.dayClickable,
                pos === 'today' && styles.dayToday,
                pos === 'past' && styles.dayPast,
                selectedKey === key && styles.daySelected,
              )}
              onClick={() => onSelectDate(d)}
              aria-label={`Open day summary for ${key}`}
              aria-pressed={selectedKey === key}
            >
              {hasData && <MomentumCell point={point!} variant="stack" />}
              {cards.map((t) => (
                <TaskCard key={t.id} task={t} />
              ))}
              {empty && (
                <div className={styles.dayEmpty} aria-hidden="true">
                  <Text variant="data" tone="faintest">
                    {pos === 'future' ? '—' : 'quiet'}
                  </Text>
                </div>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
};

export default WeekGrid;
