/**
 * App-shell tunables (P0.4) — named config, no magic numbers (configs-not-hardcoded).
 * The breakpoint + persistence key live here so the Sidebar, Topbar and the
 * collapse/mobile hooks all agree on one source.
 */
export const shellConfig = {
  /**
   * Below this viewport width the inline sidebar is replaced by an overlay
   * Drawer (reference: "Below ~860px the sidebar is an overlay drawer"). Kept as
   * a max-width media query string so the hook and any CSS stay in lockstep.
   */
  mobileMaxWidth: 860,
  get mobileMediaQuery(): string {
    return `(max-width: ${shellConfig.mobileMaxWidth}px)`;
  },
  /** localStorage key for the persisted rail-collapsed state (per user/browser). */
  collapseStorageKey: 'command_sidebar_collapsed',
} as const;

export default shellConfig;
