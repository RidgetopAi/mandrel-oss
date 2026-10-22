/**
 * StatusBreakdown — "Open tasks by status" (mock's stacked bar + key). The stacked bar
 * shows the OPEN statuses only (Todo / In progress / Blocked); Done would dwarf the bar,
 * so it lives in the key. REUSES the shared BarChartCard (stacked). All counts are REAL —
 * the uncapped `by_status` stats map, missing statuses read 0 (never fabricated).
 */
import React from 'react';
import { BarChartCard, useChartTheme, type SeriesDef } from '../../components/charts';
import { ANALYTICS_CONFIG, ANALYTICS_STATUS_SERIES } from './config';
import { toneHex, statusCount } from './analyticsParts';
import type { TaskStats } from '../../types/task';
import styles from './Tasks.module.css';

export interface StatusBreakdownProps {
  stats: TaskStats | undefined;
  loading?: boolean;
  responsive?: boolean;
}

export const StatusBreakdown: React.FC<StatusBreakdownProps> = ({
  stats,
  loading = false,
  responsive = true,
}) => {
  const ct = useChartTheme();
  const byStatus = stats?.by_status;

  const stackedSeries = ANALYTICS_STATUS_SERIES.filter((s) => s.stacked);
  const openTotal = stackedSeries.reduce((sum, s) => sum + statusCount(byStatus, s.key), 0);

  const row: Record<string, number | string> = { name: 'Open' };
  for (const s of stackedSeries) row[s.key] = statusCount(byStatus, s.key);

  const seriesDefs: SeriesDef[] = stackedSeries.map((s) => ({
    key: s.key,
    name: s.label,
    color: toneHex(ct, s.tone),
  }));

  return (
    <div>
      <BarChartCard
        data={[row]}
        xKey="name" /* non-date-axis: task status names, a category axis */
        series={seriesDefs}
        layout="vertical"
        stacked
        title="Open tasks by status"
        caption="task stats · live"
        height={ANALYTICS_CONFIG.breakdownChartHeight}
        showAxes={false}
        showGrid={false}
        loading={loading}
        empty={openTotal === 0}
        responsive={responsive}
      />
      <div className={styles.stackKey}>
        {ANALYTICS_STATUS_SERIES.map((s) => (
          <span key={s.key}>
            <i style={{ background: toneHex(ct, s.tone) }} aria-hidden="true" />
            {s.label} <b>{statusCount(byStatus, s.key).toLocaleString()}</b>
          </span>
        ))}
      </div>
    </div>
  );
};

export default StatusBreakdown;
