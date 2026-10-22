/**
 * Calendar line icons — glyphs from the locked mock (command-calendar-mock.html),
 * stroke = currentColor so the tone class colours them. Presentational only; every
 * icon is aria-hidden (adjacent text carries the meaning).
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

/** ‹ previous-week arrow. */
export const ChevronLeft: React.FC<IconProps> = ({ size, className }) =>
  wrap(size, className, <path d="M15 6l-6 6 6 6" />);

/** › next-week arrow. */
export const ChevronRight: React.FC<IconProps> = ({ size, className }) =>
  wrap(size, className, <path d="M9 6l6 6-6 6" />);

/** Target — the "Today" jump. */
export const TargetIcon: React.FC<IconProps> = ({ size, className }) =>
  wrap(size, className, (
    <>
      <circle cx="12" cy="12" r="8" />
      <circle cx="12" cy="12" r="3" />
    </>
  ));

/** Check — a completed task card. */
export const CheckIcon: React.FC<IconProps> = ({ size, className }) =>
  wrap(size, className, <path d="M5 12l4 4 10-10" />);
