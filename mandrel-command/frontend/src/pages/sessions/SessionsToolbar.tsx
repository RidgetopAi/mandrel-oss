/**
 * SessionsToolbar — the mock's pivot/filter bar, built from P0.3 Select + Input.
 * Actor + project + status + free-text filters.
 *
 * WHAT RUNS WHERE (this changed with an earlier epic): the PROJECT filter and the ACTOR
 * filter are SERVER-SIDE — each re-fetches `api.sessions.list` with a narrower request.
 * Status and free-text search stay client-side over the loaded page; they are display
 * refinements, not scope.
 *
 * The PROJECT control is NOT here any more: the page is scoped by the ONE switch in the
 * topbar (shell/ProjectSwitch), read via `usePageProject()`.
 */
import React from 'react';
import { Select, Input, Label } from '../../components/ui';
import { SearchIcon } from './icons';
import { STATUS_FILTERS, type StatusFilterValue } from './config';
import styles from './Sessions.module.css';

export interface SessionsToolbarProps {
  status: StatusFilterValue;
  onStatusChange: (v: StatusFilterValue) => void;
  /** The distinct actor slugs present (server-side filter targets). */
  actors: string[];
  /** 'all' | an actor slug. */
  actor: string;
  onActorChange: (v: string) => void;
  search: string;
  onSearchChange: (v: string) => void;
}

export const SessionsToolbar: React.FC<SessionsToolbarProps> = ({
  status,
  onStatusChange,
  actors,
  actor,
  onActorChange,
  search,
  onSearchChange,
}) => {
  const actorOptions = [
    { value: 'all', label: 'All actors' },
    ...actors.map((a) => ({ value: a, label: a })),
  ];

  return (
    <div className={styles.pivot}>
      <Label as="span" tone="faint" className={styles.pvLabel}>
        Actor
      </Label>
      <Select
        options={actorOptions}
        value={actor}
        onChange={onActorChange}
        aria-label="Filter by actor"
        className={styles.pvActor}
      />
      <Label as="span" tone="faint" className={styles.pvLabel}>
        Status
      </Label>
      <Select
        options={STATUS_FILTERS.map((s) => ({ value: s.value, label: s.label }))}
        value={status}
        onChange={(v) => onStatusChange(v as StatusFilterValue)}
        aria-label="Filter by status"
        className={styles.pvStatus}
      />
      <div className={styles.pvRight}>
        <div className={styles.searchBox}>
          <SearchIcon size={15} className={styles.searchIco} />
          <Input
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="Search title, actor, project, goal, tags"
            aria-label="Search sessions"
            className={styles.searchInput}
          />
        </div>
      </div>
    </div>
  );
};

export default SessionsToolbar;
