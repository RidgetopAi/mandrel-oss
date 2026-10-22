import React from 'react';
import { Spinner, Empty } from '../ui';
import styles from './ChartFrame.module.css';

/**
 * Shared chart panel chrome + state machine (P0.6). Every chart wrapper renders
 * inside a ChartFrame so the surface, title/caption/value treatment and the
 * loading / empty / data states are consistent and defined ONCE (reuses the P0.3
 * Spinner + Empty primitives). The chart itself is the `children` — usually a
 * recharts <ResponsiveContainer>.
 *
 * Caption + top-right mono `value` reproduce the dataviz header treatment from
 * command-design-language.html (`.chart .cap` / `.chart .val`).
 */
export type ChartValueTone = 'default' | 'up' | 'down' | 'teal';

export interface ChartFrameProps {
  /** Primary heading (optional — sparklines use only `caption`). */
  title?: React.ReactNode;
  /** Small uppercase caption above/left (e.g. "Contexts / day · 30d"). */
  caption?: React.ReactNode;
  /** Emphasized top-right value (e.g. "+18%") in mono. */
  value?: React.ReactNode;
  valueTone?: ChartValueTone;
  /** Fixed stage height in px (the ResponsiveContainer fills width×this). */
  height: number;
  /** Loading → Spinner overlay. */
  loading?: boolean;
  /** No data → Empty overlay. */
  empty?: boolean;
  emptyTitle?: React.ReactNode;
  emptyDescription?: React.ReactNode;
  emptyIcon?: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
  children: React.ReactNode;
}

export const ChartFrame: React.FC<ChartFrameProps> = ({
  title,
  caption,
  value,
  valueTone = 'default',
  height,
  loading = false,
  empty = false,
  emptyTitle = 'No data yet',
  emptyDescription,
  emptyIcon,
  className,
  style,
  children,
}) => {
  const hasHead = Boolean(title || caption || value);
  const valueClass =
    valueTone === 'up'
      ? styles.up
      : valueTone === 'down'
        ? styles.down
        : valueTone === 'teal'
          ? styles.teal
          : undefined;

  return (
    <div className={[styles.frame, className].filter(Boolean).join(' ')} style={style}>
      {hasHead && (
        <div className={styles.head}>
          <div style={{ minWidth: 0 }}>
            {title && <div className={styles.title}>{title}</div>}
            {caption && <div className={styles.caption}>{caption}</div>}
          </div>
          {value != null && (
            <div className={[styles.value, valueClass].filter(Boolean).join(' ')}>{value}</div>
          )}
        </div>
      )}
      <div className={styles.body} style={{ height }}>
        {/* Chart is always mounted underneath; overlays cover it while
            loading/empty so layout never jumps. */}
        {!loading && !empty && children}
        {loading && (
          <div className={styles.state}>
            <Spinner size="md" />
          </div>
        )}
        {!loading && empty && (
          <div className={styles.state}>
            <Empty icon={emptyIcon} title={emptyTitle} description={emptyDescription} />
          </div>
        )}
      </div>
    </div>
  );
};

export default ChartFrame;
