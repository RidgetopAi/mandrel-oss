/**
 * MomentumCell — the per-day momentum treatment rendered on every Calendar cell (Day /
 * Week / Month) BEFORE click-in: a centered mini-ring
 * (SVG arc sized by score, coloured by band), the momentum number, and the compact
 * sessions·contexts counts. Purely presentational + pure — driven by one momentum-series
 * point. Band colours come from the single NAMED config (`momentumCells.ts`) so a palette
 * tweak is a one-file edit; they're applied inline so the stylesheet stays token-driven.
 *
 * A day with `hasData=false` renders NOTHING here (the caller guards) → a blank cell.
 */
import React from 'react';
import type { MomentumSeriesPoint } from '../../api/domains/momentumSeries';
import {
  MOMENTUM_RING,
  momentumBand,
  momentumCountsLabel,
  type MomentumBand,
} from './momentumCells';
import styles from './Calendar.module.css';

/** The mini-ring: a full track + a foreground arc whose sweep encodes the 0-100 score. */
export const MomentumRing: React.FC<{ score: number; band: MomentumBand }> = ({ score, band }) => {
  const { size, viewBox, radius, stroke, trackColor } = MOMENTUM_RING;
  const clamped = Math.max(0, Math.min(100, score));
  const c = viewBox / 2;
  const circ = 2 * Math.PI * radius;
  const offset = circ * (1 - clamped / 100);
  return (
    <svg
      className={styles.moRingSvg}
      width={size}
      height={size}
      viewBox={`0 0 ${viewBox} ${viewBox}`}
      role="img"
      aria-label={`Momentum ${clamped} of 100`}
      data-band={band.key}
    >
      <circle cx={c} cy={c} r={radius} fill="none" stroke={trackColor} strokeWidth={stroke} />
      <circle
        cx={c}
        cy={c}
        r={radius}
        fill="none"
        stroke={band.color}
        strokeWidth={stroke}
        strokeLinecap="round"
        strokeDasharray={circ}
        strokeDashoffset={offset}
        transform={`rotate(-90 ${c} ${c})`}
      />
    </svg>
  );
};

export interface MomentumCellProps {
  point: MomentumSeriesPoint;
  /**
   * `month` → the mock's absolute overlay (ring centered, number bottom-left, counts
   * top-right, band edge on the right) inside a `position:relative` cell.
   * `stack` → a compact inline row for the taller Week/Day columns.
   */
  variant: 'month' | 'stack';
}

/** The full per-cell momentum badge. Assumes the caller already checked `point.hasData`. */
export const MomentumCell: React.FC<MomentumCellProps> = ({ point, variant }) => {
  const score = point.momentum.score;
  const band = momentumBand(score);
  const counts = momentumCountsLabel(point);

  if (variant === 'month') {
    return (
      <>
        <span className={styles.moCounts} data-testid="mo-counts" aria-hidden="true">
          {counts}
        </span>
        <span className={styles.moEdge} style={{ background: band.color }} aria-hidden="true" />
        <span className={styles.moRing}>
          <MomentumRing score={score} band={band} />
        </span>
        <span className={styles.moMo}>
          <span className={styles.moVal} style={{ color: band.valColor }} data-testid="mo-val">
            {score}
          </span>
          <span className={styles.moCap}>MO</span>
        </span>
      </>
    );
  }

  return (
    <div className={styles.stackMomentum} data-band={band.key}>
      <MomentumRing score={score} band={band} />
      <span className={styles.moVal} style={{ color: band.valColor }} data-testid="mo-val">
        {score}
      </span>
      <span className={styles.moCap}>MO</span>
      <span className={styles.moCounts} data-testid="mo-counts">
        {counts}
      </span>
    </div>
  );
};

export default MomentumCell;
