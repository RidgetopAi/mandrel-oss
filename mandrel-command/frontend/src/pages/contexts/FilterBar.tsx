/**
 * FilterBar — the mock's filter row: a semantic search box, the type facets with LIVE
 * counts (from api.contexts.stats by_type), and a sort control. The "semantic" affordance
 * on the search box is preserved (a non-empty query dispatches to the semantic engine).
 * Counts come only from real stats — a type with no count shows without a number rather
 * than a fabricated one.
 */
import React from 'react';
import { Input, Select, cx } from '../../components/ui';
import { SearchIcon, SortIcon } from './icons';
import { TYPE_FACETS, SORT_OPTIONS, kindDotVar, type SortValue } from './config';
import type { ContextStats } from '../../types/context';
import styles from './Contexts.module.css';

export interface FilterBarProps {
  search: string;
  onSearchChange: (v: string) => void;
  type: string | null;
  onTypeChange: (v: string | null) => void;
  sort: SortValue;
  onSortChange: (v: SortValue) => void;
  stats?: ContextStats;
}

/** A single type facet chip — a coloured dot, the label, and its live count (if known). */
const Facet: React.FC<{
  active: boolean;
  label: string;
  dotVar?: string;
  count?: number;
  onClick: () => void;
}> = ({ active, label, dotVar, count, onClick }) => (
  <button
    type="button"
    className={cx(styles.facet, active && styles.facetOn)}
    aria-pressed={active}
    onClick={onClick}
  >
    {dotVar && (
      <span className={styles.facetDot} style={{ background: `var(${dotVar})` }} aria-hidden="true" />
    )}
    {label}
    {count != null && <span className={styles.facetCount}>{count}</span>}
  </button>
);

export const FilterBar: React.FC<FilterBarProps> = ({
  search,
  onSearchChange,
  type,
  onTypeChange,
  sort,
  onSortChange,
  stats,
}) => {
  const byType = stats?.by_type ?? {};
  const total = stats?.total_contexts;

  return (
    <div className={styles.filters}>
      <div className={styles.searchBox}>
        <SearchIcon size={15} className={styles.searchIco} />
        <Input
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder="Search memory…"
          aria-label="Search contexts"
          className={styles.searchInput}
        />
        <span className={styles.semantic}>semantic</span>
      </div>

      <div className={styles.facets} role="group" aria-label="Filter by type">
        <Facet
          active={type == null}
          label="All"
          count={total}
          onClick={() => onTypeChange(null)}
        />
        {TYPE_FACETS.map((f) => (
          <Facet
            key={f.value}
            active={type === f.value}
            label={f.label}
            dotVar={kindDotVar(f.value)}
            count={byType[f.value]}
            onClick={() => onTypeChange(f.value)}
          />
        ))}
      </div>

      <div className={styles.sortWrap}>
        <SortIcon size={15} className={styles.sortIco} />
        <Select
          options={SORT_OPTIONS.map((s) => ({ value: s.value, label: s.label }))}
          value={sort}
          onChange={(v) => onSortChange(v as SortValue)}
          aria-label="Sort contexts"
          className={styles.sortSelect}
        />
      </div>
    </div>
  );
};

export default FilterBar;
