import React from 'react';
import { cx } from './cx';
import styles from './StatusPill.module.css';

/**
 * StatusPill (P0.3) — the doc's `.pl` status treatment: a fully-rounded pill
 * with an optional leading dot, mapping a lifecycle status onto a semantic hue.
 *   active → ok/green · dormant → warn/amber · ended → faint · alert → crit/rose
 * Extra hues (teal/violet/blue) are available for domain statuses.
 */
export type StatusTone =
  | 'active'
  | 'dormant'
  | 'ended'
  | 'alert'
  | 'teal'
  | 'violet'
  | 'blue';

const toneClass: Record<StatusTone, string> = {
  active: styles.active,
  dormant: styles.dormant,
  ended: styles.ended,
  alert: styles.alert,
  teal: styles.teal,
  violet: styles.violet,
  blue: styles.blue,
};

export interface StatusPillProps
  extends Omit<React.HTMLAttributes<HTMLSpanElement>, 'className'> {
  tone?: StatusTone;
  /** Leading status dot (default on, matching the doc). `ended` has no dot. */
  dot?: boolean;
  className?: string;
}

export const StatusPill: React.FC<StatusPillProps> = ({
  tone = 'active',
  dot = true,
  className,
  children,
  ...rest
}) => (
  <span className={cx(styles.pill, toneClass[tone], className)} {...rest}>
    {dot && tone !== 'ended' && <span className={styles.dot} aria-hidden="true" />}
    {children}
  </span>
);

export default StatusPill;
