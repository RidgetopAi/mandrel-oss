/**
 * DecisionList — the mock's left column: a scrollable list of decision cards (type badge,
 * impact dot, outcome chip, title). Selecting an item drives the reader. Owns its own
 * loading / empty / error state (Spinner / Empty / Alert), like the Contexts page.
 */
import React from 'react';
import { Badge, Spinner, Empty, Alert, cx } from '../../components/ui';
import {
  typeLabel,
  typeTone,
  impactLabel,
  impactDotVar,
  outcomeLabel,
  outcomeDotVar,
} from './config';
import type { Decision } from '../../types/decision';
import styles from './Decisions.module.css';
import { apiErrorMessage } from '../../api/request';

export interface DecisionListProps {
  decisions: Decision[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  isLoading: boolean;
  isError: boolean;
  /**
   * True when the page has NO project to scope to and is not merely still loading one
   * (page-scope epic). The reads are gated off in that state, so without this branch the
   * rail would render "No decisions" and imply an empty ledger rather than an absent
   * project.
   */
  noProject?: boolean;
  error: unknown;
}

const DecisionRow: React.FC<{ dec: Decision; active: boolean; onSelect: (id: string) => void }> = ({
  dec,
  active,
  onSelect,
}) => (
  <button
    type="button"
    className={cx(styles.item, active && styles.itemOn)}
    aria-current={active}
    onClick={() => onSelect(dec.id)}
  >
    <span className={styles.itemR1}>
      <Badge variant={typeTone(dec.decision_type)}>{typeLabel(dec.decision_type)}</Badge>
      {dec.impact_level && (
        <span className={styles.impact}>
          <span
            className={styles.impactDot}
            style={{ background: `var(${impactDotVar(dec.impact_level)})` }}
            aria-hidden="true"
          />
          {impactLabel(dec.impact_level)}
        </span>
      )}
      {dec.outcomeStatus && (
        <span className={styles.outcomeChip}>
          <span
            className={styles.outcomeDot}
            style={{ background: `var(${outcomeDotVar(dec.outcomeStatus)})` }}
            aria-hidden="true"
          />
          {outcomeLabel(dec.outcomeStatus)}
        </span>
      )}
    </span>
    <span className={styles.itemTitle}>{dec.title}</span>
  </button>
);

export const DecisionList: React.FC<DecisionListProps> = ({
  decisions,
  selectedId,
  onSelect,
  isLoading,
  isError,
  noProject = false,
  error,
}) => {
  // Guide, don't error — checked FIRST so it wins over the idle states below.
  if (noProject) {
    return (
      <div className={styles.listState}>
        <Empty
          title="No project selected"
          description="The ledger is scoped to a project. Create a project, or pick one from the selector above, to read its decisions."
        />
      </div>
    );
  }
  if (isLoading) {
    return (
      <div className={styles.listState}>
        <Spinner size="md" />
      </div>
    );
  }
  if (isError) {
    return (
      <div className={styles.listState}>
        <Alert variant="error" title="Couldn't load decisions">
          {apiErrorMessage(error, 'Failed to load decisions.')}
        </Alert>
      </div>
    );
  }
  if (decisions.length === 0) {
    return (
      <div className={styles.listState}>
        <Empty title="No decisions" description="No decisions match the current filters." />
      </div>
    );
  }

  return (
    <div className={styles.list} role="listbox" aria-label="Decisions">
      {decisions.map((dec) => (
        <DecisionRow
          key={dec.id}
          dec={dec}
          active={dec.id === selectedId}
          onSelect={onSelect}
        />
      ))}
    </div>
  );
};

export default DecisionList;
