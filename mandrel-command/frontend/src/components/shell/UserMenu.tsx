/**
 * Topbar user menu (P0.4) — token-driven dropdown (antd-free). Avatar + username
 * trigger opens a small menu: Profile, Settings, Logout. Logout runs through the
 * existing AuthContext (which calls `api.auth` under the hood + clears session).
 *
 * a11y: trigger is aria-haspopup="menu"/aria-expanded; the popup is a `role="menu"`
 * of `role="menuitem"` buttons with the standard WAI-ARIA roving-focus pattern —
 * Down/Up move focus between items (wrapping), Home/End jump to the first/last,
 * Enter/Space activate (native button), Esc/Tab and click-outside close and return
 * focus to the trigger. Matches the a11y quality of the Select primitive's listbox.
 */
import React from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuthContext } from '../../contexts/AuthContext';
import { useOnClickOutside } from '../ui/hooks';
import { UserIcon, SettingsIcon, LogoutIcon, ChevronDownIcon } from './icons';
import styles from './Topbar.module.css';

export const UserMenu: React.FC = () => {
  const navigate = useNavigate();
  const { user, logout } = useAuthContext();
  const [open, setOpen] = React.useState(false);
  const [activeIndex, setActiveIndex] = React.useState(0);
  const rootRef = React.useRef<HTMLDivElement>(null);
  const triggerRef = React.useRef<HTMLButtonElement>(null);
  const itemRefs = React.useRef<(HTMLButtonElement | null)[]>([]);

  useOnClickOutside(rootRef, () => setOpen(false), open);

  const close = React.useCallback(() => {
    setOpen(false);
    triggerRef.current?.focus();
  }, []);

  const openTo = (index: number) => {
    setActiveIndex(index);
    setOpen(true);
  };

  const go = (to: string) => {
    close();
    navigate(to);
  };

  const items = [
    { key: 'profile', label: 'Profile', Icon: UserIcon, run: () => go('/profile') },
    { key: 'settings', label: 'Settings', Icon: SettingsIcon, run: () => go('/settings') },
    {
      key: 'logout',
      label: 'Logout',
      Icon: LogoutIcon,
      danger: true,
      sepBefore: true,
      run: () => {
        close();
        void logout();
      },
    },
  ];

  // Move DOM focus onto the active menuitem whenever it changes while open
  // (roving focus: the active item is the only one in the tab sequence).
  React.useEffect(() => {
    if (open) itemRefs.current[activeIndex]?.focus();
  }, [open, activeIndex]);

  const onTriggerKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      openTo(0);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      openTo(items.length - 1);
    }
  };

  const onMenuKeyDown = (e: React.KeyboardEvent) => {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setActiveIndex((i) => (i + 1) % items.length);
        break;
      case 'ArrowUp':
        e.preventDefault();
        setActiveIndex((i) => (i - 1 + items.length) % items.length);
        break;
      case 'Home':
        e.preventDefault();
        setActiveIndex(0);
        break;
      case 'End':
        e.preventDefault();
        setActiveIndex(items.length - 1);
        break;
      case 'Escape':
        e.stopPropagation();
        close();
        break;
      case 'Tab':
        // Let focus leave naturally; just dismiss the menu.
        setOpen(false);
        break;
      default:
        break;
    }
  };

  const username = user?.username || 'User';

  return (
    <div className={styles.userMenu} ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className={styles.userTrigger}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => (open ? close() : openTo(0))}
        onKeyDown={onTriggerKeyDown}
        data-testid="user-menu-trigger"
      >
        <span className={styles.avatar} aria-hidden="true">
          <UserIcon size={15} />
        </span>
        <span className={styles.username}>{username}</span>
        <ChevronDownIcon size={14} className={styles.chevron} />
      </button>

      {open ? (
        <div className={styles.menu} role="menu" aria-label="User menu" onKeyDown={onMenuKeyDown}>
          {items.map((item, index) => (
            <React.Fragment key={item.key}>
              {item.sepBefore ? <div className={styles.menuSep} role="separator" /> : null}
              <button
                ref={(el) => {
                  itemRefs.current[index] = el;
                }}
                type="button"
                role="menuitem"
                tabIndex={index === activeIndex ? 0 : -1}
                className={`${styles.menuItem}${item.danger ? ` ${styles.menuItemDanger}` : ''}`}
                onClick={item.run}
              >
                <item.Icon size={15} className={styles.menuIcon} />
                {item.label}
              </button>
            </React.Fragment>
          ))}
        </div>
      ) : null}
    </div>
  );
};

export default UserMenu;
