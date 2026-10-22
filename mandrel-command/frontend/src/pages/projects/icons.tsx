/**
 * Projects line icons — the glyphs from the locked mock (command-projects-mock.html).
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

/** Search glyph — the search box. */
export const SearchIcon: React.FC<IconProps> = ({ size, className }) =>
  wrap(size, className, (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="M20 20l-3.2-3.2" />
    </>
  ));

/** Plus glyph — the "New project" button. */
export const PlusIcon: React.FC<IconProps> = ({ size, className }) =>
  wrap(size, className, <path d="M12 5v14M5 12h14" />);

/** Sort glyph — the sort select affordance. */
export const SortIcon: React.FC<IconProps> = ({ size, className }) =>
  wrap(size, className, <path d="M3 6h18M6 12h12M10 18h4" />);

/** Chevron down — select affordance. */
export const ChevronDown: React.FC<IconProps> = ({ size, className }) =>
  wrap(size, className, <path d="M6 9l6 6 6-6" />);

/**
 * Graph/branch glyph — the footer active-work chip (three nodes + links). Same shape the
 * mock uses for "active branches"; here it fronts the honest in-progress-task signal.
 */
export const BranchIcon: React.FC<IconProps> = ({ size, className }) =>
  wrap(size, className, (
    <>
      <circle cx="6" cy="6" r="2.4" />
      <circle cx="18" cy="6" r="2.4" />
      <circle cx="12" cy="18" r="2.4" />
      <path d="M7.6 7.6l3 8M16.4 7.6l-3 8M8 6h8" />
    </>
  ));

/** Cube/project glyph — the page heading + empty state. */
export const ProjectIcon: React.FC<IconProps> = ({ size, className }) =>
  wrap(size, className, (
    <>
      <path d="M3 7l9-4 9 4v10l-9 4-9-4V7z" />
      <path d="M3 7l9 4 9-4M12 11v10" />
    </>
  ));
