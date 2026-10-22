/**
 * Sessions — the Command "live streams" screen, rebuilt to the LOCKED mock
 * (docs/command-sessions-mock.html) on the P0 foundation: P0.3 primitives + P0.2
 * tokens, ZERO antd, all data through the unified `api` client via react-query
 * (src/pages/sessions/hooks.ts). Mirrors the Dashboard screen-rebuild pattern:
 * thin composition here, a `sessions/` module owning the parts, config, data, and
 * a token-driven stylesheet — each section owning its loading/empty/error state.
 *
 * The mock keys "streams" by (actor × project). The read model now serialises
 * `actor`, so the per-card actor chip + an actor filter are built;
 * the actor filter slices server-side (`api.sessions.list({ actor })`). This build
 * still groups the cards by session lifecycle (Live now / Dormant / Earlier), not by
 * (actor × project) — the full stream-keying is a follow-up (see the returned note).
 *
 * The three groups ARE the three derived statuses, one group per pill value — see
 * `groupByStatus` in sessions/parts.tsx for why that is not two groups.
 */
import React from 'react';
import { Heading, Text, Spinner, Empty, Alert, Button } from '../components/ui';
import { SessionsToolbar } from './sessions/SessionsToolbar';
import { StreamCard } from './sessions/StreamCard';
import { SessionEditDrawer } from './sessions/SessionEditDrawer';
import { NewSessionModal } from './sessions/NewSessionModal';
import {
  SectionHead,
  deriveStatus,
  distinctActors,
  groupByStatus,
  liveWindowLabel,
  type StatusedRow,
} from './sessions/parts';
import { PulseIcon, PlusIcon } from './sessions/icons';
import { useSessions, type SessionListRow } from './sessions/hooks';
import { matchesSearch } from './sessions/search';
import { usePageProject } from '../hooks/usePageProject';
import type { StatusFilterValue } from './sessions/config';
import styles from './sessions/Sessions.module.css';
import { apiErrorMessage } from '../api/request';

const Sessions: React.FC = () => {
  const [status, setStatus] = React.useState<StatusFilterValue>('all');
  const [actor, setActor] = React.useState('all');
  const [search, setSearch] = React.useState('');
  const [editing, setEditing] = React.useState<SessionListRow | null>(null);
  const [startingOpen, setStartingOpen] = React.useState(false);

  // Scoped by the ONE switch in the topbar: one project at a time, opening
  // on the user's default. No "All projects" here (walkthrough ed6ae449 F2).
  const project = usePageProject();

  const listArgs = {
    projectId: project.projectId,
    scope: project.scope,
    // `scope()` throws rather than falling back to the ambient project, so no query may
    // run until the page HAS a project. `ready` is the non-throwing form of that question.
    enabled: project.ready,
  };

  // Displayed list — sliced SERVER-SIDE by project, and by actor when a specific actor is
  // chosen (the `?actor=` param); the full list for that project when actor is 'all'.
  const { data, isLoading, isError, error } = useSessions({
    ...listArgs,
    actor: actor === 'all' ? undefined : actor,
  });
  // The actor-unsliced list feeds the actor dropdown's full option set, so every actor in
  // the CURRENT PROJECT stays selectable regardless of the active actor filter. When actor
  // is 'all' this shares the same query (deduped); otherwise it is a cheap second read.
  const { data: allRows } = useSessions(listArgs);

  const rows = React.useMemo(() => data ?? [], [data]);
  const actorOptions = React.useMemo(() => distinctActors(allRows ?? []), [allRows]);

  // Grouped by the row's DERIVED status — the same value its pill shows.
  // The old code bucketed on "is it ended?" while the pills answered "was it recently
  // active?", so a group headed LIVE NOW could hold four cards each pilled `dormant`.
  // `groupByStatus` makes that unrepresentable: the group IS the status.
  const { live, dormant, ended } = React.useMemo(() => {
    const visible: StatusedRow[] = [];
    for (const row of rows) {
      // NO client-side project filter. The rows arriving here are already the selected
      // project's — filtering a `limit`-capped page client-side silently hid a project
      // whose sessions were not among the newest N overall. Status and search below are
      // display refinements over the loaded page, which is a different thing from scope.
      if (!matchesSearch(row, search)) continue;
      const st = deriveStatus(row);
      // Compare against the derived status directly — 'live' now means LIVE, not
      // "not ended", so the filter and the grouping below cannot disagree.
      if (status !== 'all' && st !== status) continue;
      visible.push({ row, status: st });
    }
    return groupByStatus(visible);
  }, [rows, search, status]);

  const total = live.length + dormant.length + ended.length;
  // Both hints name the SAME window the pill is decided by, read from SESSIONS_CONFIG —
  // never a hardcoded "30m" that can drift away from the rule.
  const windowLabel = liveWindowLabel();

  return (
    <div className={styles.page}>
      <header className={styles.head}>
        <div className={styles.headRow}>
          <Heading level={2} variant="display">
            Sessions
          </Heading>
          <Text variant="data" tone="faintest">
            {rows.length} sessions · {project.projectName ?? '…'}
          </Text>
          <div className={styles.headActions}>
            <Button size="sm" onClick={() => setStartingOpen(true)}>
              <PlusIcon size={15} /> New session
            </Button>
          </div>
        </div>
        <Text variant="body" tone="faint">
          Work streams in the selected project — expand a session to see its activity.
        </Text>
      </header>

      <SessionsToolbar
        status={status}
        onStatusChange={setStatus}
        actors={actorOptions}
        actor={actor}
        onActorChange={setActor}
        search={search}
        onSearchChange={setSearch}
      />

      {project.unavailable ? (
        // Ahead of the query states on purpose: with no resolvable project the list
        // query never runs, so `isLoading`/`isError` are both false and the branch that
        // would otherwise win is "No sessions" — an empty result presented as a measured
        // one. Say which of the two it is.
        <div className={styles.pageState}>
          <Alert variant="error" title="Can't reach the server">
            The project list couldn&apos;t be loaded, so this page has no project scope.
            Sessions aren&apos;t being shown — this is not an empty project. Reload once the
            connection is back.
          </Alert>
        </div>
      ) : isLoading ? (
        <div className={styles.pageState}>
          <Spinner size="lg" />
        </div>
      ) : isError ? (
        <div className={styles.pageState}>
          <Alert variant="error" title="Couldn't load sessions">
            {apiErrorMessage(error, 'Failed to load sessions.')}
          </Alert>
        </div>
      ) : total === 0 ? (
        <div className={styles.pageState}>
          <Empty title="No sessions" description="No sessions match the current filters." />
        </div>
      ) : (
        <>
          {live.length > 0 && (
            <section aria-label="Live now">
              <SectionHead
                live
                count={live.length}
                hint={`recorded activity in the last ${windowLabel}`}
              >
                Live now
              </SectionHead>
              <div className={styles.streams}>
                {live.map(({ row, status: st }) => (
                  <StreamCard key={row.id} row={row} status={st} onEdit={setEditing} />
                ))}
              </div>
            </section>
          )}

          {dormant.length > 0 && (
            <section aria-label="Dormant">
              <SectionHead
                count={dormant.length}
                hint={`no recorded activity for ${windowLabel}+ — still open, may still be working`}
              >
                Dormant
              </SectionHead>
              <div className={styles.streams}>
                {dormant.map(({ row, status: st }) => (
                  <StreamCard key={row.id} row={row} status={st} onEdit={setEditing} />
                ))}
              </div>
            </section>
          )}

          {ended.length > 0 && (
            <section aria-label="Earlier">
              <SectionHead
                icon={<PulseIcon size={15} />}
                count={ended.length}
                hint="ended sessions"
              >
                Earlier
              </SectionHead>
              <div className={styles.streams}>
                {ended.map(({ row, status: st }) => (
                  <StreamCard key={row.id} row={row} status={st} onEdit={setEditing} />
                ))}
              </div>
            </section>
          )}
        </>
      )}

      <SessionEditDrawer session={editing} open={editing != null} onClose={() => setEditing(null)} />
      <NewSessionModal
        open={startingOpen}
        onClose={() => setStartingOpen(false)}
        defaultProjectId={project.projectId}
        pageScope={project.scope}
      />
    </div>
  );
};

export default Sessions;
