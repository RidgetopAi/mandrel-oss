/**
 * Segmented — a radiogroup rendered as the mock's segmented chips (the ViewToggle pattern
 * from Tasks, generalised). Used for Proof (Browser · Test · Look), Kind (Bug · Change)
 * and the phone stage picker. Native buttons, `role="radio"` + `aria-checked`, arrow keys
 * move the selection — token-driven, zero antd.
 */
import React from 'react';
import { cx } from '../../components/ui';
import styles from './Punch.module.css';

export interface SegmentedOption<V extends string> {
  value: V;
  label: React.ReactNode;
  /** Optional trailing count/meta pill. */
  meta?: React.ReactNode;
  /** CSS custom-property NAME for a leading dot (resolved with var() here). */
  dotVar?: string;
}

export interface SegmentedProps<V extends string> {
  options: ReadonlyArray<SegmentedOption<V>>;
  /** `undefined` renders with NO option checked — a control with no default (the punch
   * clause owner toggle: the user must choose, so nothing is pre-selected). */
  value: V | undefined;
  onChange: (v: V) => void;
  'aria-label': string;
  /** Fill the row (phone forms) instead of hugging content. */
  fullWidth?: boolean;
  /** Scroll horizontally instead of wrapping (the phone stage picker). */
  scroll?: boolean;
  invalid?: boolean;
  className?: string;
}

export function Segmented<V extends string>({
  options,
  value,
  onChange,
  'aria-label': ariaLabel,
  fullWidth = false,
  scroll = false,
  invalid = false,
  className,
}: SegmentedProps<V>) {
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    e.preventDefault();
    const i = options.findIndex((o) => o.value === value);
    const step = e.key === 'ArrowRight' ? 1 : -1;
    const next = options[(i + step + options.length) % options.length];
    if (next) onChange(next.value);
  };
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      aria-invalid={invalid || undefined}
      className={cx(
        styles.seg,
        fullWidth && styles.segFull,
        scroll && styles.segScroll,
        invalid && styles.segInvalid,
        className,
      )}
      onKeyDown={onKeyDown}
    >
      {options.map((opt) => {
        const on = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={on ? 0 : -1}
            className={cx(styles.segItem, on && styles.segOn)}
            onClick={() => onChange(opt.value)}
          >
            {opt.dotVar && (
              <span
                className={styles.segDot}
                style={{ background: `var(${opt.dotVar})` }}
                aria-hidden="true"
              />
            )}
            {opt.label}
            {opt.meta != null && <span className={styles.segMeta}>{opt.meta}</span>}
          </button>
        );
      })}
    </div>
  );
}

export default Segmented;
