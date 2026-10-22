import React from 'react';
import { cx } from './cx';
import styles from './Skeleton.module.css';

/**
 * Skeleton primitive (P0.3) — shimmer placeholders for loading content.
 * Shapes: line (text row), block (card/region), circle (avatar). `width`/`height`
 * accept any CSS length; a subtle token-derived shimmer runs across the surface.
 */
export type SkeletonShape = 'line' | 'block' | 'circle';

const shapeClass: Record<SkeletonShape, string> = {
  line: styles.line,
  block: styles.block,
  circle: styles.circle,
};

export interface SkeletonProps
  extends Omit<React.HTMLAttributes<HTMLSpanElement>, 'className'> {
  shape?: SkeletonShape;
  width?: number | string;
  height?: number | string;
  className?: string;
}

export const Skeleton: React.FC<SkeletonProps> = ({
  shape = 'line',
  width,
  height,
  className,
  style,
  ...rest
}) => (
  <span
    aria-hidden="true"
    className={cx(styles.skeleton, shapeClass[shape], className)}
    style={{ width, height, ...style }}
    {...rest}
  />
);

export default Skeleton;
