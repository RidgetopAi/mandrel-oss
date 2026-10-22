/**
 * SectionNav — the left section rail (the mock's `.set-nav`). A real keyboard-navigable
 * tablist: each entry is a button; the active one is marked. The Danger zone entry is
 * separated by a divider and rendered in the rose tint, matching the mock.
 */
import React from 'react';
import { cx } from '../../components/ui';
import { SectionIcon } from './icons';
import { SETTINGS_SECTIONS } from './config';
import styles from './Settings.module.css';

export interface SectionNavProps {
  activeId: string;
  onSelect: (id: string) => void;
}

export const SectionNav: React.FC<SectionNavProps> = ({ activeId, onSelect }) => (
  <nav className={styles.rail} aria-label="Settings sections">
    {SETTINGS_SECTIONS.map((s, i) => {
      const prev = SETTINGS_SECTIONS[i - 1];
      const divider = s.danger && prev && !prev.danger;
      return (
        <React.Fragment key={s.id}>
          {divider && <div className={styles.railDivider} aria-hidden="true" />}
          <button
            type="button"
            className={cx(
              styles.railItem,
              s.danger && styles.railItemDanger,
              activeId === s.id && styles.railItemOn,
            )}
            aria-current={activeId === s.id ? 'page' : undefined}
            onClick={() => onSelect(s.id)}
          >
            <SectionIcon name={s.icon} className={styles.railIcon} />
            {s.label}
          </button>
        </React.Fragment>
      );
    })}
  </nav>
);
