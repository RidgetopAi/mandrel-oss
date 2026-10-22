/**
 * ClauseRows — the structured `doneWhen` editor (an earlier decision /
 * 1e53165a): one row per clause, each with text / owner (lane|human, no default) / proof
 * (shown only when owner is lane, since only a lane owes the gate a producible artifact).
 * Inline errors only appear once a row is STARTED (`clauseStarted`) — a fresh blank row
 * does not scream "required" before the user has typed anything into it.
 */
import React from 'react';
import { Field, Input, Button } from '../../components/ui';
import { Segmented, type SegmentedOption } from './Segmented';
import { PUNCH_COPY } from './config';
import {
  clauseComplete,
  clauseErrors,
  clauseStarted,
  emptyClause,
  type ClauseDraft,
} from './doneWhenClauses';
import type { PunchClauseOwner } from '../../types/task';
import styles from './Punch.module.css';

const OWNER_OPTIONS: ReadonlyArray<SegmentedOption<PunchClauseOwner>> = [
  { value: 'lane', label: 'Lane' },
  { value: 'human', label: 'Human' },
] as const;

export interface ClauseRowsProps {
  clauses: ClauseDraft[];
  onChange: (clauses: ClauseDraft[]) => void;
  disabled?: boolean;
}

export const ClauseRows: React.FC<ClauseRowsProps> = ({ clauses, onChange, disabled = false }) => {
  const patch = (i: number, next: Partial<ClauseDraft>) =>
    onChange(clauses.map((c, j) => (j === i ? { ...c, ...next } : c)));
  const addRow = () => onChange([...clauses, emptyClause()]);
  const removeRow = (i: number) => onChange(clauses.filter((_, j) => j !== i));

  return (
    <div className={styles.clauses} role="group" aria-label={PUNCH_COPY.doneWhenLabel}>
      {clauses.map((c, i) => {
        const n = i + 1;
        const errors = clauseStarted(c) ? clauseErrors(c) : {};
        return (
          <div key={i} className={styles.clauseRow} data-clause-complete={clauseComplete(c)}>
            <Field label={`Done when ${n}`} hideLabel required error={errors.text}>
              <Input
                value={c.text}
                onChange={(e) => patch(i, { text: e.target.value })}
                placeholder={PUNCH_COPY.doneWhenPlaceholder}
                aria-label={`Done when ${n}`}
                disabled={disabled}
              />
            </Field>
            <Field label={`Owner ${n}`} hideLabel required error={errors.owner}>
              <Segmented
                aria-label={`Owner ${n}`}
                options={OWNER_OPTIONS}
                value={c.owner || undefined}
                onChange={(owner) => patch(i, { owner, proof: owner === 'lane' ? c.proof : '' })}
                invalid={Boolean(errors.owner)}
              />
            </Field>
            {c.owner === 'lane' && (
              <Field label={`Proof ${n}`} hideLabel required error={errors.proof}>
                <Input
                  value={c.proof}
                  onChange={(e) => patch(i, { proof: e.target.value })}
                  placeholder="repo path or test id that proves this"
                  aria-label={`Proof ${n}`}
                  disabled={disabled}
                />
              </Field>
            )}
            <Button
              type="button"
              variant="subtle"
              size="sm"
              onClick={() => removeRow(i)}
              disabled={disabled || clauses.length <= 1}
              aria-label={`Remove done-when ${n}`}
            >
              Remove
            </Button>
          </div>
        );
      })}
      <Button type="button" variant="subtle" onClick={addRow} disabled={disabled}>
        {PUNCH_COPY.doneWhenAddLabel}
      </Button>
    </div>
  );
};

export default ClauseRows;
