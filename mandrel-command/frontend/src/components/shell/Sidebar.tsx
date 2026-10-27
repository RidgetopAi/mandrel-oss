/**
 * App-shell Sidebar (P0.4) — the LOCKED IA nav rendered from `navConfig`
 * (config-driven, no repeated JSX). Antd-free, token-driven, CSS-Modules.
 *
 * a11y: rendered inside a <nav aria-label="Primary"> landmark (see AppShell);
 * each item is a react-router NavLink → active route gets `aria-current="page"`
 * automatically plus the teal edge-bar highlight. Every item carries a native
 * `title` so the collapsed icon-rail still surfaces its label on hover/focus.
 */
import React from 'react';
import { NavLink } from 'react-router-dom';
import { cx } from '../ui/cx';
import { LogoMark } from './icons';
import { NAV_GROUPS, NAV_UTILITY, type NavItem } from './navConfig';
import { useOpenDecisionCount } from '../../pages/decisionInbox/hooks';
import styles from './Sidebar.module.css';

export interface SidebarProps {
  /** Collapsed = icon rail (labels/counts drop, icons stay). */
  collapsed?: boolean;
  /** Fill the container width + drop the right border (mobile drawer context). */
  fullWidth?: boolean;
  /** Fired after a nav item is chosen — the mobile drawer uses it to close. */
  onNavigate?: () => void;
  className?: string;
}

const NavItemLink: React.FC<{ item: NavItem; onNavigate?: () => void; badge?: React.ReactNode }> = ({
  item,
  onNavigate,
  badge,
}) => {
  const Icon = item.icon;
  const title = item.qualifier ? `${item.label} · ${item.qualifier}` : item.label;
  return (
    <NavLink
      to={item.to}
      title={title}
      data-nav-item={item.id}
      onClick={onNavigate}
      className={({ isActive }) => cx(styles.item, isActive && styles.active)}
    >
      <Icon className={styles.icon} />
      <span className={styles.labelWrap}>
        <span className={styles.label}>{item.label}</span>
        {item.qualifier ? <span className={styles.qualifier}>{item.qualifier}</span> : null}
      </span>
      {badge}
    </NavLink>
  );
};

/**
 * The Decision Inbox nav badge — the live open-decision count
 * (an earlier task DONE WHEN 5). Renders NOTHING at zero (and while loading/erroring): an
 * empty inbox and "could not measure" must not both render as a visible zero pill.
 */
const DecisionInboxBadge: React.FC = () => {
  const { data: count } = useOpenDecisionCount();
  if (!count) return null;
  return (
    <span className={styles.navBadge} data-testid="decision-inbox-badge">
      {count}
    </span>
  );
};

export const Sidebar: React.FC<SidebarProps> = ({
  collapsed = false,
  fullWidth = false,
  onNavigate,
  className,
}) => (
  <div
    className={cx(styles.side, collapsed && styles.rail, fullWidth && styles.fullWidth, className)}
    data-collapsed={collapsed}
    data-testid="sidebar"
  >
    <NavLink to="/dashboard" className={styles.logo} title="Mandrel — Dashboard" onClick={onNavigate}>
      <span className={styles.mark}>
        <LogoMark />
      </span>
      <span className={styles.wordmark}>Mandrel</span>
    </NavLink>

    {NAV_GROUPS.map((group) => (
      <React.Fragment key={group.id}>
        <div className={styles.navlabel} data-nav-group={group.id} aria-hidden={collapsed}>
          <span>{group.label}</span>
          <span className={styles.gtag}>{group.gtag}</span>
        </div>
        {group.items.map((item) => (
          <NavItemLink
            key={item.id}
            item={item}
            onNavigate={onNavigate}
            badge={item.id === 'decision-inbox' ? <DecisionInboxBadge /> : undefined}
          />
        ))}
      </React.Fragment>
    ))}

    <div className={styles.spacer} />
    <div className={styles.sep} />
    <div className={styles.utilNote}>workspace</div>
    {NAV_UTILITY.map((item) => (
      <NavItemLink key={item.id} item={item} onNavigate={onNavigate} />
    ))}
  </div>
);

export default Sidebar;
