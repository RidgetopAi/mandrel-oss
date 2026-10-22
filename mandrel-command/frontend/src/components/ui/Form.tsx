import React from 'react';
import { cx } from './cx';
import styles from './Form.module.css';

/**
 * Form layout (P0.3b) — a semantic <form> that vertically stacks Fields with a
 * consistent token rhythm, plus a FormActions row (right-aligned by default) for
 * the submit/cancel buttons. Pure layout: validation/state stays with the caller.
 */
export interface FormProps extends React.FormHTMLAttributes<HTMLFormElement> {
  /** Vertical gap between fields (spacing step). Default 5 (20px). */
  gap?: 3 | 4 | 5 | 6;
  className?: string;
}

export const Form: React.FC<FormProps> = ({ gap = 5, className, style, children, ...rest }) => (
  <form
    className={cx(styles.form, className)}
    style={{ gap: `var(--sp-${gap})`, ...style }}
    {...rest}
  >
    {children}
  </form>
);

export interface FormActionsProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Horizontal alignment of the action buttons. */
  align?: 'start' | 'end' | 'between';
  className?: string;
}

const alignClass: Record<NonNullable<FormActionsProps['align']>, string> = {
  start: styles.alignStart,
  end: styles.alignEnd,
  between: styles.alignBetween,
};

export const FormActions: React.FC<FormActionsProps> = ({
  align = 'end',
  className,
  children,
  ...rest
}) => (
  <div className={cx(styles.actions, alignClass[align], className)} {...rest}>
    {children}
  </div>
);

export default Form;
