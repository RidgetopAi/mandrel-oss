/**
 * PriorityBreakdown — "Open by priority" (mock's horizontal bars). REUSES the shared
 * BarChartCard (horizontal layout, per-bar colour via `colorKey`) in the fixed categorical
 * order Urgent / High / Medium / Low. Counts are REAL — derived from the loaded OPEN rows
 * (there is no open-by-priority endpoint; the stats map is all-status, so this reads the
 * same task set the board shows).
 */
import React from 'react';
import { BarChartCard, useChartTheme } from '../../components/charts';
import { ANALYTICS_CONFIG } from './config';
import { deriveOpenByPriority } from './analyticsParts';
import type { Task } from '../../types/task';

export interface PriorityBreakdownProps {
  rows: Task[];
  loading?: boolean;
  responsive?: boolean;
}

export const PriorityBreakdown: React.FC<PriorityBreakdownProps> = ({
  rows,
  loading = false,
  responsive = true,
}) => {
  const ct = useChartTheme();
  const data = deriveOpenByPriority(rows, ct);
  const openTotal = data.reduce((sum, d) => sum + d.count, 0);

  return (
    <BarChartCard
      data={data as unknown as Array<Record<string, number | string>>}
      xKey="label" /* non-date-axis: priority names (High/Medium/Low), a category axis */
      series={[{ key: 'count', name: 'Open' }]}
      colorKey="color"
      layout="vertical"
      title="Open by priority"
      caption="open tasks · live"
      height={ANALYTICS_CONFIG.breakdownChartHeight}
      loading={loading}
      empty={openTotal === 0}
      responsive={responsive}
    />
  );
};

export default PriorityBreakdown;
