/**
 * Small shared Analytics building blocks — pure formatters + the provenance dot, the panel
 * chrome, and the segmented toggle from the mock. No data access here; colour is only ever
 * a token CSS-var (guarded by Analytics.wiring.test.ts).
 */
import React from 'react';
import { cx } from '../../components/ui';
import { ANALYTICS_CONFIG } from './config';
import styles from './Analytics.module.css';

/*
 * `formatCompact` (a pass-through to the charting module's `compactNumber`) is DELETED
 * with the `MCP payload (est.)` metric that was its only caller. Every
 * KPI tile now prints a plain count of records. The shared `compactNumber` is untouched
 * and the chart axes still use it directly.
 */

/** Plain grouped integer: 1,028. */
export function formatInt(n: number): string {
  return Number.isFinite(n) ? Math.round(n).toLocaleString() : '—';
}

export interface Delta {
  pct: number;
  trend: 'up' | 'down' | 'flat';
  /**
   * The length, in days, of EACH half actually compared — after the trailing partial day
   * and any odd point have been dropped. The label must be rendered from THIS, never from
   * `Math.floor(days / 2)`: that expression is what printed "vs prior 15d" next to a
   * comparison against a 16-day half.
   */
  halfDays: number;
}

/**
 * Honest intra-window delta: sum the recent half vs the prior half of the series (the same
 * live data the chart draws). Returns null when there aren't enough points or the prior
 * half is empty (never a fabricated baseline / never divide-by-zero).
 *
 * ── TWO WAYS THIS FLATTERED THE RECENT HALF (item 5) ───────────────────
 *
 * 1. THE ODD POINT WENT TO `recent`. `slice(0, mid)` / `slice(mid)` on an odd-length
 *    series gives the recent half one extra day, and days are not free — they carry
 *    activity. The backend's series was itself one row too long (inclusive
 *    `generate_series`, fixed there), so a "30d" window produced 31 points and
 *    `floor(31/2) = 15` meant 15 prior days were compared against 16 recent ones, every
 *    time, for every metric on this page. Measured on prod contexts 2026-08-10: 1048 over
 *    the prior 15 vs 1095 over the recent 16 — a comparison of unequal denominators
 *    printed as a single percentage. Now the OLDEST point is dropped instead, so both
 *    halves are always the same length and the ratio is a ratio of like for like.
 *
 * 2. TODAY'S BUCKET IS PARTIAL, AND IT SAT INSIDE `recent`. The series always ends on the
 *    viewer's current local day (the backend's `date_series` runs through `local_today`),
 *    which has had only part of a day to accumulate. Including it drags the recent half
 *    down early in the day and up by evening — i.e. the headline moves from the CLOCK, on
 *    unchanged data. On a 7d window that partial day was a seventh of the comparison. It
 *    is dropped from the DELTA here and stays on the CHART, where a short final column is
 *    self-evidently today rather than a hidden term in an average.
 *
 * The trailing point is identified structurally (it is the last one) rather than by
 * parsing a date, because "the series ends at the viewer's today" is a property of the
 * endpoint, asserted at the endpoint — see the row-count assertion in
 * `sessionAnalytics.getSessionTrends`.
 */
export function computeDelta(values: number[]): Delta | null {
  // Drop today's partial bucket, then drop the odd point from the OLD end.
  const settled = values.slice(0, -1);
  const usable = settled.length - (settled.length % 2);
  const even = settled.slice(settled.length - usable);
  if (even.length < ANALYTICS_CONFIG.minPointsForDelta) return null;
  const half = even.length / 2;
  const prior = sum(even.slice(0, half));
  const recent = sum(even.slice(half));
  if (prior <= 0) return null;
  const pct = ((recent - prior) / prior) * 100;
  const rounded = Math.round(pct);
  return {
    pct: Math.abs(rounded),
    trend: rounded > 0 ? 'up' : rounded < 0 ? 'down' : 'flat',
    halfDays: half,
  };
}

export function sum(values: number[]): number {
  return values.reduce((a, b) => a + b, 0);
}

/**
 * A provenance source dot + label (mock `.src`). Names the panel's real data source.
 *
 * The `kind` prop is GONE with the vocabulary it indexed (item 2 — see
 * config.ts). Every panel on this page is live, so the prop was a constant at every call
 * site; what carries the information is the ENDPOINT the caller passes as `children`.
 */
export const Provenance: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <span className={styles.src}>
    <span className={cx(styles.srcDot, styles.dot_live)} aria-hidden="true" />
    {children}
  </span>
);

/**
 * Panel chrome for the non-chart secondary panels (mock `.panel`): a header row with an
 * icon + title + a right-aligned provenance source, then the body. Chart-bearing panels use
 * the charts module's own ChartFrame instead (its caption carries the provenance).
 */
export const Panel: React.FC<{
  icon?: React.ReactNode;
  title: React.ReactNode;
  /**
   * The one-line statement of WHAT IS COUNTED and OVER WHAT WINDOW.
   * Two panels here sat under a 7d/30d/90d control while answering a different question
   * than the title implied — an all-time list, and a status mix of every task ever filed.
   * Both are windowed now, and a window the viewer cannot see is a window they will
   * mis-read, so the panel says it.
   */
  subtitle?: React.ReactNode;
  provenance?: React.ReactNode;
  children: React.ReactNode;
}> = ({ icon, title, subtitle, provenance, children }) => (
  <section className={styles.panel}>
    <div className={styles.panelHead}>
      {icon && <span className={styles.panelIco} aria-hidden="true">{icon}</span>}
      <span className={styles.panelTitle}>{title}</span>
      {provenance && <span className={styles.panelSrc}>{provenance}</span>}
    </div>
    {subtitle && <div className={styles.panelSub}>{subtitle}</div>}
    {children}
  </section>
);

/** The mock's segmented control (`.fseg` / `.metricseg`) — token-driven pill buttons. */
export function Segmented<T extends string | number>({
  options,
  value,
  onChange,
  ariaLabel,
  size = 'md',
}: {
  options: ReadonlyArray<{ value: T; label: string }>;
  value: T;
  onChange: (v: T) => void;
  ariaLabel: string;
  size?: 'sm' | 'md';
}): React.ReactElement {
  return (
    <div
      className={cx(styles.seg, size === 'sm' && styles.segSm)}
      role="tablist"
      aria-label={ariaLabel}
    >
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={String(o.value)}
            type="button"
            role="tab"
            aria-selected={on}
            className={cx(styles.segItem, on && styles.segOn)}
            onClick={() => onChange(o.value)}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
