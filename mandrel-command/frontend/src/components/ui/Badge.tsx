import React from 'react';
import { cx } from './cx';
import styles from './Badge.module.css';

/**
 * Badge / Tag primitive (P0.3). Two treatments from the design doc:
 *   • the tinted "kind" tag (`.kind` — mono, uppercase, accent text on an accent
 *     tint): handoff=teal, milestone=violet, completion=green, decision=blue.
 *   • generic accent/semantic chips.
 * The tint background is derived from the accent token via color-mix (the doc's
 * inline `#..1a` tints have no token), so every colour stays token-driven.
 */
export type BadgeVariant =
  | 'neutral'
  | 'teal'
  | 'violet'
  | 'blue'
  | 'green'
  | 'amber'
  | 'rose'
  | 'ok'
  | 'warn'
  | 'crit';

const variantClass: Record<BadgeVariant, string> = {
  neutral: styles.neutral,
  teal: styles.teal,
  violet: styles.violet,
  blue: styles.blue,
  green: styles.green,
  amber: styles.amber,
  rose: styles.rose,
  ok: styles.ok,
  warn: styles.warn,
  crit: styles.crit,
};

export interface BadgeProps
  extends Omit<React.HTMLAttributes<HTMLSpanElement>, 'className'> {
  variant?: BadgeVariant;
  /** Fully-rounded pill shape (default is the doc's small `--r-xs` tag). */
  pill?: boolean;
  /** Leading status dot (currentColor). */
  dot?: boolean;
  /** Monospace, uppercase — the `.kind` record-type treatment. */
  mono?: boolean;
  className?: string;
}

export const Badge: React.FC<BadgeProps> = ({
  variant = 'neutral',
  pill = false,
  dot = false,
  mono = false,
  className,
  children,
  ...rest
}) => (
  <span
    className={cx(
      styles.badge,
      variantClass[variant],
      pill ? styles.pill : styles.tag,
      mono && styles.mono,
      className,
    )}
    {...rest}
  >
    {dot && <span className={styles.dot} aria-hidden="true" />}
    {children}
  </span>
);

export default Badge;
