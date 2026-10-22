/**
 * Analytics line icons — the glyphs from the locked mock (command-analytics-mock.html).
 * stroke = currentColor so a tone class colours them. Presentational only; every icon is
 * aria-hidden (the adjacent label carries meaning).
 */
import React from 'react';

const base = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.6,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
  focusable: false,
};

export type IconProps = { size?: number; className?: string };

const wrap = (size: number | undefined, className: string | undefined, d: React.ReactNode) => (
  <svg {...base} width={size ?? 16} height={size ?? 16} className={className}>
    {d}
  </svg>
);

/** Chevron down — select affordance. */
export const ChevronDown: React.FC<IconProps> = ({ size, className }) =>
  wrap(size, className, <path d="M6 9l6 6 6-6" />);

/** Person glyph — the actor filter + "Activity by actor" panel. */
export const ActorIcon: React.FC<IconProps> = ({ size, className }) =>
  wrap(size, className, (
    <>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 20c0-4 4-6 8-6s8 2 8 6" />
    </>
  ));

/** Checkbox glyph — the "Work mix — tasks" panel. */
export const TaskIcon: React.FC<IconProps> = ({ size, className }) =>
  wrap(size, className, (
    <>
      <rect x="4" y="4" width="16" height="16" rx="3" />
      <path d="M8.5 12.5l2.5 2.5 4.5-5" />
    </>
  ));

/** Star glyph — the "Most productive sessions" panel. */
export const StarIcon: React.FC<IconProps> = ({ size, className }) =>
  wrap(size, className, <path d="M12 3l2.5 6H21l-5 4 2 7-6-4-6 4 2-7-5-4h6.5z" />);

/** Pulse glyph — the "Token rhythm — by hour" panel. */
export const PulseIcon: React.FC<IconProps> = ({ size, className }) =>
  wrap(size, className, <path d="M4 12h3l2 5 4-13 2 8h5" />);

/** Bars glyph — the page glyph + group-by. */
export const BarsIcon: React.FC<IconProps> = ({ size, className }) =>
  wrap(size, className, <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />);

/** Tree glyph — the group-by dimension affordance. */
export const TreeIcon: React.FC<IconProps> = ({ size, className }) =>
  wrap(size, className, <path d="M12 3v18M4 8l8-5 8 5" />);
