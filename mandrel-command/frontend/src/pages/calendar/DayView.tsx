/**
 * DayView — the single-day view: one full-width panel for the focused day leading
 * with its MOMENTUM at a glance (mini-ring + score + sessions·contexts counts, from
 * `/api/momentum-series`) and every task scheduled by due-date on it. The panel is
 * CLICKABLE → `onSelectDate` opens the day-summary card, consistent
 * with the Month/Week cells.
 */
import React from 'react';
import { Text, cx } from '../../components/ui';
import type { MomentumSeriesPoint } from '../../api/domains/momentumSeries';
import type { TaskEntity } from '../../api/generated/models/TaskEntity';
import { toDateKey, dayPosition, formatDayLabel } from './dates';
import { TaskCard } from './parts';
import { MomentumCell } from './MomentumCell';
import styles from './Calendar.module.css';

export interface DayViewProps {
  day: Date;
  momentum: Map<string, MomentumSeriesPoint>;
  tasksByDay: Map<string, TaskEntity[]>;
  onSelectDate: (d: Date) => void;
  selectedKey?: string;
}

export const DayView: React.FC<DayViewProps> = ({
  day,
  momentum,
  tasksByDay,
  onSelectDate,
  selectedKey,
}) => {
  const now = new Date();
  const key = toDateKey(day);
  const pos = dayPosition(day, now);
  const point = momentum.get(key);
  const hasData = point?.hasData ?? false;
  const cards = tasksByDay.get(key) ?? [];
  const empty = !hasData && cards.length === 0;

  return (
    <button
      type="button"
      className={cx(
        styles.dayView,
        styles.dayClickable,
        pos === 'today' && styles.dayToday,
        pos === 'past' && styles.dayPast,
        selectedKey === key && styles.daySelected,
      )}
      onClick={() => onSelectDate(day)}
      aria-label={`Open day summary for ${key}`}
      aria-pressed={selectedKey === key}
    >
      <div className={styles.dayViewHead}>
        <span className={styles.dayViewTitle}>{formatDayLabel(day)}</span>
        {pos === 'today' && <span className={styles.todayTag}>· today</span>}
      </div>

      {hasData && <MomentumCell point={point!} variant="stack" />}

      {cards.length > 0 ? (
        <div className={styles.dayViewCards}>
          {cards.map((t) => (
            <TaskCard key={t.id} task={t} />
          ))}
        </div>
      ) : null}

      {empty && (
        <div className={styles.dayViewEmpty} aria-hidden="true">
          <Text variant="body" tone="faintest">
            {pos === 'future' ? 'Nothing scheduled yet.' : 'A quiet day — no recorded activity.'}
          </Text>
        </div>
      )}
    </button>
  );
};

export default DayView;
