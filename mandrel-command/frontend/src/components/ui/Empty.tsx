import React from 'react';
import { cx } from './cx';
import styles from './Empty.module.css';

/**
 * Empty-state primitive (P0.3). Centered icon slot + message + optional
 * description and action (e.g. a Button). Calm, muted — no heavy container.
 */
export interface EmptyProps
  extends Omit<React.HTMLAttributes<HTMLDivElement>, 'className' | 'title'> {
  /** Icon / illustration slot. */
  icon?: React.ReactNode;
  title?: React.ReactNode;
  description?: React.ReactNode;
  /** Action slot (typically a Button). */
  action?: React.ReactNode;
  className?: string;
}

export const Empty: React.FC<EmptyProps> = ({
  icon,
  title,
  description,
  action,
  className,
  children,
  ...rest
}) => (
  <div className={cx(styles.empty, className)} {...rest}>
    {icon && (
      <div className={styles.icon} aria-hidden="true">
        {icon}
      </div>
    )}
    {title && <div className={styles.title}>{title}</div>}
    {description && <div className={styles.description}>{description}</div>}
    {children}
    {action && <div className={styles.action}>{action}</div>}
  </div>
);

export default Empty;
