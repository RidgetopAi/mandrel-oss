import React from 'react';
import { cx } from './cx';
import styles from './Field.module.css';

/**
 * Field wrapper (P0.3b) — the a11y harness every form control sits in: a proper
 * <label> bound by id, an optional hint, and an error message wired via
 * aria-describedby + aria-invalid. It publishes a FieldContext so the inner
 * control (Input/Textarea/NumberInput/Select) picks up its `id`, `describedBy`,
 * `invalid` and `required` automatically — no hand-wiring per control.
 */
export interface FieldContextValue {
  id: string;
  describedBy?: string;
  invalid: boolean;
  required: boolean;
}

const FieldContext = React.createContext<FieldContextValue | null>(null);

/** Read the enclosing Field's wiring (null when a control is used standalone). */
export function useFieldContext(): FieldContextValue | null {
  return React.useContext(FieldContext);
}

export interface FieldProps {
  label?: React.ReactNode;
  /** Helper text under the control (associated via aria-describedby). */
  hint?: React.ReactNode;
  /** Error message; sets aria-invalid + role="alert" and hides the hint. */
  error?: React.ReactNode;
  required?: boolean;
  /** Explicit control id; auto-generated when omitted. */
  htmlFor?: string;
  /** Render the label visually hidden (still announced). */
  hideLabel?: boolean;
  className?: string;
  children: React.ReactNode;
}

export const Field: React.FC<FieldProps> = ({
  label,
  hint,
  error,
  required = false,
  htmlFor,
  hideLabel = false,
  className,
  children,
}) => {
  const auto = React.useId();
  const id = htmlFor ?? `${auto}-control`;
  const hintId = hint ? `${auto}-hint` : undefined;
  const errorId = error ? `${auto}-error` : undefined;
  const describedBy = [errorId, hintId].filter(Boolean).join(' ') || undefined;
  const ctx: FieldContextValue = { id, describedBy, invalid: !!error, required };

  return (
    <div className={cx(styles.field, className)}>
      {label != null && (
        <label htmlFor={id} className={cx(styles.label, hideLabel && styles.srOnly)}>
          {label}
          {required && (
            <span className={styles.required} aria-hidden="true">
              *
            </span>
          )}
        </label>
      )}
      <FieldContext.Provider value={ctx}>{children}</FieldContext.Provider>
      {error ? (
        <div id={errorId} role="alert" className={styles.error}>
          {error}
        </div>
      ) : (
        hint != null && (
          <div id={hintId} className={styles.hint}>
            {hint}
          </div>
        )
      )}
    </div>
  );
};

export default Field;
