/**
 * StatusFilter — the List view's segmented status-chip control:
 * `All · To do · In progress · Blocked · Done · Cancelled`, each with a LIVE count pill.
 * Selecting a chip scopes the List rows to that status (server-side filtered — see
 * `useTaskList(projectId, { status })`); "All" shows everything. Mirrors ViewToggle's
 * segmented pattern.
 *
 * COUNTS come from the UNCAPPED `/api/tasks/stats` (`stats.by_status` + `stats.total`), NOT
 * the capped list — `All` = `stats.total`, each status = `by_status[status] ?? 0`. Never
 * hardcoded. Options + labels come from config (`LIST_STATUS_FILTERS`). Rendered ONLY in the
 * List view (Tasks.tsx). Active chip via `aria-pressed`; the group is labelled for a11y.
 */
import React from 'react';
import { cx } from '../../components/ui';
import { ARCHIVED_FILTER_VALUE, LIST_STATUS_FILTERS, type ListStatusFilterValue } from './config';
import type { TaskStats } from '../../types/task';
import styles from './Tasks.module.css';

export interface StatusFilterProps {
  value: ListStatusFilterValue;
  onChange: (v: ListStatusFilterValue) => void;
  /** The UNCAPPED stats payload (`/api/tasks/stats`); undefined while it loads. */
  stats?: TaskStats;
}

/**
 * The live count for a filter option — `All` → total, `Archived` → the SEPARATE
 * soft-delete count, any status → by_status[status].
 *
 * `archived` is its own field on purpose: `total` and `by_status` count
 * LIVE rows only, so an archived task appears in neither — reading the Archived count out
 * of `by_status` would silently render 0 forever.
 */
function countFor(value: ListStatusFilterValue, stats?: TaskStats): number {
  if (value === 'all') return stats?.total ?? 0;
  if (value === ARCHIVED_FILTER_VALUE) return stats?.archived ?? 0;
  return stats?.by_status?.[value] ?? 0;
}

export const StatusFilter: React.FC<StatusFilterProps> = ({ value, onChange, stats }) => (
  <div className={styles.statusFilter} role="group" aria-label="Filter by status">
    {LIST_STATUS_FILTERS.map((opt) => {
      const count = countFor(opt.value, stats);
      return (
        <button
          key={opt.value}
          type="button"
          className={cx(styles.statusFilterItem, value === opt.value && styles.statusFilterOn)}
          aria-pressed={value === opt.value}
          onClick={() => onChange(opt.value)}
        >
          {opt.label}
          <span className={styles.statusFilterCount}>{count.toLocaleString()}</span>
        </button>
      );
    })}
  </div>
);

export default StatusFilter;
