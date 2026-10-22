/**
 * App-shell nav icons (P0.4).
 *
 * Line-glyph SVGs transcribed VERBATIM from the locked IA/nav build-spec artifact
 * (riverbend/docs/command-ia-nav-reference.html — the `.ic` glyphs) so the shell
 * matches the design exactly. Every icon inherits `currentColor` (token-driven via
 * the consuming stylesheet) — no hardcoded hex here.
 */
import React from 'react';

export interface IconProps {
  /** Pixel size (square). Defaults to the reference `.ic` size. */
  size?: number;
  className?: string;
}

/** Shared line-icon frame — matches the reference `.ic` (stroke 1.6, no fill). */
const Glyph: React.FC<IconProps & { children: React.ReactNode; title?: string }> = ({
  size = 16.5,
  className,
  children,
  title,
}) => (
  <svg
    className={className}
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.6}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden={title ? undefined : true}
    role={title ? 'img' : undefined}
    focusable="false"
  >
    {title ? <title>{title}</title> : null}
    {children}
  </svg>
);

// ── Brand mark ──────────────────────────────────────────────────────────────
export const LogoMark: React.FC<IconProps> = (p) => (
  <Glyph {...p}>
    <line x1="12" y1="2" x2="12" y2="6" />
    <line x1="12" y1="18" x2="12" y2="22" />
    <circle cx="12" cy="12" r="8" strokeWidth={0.95} />
    <circle cx="12" cy="12" r="4.6" strokeWidth={0.95} />
    <circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none" />
  </Glyph>
);

// ── Operate ─────────────────────────────────────────────────────────────────
export const DashboardIcon: React.FC<IconProps> = (p) => (
  <Glyph {...p}>
    <rect x="3" y="3" width="7" height="9" rx="1.5" />
    <rect x="14" y="3" width="7" height="5" rx="1.5" />
    <rect x="14" y="12" width="7" height="9" rx="1.5" />
    <rect x="3" y="16" width="7" height="5" rx="1.5" />
  </Glyph>
);
export const SessionsIcon: React.FC<IconProps> = (p) => (
  <Glyph {...p}>
    <path d="M4 12h3l2 5 4-13 2 8h5" />
  </Glyph>
);
export const CalendarIcon: React.FC<IconProps> = (p) => (
  <Glyph {...p}>
    <rect x="3" y="5" width="18" height="16" rx="2" />
    <path d="M3 9h18M8 3v4M16 3v4M7.5 13h3M13.5 13h3M7.5 17h3" />
  </Glyph>
);

// ── Memory & work ─────────────────────────────────────────────────────────────
export const ContextsIcon: React.FC<IconProps> = (p) => (
  <Glyph {...p}>
    <path d="M4 7l8-4 8 4-8 4-8-4z" />
    <path d="M4 12l8 4 8-4M4 17l8 4 8-4" />
  </Glyph>
);
export const TasksIcon: React.FC<IconProps> = (p) => (
  <Glyph {...p}>
    <rect x="4" y="4" width="16" height="16" rx="3" />
    <path d="M8.5 12.5l2.5 2.5 4.5-5" />
  </Glyph>
);
/** Punch List — a clipboard with a check. */
export const PunchIcon: React.FC<IconProps> = (p) => (
  <Glyph {...p}>
    <rect x="5" y="4" width="14" height="17" rx="2" />
    <path d="M9 4V3h6v1" />
    <path d="M8.5 13l2.5 2.5 4.5-5" />
  </Glyph>
);

export const DecisionsIcon: React.FC<IconProps> = (p) => (
  <Glyph {...p}>
    <circle cx="6" cy="7" r="2.5" />
    <circle cx="18" cy="17" r="2.5" />
    <path d="M6 9.5V15a2 2 0 002 2h7.5" />
  </Glyph>
);

/** Decision Inbox nav icon — a tray with a question mark. */
export const DecisionInboxIcon: React.FC<IconProps> = (p) => (
  <Glyph {...p}>
    <path d="M4 13l3-8h10l3 8" />
    <path d="M4 13v6a1 1 0 001 1h14a1 1 0 001-1v-6" />
    <path d="M4 13h4.5a1 1 0 01.95.68l.3.9a1 1 0 00.95.68h2.6a1 1 0 00.95-.68l.3-.9a1 1 0 01.95-.68H20" />
  </Glyph>
);

// ── Insight ───────────────────────────────────────────────────────────────────
export const AnalyticsIcon: React.FC<IconProps> = (p) => (
  <Glyph {...p}>
    <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />
  </Glyph>
);
export const TreeWalkerIcon: React.FC<IconProps> = (p) => (
  <Glyph {...p}>
    <path d="M12 21V9M12 9L6 5M12 9l6-4M6 5v5l-2 2M18 5v5l2 2M12 21l-4-2M12 21l4-2" />
  </Glyph>
);

// ── Utility zone ──────────────────────────────────────────────────────────────
export const ProjectsIcon: React.FC<IconProps> = (p) => (
  <Glyph {...p}>
    <path d="M3 7l9-4 9 4v10l-9 4-9-4V7z" />
    <path d="M3 7l9 4 9-4M12 11v10" />
  </Glyph>
);
export const SettingsIcon: React.FC<IconProps> = (p) => (
  <Glyph {...p}>
    <circle cx="12" cy="12" r="3.2" />
    <path d="M12 3v2.5M12 18.5V21M4.2 7.5l2 1.2M17.8 15.3l2 1.2M4.2 16.5l2-1.2M17.8 8.7l2-1.2" />
  </Glyph>
);

/** Feedback — speech bubble (utility zone). */
export const FeedbackIcon: React.FC<IconProps> = (p) => (
  <Glyph {...p}>
    <path d="M21 11.5a7.5 7.5 0 0 1-7.5 7.5H8l-4 3v-4.4A7.5 7.5 0 0 1 13.5 4h0A7.5 7.5 0 0 1 21 11.5z" />
    <path d="M9 10.5h8M9 14h5" />
  </Glyph>
);

// ── Topbar / chrome controls ──────────────────────────────────────────────────
/** Panel-left toggle — the sidebar collapse control (reference seg glyph). */
export const PanelLeftIcon: React.FC<IconProps> = (p) => (
  <Glyph {...p}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M9 4v16" />
  </Glyph>
);
export const MenuIcon: React.FC<IconProps> = (p) => (
  <Glyph {...p}>
    <path d="M4 7h16M4 12h16M4 17h16" />
  </Glyph>
);
export const CloseIcon: React.FC<IconProps> = (p) => (
  <Glyph {...p}>
    <path d="M6 6l12 12M18 6L6 18" />
  </Glyph>
);
export const ChevronDownIcon: React.FC<IconProps> = (p) => (
  <Glyph {...p}>
    <path d="M6 9l6 6 6-6" />
  </Glyph>
);
export const SunIcon: React.FC<IconProps> = (p) => (
  <Glyph {...p}>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
  </Glyph>
);
export const MoonIcon: React.FC<IconProps> = (p) => (
  <Glyph {...p}>
    <path d="M21 12.8A9 9 0 1111.2 3a7 7 0 009.8 9.8z" />
  </Glyph>
);
export const UserIcon: React.FC<IconProps> = (p) => (
  <Glyph {...p}>
    <circle cx="12" cy="8" r="4" />
    <path d="M4 21v-1a6 6 0 0112 0v1" />
  </Glyph>
);
export const LogoutIcon: React.FC<IconProps> = (p) => (
  <Glyph {...p}>
    <path d="M15 12H4M8 8l-4 4 4 4M13 4h5a1 1 0 011 1v14a1 1 0 01-1 1h-5" />
  </Glyph>
);
