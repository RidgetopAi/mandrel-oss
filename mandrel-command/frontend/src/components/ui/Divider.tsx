import React from 'react';
import { cx } from './cx';
import styles from './Divider.module.css';

/**
 * Divider primitive (P0.3). A hairline rule (var(--line-soft)), horizontal or
 * vertical, with an optional centered label (the doc's `.ref-h` section rule).
 */
export interface DividerProps
  extends Omit<React.HTMLAttributes<HTMLDivElement>, 'className'> {
  orientation?: 'horizontal' | 'vertical';
  /** Optional centered label — renders as an uppercase section rule. */
  label?: React.ReactNode;
  className?: string;
}

export const Divider: React.FC<DividerProps> = ({
  orientation = 'horizontal',
  label,
  className,
  ...rest
}) => {
  if (orientation === 'vertical') {
    return (
      <div
        role="separator"
        aria-orientation="vertical"
        className={cx(styles.vertical, className)}
        {...rest}
      />
    );
  }
  if (label) {
    return (
      <div className={cx(styles.labelled, className)} {...rest}>
        <span className={styles.label}>{label}</span>
      </div>
    );
  }
  return (
    <div
      role="separator"
      aria-orientation="horizontal"
      className={cx(styles.horizontal, className)}
      {...rest}
    />
  );
};

export default Divider;
