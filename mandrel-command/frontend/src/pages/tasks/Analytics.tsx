/**
 * Analytics — the third Tasks view (Board / List / **Analytics**), Phase 3 "Insight".
 * A view PART inside the existing `pages/tasks/` module (NOT a new route/page/nav item):
 * Tasks.tsx renders it when the view toggle is on `analytics`. Composes the KPI row, the
 * full-width throughput trend, and the 2×2 breakdown grid (status / priority / actor /
 * aging). Each panel owns its loading / empty / error state and is REAL-or-honest-empty
 * (the data-gap policy) — the time-based panels (throughput trend, actor breakdown)
 * are fed by real range-scoped endpoints (/api/tasks/throughput, /completed-by-actor) and
 * render an honest empty state only when the endpoint returns no data — never a fabricated series.
 */
import React from 'react';
import { Alert } from '../../components/ui';
import { AnalyticsKpis } from './AnalyticsKpis';
import { ThroughputChart } from './ThroughputChart';
import { StatusBreakdown } from './StatusBreakdown';
import { PriorityBreakdown } from './PriorityBreakdown';
import { ActorBreakdown } from './ActorBreakdown';
import { AgingList } from './AgingList';
import { RANGE_OPTIONS, ANALYTICS_CONFIG, type RangeValue } from './config';
import type {
  Task,
  TaskStats,
  TaskLeadTime,
  ThroughputPoint,
  CompletedByActor,
} from '../../types/task';
import styles from './Tasks.module.css';
import { apiErrorMessage } from '../../api/request';

export interface AnalyticsProps {
  /** Project-scoped task rows (pre text-search) — the same set the board loads. */
  rows: Task[];
  /** The LIST query's loading flag — drives the row-derived panels (priority / aging). */
  rowsLoading: boolean;
  stats: TaskStats | undefined;
  statsLoading: boolean;
  statsError: boolean;
  statsErrorObj: unknown;
  leadTime: TaskLeadTime | undefined;
  leadTimeLoading: boolean;
  /** Per-day throughput series (REAL server data). Empty ⇒ honest "no activity" state. */
  throughputSeries: ThroughputPoint[] | undefined;
  throughputLoading: boolean;
  /** Completed-by-actor breakdown (REAL server data). Empty ⇒ honest empty state. */
  actors: CompletedByActor[] | undefined;
  actorsLoading: boolean;
  range: RangeValue;
  onSelect: (id: string) => void;
  /** Test seam forwarded to the charts (jsdom has no layout). */
  responsive?: boolean;
}

export const Analytics: React.FC<AnalyticsProps> = ({
  rows,
  rowsLoading,
  stats,
  statsLoading,
  statsError,
  statsErrorObj,
  leadTime,
  leadTimeLoading,
  throughputSeries,
  throughputLoading,
  actors,
  actorsLoading,
  range,
  onSelect,
  responsive = true,
}) => {
  const rangeLabel = RANGE_OPTIONS.find((r) => r.value === range)?.label ?? range;

  // Derive the Throughput KPI (sparkline of completions/day + a completed-per-week rate)
  // from the SAME real per-day series the trend chart plots — no separate/fabricated feed.
  const series = throughputSeries ?? [];
  const sparkData = series.map((p) => ({ value: p.completed }));
  const totalCompleted = series.reduce((sum, p) => sum + p.completed, 0);
  const throughputPerWeek =
    series.length > 0
      ? Math.round((totalCompleted / series.length) * ANALYTICS_CONFIG.throughputPerWeekDays)
      : undefined;

  if (statsError) {
    return (
      <Alert variant="error" title="Couldn't load task analytics">
        {apiErrorMessage(statsErrorObj, 'Failed to load task stats.')}
      </Alert>
    );
  }

  return (
    <div className={styles.analytics}>
      <AnalyticsKpis
        stats={stats}
        statsLoading={statsLoading}
        leadTime={leadTime}
        leadTimeLoading={leadTimeLoading}
        throughputSeries={sparkData.length > 0 ? sparkData : undefined}
        throughputPerWeek={throughputPerWeek}
      />

      <ThroughputChart
        series={throughputSeries}
        rangeLabel={rangeLabel}
        loading={throughputLoading}
        responsive={responsive}
      />

      <div className={styles.analyticsCols}>
        <StatusBreakdown stats={stats} loading={statsLoading} responsive={responsive} />
        <PriorityBreakdown rows={rows} loading={rowsLoading} responsive={responsive} />
        <ActorBreakdown
          actors={actors}
          rangeLabel={rangeLabel}
          loading={actorsLoading}
          responsive={responsive}
        />
        <AgingList rows={rows} loading={rowsLoading} onSelect={onSelect} />
      </div>
    </div>
  );
};

export default Analytics;
