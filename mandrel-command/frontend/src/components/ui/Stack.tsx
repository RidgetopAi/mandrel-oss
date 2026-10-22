import React from 'react';
import { cx } from './cx';
import styles from './Stack.module.css';

/**
 * Stack layout primitive (P0.3). Flexbox row/column with a token-scale gap.
 * `gap` is a spacing-token step (1–10 → var(--sp-N)); align/justify/wrap map to
 * flexbox. No hardcoded spacing — the gap resolves to a design token.
 */
export type SpaceStep = 1 | 2 | 3 | 4 | 5 | 6 | 8 | 10;

export interface StackProps
  extends Omit<React.HTMLAttributes<HTMLDivElement>, 'className'> {
  direction?: 'row' | 'column';
  gap?: SpaceStep;
  align?: 'start' | 'center' | 'end' | 'stretch' | 'baseline';
  justify?: 'start' | 'center' | 'end' | 'between' | 'around';
  wrap?: boolean;
  /** Stretch to fill the cross axis width. */
  as?: React.ElementType;
  className?: string;
}

const alignMap: Record<NonNullable<StackProps['align']>, string> = {
  start: 'flex-start',
  center: 'center',
  end: 'flex-end',
  stretch: 'stretch',
  baseline: 'baseline',
};

const justifyMap: Record<NonNullable<StackProps['justify']>, string> = {
  start: 'flex-start',
  center: 'center',
  end: 'flex-end',
  between: 'space-between',
  around: 'space-around',
};

export const Stack: React.FC<StackProps> = ({
  direction = 'column',
  gap = 4,
  align,
  justify,
  wrap = false,
  as,
  className,
  style,
  children,
  ...rest
}) => {
  const Component = as ?? 'div';
  return (
    <Component
      className={cx(styles.stack, wrap && styles.wrap, className)}
      style={{
        flexDirection: direction,
        gap: `var(--sp-${gap})`,
        alignItems: align ? alignMap[align] : undefined,
        justifyContent: justify ? justifyMap[justify] : undefined,
        ...style,
      }}
      {...rest}
    >
      {children}
    </Component>
  );
};

export default Stack;
