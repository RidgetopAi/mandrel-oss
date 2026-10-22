import React from 'react';
import { cx } from './cx';
import styles from './Spinner.module.css';

/**
 * Spinner primitive (P0.3). A token-coloured ring; size is `em`-based so it
 * scales with surrounding font-size, plus explicit sm/md/lg presets. Accessible
 * (role=status + label). Colour defaults to the teal brand.
 */
export type SpinnerSize = 'sm' | 'md' | 'lg';

const sizeClass: Record<SpinnerSize, string> = {
  sm: styles.sm,
  md: styles.md,
  lg: styles.lg,
};

export interface SpinnerProps
  extends Omit<React.HTMLAttributes<HTMLSpanElement>, 'className'> {
  size?: SpinnerSize;
  /** Tone token name (e.g. 'teal', 'tx-2'); defaults to teal. */
  tone?: 'teal' | 'muted' | 'current';
  /** Accessible label (visually hidden). */
  label?: string;
  className?: string;
}

export const Spinner: React.FC<SpinnerProps> = ({
  size = 'md',
  tone = 'teal',
  label = 'Loading',
  className,
  ...rest
}) => (
  <span
    role="status"
    aria-live="polite"
    className={cx(
      styles.spinner,
      sizeClass[size],
      tone === 'teal' && styles.toneTeal,
      tone === 'muted' && styles.toneMuted,
      className,
    )}
    {...rest}
  >
    <span className={styles.srOnly}>{label}</span>
  </span>
);

export default Spinner;
