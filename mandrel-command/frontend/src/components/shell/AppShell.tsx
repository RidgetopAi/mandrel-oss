/**
 * AppShell (P0.4) — the token-driven, primitive-built application frame that
 * replaces the antd AppLayout. Implements the LOCKED IA/nav:
 *   • Sidebar  — 3 groups + bottom utility zone, active-route highlight, collapse
 *                to an icon rail (persisted), mobile overlay drawer.
 *   • Topbar   — project switcher, SSE status, theme toggle, user menu.
 *   • Content  — <Outlet/> where the existing routed screens (still antd inside,
 *                which is expected — each is rebuilt in its own later phase) mount.
 *
 * This is the FRAME, not the screens. The provider tree (Theme/Auth/Project/
 * Settings/Sse/FeatureFlag) is preserved by App.tsx; AppShell just consumes those
 * contexts. Antd-free chrome (configs-not-hardcoded, tokens + CSS Modules).
 */
import React from 'react';
import { Outlet } from 'react-router-dom';
import { Drawer } from '../ui';
import SectionErrorBoundary from '../error/SectionErrorBoundary';
import { Sidebar } from './Sidebar';
import { Topbar } from './Topbar';
import { useSidebarCollapse, useIsMobile } from './hooks';
import { useTrackVisitedPath } from '../../utils/lastVisitedPath';
import styles from './AppShell.module.css';

export const AppShell: React.FC = () => {
  const { collapsed, toggle } = useSidebarCollapse();
  // Remember which screen the user is on so the Feedback form can report THAT path
  // instead of `/feedback`. Mounted here because the shell is the one
  // component every protected route renders inside.
  useTrackVisitedPath();
  const isMobile = useIsMobile();
  const [drawerOpen, setDrawerOpen] = React.useState(false);

  // Close the mobile drawer whenever we cross back to desktop.
  React.useEffect(() => {
    if (!isMobile && drawerOpen) setDrawerOpen(false);
  }, [isMobile, drawerOpen]);

  return (
    <div className={styles.shell}>
      <a href="#main-content" className={styles.skipLink}>
        Skip to content
      </a>

      {/* Inline sidebar — desktop only. */}
      {!isMobile && (
        <nav className={styles.sideCol} aria-label="Primary">
          <Sidebar collapsed={collapsed} />
        </nav>
      )}

      {/* Mobile navigation — overlay drawer (reuses the P0.3 Drawer). */}
      {isMobile && (
        <Drawer
          open={drawerOpen}
          onClose={() => setDrawerOpen(false)}
          side="left"
          aria-label="Primary navigation"
        >
          <nav className={styles.drawerNav} aria-label="Primary">
            <Sidebar fullWidth onNavigate={() => setDrawerOpen(false)} />
          </nav>
        </Drawer>
      )}

      <div className={styles.main}>
        <Topbar
          isMobile={isMobile}
          collapsed={collapsed}
          onToggleCollapse={toggle}
          onOpenDrawer={() => setDrawerOpen(true)}
        />
        <main id="main-content" className={styles.content} tabIndex={-1}>
          <SectionErrorBoundary section="App Shell">
            <Outlet />
          </SectionErrorBoundary>
        </main>
      </div>
    </div>
  );
};

export default AppShell;
