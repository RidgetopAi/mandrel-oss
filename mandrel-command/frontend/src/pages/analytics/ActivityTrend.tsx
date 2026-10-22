/**
 * ActivityTrend — the hero "Activity over time" area+line chart with a metric segmented
 * toggle (Contexts / Tasks completed / Tasks created / Sessions). REUSES `AreaChartCard` (teal
 * line + gradient fill + emphasized endpoint dot, one y-axis, hover tooltip) — no new chart
 * component. Data is the ONE live `/api/sessions/trends` series; the toggle just re-keys the
 * plotted series. The "vs prior" figure is the honest recent-half vs prior-half delta.
 */
import React from 'react';
import { AreaChartCard } from '../../components/charts';
import { Provenance, Segmented, computeDelta } from './parts';
import {
  HERO_METRIC_ORDER,
  HERO_DEFAULT_METRIC,
  METRICS,
  type MetricId,
  type RangeValue,
} from './config';
import type { SessionTrendPoint } from '../../api/domains/sessions';
import { formatDayShort, formatDayLong } from '../../utils/datetime';
import styles from './Analytics.module.css';

export interface ActivityTrendProps {
  trends: SessionTrendPoint[] | undefined;
  days: RangeValue;
  /**
   * The pivot bar's actor slice, when one is selected. Rendered into the caption so THIS
   * panel states the request it actually made. `/api/sessions/trends` is one of the reads
   * that accepts an actor; panels that do not are not filtered, and each one printing its
   * own query is what keeps that legible without a page-level claim that can go stale.
   */
  actor?: string;
  isLoading: boolean;
  isError: boolean;
}

// The local `shortDate` that used to live here did `new Date(Date.parse(iso)).getDate()`
// on a per-day bucket, i.e. on UTC midnight — so every viewer west of Greenwich saw each
// column labelled with the PREVIOUS day while the value under it was the right day's.
// Formatting also happened here, on the DATA, which left the tooltip printing the raw ISO
// string. Both are now the shared formatters, applied at the axis/tooltip where they
// belong; the row keeps the real bucket value.

export const ActivityTrend: React.FC<ActivityTrendProps> = ({
  trends,
  days,
  actor,
  isLoading,
  isError,
}) => {
  const [metric, setMetric] = React.useState<MetricId>(HERO_DEFAULT_METRIC);
  const meta = METRICS[metric];

  const rows = (trends ?? []).map((t) => ({
    date: t.date,
    contexts: Number(t.total_contexts ?? 0),
    tasksCompleted: Number(t.total_tasks_completed ?? 0),
    tasks: Number(t.total_tasks_created ?? 0),
    sessions: Number(t.session_count ?? 0),
  }));

  const values = rows.map((r) => Number(r[metric]));
  const delta = computeDelta(values);
  const deltaGlyph = delta ? (delta.trend === 'up' ? '▲' : delta.trend === 'down' ? '▼' : '▬') : '';
  const deltaTone = delta?.trend === 'up' ? styles.up : delta?.trend === 'down' ? styles.down : undefined;

  const metricOptions = HERO_METRIC_ORDER.map((id) => ({ value: id, label: METRICS[id].label }));

  return (
    <section className={styles.trend}>
      <div className={styles.trendHead}>
        <span className={styles.trendTitle}>Activity over time</span>
        <Segmented
          size="sm"
          options={metricOptions}
          value={metric}
          onChange={(v) => setMetric(v as MetricId)}
          ariaLabel="Trend metric"
        />
        {delta && (
          <span
            className={[styles.trendVal, deltaTone].filter(Boolean).join(' ')}
            title={`Most recent ${delta.halfDays} complete days vs the ${delta.halfDays} before them. Today is still in progress and is charted but not counted in this figure.`}
          >
            {deltaGlyph} {delta.pct}% vs prior {delta.halfDays}d
          </span>
        )}
      </div>
      {isError ? (
        <div className={styles.inlineError} role="alert">
          Couldn&apos;t load activity trends.
        </div>
      ) : (
        <AreaChartCard
          data={rows}
          xKey="date"
          xTickFormatter={(v) => formatDayShort(v as string)}
          tooltipLabelFormatter={(v) => formatDayLong(v as string)}
          series={[{ key: metric, name: meta.label }]}
          caption={
            <Provenance>
              /api/sessions/trends?days={days}
              {actor ? `&actor=${actor}` : ''} ·{' '}
              {'{date, contexts, tasksCompleted, tasks, sessions}'} per day
            </Provenance>
          }
          height={200}
          loading={isLoading}
          empty={rows.length === 0}
          emphasizeEndpoint
        />
      )}
    </section>
  );
};

export default ActivityTrend;
