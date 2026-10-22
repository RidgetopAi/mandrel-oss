/**
 * ViewToggle — the mock's Board / List / Analytics segmented control. All three are
 * in-page views over the same task data: Board + List render the tasks; Analytics (Phase 3
 * "Insight") renders the throughput / cycle-time / distribution
 * view PART (see Analytics.tsx) — a view mode, not a separate route/page/nav item.
 */
import React from 'react';
import { cx } from '../../components/ui';
import { BoardIcon, ListIcon, ChartIcon } from './icons';
import { VIEW_OPTIONS, type ViewValue } from './config';
import styles from './Tasks.module.css';

const ICONS: Record<ViewValue, React.FC<{ size?: number }>> = {
  board: BoardIcon,
  list: ListIcon,
  analytics: ChartIcon,
};

export interface ViewToggleProps {
  view: ViewValue;
  onChange: (v: ViewValue) => void;
}

export const ViewToggle: React.FC<ViewToggleProps> = ({ view, onChange }) => (
  <div className={styles.vtoggle} role="group" aria-label="View">
    {VIEW_OPTIONS.map((opt) => {
      const Icon = ICONS[opt.value];
      return (
        <button
          key={opt.value}
          type="button"
          className={cx(styles.vtoggleItem, view === opt.value && styles.vtoggleOn)}
          aria-pressed={view === opt.value}
          onClick={() => onChange(opt.value)}
        >
          <Icon size={15} />
          {opt.label}
        </button>
      );
    })}
  </div>
);

export default ViewToggle;
