import React from 'react';
import { cx } from './cx';
import styles from './Card.module.css';

/**
 * Card / Panel primitive (P0.3). The surface treatment from the design doc:
 * `background: var(--s1); border: 1px solid var(--line); border-radius: var(--r)`
 * (the reader/`.cbox`/`.sw` panels). Composes optional Header/Body/Footer.
 */
export interface CardProps
  extends Omit<React.HTMLAttributes<HTMLDivElement>, 'className'> {
  /** Elevated surface (--s2) instead of the default panel surface (--s1). */
  surface?: 's1' | 's2';
  /** Interactive hover affordance (row/clickable card). */
  interactive?: boolean;
  /** Remove inner padding (caller composes Header/Body/Footer for their own). */
  flush?: boolean;
  className?: string;
}

export const Card = React.forwardRef<HTMLDivElement, CardProps>(
  ({ surface = 's1', interactive = false, flush = false, className, children, ...rest }, ref) => (
    <div
      ref={ref}
      className={cx(
        styles.card,
        surface === 's2' ? styles.surface2 : styles.surface1,
        interactive && styles.interactive,
        !flush && styles.padded,
        className,
      )}
      {...rest}
    >
      {children}
    </div>
  ),
);
Card.displayName = 'Card';

export type CardSectionProps = Omit<React.HTMLAttributes<HTMLDivElement>, 'className'> & {
  className?: string;
};

export const CardHeader: React.FC<CardSectionProps> = ({ className, children, ...rest }) => (
  <div className={cx(styles.header, className)} {...rest}>
    {children}
  </div>
);

export const CardBody: React.FC<CardSectionProps> = ({ className, children, ...rest }) => (
  <div className={cx(styles.body, className)} {...rest}>
    {children}
  </div>
);

export const CardFooter: React.FC<CardSectionProps> = ({ className, children, ...rest }) => (
  <div className={cx(styles.footer, className)} {...rest}>
    {children}
  </div>
);

export default Card;
