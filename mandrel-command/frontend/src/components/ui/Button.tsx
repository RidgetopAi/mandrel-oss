import React from 'react';
import { cx } from './cx';
import styles from './Button.module.css';

/**
 * Button primitive (P0.3). Variants + treatments transcribed from the design
 * language doc's Components/Buttons block:
 *   • primary — teal gradient, dark ink, glow (`.btn.primary`)
 *   • ghost   — surface-2 fill, stronger border (`.btn.ghost`)
 *   • subtle  — transparent, muted text (`.btn.subtle`)  [aka secondary]
 *   • danger  — rose, for destructive actions (semantic extension)
 * All colour/size/radius via `var(--token)`. forwardRef exposes the <button>.
 */
export type ButtonVariant = 'primary' | 'ghost' | 'subtle' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

const variantClass: Record<ButtonVariant, string> = {
  primary: styles.primary,
  ghost: styles.ghost,
  subtle: styles.subtle,
  danger: styles.danger,
};

const sizeClass: Record<ButtonSize, string> = {
  sm: styles.sm,
  md: styles.md,
  lg: styles.lg,
};

export interface ButtonProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'className'> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Show a spinner + disable interaction; preserves width (no layout jump). */
  loading?: boolean;
  /** Icon rendered before the label. */
  iconLeft?: React.ReactNode;
  /** Icon rendered after the label. */
  iconRight?: React.ReactNode;
  /** Stretch to fill the container width. */
  fullWidth?: boolean;
  className?: string;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      variant = 'primary',
      size = 'md',
      loading = false,
      iconLeft,
      iconRight,
      fullWidth = false,
      disabled,
      type = 'button',
      children,
      className,
      ...rest
    },
    ref,
  ) => {
    const isDisabled = disabled || loading;
    return (
      <button
        ref={ref}
        type={type}
        disabled={isDisabled}
        aria-busy={loading || undefined}
        className={cx(
          styles.btn,
          variantClass[variant],
          sizeClass[size],
          fullWidth && styles.fullWidth,
          loading && styles.loading,
          className,
        )}
        {...rest}
      >
        {loading && <span className={styles.spinner} aria-hidden="true" />}
        <span className={styles.inner}>
          {iconLeft && (
            <span className={styles.icon} aria-hidden="true">
              {iconLeft}
            </span>
          )}
          {children != null && <span className={styles.label}>{children}</span>}
          {iconRight && (
            <span className={styles.icon} aria-hidden="true">
              {iconRight}
            </span>
          )}
        </span>
      </button>
    );
  },
);

Button.displayName = 'Button';

export default Button;
