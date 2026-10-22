import React from 'react';
import { cx } from './cx';
import styles from './Radio.module.css';

/**
 * Radio + RadioGroup (P0.3b). RadioGroup owns the selected `value` (controlled or
 * uncontrolled) and a shared `name`, exposing them via context; each Radio is a
 * native <input type="radio">. Native radios already give arrow-key roving within
 * a `name`; the group is `role="radiogroup"` with an accessible name.
 */
interface RadioGroupContextValue {
  name: string;
  value: string | undefined;
  onSelect: (value: string) => void;
  disabled?: boolean;
}

const RadioGroupContext = React.createContext<RadioGroupContextValue | null>(null);

export interface RadioGroupProps {
  name?: string;
  value?: string;
  defaultValue?: string;
  onChange?: (value: string) => void;
  disabled?: boolean;
  'aria-label'?: string;
  'aria-labelledby'?: string;
  /** Layout the radios in a row instead of a column. */
  row?: boolean;
  className?: string;
  children: React.ReactNode;
}

export const RadioGroup: React.FC<RadioGroupProps> = ({
  name,
  value,
  defaultValue,
  onChange,
  disabled,
  row = false,
  className,
  children,
  ...aria
}) => {
  const auto = React.useId();
  const groupName = name ?? `${auto}-radio`;
  const isControlled = value !== undefined;
  const [internal, setInternal] = React.useState<string | undefined>(defaultValue);
  const current = isControlled ? value : internal;

  const onSelect = (v: string) => {
    if (!isControlled) setInternal(v);
    onChange?.(v);
  };

  return (
    <div
      role="radiogroup"
      aria-label={aria['aria-label']}
      aria-labelledby={aria['aria-labelledby']}
      className={cx(styles.group, row && styles.row, className)}
    >
      <RadioGroupContext.Provider value={{ name: groupName, value: current, onSelect, disabled }}>
        {children}
      </RadioGroupContext.Provider>
    </div>
  );
};

export interface RadioProps
  extends Omit<
    React.InputHTMLAttributes<HTMLInputElement>,
    'className' | 'type' | 'value' | 'onChange' | 'checked'
  > {
  value: string;
  className?: string;
}

export const Radio = React.forwardRef<HTMLInputElement, RadioProps>(
  ({ value, disabled, children, className, ...rest }, ref) => {
    const group = React.useContext(RadioGroupContext);
    const isDisabled = disabled || group?.disabled;
    return (
      <label className={cx(styles.wrap, isDisabled && styles.disabled, className)}>
        <input
          ref={ref}
          type="radio"
          name={group?.name}
          value={value}
          checked={group ? group.value === value : undefined}
          disabled={isDisabled}
          onChange={() => group?.onSelect(value)}
          className={styles.input}
          {...rest}
        />
        <span className={styles.dot} aria-hidden="true" />
        {children != null && <span className={styles.label}>{children}</span>}
      </label>
    );
  },
);

Radio.displayName = 'Radio';

export default Radio;
