/**
 * IdJumpResult — the SERVER-SIDE search-by-id surface.
 *
 * When the Tasks search box holds an id-shaped query, `useResolveTaskSearch` resolves it
 * against the whole database (the same resolver `/r/<id8>` uses). This renders that
 * outcome as a single clear affordance ABOVE the (client-filtered) board/list, so a task
 * that is outside the current project scope or past the page cap can still be reached —
 * the "paste an id → jump to any task" workflow.
 *
 * It NEVER auto-navigates (that would be jarring mid-type); it surfaces one explicit,
 * clickable jump. Every outcome maps to an honest state — a match that isn't a task, an
 * ambiguous prefix, and a not-found id are all shown plainly (never a crash, never a
 * misleading unrelated row). Clicking a resolved record navigates client-side to its
 * typed detail page (`record.url`, e.g. `/tasks/<id>` or `/punch/<id>` — the backend
 * resolver alone decides which, via `idResolver.ts urlForRecord`'s `isPunchSql` bit) —
 * unless the caller overrides the target via `urlFor`, a generic escape hatch with this
 * safe default.
 *
 * Reused as-is by the Punch board with NO `urlFor` override:
 * a punch resolves to `/punch/<id>` and an ordinary task to `/tasks/<id>` from
 * the SAME `record.url` every other surface uses, so the Punch board never disagrees with
 * `/r/` links or tool responses about where a resolved task opens.
 */
import React from 'react';
import { useNavigate } from 'react-router-dom';
import { Text, Spinner, cx } from '../../components/ui';
import type { ResolvedNavRecord, ResolveResult } from '../../api/resolveClient';
import styles from './Tasks.module.css';

export interface IdJumpResultProps {
  /** The query is id-shaped (a server resolve was attempted). When false, render nothing. */
  active: boolean;
  /** The resolve request is in flight. */
  loading: boolean;
  /** The resolved outcome (unique / ambiguous / invalid / notfound), once settled. */
  result?: ResolveResult;
  /** Override the jump target for a `unique` result. Defaults to the resolver's own `record.url`. */
  urlFor?: (record: ResolvedNavRecord) => string;
}

/** Human label for the record type on the jump button. */
const TYPE_NOUN: Record<string, string> = {
  task: 'task',
  decision: 'decision',
  context: 'context',
};

export const IdJumpResult: React.FC<IdJumpResultProps> = ({ active, loading, result, urlFor }) => {
  const navigate = useNavigate();

  if (!active) return null;

  if (loading) {
    return (
      <div className={cx(styles.idjump, styles.idjumpMuted)} role="status">
        <Spinner size="sm" />
        <Text variant="data" tone="faint">
          Looking up id…
        </Text>
      </div>
    );
  }

  if (!result) return null;

  if (result.status === 'unique') {
    const { record } = result;
    const noun = TYPE_NOUN[record.type] ?? record.type;
    const verb = record.type === 'task' ? 'Jump to task' : `Open ${noun}`;
    const url = urlFor ? urlFor(record) : record.url;
    return (
      <button
        type="button"
        className={cx(styles.idjump, styles.idjumpHit)}
        onClick={() => navigate(url)}
      >
        <Text variant="label" tone="teal">
          {verb}
        </Text>
        <Text variant="data" tone="default" className={styles.idjumpTitle}>
          {record.title || record.id}
        </Text>
      </button>
    );
  }

  if (result.status === 'ambiguous') {
    return (
      <div className={cx(styles.idjump, styles.idjumpMuted)} role="status">
        <Text variant="data" tone="faint">
          {`This id matches ${result.candidates.length} records — paste the full id to jump to the one you mean.`}
        </Text>
      </div>
    );
  }

  // invalid | notfound → one clean not-found line (never a misleading unrelated result).
  return (
    <div className={cx(styles.idjump, styles.idjumpMuted)} role="status">
      <Text variant="data" tone="faint">
        No task or record matches this id.
      </Text>
    </div>
  );
};

export default IdJumpResult;
