/**
 * AnalyticsKpis — the four KPI tiles atop the Tasks · Analytics view (mock's `.kpis`).
 * Each tile carries a provenance tag (live / built / not-yet-available) so a real number
 * is never confused with a gap (the operator's real-not-mocked rule + the data-gap policy):
 *
 *   1. Throughput (/wk + Sparkline) — LIVE from `/api/tasks/throughput` (range-scoped per-day
 *      series of completed/created); the /wk figure + Sparkline are derived from that real
 *      series, with an honest empty state when the window has no activity.
 *   2. Completion rate (%) — LIVE from `/api/tasks/stats` (completed / total).
 *   3. Avg cycle time (d) — LIVE from `/api/tasks/lead-time` (completed_at − created_at).
 *   4. WIP · blocked — LIVE from stats.by_status (in_progress · blocked).
 */
import React from 'react';
import { Skeleton, Spinner } from '../../components/ui';
import { Sparkline } from '../../components/charts';
import type { TaskStats, TaskLeadTime } from '../../types/task';
import { statusCount } from './analyticsParts';
import styles from './Tasks.module.css';

type SourceKind = 'live' | 'built' | 'gap';

const KpiTile: React.FC<{
  label: string;
  value: React.ReactNode;
  unit?: React.ReactNode;
  caption?: React.ReactNode;
  spark?: React.ReactNode;
  source: { text: string; kind: SourceKind };
  loading?: boolean;
}> = ({ label, value, unit, caption, spark, source, loading }) => (
  <div className={styles.kpi}>
    <div className={styles.kpiK}>{label}</div>
    {loading ? (
      <Skeleton shape="line" style={{ width: '55%', height: 26, marginTop: 6 }} />
    ) : (
      <div className={styles.kpiV}>
        {value}
        {unit != null && <small>{unit}</small>}
      </div>
    )}
    {caption && !loading && <div className={styles.kpiCap}>{caption}</div>}
    {spark && <div className={styles.kpiSpark}>{spark}</div>}
    <div className={styles.kpiSrc}>
      <i className={styles[source.kind]} aria-hidden="true" />
      {source.text}
    </div>
  </div>
);

export interface AnalyticsKpisProps {
  stats: TaskStats | undefined;
  statsLoading: boolean;
  leadTime: TaskLeadTime | undefined;
  leadTimeLoading: boolean;
  /**
   * Per-period throughput series for the KPI sparkline. The backend does not serve a
   * completion time-series yet, so this is normally undefined → the tile shows the honest
   * "not yet available" state. Supplying it (e.g. once the endpoint ships, or in tests)
   * lights up the Sparkline + the /wk figure.
   */
  throughputSeries?: Array<{ value: number }>;
  throughputPerWeek?: number;
}

export const AnalyticsKpis: React.FC<AnalyticsKpisProps> = ({
  stats,
  statsLoading,
  leadTime,
  leadTimeLoading,
  throughputSeries,
  throughputPerWeek,
}) => {
  const byStatus = stats?.by_status ?? {};
  const total = stats?.total ?? 0;
  const completed = statusCount(byStatus, 'completed');
  const inProgress = statusCount(byStatus, 'in_progress');
  const blocked = statusCount(byStatus, 'blocked');
  const rate =
    stats?.completion_rate != null
      ? Math.round(stats.completion_rate)
      : total > 0
        ? Math.round((completed / total) * 100)
        : 0;

  const lt = leadTime?.stats;
  const hasCycle = (lt?.totalTasks ?? 0) > 0;

  const hasThroughput = Array.isArray(throughputSeries) && throughputSeries.length > 0;

  return (
    <div className={styles.kpiGrid}>
      {/* 1 — Throughput (gap: no completion time-series endpoint) */}
      <KpiTile
        label="Throughput"
        value={hasThroughput && throughputPerWeek != null ? throughputPerWeek : '—'}
        unit={hasThroughput ? ' /wk' : undefined}
        caption={hasThroughput ? 'completed per week' : 'not yet available'}
        source={
          hasThroughput
            ? { text: 'tasks completed · live', kind: 'live' }
            : { text: 'needs per-day completion series', kind: 'gap' }
        }
        spark={
          hasThroughput ? (
            <Sparkline data={throughputSeries} tone="teal" height={26} />
          ) : undefined
        }
      />

      {/* 2 — Completion rate (LIVE) */}
      <KpiTile
        label="Completion rate"
        value={rate}
        unit="%"
        caption={`${completed.toLocaleString()} / ${total.toLocaleString()}`}
        source={{ text: 'tasks stats · live', kind: 'live' }}
        loading={statsLoading}
      />

      {/* 3 — Avg cycle time (LIVE from lead-time) */}
      <KpiTile
        label="Avg cycle time"
        value={leadTimeLoading ? <Spinner size="sm" /> : hasCycle ? lt!.averageLeadTime : '—'}
        unit={!leadTimeLoading && hasCycle ? ' d' : undefined}
        caption={
          leadTimeLoading
            ? undefined
            : hasCycle
              ? `median ${lt!.medianLeadTime}d · ${lt!.totalTasks.toLocaleString()} completed`
              : 'no completed tasks yet'
        }
        source={{ text: 'started→completed · live', kind: 'built' }}
      />

      {/* 4 — WIP · blocked (LIVE) */}
      <KpiTile
        label="WIP · blocked"
        value={
          <>
            {inProgress}
            <small> · </small>
            {blocked}
          </>
        }
        caption={`${blocked} blocked`}
        source={{ text: 'status = in_progress|blocked · live', kind: 'live' }}
        loading={statsLoading}
      />
    </div>
  );
};

export default AnalyticsKpis;
