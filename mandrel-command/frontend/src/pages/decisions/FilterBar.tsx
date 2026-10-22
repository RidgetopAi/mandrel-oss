/**
 * FilterBar — the mock's filter row: a search box, the decision_type facets with LIVE
 * counts (from api.decisions.stats by_type), and an outcome-filter select. Counts come only
 * from real stats — a type with no count shows without a number rather than a fabricated
 * one. Type + outcome filtering is applied client-side by the page (the MCP engine rejects
 * a decision_type param — verified).
 */
import React from 'react';
import { Input, Select, cx } from '../../components/ui';
import { SearchIcon, ClockIcon } from './icons';
import {
  TYPE_FACETS,
  OUTCOME_FILTER_OPTIONS,
  typeDotVar,
  type OutcomeFilterValue,
} from './config';
import type { DecisionStats } from '../../types/decision';
import styles from './Decisions.module.css';

export interface FilterBarProps {
  search: string;
  onSearchChange: (v: string) => void;
  type: string | null;
  onTypeChange: (v: string | null) => void;
  outcome: OutcomeFilterValue;
  onOutcomeChange: (v: OutcomeFilterValue) => void;
  stats?: DecisionStats;
}

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
  outcome,
  onOutcomeChange,
  stats,
}) => {
  const byType = stats?.by_type ?? {};
  const total = stats?.total_decisions;

  return (
    <div className={styles.filters}>
      <div className={styles.searchBox}>
        <SearchIcon size={15} className={styles.searchIco} />
        <Input
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder="Search the why…"
          aria-label="Search decisions"
          className={styles.searchInput}
        />
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
            dotVar={typeDotVar(f.value)}
            count={byType[f.value]}
            onClick={() => onTypeChange(f.value)}
          />
        ))}
      </div>

      <div className={styles.outcomeWrap}>
        <ClockIcon size={15} className={styles.outcomeIco} />
        <Select
          options={OUTCOME_FILTER_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
          value={outcome}
          onChange={(v) => onOutcomeChange(v as OutcomeFilterValue)}
          aria-label="Filter by outcome"
          className={styles.outcomeSelect}
        />
      </div>
    </div>
  );
};

export default FilterBar;
