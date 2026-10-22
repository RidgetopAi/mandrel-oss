/**
 * Decisions line icons — the glyphs from the locked mock (command-decisions-mock.html).
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

/** Clock glyph — the outcome filter + the outcome/learning-loop section header. */
export const ClockIcon: React.FC<IconProps> = ({ size, className }) =>
  wrap(size, className, (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </>
  ));

/** Chevron down — select affordance. */
export const ChevronDown: React.FC<IconProps> = ({ size, className }) =>
  wrap(size, className, <path d="M6 9l6 6 6-6" />);

/** Chevron right — the "Walk the story" affordance. */
export const ChevronRight: React.FC<IconProps> = ({ size, className }) =>
  wrap(size, className, <path d="M9 6l6 6-6 6" />);

/** Decision/graph glyph — the thread box header + page glyph (two nodes + a link). */
export const DecisionIcon: React.FC<IconProps> = ({ size, className }) =>
  wrap(size, className, (
    <>
      <circle cx="6" cy="7" r="2.5" />
      <circle cx="18" cy="17" r="2.5" />
      <path d="M6 9.5V15a2 2 0 002 2h7.5" />
    </>
  ));

/** Problem glyph — an info circle for the "Problem" section. */
export const ProblemIcon: React.FC<IconProps> = ({ size, className }) =>
  wrap(size, className, (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 8v0M12 11v5" />
    </>
  ));

/** Check glyph — the "Decision" section header + copied confirmation. */
export const CheckIcon: React.FC<IconProps> = ({ size, className }) =>
  wrap(size, className, <path d="M5 12l4 4L19 6" />);

/** Sun/rays glyph — the "Rationale" section header. */
export const RationaleIcon: React.FC<IconProps> = ({ size, className }) =>
  wrap(size, className, (
    <path d="M12 3v3M12 18v3M3 12h3M18 12h3M6 6l2 2M16 16l2 2M6 18l2-2M16 8l2-2" />
  ));

/** List glyph — the "Alternatives considered" section header. */
export const ListIcon: React.FC<IconProps> = ({ size, className }) =>
  wrap(size, className, <path d="M8 6h13M8 12h13M8 18h13M3 6v0M3 12v0M3 18v0" />);

/** Star glyph — the "Success criteria" section header. */
export const StarIcon: React.FC<IconProps> = ({ size, className }) =>
  wrap(size, className, <path d="M12 3l2.5 6H21l-5 4 2 7-6-4-6 4 2-7-5-4h6.5z" />);

/** X glyph — the rejected-alternative marker. */
export const XIcon: React.FC<IconProps> = ({ size, className }) =>
  wrap(size, className, <path d="M6 6l12 12M18 6L6 18" />);

/** Copy glyph — copy the record id. */
export const CopyIcon: React.FC<IconProps> = ({ size, className }) =>
  wrap(size, className, (
    <>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15V5a2 2 0 012-2h10" />
    </>
  ));

/** Pencil glyph — record an outcome / edit. */
export const EditIcon: React.FC<IconProps> = ({ size, className }) =>
  wrap(size, className, (
    <>
      <path d="M4 20h4L18 10l-4-4L4 16z" />
      <path d="M13 5l4 4" />
    </>
  ));
