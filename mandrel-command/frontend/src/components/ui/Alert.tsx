import React from 'react';
import { cx } from './cx';
import styles from './Alert.module.css';

/**
 * Alert / Callout primitive (P0.3). Semantic status surfaces built on the
 * accent tokens: info=blue, success=green/ok, warning=amber/warn, error=rose/crit.
 * Left accent bar + tinted ground (color-mix from the accent) + optional icon,
 * title and dismiss. `role="alert"` for error/warning so SRs announce them.
 */
export type AlertVariant = 'info' | 'success' | 'warning' | 'error';

const variantClass: Record<AlertVariant, string> = {
  info: styles.info,
  success: styles.success,
  warning: styles.warning,
  error: styles.error,
};

export interface AlertProps
  extends Omit<React.HTMLAttributes<HTMLDivElement>, 'className' | 'title'> {
  variant?: AlertVariant;
  title?: React.ReactNode;
  /** Leading icon slot. */
  icon?: React.ReactNode;
  /** Show a dismiss control; fires onClose. */
  onClose?: () => void;
  className?: string;
}

export const Alert: React.FC<AlertProps> = ({
  variant = 'info',
  title,
  icon,
  onClose,
  className,
  children,
  ...rest
}) => {
  const assertive = variant === 'error' || variant === 'warning';
  return (
    <div
      role={assertive ? 'alert' : 'status'}
      className={cx(styles.alert, variantClass[variant], className)}
      {...rest}
    >
      {icon && (
        <span className={styles.icon} aria-hidden="true">
          {icon}
        </span>
      )}
      <div className={styles.content}>
        {title && <div className={styles.title}>{title}</div>}
        {children != null && <div className={styles.message}>{children}</div>}
      </div>
      {onClose && (
        <button
          type="button"
          className={styles.close}
          aria-label="Dismiss"
          onClick={onClose}
        >
          <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
            <path
              d="M6 6l12 12M18 6L6 18"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
            />
          </svg>
        </button>
      )}
    </div>
  );
};

export default Alert;
