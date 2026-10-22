import React from 'react';
import { cx } from './cx';
import styles from './StatTile.module.css';

/**
 * StatTile / Statistic primitive (P0.3) — the dashboard KPI tile: a big
 * `--fs-display` value over an uppercase label, with an optional trend/delta
 * chip (up=ok, down=crit, flat=muted) and an optional icon + caption.
 */
export type TrendDirection = 'up' | 'down' | 'flat';

const trendClass: Record<TrendDirection, string> = {
  up: styles.trendUp,
  down: styles.trendDown,
  flat: styles.trendFlat,
};

const trendGlyph: Record<TrendDirection, string> = {
  up: '↑',
  down: '↓',
  flat: '→',
};

export interface StatTileProps
  extends Omit<React.HTMLAttributes<HTMLDivElement>, 'className'> {
  label: React.ReactNode;
  value: React.ReactNode;
  /** Optional delta text (e.g. "+18%"); paired with `trend` for colour + glyph. */
  delta?: React.ReactNode;
  trend?: TrendDirection;
  /** Leading icon slot. */
  icon?: React.ReactNode;
  /** Sub-caption under the value (e.g. "vs last 30d"). */
  caption?: React.ReactNode;
  className?: string;
}

export const StatTile: React.FC<StatTileProps> = ({
  label,
  value,
  delta,
  trend = 'flat',
  icon,
  caption,
  className,
  ...rest
}) => (
  <div className={cx(styles.tile, className)} {...rest}>
    <div className={styles.head}>
      {icon && (
        <span className={styles.icon} aria-hidden="true">
          {icon}
        </span>
      )}
      <span className={styles.label}>{label}</span>
    </div>
    <div className={styles.valueRow}>
      <span className={styles.value}>{value}</span>
      {delta != null && (
        <span className={cx(styles.trend, trendClass[trend])}>
          <span aria-hidden="true">{trendGlyph[trend]}</span>
          {delta}
        </span>
      )}
    </div>
    {caption && <div className={styles.caption}>{caption}</div>}
  </div>
);

export default StatTile;
