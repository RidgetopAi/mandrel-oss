/**
 * Project-detail line icons — the glyphs from the locked mock
 * (command-project-detail-mock.html). stroke = currentColor so a tone class colours them.
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

/** Cube/project glyph — the hero + vital tile. */
export const ProjectIcon: React.FC<IconProps> = ({ size, className }) =>
  wrap(size, className, (
    <>
      <path d="M3 7l9-4 9 4v10l-9 4-9-4V7z" />
      <path d="M3 7l9 4 9-4M12 11v10" />
    </>
  ));

/** Layers glyph — Contexts. */
export const ContextsIcon: React.FC<IconProps> = ({ size, className }) =>
  wrap(size, className, (
    <>
      <path d="M4 7l8-4 8 4-8 4-8-4z" />
      <path d="M4 12l8 4 8-4" />
    </>
  ));

/** Checkbox glyph — Tasks. */
export const TasksIcon: React.FC<IconProps> = ({ size, className }) =>
  wrap(size, className, (
    <>
      <rect x="4" y="4" width="16" height="16" rx="3" />
      <path d="M8.5 12.5l2.5 2.5 4.5-5" />
    </>
  ));

/** Nodes glyph — Decisions. */
export const DecisionsIcon: React.FC<IconProps> = ({ size, className }) =>
  wrap(size, className, (
    <>
      <circle cx="6" cy="7" r="2.5" />
      <circle cx="18" cy="17" r="2.5" />
      <path d="M6 9.5V15a2 2 0 002 2h7.5" />
    </>
  ));

/** Pulse glyph — Sessions. */
export const SessionsIcon: React.FC<IconProps> = ({ size, className }) =>
  wrap(size, className, <path d="M4 12h3l2 5 4-13 2 8h5" />);

/** Commit/branch glyph — the repository-activity signal + Commits tile. */
export const CommitIcon: React.FC<IconProps> = ({ size, className }) =>
  wrap(size, className, (
    <>
      <path d="M12 21V9M12 9L6 5M12 9l6-4M6 5v5M18 5v5" />
    </>
  ));

/** Edit/pencil glyph — the hero Edit action. */
export const EditIcon: React.FC<IconProps> = ({ size, className }) =>
  wrap(size, className, (
    <>
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z" />
    </>
  ));

/** Arrow-right glyph — the "Switch to project" action + section "open in …" links. */
export const ArrowRightIcon: React.FC<IconProps> = ({ size, className }) =>
  wrap(size, className, <path d="M5 12h14M13 6l6 6-6 6" />);

/** Chevron-left glyph — the "Back to projects" affordance. */
export const ChevronLeftIcon: React.FC<IconProps> = ({ size, className }) =>
  wrap(size, className, <path d="M15 6l-6 6 6 6" />);
