/**
 * Settings icon set — inline, stroke-only SVGs transcribed from the locked mock
 * (docs/command-settings-mock.html). Kept local to the settings module (like
 * decisions/icons.tsx) so the section rail + control glyphs match the design exactly.
 * `currentColor` throughout so colour comes from the token-driven CSS, never a literal.
 */
import React from 'react';

export type IconKey =
  | 'user'
  | 'cube'
  | 'identity'
  | 'bell'
  | 'key'
  | 'appearance'
  | 'warning';

interface IconProps {
  size?: number;
  className?: string;
}

const base = (size: number): React.SVGProps<SVGSVGElement> => ({
  viewBox: '0 0 24 24',
  width: size,
  height: size,
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.6,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true,
});

export const SectionIcon: React.FC<IconProps & { name: IconKey }> = ({ name, size = 15, className }) => {
  const props = { ...base(size), className };
  switch (name) {
    case 'user':
      return (
        <svg {...props}>
          <circle cx="12" cy="8" r="4" />
          <path d="M4 21c0-4 3.5-6 8-6s8 2 8 6" />
        </svg>
      );
    case 'cube':
      return (
        <svg {...props}>
          <path d="M3 7l9-4 9 4v10l-9 4-9-4V7z" />
          <path d="M3 7l9 4 9-4" />
        </svg>
      );
    case 'identity':
      return (
        <svg {...props}>
          <circle cx="9" cy="8" r="3.2" />
          <path d="M3 20c0-3 2.5-4.5 6-4.5M15.5 12.5l2 2 4-4" />
        </svg>
      );
    case 'bell':
      return (
        <svg {...props}>
          <path d="M18 8a6 6 0 10-12 0c0 7-3 8-3 8h18s-3-1-3-8" />
          <path d="M13.5 21a2 2 0 01-3 0" />
        </svg>
      );
    case 'key':
      return (
        <svg {...props}>
          <path d="M15 7a5 5 0 00-5 5M9 7a5 5 0 015 5M7 12l-3 3 2 2 3-3M17 12l3 3-2 2-3-3" />
        </svg>
      );
    case 'appearance':
      return (
        <svg {...props}>
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
        </svg>
      );
    case 'warning':
      return (
        <svg {...props}>
          <path d="M12 3l9 16H3z" />
          <path d="M12 9v4" />
        </svg>
      );
    default:
      return null;
  }
};

/** Chat paper-plane (Notifications). */
export const chatIcon: React.FC<IconProps> = ({ size = 15, className }) => (
  <svg {...base(size)} className={className}>
    <path d="M21 4L3 11l6 2 2 6 3-4 4 3z" />
  </svg>
);

/** Checkmark (checkbox glyph / done). */
export const CheckIcon: React.FC<IconProps> = ({ size = 12, className }) => (
  <svg {...base(size)} strokeWidth={2.4} className={className}>
    <path d="M5 12l4 4 10-10" />
  </svg>
);

/** Rotate / refresh (token rotation). */
export const RotateIcon: React.FC<IconProps> = ({ size = 14, className }) => (
  <svg {...base(size)} className={className}>
    <path d="M20 11a8 8 0 10-1.5 5" />
    <path d="M20 5v6h-6" />
  </svg>
);

/** Lock (embeddings on-box). */
export const LockIcon: React.FC<IconProps> = ({ size = 13, className }) => (
  <svg {...base(size)} className={className}>
    <rect x="5" y="11" width="14" height="9" rx="2" />
    <path d="M8 11V8a4 4 0 018 0v3" />
  </svg>
);
