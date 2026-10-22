/**
 * Dashboard line icons — the exact glyphs from the locked mock
 * (command-dashboard-mock.html), stroke = currentColor so the tone class colours
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

export const ProjectsIcon: React.FC<IconProps> = ({ size, className }) =>
  wrap(size, className, (
    <>
      <path d="M3 7l9-4 9 4v10l-9 4-9-4V7z" />
      <path d="M3 7l9 4 9-4M12 11v10" />
    </>
  ));

export const TasksIcon: React.FC<IconProps> = ({ size, className }) =>
  wrap(size, className, (
    <>
      <rect x="4" y="4" width="16" height="16" rx="3" />
      <path d="M8.5 12.5l2.5 2.5 4.5-5" />
    </>
  ));

export const ContextsIcon: React.FC<IconProps> = ({ size, className }) =>
  wrap(size, className, (
    <>
      <path d="M4 7l8-4 8 4-8 4-8-4z" />
      <path d="M4 12l8 4 8-4M4 17l8 4 8-4" />
    </>
  ));

export const DecisionsIcon: React.FC<IconProps> = ({ size, className }) =>
  wrap(size, className, (
    <>
      <circle cx="6" cy="7" r="2.5" />
      <circle cx="18" cy="17" r="2.5" />
      <path d="M6 9.5V15a2 2 0 002 2h7.5" />
    </>
  ));

export const ClockIcon: React.FC<IconProps> = ({ size, className }) =>
  wrap(size, className, (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3.5 2" />
    </>
  ));

export const ActivityIcon: React.FC<IconProps> = ({ size, className }) =>
  wrap(size, className, <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />);

export const KPI_ICONS = {
  projects: ProjectsIcon,
  tasks: TasksIcon,
  contexts: ContextsIcon,
  decisions: DecisionsIcon,
} as const;
