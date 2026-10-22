/**
 * TreeWalker line icons — the glyphs from the locked mock (command-treewalker-mock.html).
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

/** Tree glyph — the page + spine header (roots → trunk → branch). */
export const TreeIcon: React.FC<IconProps> = ({ size, className }) =>
  wrap(size, className, (
    <path d="M12 21V9M12 9L6 5M12 9l6-4M6 5v5l-2 2M18 5v5l2 2M12 21l-4-2M12 21l4-2" />
  ));

/** Node-graph glyph — the "Graph" view toggle. */
export const GraphIcon: React.FC<IconProps> = ({ size, className }) =>
  wrap(size, className, (
    <>
      <circle cx="6" cy="6" r="2.2" />
      <circle cx="18" cy="8" r="2.2" />
      <circle cx="10" cy="18" r="2.2" />
      <path d="M8 6.5l8 1.4M8 7.5l1.6 8.5" />
    </>
  ));

/** List glyph — the "Story" view toggle + the story head. */
export const StoryIcon: React.FC<IconProps> = ({ size, className }) =>
  wrap(size, className, <path d="M4 6h16M4 12h10M4 18h13" />);

/** Trunk glyph — the "Jump to trunk" button. */
export const TrunkIcon: React.FC<IconProps> = ({ size, className }) =>
  wrap(size, className, <path d="M12 3v18M4 8l8-5 8 5" />);

/** Clock glyph — the "Only trusted" filter. */
export const ClockIcon: React.FC<IconProps> = ({ size, className }) =>
  wrap(size, className, (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </>
  ));

/** Play glyph — the "Walk the story" control. */
export const PlayIcon: React.FC<IconProps> = ({ size, className }) =>
  wrap(size, className, <path d="M5 3l14 9-14 9z" />);

/** Arrow glyph — the "Open the full thread in the reader" footer. */
export const ArrowIcon: React.FC<IconProps> = ({ size, className }) =>
  wrap(size, className, <path d="M5 12h14M5 12l5-5M5 12l5 5" />);
