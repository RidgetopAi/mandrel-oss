/**
 * App-shell Topbar (P0.4) — antd-free, token-driven. Left: the sidebar control
 * (hamburger on mobile → opens the overlay drawer; panel toggle on desktop →
 * collapses the rail). Right: SSE status, THE project switch, theme toggle, user
 * menu. These stay put regardless of rail state (reference: "Topbar unaffected").
 *
 * The project switch here is the ONE control that scopes every page.
 * The page-scope epic §B had removed it in favour of a
 * selector on each page; the operator's punch returns the master switch to the top bar and
 * deletes the per-page ones. See shell/ProjectSwitch for what it writes.
 */
import React from 'react';
import { cx } from '../ui/cx';
import { PanelLeftIcon, MenuIcon } from './icons';
import { SseIndicator } from './SseIndicator';
import { ProjectSwitch } from './ProjectSwitch';
import { ThemeToggle } from './ThemeToggle';
import { UserMenu } from './UserMenu';
import styles from './Topbar.module.css';

export interface TopbarProps {
  isMobile: boolean;
  /** Desktop: rail collapsed? (drives the toggle's aria-expanded). */
  collapsed: boolean;
  /** Desktop: toggle the rail. */
  onToggleCollapse: () => void;
  /** Mobile: open the overlay drawer. */
  onOpenDrawer: () => void;
}

export const Topbar: React.FC<TopbarProps> = ({
  isMobile,
  collapsed,
  onToggleCollapse,
  onOpenDrawer,
}) => (
  <header className={styles.bar}>
    <div className={styles.left}>
      {isMobile ? (
        <button
          type="button"
          className={styles.iconBtn}
          onClick={onOpenDrawer}
          aria-label="Open navigation menu"
          data-testid="open-drawer"
        >
          <MenuIcon size={18} />
        </button>
      ) : (
        <button
          type="button"
          className={cx(styles.iconBtn)}
          onClick={onToggleCollapse}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          aria-expanded={!collapsed}
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          data-testid="collapse-toggle"
        >
          <PanelLeftIcon size={18} />
        </button>
      )}
    </div>

    <div className={styles.right}>
      <SseIndicator />
      <ProjectSwitch />
      <ThemeToggle />
      <UserMenu />
    </div>
  </header>
);

export default Topbar;
