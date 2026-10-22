import React from 'react';
import { cx } from './cx';
import { useFieldContext } from './Field';
import styles from './Input.module.css';

/**
 * NumberInput (P0.3b). A native numeric <input> with +/- stepper buttons that
 * respect min/max/step and disable at the bounds. Controlled (`value`) or
 * uncontrolled (`defaultValue`); `onValueChange` reports the parsed number (or
 * null when empty). The steppers are out of the tab order (the input's own
 * ArrowUp/Down handles keyboard stepping); wires to an enclosing Field.
 */
export interface NumberInputProps
  extends Omit<
    React.InputHTMLAttributes<HTMLInputElement>,
    'className' | 'value' | 'defaultValue' | 'onChange' | 'type'
  > {
  value?: number | '';
  defaultValue?: number | '';
  min?: number;
  max?: number;
  step?: number;
  onValueChange?: (value: number | null) => void;
  invalid?: boolean;
  className?: string;
}

const IconChevron = ({ up }: { up: boolean }) => (
  <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={up ? 'M6 15l6-6 6 6' : 'M6 9l6 6 6-6'} />
  </svg>
);

export const NumberInput = React.forwardRef<HTMLInputElement, NumberInputProps>(
  (
    {
      value,
      defaultValue,
      min,
      max,
      step = 1,
      onValueChange,
      invalid,
      id,
      required,
      'aria-describedby': describedBy,
      className,
      ...rest
    },
    ref,
  ) => {
    const field = useFieldContext();
    const isInvalid = invalid ?? field?.invalid ?? false;
    const isControlled = value !== undefined;
    const [internal, setInternal] = React.useState<number | ''>(defaultValue ?? '');
    const current = isControlled ? (value as number | '') : internal;

    const commit = (next: number | '') => {
      if (!isControlled) setInternal(next);
      onValueChange?.(next === '' ? null : next);
    };

    const clamp = (n: number) => {
      let v = n;
      if (min !== undefined) v = Math.max(min, v);
      if (max !== undefined) v = Math.min(max, v);
      return v;
    };

    const nudge = (dir: 1 | -1) => {
      const base = current === '' ? 0 : current;
      commit(clamp(base + dir * step));
    };

    const atMax = max !== undefined && current !== '' && current >= max;
    const atMin = min !== undefined && current !== '' && current <= min;

    return (
      <div className={cx(styles.number, className)} data-invalid={isInvalid || undefined}>
        <input
          ref={ref}
          id={id ?? field?.id}
          type="number"
          inputMode="decimal"
          value={current}
          min={min}
          max={max}
          step={step}
          aria-invalid={isInvalid || undefined}
          aria-describedby={describedBy ?? field?.describedBy}
          required={required ?? field?.required}
          onChange={(e) => {
            const raw = e.target.value;
            commit(raw === '' ? '' : Number(raw));
          }}
          className={cx(styles.control, styles.numberField)}
          {...rest}
        />
        <div className={styles.stepper}>
          <button
            type="button"
            tabIndex={-1}
            aria-label="Increment"
            className={styles.step}
            disabled={atMax || rest.disabled}
            onClick={() => nudge(1)}
          >
            <IconChevron up />
          </button>
          <button
            type="button"
            tabIndex={-1}
            aria-label="Decrement"
            className={styles.step}
            disabled={atMin || rest.disabled}
            onClick={() => nudge(-1)}
          >
            <IconChevron up={false} />
          </button>
        </div>
      </div>
    );
  },
);

NumberInput.displayName = 'NumberInput';

export default NumberInput;
