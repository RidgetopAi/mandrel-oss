/**
 * Tasks line icons — the exact glyphs from the locked mock (command-tasks-mock.html).
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

/** Board / columns glyph — the Board view toggle. */
export const BoardIcon: React.FC<IconProps> = ({ size, className }) =>
  wrap(size, className, (
    <>
      <rect x="3" y="4" width="5" height="16" rx="1" />
      <rect x="10" y="4" width="5" height="10" rx="1" />
      <rect x="17" y="4" width="4" height="13" rx="1" />
    </>
  ));

/** List rows glyph — the List view toggle. */
export const ListIcon: React.FC<IconProps> = ({ size, className }) =>
  wrap(size, className, <path d="M4 6h16M4 12h16M4 18h16" />);

/** Bar chart glyph — the Analytics view toggle. */
export const ChartIcon: React.FC<IconProps> = ({ size, className }) =>
  wrap(size, className, <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />);

/** Clock glyph — the "Oldest open tasks" (aging) panel header. */
export const ClockIcon: React.FC<IconProps> = ({ size, className }) =>
  wrap(size, className, (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </>
  ));

/** Link glyph — the typed-edge count on a card. */
export const LinkIcon: React.FC<IconProps> = ({ size, className }) =>
  wrap(size, className, (
    <>
      <path d="M10 13a5 5 0 007 0l2-2a5 5 0 00-7-7l-1 1" />
      <path d="M14 11a5 5 0 00-7 0l-2 2a5 5 0 007 7l1-1" />
    </>
  ));

/** Branch/git glyph — the branch tag + the build-story header. */
export const BranchIcon: React.FC<IconProps> = ({ size, className }) =>
  wrap(size, className, (
    <>
      <circle cx="6" cy="6" r="2.4" />
      <circle cx="6" cy="18" r="2.4" />
      <circle cx="18" cy="9" r="2.4" />
      <path d="M6 8.5v7M8.3 6h4.5a3 3 0 013 3v0" />
    </>
  ));

/** Layers glyph — the "Task thread" section header. */
export const ThreadIcon: React.FC<IconProps> = ({ size, className }) =>
  wrap(size, className, (
    <>
      <path d="M4 7l8-4 8 4-8 4-8-4z" />
      <path d="M4 12l8 4 8-4M4 17l8 4 8-4" />
    </>
  ));

/** Chevron right — the "Walk the thread" affordance. */
export const ChevronRight: React.FC<IconProps> = ({ size, className }) =>
  wrap(size, className, <path d="M9 6l6 6-6 6" />);

/** Search glyph. */
export const SearchIcon: React.FC<IconProps> = ({ size, className }) =>
  wrap(size, className, (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="M20 20l-3.2-3.2" />
    </>
  ));

/** Lock glyph — the commit-gated chip on the live panel. */
export const LockIcon: React.FC<IconProps> = ({ size, className }) =>
  wrap(size, className, (
    <>
      <rect x="4" y="10" width="16" height="10" rx="2" />
      <path d="M8 10V7a4 4 0 018 0v3" />
    </>
  ));
