/**
 * App-shell navigation configuration (P0.4) — the SINGLE source of truth for the
 * sidebar structure. Driven data, not repeated JSX (configs-not-hardcoded): the
 * Sidebar maps over these arrays, so a nav change is a one-line edit here.
 *
 * Reconciled VERBATIM from the LOCKED IA/nav build-spec
 *   riverbend/docs/command-ia-nav-reference.html  (IA-lock an earlier context)
 * THREE content groups — Operate / Memory & work / Insight — plus a bottom,
 * hairline-separated UTILITY zone (Projects, Settings). TreeWalker carries a
 * `work` qualifier (Decision 3·A). Calendar is
 * `isNew` (no dedicated screen yet → the ComingSoon placeholder). TreeWalker is
 * now a live screen (its thread data renders honest-empty until backend).
 *
 * NOTE (reconciled, flagged for the coordinator): the locked IA lists exactly 11 nav
 * entries. Existing routes NOT in the locked IA (Embedding, Profile, and every
 * drill-down detail route) remain mounted + reachable (drill-downs, the user
 * menu) but are intentionally absent from the top-level nav — they get
 * folded/placed in their own later phases.
 *
 * FEEDBACK IS THE ONE DELIBERATE ADDITION TO THE LOCKED 11
 * (2026-08-08). It sits in the bottom UTILITY zone (Projects · Settings ·
 * Feedback), not in a content group, so the three locked content groups are
 * untouched. Reason: the screen's entire purpose is to be found in the moment a
 * user hits a problem — a reporting surface reachable only by typing /feedback
 * collects nothing, which is exactly what happened while it sat unlinked. The
 * total was therefore 12 entries (9 content + 3 utility); shell.test.tsx pins that
 * number, so changing it is a deliberate act, not a drift.
 *
 * PUNCH LIST IS THE SECOND ADDITION (2026-09-10). It sits in
 * "Memory & work" beside Tasks because a punch IS a task (one board item with a
 * `stage`), filed from a phone.
 *
 * DECISION INBOX IS THE THIRD ADDITION
 * (2026-09-21). Sits beside Decisions — the answer-fast surface for open decisions,
 * distinct from the Decisions "why ledger" screen. Carries a live open-count badge
 * (Sidebar.tsx), rendered by item id rather than as static config (the count is a
 * network read, not a compile-time value). 14 entries now (11 content + 3 utility).
 */
import type React from 'react';
import {
  DashboardIcon,
  SessionsIcon,
  CalendarIcon,
  ContextsIcon,
  TasksIcon,
  PunchIcon,
  DecisionsIcon,
  DecisionInboxIcon,
  AnalyticsIcon,
  TreeWalkerIcon,
  ProjectsIcon,
  SettingsIcon,
  FeedbackIcon,
  type IconProps,
} from './icons';

export interface NavItem {
  /** Stable id — used as React key + test hook. */
  id: string;
  label: string;
  /** Route path (absolute). */
  to: string;
  icon: React.FC<IconProps>;
  /** One-word qualifier rendered after the label (Surveyor `code`, TreeWalker `work`). */
  qualifier?: string;
  /** True for items whose real screen ships in a later phase (→ ComingSoon placeholder). */
  isNew?: boolean;
}

export interface NavGroup {
  id: string;
  label: string;
  /** Faint mono tag shown right of the group label (reference `.gtag`). */
  gtag: string;
  items: NavItem[];
}

/** The three content groups, in order. */
export const NAV_GROUPS: NavGroup[] = [
  {
    id: 'operate',
    label: 'Operate',
    gtag: 'now / time',
    items: [
      { id: 'dashboard', label: 'Dashboard', to: '/dashboard', icon: DashboardIcon },
      { id: 'sessions', label: 'Sessions', to: '/sessions', icon: SessionsIcon },
      { id: 'calendar', label: 'Calendar', to: '/calendar', icon: CalendarIcon, isNew: true },
    ],
  },
  {
    id: 'memory-work',
    label: 'Memory & work',
    gtag: 'the record',
    items: [
      { id: 'contexts', label: 'Contexts', to: '/contexts', icon: ContextsIcon },
      { id: 'tasks', label: 'Tasks', to: '/tasks', icon: TasksIcon },
      { id: 'punch', label: 'Punch List', to: '/punch', icon: PunchIcon },
      { id: 'decisions', label: 'Decisions', to: '/decisions', icon: DecisionsIcon },
      { id: 'decision-inbox', label: 'Decision Inbox', to: '/decisions/inbox', icon: DecisionInboxIcon },
    ],
  },
  {
    id: 'insight',
    label: 'Insight',
    gtag: 'analysis',
    items: [
      { id: 'analytics', label: 'Analytics', to: '/analytics', icon: AnalyticsIcon },
      { id: 'treewalker', label: 'TreeWalker', to: '/treewalker', icon: TreeWalkerIcon, qualifier: 'work' },
    ],
  },
];

/** Bottom-pinned utility zone (hairline-separated from content nav). */
export const NAV_UTILITY: NavItem[] = [
  { id: 'projects', label: 'Projects', to: '/projects', icon: ProjectsIcon },
  { id: 'settings', label: 'Settings', to: '/settings', icon: SettingsIcon },
  { id: 'feedback', label: 'Feedback', to: '/feedback', icon: FeedbackIcon },
];

/** Flat list of every nav route (content + utility) — handy for tests/guards. */
export const ALL_NAV_ITEMS: NavItem[] = [
  ...NAV_GROUPS.flatMap((g) => g.items),
  ...NAV_UTILITY,
];
