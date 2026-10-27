/**
 * ThroughputChart — the full-width "Throughput vs created" trend (mock's `.card.full`):
 * an area+line with TWO series on a SINGLE y-axis (both are counts/day) — Completed/day
 * (teal) + Created/day (violet). REUSES the shared AreaChartCard (recharts), never a
 * bespoke chart or a new lib.
 *
 * WIRED: the backend now serves this per-day series
 * (GET /api/tasks/throughput, range-scoped + zero-filled). When the window has activity the
 * two lines plot REAL counts; an empty `series` means ZERO task activity of either kind in
 * the window → an HONEST empty state (data policy), never a fabricated trend.
 */
import React from 'react';
import {
  AreaChartCard,
  ChartFrame,
  useChartTheme,
  type SeriesDef,
} from '../../components/charts';
import { ANALYTICS_CONFIG } from './config';
import { toneHex } from './analyticsParts';
import { formatDayShort, formatDayLong } from '../../utils/datetime';

export interface ThroughputPoint {
  day: string;
  completed: number;
  created: number;
}

export interface ThroughputChartProps {
  /** Per-day series; empty ⇒ honest "No activity in this window". */
  series?: ThroughputPoint[];
  rangeLabel: string;
  loading?: boolean;
  /** Test seam: render at a fixed size (jsdom has no layout). */
  responsive?: boolean;
}

export const ThroughputChart: React.FC<ThroughputChartProps> = ({
  series,
  rangeLabel,
  loading = false,
  responsive = true,
}) => {
  const ct = useChartTheme();
  const data = series ?? [];
  const seriesDefs: SeriesDef[] = [
    { key: 'completed', name: 'Completed / day', color: toneHex(ct, 'teal') },
    { key: 'created', name: 'Created / day', color: toneHex(ct, 'violet') },
  ];

  // Honest empty: the endpoint returned no activity for the window (no tasks created OR
  // completed). Render the shared ChartFrame's empty state rather than a fabricated trend.
  if (!loading && data.length === 0) {
    return (
      <ChartFrame
        title="Throughput vs created"
        caption={`tasks / day · ${rangeLabel}`}
        height={ANALYTICS_CONFIG.throughputChartHeight}
        empty
        emptyTitle="No activity in this window"
        emptyDescription={`No tasks were created or completed in the ${rangeLabel} window. Widen the range to see more.`}
      >
        <div />
      </ChartFrame>
    );
  }

  return (
    <AreaChartCard
      data={data as unknown as Array<Record<string, number | string>>}
      xKey="day"
      // `day` arrives as a bare `YYYY-MM-DD` calendar day. Parsed as an instant that is
      // UTC midnight, so it must NOT be converted into the browser's zone — see
      // utils/datetime.ts.
      xTickFormatter={(v) => formatDayShort(v as string)}
      tooltipLabelFormatter={(v) => formatDayLong(v as string)}
      series={seriesDefs}
      title="Throughput vs created"
      caption={`tasks / day · ${rangeLabel}`}
      height={ANALYTICS_CONFIG.throughputChartHeight}
      showLegend
      emphasizeEndpoint={false}
      loading={loading}
      responsive={responsive}
    />
  );
};

export default ThroughputChart;
