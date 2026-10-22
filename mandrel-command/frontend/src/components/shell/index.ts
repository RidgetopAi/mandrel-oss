/**
 * App shell (P0.4) — token-driven, primitive-built application frame + LOCKED IA
 * nav. Public surface for App.tsx (AppShell) and the placeholder routes.
 */
export { AppShell } from './AppShell';
export { Sidebar } from './Sidebar';
export type { SidebarProps } from './Sidebar';
export { Topbar } from './Topbar';
export type { TopbarProps } from './Topbar';
export { ComingSoon, CalendarPlaceholder, TreeWalkerPlaceholder } from './ComingSoon';
export type { ComingSoonProps } from './ComingSoon';
export {
  NAV_GROUPS,
  NAV_UTILITY,
  ALL_NAV_ITEMS,
  type NavItem,
  type NavGroup,
} from './navConfig';
export { useSidebarCollapse, useMediaQuery, useIsMobile } from './hooks';
export { shellConfig } from './shellConfig';

export { AppShell as default } from './AppShell';
