/**
 * Toolbar — the mock's filter row: the All/Active/Dormant segment (with LIVE counts
 * derived from the real project list), a search box (client-side over name + description),
 * and a sort select. Every count is real — derived from the loaded records, never
 * fabricated.
 */
import React from 'react';
import { Input, Select, cx } from '../../components/ui';
import { SearchIcon, SortIcon } from './icons';
import { SEGMENTS, SORT_OPTIONS, type SegmentValue, type SortValue } from './config';
import styles from './Projects.module.css';

export interface ToolbarProps {
  segment: SegmentValue;
  onSegmentChange: (v: SegmentValue) => void;
  counts: Record<SegmentValue, number>;
  search: string;
  onSearchChange: (v: string) => void;
  sort: SortValue;
  onSortChange: (v: SortValue) => void;
}

export const Toolbar: React.FC<ToolbarProps> = ({
  segment,
  onSegmentChange,
  counts,
  search,
  onSearchChange,
  sort,
  onSortChange,
}) => (
  <div className={styles.toolbar}>
    <div className={styles.segment} role="group" aria-label="Filter by activity">
      {SEGMENTS.map((s) => (
        <button
          key={s.value}
          type="button"
          className={cx(styles.seg, segment === s.value && styles.segOn)}
          aria-pressed={segment === s.value}
          onClick={() => onSegmentChange(s.value)}
        >
          {s.label}
          <span className={styles.segCount}>{counts[s.value]}</span>
        </button>
      ))}
    </div>

    <div className={styles.searchBox}>
      <SearchIcon size={15} className={styles.searchIco} />
      <Input
        value={search}
        onChange={(e) => onSearchChange(e.target.value)}
        placeholder="Search projects"
        aria-label="Search projects"
        className={styles.searchInput}
      />
    </div>

    <span className={styles.tbSpring} />

    <div className={styles.sortWrap}>
      <SortIcon size={15} className={styles.sortIco} />
      <Select
        options={SORT_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
        value={sort}
        onChange={(v) => onSortChange(v as SortValue)}
        aria-label="Sort projects"
        className={styles.sortSelect}
      />
    </div>
  </div>
);

export default Toolbar;
