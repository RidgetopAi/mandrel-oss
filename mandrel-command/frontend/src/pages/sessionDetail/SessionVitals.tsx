/**
 * SessionVitals — the row of vital-sign tiles for a session, all from REAL detail
 * fields: duration (derived from started_at→ended_at), activity score (the unbounded
 * work/effort measure — no /100 ceiling, higher is busier), contexts, tasks (with the
 * created/completed caption), decisions, tokens, and files (with the +/- churn
 * caption). Every value is the honest count/em-dash — a missing field renders "—",
 * never a fabricated 0-as-fact. Built on the StatTile primitive (P0.3).
 */
import React from 'react';
import { StatTile } from '../../components/ui';
import type { SessionDetailView } from './hooks';
import { formatCount, formatTokens, formatDuration, formatChurn, formatScore } from './parts';
import {
  ClockIcon,
  ActivityIcon,
  ContextsIcon,
  TasksIcon,
  DecisionsIcon,
  TokenIcon,
  FilesIcon,
} from './icons';
import styles from './SessionDetail.module.css';

export interface SessionVitalsProps {
  session: SessionDetailView;
}

export const SessionVitals: React.FC<SessionVitalsProps> = ({ session }) => {
  // Derived counts only — see the `??` note in pages/sessions/StreamCard.tsx. The old
  // `session.contexts_created ?? session.context_count` preferred the denormalized
  // counter, which reads 0 on every session finalized before an earlier task, and
  // `decisions_created` below was a GUARANTEED 0 (that column has no runtime writer
  // anywhere in the tree). Both are now served derived from the child tables.
  const contexts = session.context_count;
  const tasksCreated = session.task_count;
  const tasksCompleted = session.tasks_completed;
  const decisions = session.decision_count;
  const tasksCaption =
    tasksCreated != null || tasksCompleted != null
      ? `${tasksCompleted ?? 0} completed`
      : undefined;
  const hasLines = session.lines_added != null || session.lines_deleted != null;

  return (
    <div className={styles.vitals}>
      <StatTile
        label="Duration"
        value={formatDuration(
          session.started_at ?? session.created_at,
          session.ended_at ?? session.last_activity_at ?? session.last_context_at,
        )}
        icon={<ClockIcon size={15} />}
      />
      <StatTile
        label="Activity"
        value={formatScore(session.productivity_score)}
        icon={<ActivityIcon size={15} />}
      />
      <StatTile
        label="Contexts"
        value={formatCount(contexts)}
        icon={<ContextsIcon size={15} />}
      />
      <StatTile
        label="Tasks"
        value={formatCount(tasksCreated)}
        caption={tasksCaption}
        icon={<TasksIcon size={15} />}
      />
      <StatTile
        label="Decisions"
        value={formatCount(decisions)}
        icon={<DecisionsIcon size={15} />}
      />
      <StatTile
        label="Tokens"
        value={formatTokens(session.total_tokens)}
        icon={<TokenIcon size={15} />}
      />
      <StatTile
        label="Files"
        value={formatCount(session.files_modified_count)}
        caption={hasLines ? formatChurn(session.lines_added, session.lines_deleted) : undefined}
        icon={<FilesIcon size={15} />}
      />
    </div>
  );
};

export default SessionVitals;
