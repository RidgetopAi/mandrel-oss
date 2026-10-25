/**
 * Toolbar — the Tasks filter row: a client-side search box over the loaded tasks.
 *
 * No project selector here. The page-scope epic put one on every page; an earlier punch (the operator,
 * an earlier decision) moved it back to the ONE switch in the topbar (shell/ProjectSwitch),
 * which the page reads through `usePageProject`.
 *
 * Reused as-is by the Punch board for search PARITY — `placeholder` /
 * `ariaLabel` are overridable so the copy reads "punches" there, everything else (the
 * box, the icon, the styling) is the ONE implementation.
 */
import React from 'react';
import { Input, cx } from '../../components/ui';
import { SearchIcon } from './icons';
import styles from './Tasks.module.css';

export interface ToolbarProps {
  search: string;
  onSearchChange: (v: string) => void;
  placeholder?: string;
  ariaLabel?: string;
}

export const Toolbar: React.FC<ToolbarProps> = ({
  search,
  onSearchChange,
  placeholder = 'Search tasks…',
  ariaLabel = 'Search tasks',
}) => {
  return (
    <div className={styles.toolbar}>
      <div className={cx(styles.searchBox)}>
        <SearchIcon size={15} className={styles.searchIco} />
        <Input
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder={placeholder}
          aria-label={ariaLabel}
          className={styles.searchInput}
        />
      </div>
    </div>
  );
};

export default Toolbar;
