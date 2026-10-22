/**
 * Sessions by actor — the mock's "by actor" activity breakdown, wired to the real
 * serialised `actor` via `api.sessions.list`, rolled up client-side
 * (src/pages/dashboard/hooks.ts → aggregateByActor). Each row is one actor: session
 * count + summed contexts / tasks / tokens, the projects they touched, and when they
 * were last active. A null actor renders as the neutral "unattributed" group.
 *
 * OMITTED vs the mock (no backend source — surfaced, never faked): the per-hour
 * activity strip and the per-actor decision count (the list read model serialises
 * neither); and the "last 24 hours" windowing (the list endpoint has no `since`).
 */
import React from 'react';
import { useNavigate } from 'react-router-dom';
import { Card, Spinner, Empty, Alert, Text, StatusPill } from '../../components/ui';
import { SectionHead, formatCount, formatTokens, formatRelative, type ActorActivity } from './parts';
import { ClockIcon } from './icons';
import { actorDotVar, actorLabel, UNATTRIBUTED_ACTOR } from './config';
import { useSessionsByActor } from './hooks';
import type { DashboardCardProps } from './parts';
import styles from './Dashboard.module.css';
import { apiErrorMessage } from '../../api/request';

function Metric({ value, label, teal }: { value: React.ReactNode; label: string; teal?: boolean }) {
  return (
    <span className={styles.actorMetric}>
      <span className={teal ? styles.actorMetricVTeal : styles.actorMetricV}>{value}</span>
      <span className={styles.actorMetricK}>{label}</span>
    </span>
  );
}

/**
 * One actor's row. It NAVIGATES to that actor's most recent session —
 * the same session `lastSeen` is measured from, so the timestamp on the row and its link
 * target always describe the same thing.
 *
 * It is a real `<button>`, not a div with an onClick: that is what makes it tab-reachable,
 * Enter/Space-activatable and announced as a control, for free. Same shape RecentProjects
 * already uses. When the group has no resolvable session id the row degrades to a plain
 * `<div>` — inert, still readable, never a control that does nothing.
 */
function ActorRow({ a }: { a: ActorActivity }) {
  const navigate = useNavigate();
  const sessionId = a.lastSessionId;
  const interactive = Boolean(sessionId);

  const body = (
    <>
      <div className={styles.actorWho}>
        <span
          className={styles.actorDot}
          style={{ background: `var(${actorDotVar(a.actor)})` }}
          aria-hidden="true"
        />
        <Text variant="body" style={{ fontWeight: 600 }}>
          {actorLabel(a.actor)}
        </Text>
        <StatusPill tone={a.live ? 'active' : 'ended'}>{a.live ? 'live' : 'ended'}</StatusPill>
      </div>
      <div className={styles.actorMetrics}>
        <Metric teal value={formatCount(a.contexts)} label="contexts" />
        <Metric value={formatCount(a.tasks)} label="tasks" />
        <Metric value={formatTokens(a.tokens)} label="tokens" />
        <Metric value={formatCount(a.sessions)} label={a.sessions === 1 ? 'session' : 'sessions'} />
      </div>
      {a.projects.length > 0 && (
        <div className={styles.actorProjects}>
          {a.projects.map((p) => (
            <span key={p} className={styles.actorProjChip}>
              {p}
            </span>
          ))}
        </div>
      )}
      <span className={styles.actorSeen}>{formatRelative(a.lastSeen)}</span>
    </>
  );

  if (!interactive) {
    return <div className={styles.actorRow}>{body}</div>;
  }

  return (
    <button
      type="button"
      className={`${styles.actorRow} ${styles.actorRowLink}`}
      onClick={() => navigate(`/sessions/${sessionId}`)}
      aria-label={`Open the most recent session for ${actorLabel(a.actor)}`}
    >
      {body}
    </button>
  );
}

export const SessionsByActor: React.FC<DashboardCardProps> = ({ projectId, scope }) => {
  const { data, isPending, isError, error } = useSessionsByActor(projectId, scope);
  // `isPending`, not `isLoading`: a react-query v5 query that is DISABLED (this page has
  // no project yet) reports isLoading=false with no data, which every card below would
  // render as its EMPTY state — "No projects yet" on a workspace that has plenty. Pending
  // is the state that says "no answer yet", and it covers both disabled and in-flight.

  const actors = data ?? [];

  return (
    <section aria-label="Sessions by actor">
      <SectionHead icon={<ClockIcon size={15} />}>Sessions by actor</SectionHead>
      <Card flush className={styles.panelFlush}>
        {isPending ? (
          <div className={styles.stateWrap}>
            <Spinner size="md" />
          </div>
        ) : isError ? (
          <div className={styles.stateWrap}>
            <Alert variant="error" title="Couldn't load activity by actor">
              {apiErrorMessage(error, 'Failed to load sessions by actor.')}
            </Alert>
          </div>
        ) : actors.length === 0 ? (
          <div className={styles.stateWrap}>
            <Empty
              title="No actor activity yet"
              description="Activity grouped by actor will show here as sessions run."
            />
          </div>
        ) : (
          <div className={styles.actorRows}>
            {actors.map((a) => (
              <ActorRow key={a.actor ?? UNATTRIBUTED_ACTOR} a={a} />
            ))}
          </div>
        )}
      </Card>
    </section>
  );
};

export default SessionsByActor;
