/**
 * ProductiveSessions — the ranked "Most active sessions" list with mini bars, from
 * `/api/sessions/productive`. Owns its loading / empty / error state.
 *
 * ── WHAT THE "WHO" COLUMN SHOWS, AND WHY IT CHANGED (item 3b) ──────────
 * It rendered `project_name`. This page is PROJECT-SCOPED, so that column printed the
 * same string on every row — a constant occupying the slot a dimension should. The reason
 * given for it (a comment here claiming actor-on-read was not wired) had gone stale: the
 * column exists and is populated — measured on prod 2026-08-10, 138 of the 142 most recent
 * sessions carry an `actor`. It is now selected and rendered, with the project kept as a
 * secondary chip because on an "all projects" view it IS informative.
 *
 * The dot's colour is the USER-vs-AUTOMATION group (`tintVarForKind`), the one meaning
 * colour carries anywhere on this page. It used to be a hardcoded `var(--teal)` on every
 * row, which is the same defect as the who-column one layer down: a channel spending
 * itself on a constant.
 *
 * ── THE NUMBER IS A CONTEXT COUNT, AND NOW SAYS SO (item 3c) ──────────────────────────
 * The `productivity_score` this panel used to rank and print is DELETED — see
 * `ProductiveSession` in backend/services/sessionAnalytics.ts for the measurement (98.97%
 * of the top row's score was its context count) and for why re-weighting was rejected.
 */
import React from 'react';
import { Skeleton, Empty, Alert } from '../../components/ui';
import { Panel, Provenance, formatInt } from './parts';
import { StarIcon } from './icons';
import { tintVarForKind } from './config';
import type { ProductiveSession } from '../../api/domains/sessions';
import styles from './Analytics.module.css';
import { apiErrorMessage } from '../../api/request';

export interface ProductiveSessionsProps {
  sessions: ProductiveSession[] | undefined;
  /** The active window, so the panel can say which one it is describing. */
  days: number;
  isLoading: boolean;
  isError: boolean;
  error: unknown;
}

const id8 = (id: string): string => (id ? id.replace(/-/g, '').slice(0, 7) : '');

/**
 * A session with no actor is shown as `unattributed` rather than blank or omitted — the
 * same word the by-actor panel's coverage line uses for the same population, so the two
 * panels name the gap identically instead of each inventing a term.
 */
const UNATTRIBUTED = 'unattributed';

export const ProductiveSessions: React.FC<ProductiveSessionsProps> = ({
  sessions,
  days,
  isLoading,
  isError,
  error,
}) => {
  const rows = sessions ?? [];
  const top = rows.reduce((m, s) => Math.max(m, s.context_count), 0) || 1;

  return (
    <Panel
      icon={<StarIcon size={15} />}
      title="Most active sessions"
      subtitle={`By contexts created, last ${days} days`}
      provenance={<Provenance>/api/sessions/productive?days={days}</Provenance>}
    >
      {isLoading ? (
        <Skeleton width="100%" height={96} />
      ) : isError ? (
        <Alert variant="error" title="Couldn't load session activity">
          {apiErrorMessage(error, 'Failed to load session activity.')}
        </Alert>
      ) : rows.length === 0 ? (
        <Empty title="No sessions" description="No sessions produced contexts in this window." />
      ) : (
        <div className={styles.ranks}>
          {rows.map((s, i) => (
            <div key={s.id} className={styles.rank}>
              <span className={styles.rankNo}>{i + 1}</span>
              <span
                className={styles.rankDot}
                style={{ background: `var(${tintVarForKind(s.actor_kind)})` }}
                aria-hidden="true"
              />
              <span className={styles.rankWho}>{s.actor ?? UNATTRIBUTED}</span>
              {s.project_name && <span className={styles.rankProj}>{s.project_name}</span>}
              <span className={styles.rankSid}>{id8(s.id)}</span>
              <span className={styles.rankScore}>
                <span className={styles.rankMini}>
                  <i style={{ width: `${Math.min(100, (s.context_count / top) * 100)}%` }} />
                </span>
                <span className={styles.rankSc}>{formatInt(s.context_count)}</span>
              </span>
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
};

export default ProductiveSessions;
