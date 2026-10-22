/**
 * KpiStrip — the mock's hero totals (Sessions / Tasks-completed / Contexts / Tasks-created).
 * Each
 * tile's value, sparkline and delta all DERIVE from the ONE live `/api/sessions/trends`
 * series (no second fetch, no fabricated baseline): value = the window sum, sparkline = the
 * per-day series, delta = the honest recent-half vs prior-half change. Reuses the shared
 * charting `Sparkline`. Skeletons while loading; a dash on error (each tile owns its state).
 */
import React from 'react';
import { Sparkline } from '../../components/charts';
import { Skeleton } from '../../components/ui';
import { Provenance, computeDelta, formatInt } from './parts';
import { KPI_ORDER, METRICS } from './config';
import type { SessionTrendPoint } from '../../api/domains/sessions';
import styles from './Analytics.module.css';

export interface KpiStripProps {
  trends: SessionTrendPoint[] | undefined;
  /** The pivot bar's actor slice, when one is selected — see ActivityTrendProps.actor. */
  actor?: string;
  isLoading: boolean;
  isError: boolean;
}

const trendGlyph = { up: '▲', down: '▼', flat: '▬' } as const;

export const KpiStrip: React.FC<KpiStripProps> = ({ trends, actor, isLoading, isError }) => (
  <div className={styles.totals}>
    {KPI_ORDER.map((id) => {
      const meta = METRICS[id];
      const values = (trends ?? []).map((t) => Number(t[meta.trendKey] ?? 0));
      const total = values.reduce((a, b) => a + b, 0);
      const delta = computeDelta(values);
      const spark = values.map((v, i) => ({ i, value: v }));

      return (
        <div key={id} className={styles.tt} data-metric={id}>
          <div className={styles.ttK}>{meta.label}</div>
          {isLoading ? (
            <Skeleton width={72} height={28} />
          ) : (
            <div className={styles.ttV}>
              {isError ? '—' : formatInt(total)}
            </div>
          )}
          {!isLoading && !isError && delta && (
            <div className={styles[`ttD_${delta.trend}` as const]}>
              {trendGlyph[delta.trend]} {delta.pct}%
            </div>
          )}
          {!isLoading && !isError && values.length > 0 && (
            <div className={styles.spk} aria-hidden="true">
              <Sparkline data={spark} dataKey="value" tone="teal" height={26} />
            </div>
          )}
          <Provenance>/api/sessions/trends{actor ? `?actor=${actor}` : ''}</Provenance>
        </div>
      );
    })}
  </div>
);

export default KpiStrip;
