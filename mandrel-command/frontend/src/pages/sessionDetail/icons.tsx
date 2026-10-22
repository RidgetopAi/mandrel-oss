/**
 * Session-detail line icons — the glyph set for the header, vital tiles, and tab bar,
 * drawn on the design-language stroke system (stroke = currentColor so a tone class
 * colours them). Presentational only; every icon is aria-hidden (the adjacent label
 * carries meaning).
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

/** Chevron-left — the "Back to sessions" affordance. */
export const ChevronLeftIcon: React.FC<IconProps> = ({ size, className }) =>
  wrap(size, className, <path d="M15 6l-6 6 6 6" />);

/** Pulse — the session hero glyph + Timeline tab. */
export const SessionIcon: React.FC<IconProps> = ({ size, className }) =>
  wrap(size, className, <path d="M4 12h3l2 5 4-13 2 8h5" />);

/** Layers — Contexts. */
export const ContextsIcon: React.FC<IconProps> = ({ size, className }) =>
  wrap(size, className, (
    <>
      <path d="M4 7l8-4 8 4-8 4-8-4z" />
      <path d="M4 12l8 4 8-4M4 17l8 4 8-4" />
    </>
  ));

/** Checkbox — Tasks. */
export const TasksIcon: React.FC<IconProps> = ({ size, className }) =>
  wrap(size, className, (
    <>
      <rect x="4" y="4" width="16" height="16" rx="3" />
      <path d="M8.5 12.5l2.5 2.5 4.5-5" />
    </>
  ));

/** Nodes — Decisions. */
export const DecisionsIcon: React.FC<IconProps> = ({ size, className }) =>
  wrap(size, className, (
    <>
      <circle cx="6" cy="7" r="2.5" />
      <circle cx="18" cy="17" r="2.5" />
      <path d="M6 9.5V15a2 2 0 002 2h7.5" />
    </>
  ));

/** Document — Files. */
export const FilesIcon: React.FC<IconProps> = ({ size, className }) =>
  wrap(size, className, (
    <>
      <path d="M6 3h8l4 4v14H6z" />
      <path d="M14 3v4h4" />
    </>
  ));

/** Clock — Duration + timeline section head. */
export const ClockIcon: React.FC<IconProps> = ({ size, className }) =>
  wrap(size, className, (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3.5 2" />
    </>
  ));

/** Code brackets — Tokens. */
export const TokenIcon: React.FC<IconProps> = ({ size, className }) =>
  wrap(size, className, <path d="M8 6l-5 6 5 6M16 6l5 6-5 6" />);

/** Branch/commit — the git branch meta row. */
export const BranchIcon: React.FC<IconProps> = ({ size, className }) =>
  wrap(size, className, (
    <>
      <circle cx="6" cy="6" r="2.5" />
      <circle cx="6" cy="18" r="2.5" />
      <circle cx="18" cy="8" r="2.5" />
      <path d="M6 8.5v7M18 10.5a6 6 0 01-6 6H8" />
    </>
  ));

/** Robot — the AI-model meta row. */
export const ModelIcon: React.FC<IconProps> = ({ size, className }) =>
  wrap(size, className, (
    <>
      <rect x="4" y="8" width="16" height="11" rx="2.5" />
      <path d="M12 4v4M9 13h.01M15 13h.01" />
    </>
  ));

/** Cube — the project meta row. */
export const ProjectIcon: React.FC<IconProps> = ({ size, className }) =>
  wrap(size, className, (
    <>
      <path d="M3 7l9-4 9 4v10l-9 4-9-4V7z" />
      <path d="M3 7l9 4 9-4M12 11v10" />
    </>
  ));

/** Trend/activity — the activity-score tile. */
export const ActivityIcon: React.FC<IconProps> = ({ size, className }) =>
  wrap(size, className, <path d="M4 15l5-6 4 4 7-8" />);

/** Eye — the "view context" row action. */
export const EyeIcon: React.FC<IconProps> = ({ size, className }) =>
  wrap(size, className, (
    <>
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" />
      <circle cx="12" cy="12" r="2.5" />
    </>
  ));
