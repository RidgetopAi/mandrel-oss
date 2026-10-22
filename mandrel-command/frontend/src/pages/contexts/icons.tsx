/**
 * Contexts line icons — the exact glyphs from the locked mock
 * (command-contexts-mock.html). stroke = currentColor so a tone class colours them.
 * Presentational only; every icon is aria-hidden (the adjacent label carries meaning).
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

/** Search glyph — the semantic search box. */
export const SearchIcon: React.FC<IconProps> = ({ size, className }) =>
  wrap(size, className, (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="M20 20l-3.2-3.2" />
    </>
  ));

/** Sort control glyph (descending bars). */
export const SortIcon: React.FC<IconProps> = ({ size, className }) =>
  wrap(size, className, <path d="M3 6h18M6 12h12M10 18h4" />);

/** Chevron down — select affordance. */
export const ChevronDown: React.FC<IconProps> = ({ size, className }) =>
  wrap(size, className, <path d="M6 9l6 6 6-6" />);

/** Chevron right — the "Walk the story" affordance. */
export const ChevronRight: React.FC<IconProps> = ({ size, className }) =>
  wrap(size, className, <path d="M9 6l6 6-6 6" />);

/** Layers/contexts glyph — the thread box header + page glyph. */
export const ThreadIcon: React.FC<IconProps> = ({ size, className }) =>
  wrap(size, className, (
    <>
      <path d="M4 7l8-4 8 4-8 4-8-4z" />
      <path d="M4 12l8 4 8-4M4 17l8 4 8-4" />
    </>
  ));

/** Copy glyph — copy the record id. */
export const CopyIcon: React.FC<IconProps> = ({ size, className }) =>
  wrap(size, className, (
    <>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15V5a2 2 0 012-2h10" />
    </>
  ));

/** Pencil glyph — edit the context. */
export const EditIcon: React.FC<IconProps> = ({ size, className }) =>
  wrap(size, className, (
    <>
      <path d="M4 20h4L18 10l-4-4L4 16z" />
      <path d="M13 5l4 4" />
    </>
  ));

/** Check glyph — the copied confirmation. */
export const CheckIcon: React.FC<IconProps> = ({ size, className }) =>
  wrap(size, className, <path d="M5 13l4 4L19 7" />);

/** Trash glyph — delete the context (danger action). */
export const TrashIcon: React.FC<IconProps> = ({ size, className }) =>
  wrap(size, className, (
    <>
      <path d="M4 7h16" />
      <path d="M10 11v6M14 11v6" />
      <path d="M6 7l1 13a1 1 0 001 1h8a1 1 0 001-1l1-13" />
      <path d="M9 7V4a1 1 0 011-1h4a1 1 0 011 1v3" />
    </>
  ));

/** Share/export glyph — the Export/Share menu trigger. */
export const ShareIcon: React.FC<IconProps> = ({ size, className }) =>
  wrap(size, className, (
    <>
      <path d="M4 12v7a1 1 0 001 1h14a1 1 0 001-1v-7" />
      <path d="M12 15V3" />
      <path d="M8 7l4-4 4 4" />
    </>
  ));

/** Link glyph — the named-ref (`ref:<slug>`) copyable handle chip. */
export const LinkIcon: React.FC<IconProps> = ({ size, className }) =>
  wrap(size, className, (
    <>
      <path d="M10 13a5 5 0 007 0l2-2a5 5 0 00-7-7l-1 1" />
      <path d="M14 11a5 5 0 00-7 0l-2 2a5 5 0 007 7l1-1" />
    </>
  ));
