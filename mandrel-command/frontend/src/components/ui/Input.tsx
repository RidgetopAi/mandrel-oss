import React from 'react';
import { cx } from './cx';
import { useFieldContext } from './Field';
import styles from './Input.module.css';

/**
 * Text Input (P0.3b). Skins a native <input>; picks up id / aria-describedby /
 * aria-invalid / required from an enclosing Field automatically (explicit props
 * still win). forwardRef exposes the <input>. Set `mono` for id/token values.
 */
export interface InputProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'className'> {
  /** Render in the mono face (ids, tokens). */
  mono?: boolean;
  /** Mark the control invalid even without a Field error. */
  invalid?: boolean;
  className?: string;
}

export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  (
    {
      mono = false,
      invalid,
      id,
      type = 'text',
      required,
      'aria-describedby': describedBy,
      className,
      ...rest
    },
    ref,
  ) => {
    const field = useFieldContext();
    const isInvalid = invalid ?? field?.invalid ?? false;
    return (
      <input
        ref={ref}
        id={id ?? field?.id}
        type={type}
        aria-invalid={isInvalid || undefined}
        aria-describedby={describedBy ?? field?.describedBy}
        required={required ?? field?.required}
        className={cx(styles.control, mono && styles.mono, className)}
        {...rest}
      />
    );
  },
);

Input.displayName = 'Input';

export default Input;
