import React from 'react';
import { cx } from './cx';
import { useFieldContext } from './Field';
import styles from './Input.module.css';

/**
 * Textarea (P0.3b). Same skin as Input, taller with vertical-only resize. Wires
 * to an enclosing Field (id / aria-describedby / aria-invalid / required).
 */
export interface TextareaProps
  extends Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>, 'className'> {
  invalid?: boolean;
  className?: string;
}

export const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  (
    { invalid, id, rows = 4, required, 'aria-describedby': describedBy, className, ...rest },
    ref,
  ) => {
    const field = useFieldContext();
    const isInvalid = invalid ?? field?.invalid ?? false;
    return (
      <textarea
        ref={ref}
        id={id ?? field?.id}
        rows={rows}
        aria-invalid={isInvalid || undefined}
        aria-describedby={describedBy ?? field?.describedBy}
        required={required ?? field?.required}
        className={cx(styles.control, styles.textarea, className)}
        {...rest}
      />
    );
  },
);

Textarea.displayName = 'Textarea';

export default Textarea;
