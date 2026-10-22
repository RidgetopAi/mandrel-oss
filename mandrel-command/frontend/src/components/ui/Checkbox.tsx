import React from 'react';
import { cx } from './cx';
import styles from './Checkbox.module.css';

/**
 * Checkbox (P0.3b). A real <input type="checkbox"> (visually hidden but
 * focusable + in the a11y tree) with the mock's `.chk` box treatment: teal
 * gradient + on-accent check when on. Supports indeterminate. forwardRef exposes
 * the input. Label text is optional (pass children).
 */
export interface CheckboxProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'className' | 'type'> {
  indeterminate?: boolean;
  className?: string;
}

export const Checkbox = React.forwardRef<HTMLInputElement, CheckboxProps>(
  ({ indeterminate = false, disabled, children, className, ...rest }, ref) => {
    const innerRef = React.useRef<HTMLInputElement | null>(null);
    React.useImperativeHandle(ref, () => innerRef.current as HTMLInputElement);
    React.useEffect(() => {
      if (innerRef.current) innerRef.current.indeterminate = indeterminate;
    }, [indeterminate]);

    return (
      <label className={cx(styles.wrap, disabled && styles.disabled, className)}>
        <input
          ref={innerRef}
          type="checkbox"
          disabled={disabled}
          className={styles.input}
          aria-checked={indeterminate ? 'mixed' : undefined}
          {...rest}
        />
        <span className={styles.box} aria-hidden="true">
          {indeterminate ? (
            <svg viewBox="0 0 24 24" width="11" height="11" className={styles.mark}>
              <path d="M6 12h12" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" />
            </svg>
          ) : (
            <svg viewBox="0 0 24 24" width="11" height="11" className={styles.mark}>
              <path d="M5 12l4.5 4.5L19 7" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          )}
        </span>
        {children != null && <span className={styles.label}>{children}</span>}
      </label>
    );
  },
);

Checkbox.displayName = 'Checkbox';

export default Checkbox;
