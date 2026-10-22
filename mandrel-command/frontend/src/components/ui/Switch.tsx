import React from 'react';
import { cx } from './cx';
import styles from './Switch.module.css';

/**
 * Switch (P0.3b) — an on/off toggle from the settings mock `.switch`. A real
 * <input type="checkbox" role="switch"> (visually hidden, focusable) drives a
 * sliding track/thumb; the thumb-on ink is --on-accent, the track-on is the teal
 * gradient (matches the primary button). Optional label via children.
 */
export interface SwitchProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'className' | 'type'> {
  className?: string;
}

export const Switch = React.forwardRef<HTMLInputElement, SwitchProps>(
  ({ disabled, children, className, ...rest }, ref) => (
    <label className={cx(styles.wrap, disabled && styles.disabled, className)}>
      <input
        ref={ref}
        type="checkbox"
        role="switch"
        disabled={disabled}
        className={styles.input}
        {...rest}
      />
      <span className={styles.track} aria-hidden="true">
        <span className={styles.thumb} />
      </span>
      {children != null && <span className={styles.label}>{children}</span>}
    </label>
  ),
);

Switch.displayName = 'Switch';

export default Switch;
