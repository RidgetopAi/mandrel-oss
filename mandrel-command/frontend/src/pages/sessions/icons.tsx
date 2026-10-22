/**
 * Sessions line icons — the exact glyphs from the locked mock
 * (command-sessions-mock.html), stroke = currentColor so the tone class colours
 * them. Presentational only; every icon is aria-hidden (the label carries meaning).
 */
import React from 'react';

const base = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.7,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
  focusable: false,
};

export type IconProps = { size?: number; className?: string };

const wrap = (size: number | undefined, className: string | undefined, d: React.ReactNode) => (
  <svg {...base} width={size ?? 18} height={size ?? 18} className={className}>
    {d}
  </svg>
);

/** Chevron — the accordion expand affordance (rotates 90° when open via CSS). */
export const ChevronRight: React.FC<IconProps> = ({ size, className }) =>
  wrap(size, className, <path d="M9 6l6 6-6 6" />);

/** Search glyph for the activity search box. */
export const SearchIcon: React.FC<IconProps> = ({ size, className }) =>
  wrap(size, className, (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="M20 20l-3.2-3.2" />
    </>
  ));

/** Project cube — the "All projects" filter + card project glyph. */
export const ProjectIcon: React.FC<IconProps> = ({ size, className }) =>
  wrap(size, className, (
    <>
      <path d="M3 7l9-4 9 4v10l-9 4-9-4V7z" />
      <path d="M3 7l9 4 9-4M12 11v10" />
    </>
  ));

/** Clock — the "Activity in this project" section head. */
export const ClockIcon: React.FC<IconProps> = ({ size, className }) =>
  wrap(size, className, (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3.5 2" />
    </>
  ));

/** Contexts (stacked layers). */
export const ContextsIcon: React.FC<IconProps> = ({ size, className }) =>
  wrap(size, className, (
    <>
      <path d="M4 7l8-4 8 4-8 4-8-4z" />
      <path d="M4 12l8 4 8-4M4 17l8 4 8-4" />
    </>
  ));

/** Tasks (checkbox). */
export const TasksIcon: React.FC<IconProps> = ({ size, className }) =>
  wrap(size, className, (
    <>
      <rect x="4" y="4" width="16" height="16" rx="3" />
      <path d="M8.5 12.5l2.5 2.5 4.5-5" />
    </>
  ));

/** Decisions (branch/link). */
export const DecisionsIcon: React.FC<IconProps> = ({ size, className }) =>
  wrap(size, className, (
    <>
      <circle cx="6" cy="7" r="2.5" />
      <circle cx="18" cy="17" r="2.5" />
      <path d="M6 9.5V15a2 2 0 002 2h7.5" />
    </>
  ));

/** Files (document). */
export const FilesIcon: React.FC<IconProps> = ({ size, className }) =>
  wrap(size, className, (
    <>
      <path d="M6 3h8l4 4v14H6z" />
      <path d="M14 3v4h4" />
    </>
  ));

/** Edit (pencil). */
export const EditIcon: React.FC<IconProps> = ({ size, className }) =>
  wrap(size, className, (
    <>
      <path d="M4 20h4l10-10-4-4L4 16v4z" />
      <path d="M13.5 6.5l4 4" />
    </>
  ));

/** Open (arrow out) — jump to the full session detail route. */
export const OpenIcon: React.FC<IconProps> = ({ size, className }) =>
  wrap(size, className, (
    <>
      <path d="M14 4h6v6" />
      <path d="M20 4l-9 9" />
      <path d="M18 14v5a1 1 0 01-1 1H5a1 1 0 01-1-1V7a1 1 0 011-1h5" />
    </>
  ));

/** Live-stream glyph (the section-head lightning/pulse). */
export const PulseIcon: React.FC<IconProps> = ({ size, className }) =>
  wrap(size, className, <path d="M4 12h3l2 5 4-13 2 8h5" />);

/** Plus — the "New session" control. */
export const PlusIcon: React.FC<IconProps> = ({ size, className }) =>
  wrap(size, className, <path d="M12 5v14M5 12h14" />);

/** Power — the "End session" control (close the current sitting). */
export const PowerIcon: React.FC<IconProps> = ({ size, className }) =>
  wrap(size, className, (
    <>
      <path d="M12 4v8" />
      <path d="M7.5 7.5a7 7 0 109 0" />
    </>
  ));
