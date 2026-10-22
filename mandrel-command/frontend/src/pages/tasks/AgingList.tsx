/**
 * AgingList — "Oldest open tasks" (mock's aging list). Each row: a priority colour rail,
 * the title, the short id + priority, and an age badge that burns hot/warm past the config
 * thresholds. REAL rows only — the oldest OPEN tasks (by created_at) from the loaded set,
 * clicking a row opens that task (the same `/tasks/:id` deep-link the board uses).
 */
import React from 'react';
import { Empty, Spinner } from '../../components/ui';
import { ClockIcon } from './icons';
import { priorityDotVar, priorityLabel } from './config';
import { deriveAging } from './analyticsParts';
import { id8 } from './parts';
import type { Task } from '../../types/task';
import styles from './Tasks.module.css';

export interface AgingListProps {
  rows: Task[];
  onSelect: (id: string) => void;
  /** The LIST query's loading flag — show a spinner (not a false "Nothing open") mid-fetch. */
  loading?: boolean;
}

/** Heat bucket → the CSS-module tone class (cool = default text colour, no class). */
function heatClass(heat: 'hot' | 'warm' | 'cool'): string | undefined {
  if (heat === 'hot') return styles.ageHot;
  if (heat === 'warm') return styles.ageWarm;
  return undefined;
}

export const AgingList: React.FC<AgingListProps> = ({ rows, onSelect, loading = false }) => {
  const aging = React.useMemo(() => deriveAging(rows), [rows]);

  return (
    <div className={styles.card}>
      <div className={styles.cardHead}>
        <ClockIcon size={15} />
        Oldest open tasks
        <span className={styles.cardHeadCt}>aging</span>
      </div>
      {loading ? (
        <div className={styles.agingEmpty}>
          <Spinner size="sm" />
        </div>
      ) : aging.length === 0 ? (
        <div className={styles.agingEmpty}>
          <Empty title="Nothing open" description="No open tasks to age right now." />
        </div>
      ) : (
        <div className={styles.aging}>
          {aging.map((r) => (
            <button
              key={r.id}
              type="button"
              className={styles.arow}
              onClick={() => onSelect(r.id)}
              title={r.title}
            >
              <span
                className={styles.arowRail}
                style={{ background: `var(${priorityDotVar(r.priority)})` }}
                aria-hidden="true"
              />
              <span className={styles.arowBody}>
                <span className={styles.arowTitle}>{r.title}</span>
                <span className={styles.arowMeta}>
                  {id8(r.id)} · {priorityLabel(r.priority)}
                </span>
              </span>
              <span className={[styles.arowAge, heatClass(r.heat)].filter(Boolean).join(' ')}>
                {r.days}d
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

export default AgingList;
