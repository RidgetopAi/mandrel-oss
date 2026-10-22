import React from 'react';
import { cx } from './cx';
import styles from './Tooltip.module.css';

/**
 * Tooltip primitive (P0.3). Dependency-free: a positioned popover revealed on
 * hover AND keyboard focus (`:focus-within`), so it is accessible without JS
 * positioning libraries. The tooltip is linked to its trigger via
 * `aria-describedby`. Content lives in a token-styled surface with an arrow.
 */
export type TooltipPlacement = 'top' | 'bottom' | 'left' | 'right';

const placementClass: Record<TooltipPlacement, string> = {
  top: styles.top,
  bottom: styles.bottom,
  left: styles.left,
  right: styles.right,
};

export interface TooltipProps {
  /** Tooltip content. */
  label: React.ReactNode;
  placement?: TooltipPlacement;
  /** The trigger element the tooltip describes. */
  children: React.ReactElement;
  className?: string;
}

export const Tooltip: React.FC<TooltipProps> = ({
  label,
  placement = 'top',
  children,
  className,
}) => {
  const id = React.useId();
  // Thread aria-describedby onto the single trigger child (a11y).
  const trigger = React.cloneElement(children, {
    'aria-describedby': id,
  });
  return (
    <span className={cx(styles.wrapper, className)}>
      {trigger}
      <span
        role="tooltip"
        id={id}
        className={cx(styles.tooltip, placementClass[placement])}
      >
        {label}
      </span>
    </span>
  );
};

export default Tooltip;
