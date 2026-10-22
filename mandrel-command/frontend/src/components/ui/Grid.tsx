import React from 'react';
import { cx } from './cx';
import styles from './Grid.module.css';
import type { SpaceStep } from './Stack';

/**
 * Grid layout primitive (P0.3). A simple responsive CSS grid: either a fixed
 * column count or auto-fill with a minimum column width. Gap resolves to a
 * spacing token. Pair with Stack for one-dimensional layouts.
 */
export interface GridProps
  extends Omit<React.HTMLAttributes<HTMLDivElement>, 'className'> {
  /** Fixed number of equal columns. */
  columns?: number;
  /** Auto-fill columns at least this wide (CSS length). Overrides `columns`. */
  minColumnWidth?: string;
  gap?: SpaceStep;
  className?: string;
}

export const Grid: React.FC<GridProps> = ({
  columns = 2,
  minColumnWidth,
  gap = 4,
  className,
  style,
  children,
  ...rest
}) => {
  const gridTemplateColumns = minColumnWidth
    ? `repeat(auto-fill, minmax(${minColumnWidth}, 1fr))`
    : `repeat(${columns}, minmax(0, 1fr))`;
  return (
    <div
      className={cx(styles.grid, className)}
      style={{ gridTemplateColumns, gap: `var(--sp-${gap})`, ...style }}
      {...rest}
    >
      {children}
    </div>
  );
};

export default Grid;
