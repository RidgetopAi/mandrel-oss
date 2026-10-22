/**
 * Small shared Sessions building blocks: the uppercase section head (mock `.sh`),
 * the number / token / relative-time formatters, the derived-status helper, and
 * the timeline merge that flattens a session's contexts/decisions/tasks/commits
 * into one recent-first activity stream (mock `.timeline`).
 */
import React from 'react';
import { Link } from 'react-router-dom';
import { Label, Code, cx } from '../../components/ui';
import { recordPath, type RecordKind } from '../../utils/deepLink';
import type { SessionDetail } from '../../types/session';
import {
  SESSIONS_CONFIG,
  contextKind,
  actorDotVar,
  actorLabel,
  isAttributed,
  type SessionStatus,
  type TimelineKind,
} from './config';
import type { SessionListRow } from './hooks';
import styles from './Sessions.module.css';
import '../../styles/recordLink.css';

/**
 * The distinct actor slugs present across a set of session rows (sorted; every
 * non-attributed actor — null OR the `anonymous` sentinel — is excluded, since
 * "unattributed" is not a filterable value). Feeds the SessionsToolbar actor
 * Select's option list.
 */
export function distinctActors(rows: SessionListRow[]): string[] {
  const set = new Set<string>();
  for (const r of rows) if (isAttributed(r.actor)) set.add(r.actor);
  return Array.from(set).sort();
}

/**
 * The mock's actor "chip" — the WHO on a stream card. A real actor gets a stable
 * accent dot + its slug; a non-attributed actor (null OR the `anonymous` sentinel)
 * gets the neutral "unattributed" treatment (muted, still shown — never hides the
 * card).
 */
export const ActorChip: React.FC<{ actor: string | null | undefined }> = ({ actor }) => {
  const attributed = isAttributed(actor);
  return (
    <span className={cx(styles.actorChip, !attributed && styles.actorChipMuted)}>
      <span
        className={styles.actorDot}
        style={{ background: `var(${actorDotVar(actor)})` }}
        aria-hidden="true"
      />
      {actorLabel(actor)}
    </span>
  );
};

export const SectionHead: React.FC<{
  icon?: React.ReactNode;
  count?: React.ReactNode;
  live?: boolean;
  hint?: React.ReactNode;
  children: React.ReactNode;
}> = ({ icon, count, live, hint, children }) => (
  <div className={styles.sectionHead}>
    {live && <span className={styles.liveDot} aria-hidden="true" />}
    {icon}
    <Label as="span" tone="faint">
      {children}
    </Label>
    {count != null && <span className={styles.shCount}>{count}</span>}
    {hint && <span className={styles.shHint}>{hint}</span>}
  </div>
);

/** Thousands-grouped integer (tabular). Nullish → em dash. */
export function formatCount(n: number | string | undefined | null): string {
  const v = typeof n === 'string' ? Number(n) : n;
  if (v == null || Number.isNaN(v)) return '—';
  return v.toLocaleString();
}

/** Compact token count: 142000 → "142k", 1_200_000 → "1.2m". */
export function formatTokens(n: number | string | undefined | null): string {
  const v = typeof n === 'string' ? Number(n) : n;
  if (v == null || Number.isNaN(v)) return '—';
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}m`;
  if (v >= 1_000) return `${Math.round(v / 1_000)}k`;
  return String(v);
}

/**
 * Compact "now / 38m / 2h / 3d" relative time.
 *
 * Re-exported, not reimplemented: this function was copy-pasted
 * VERBATIM into six pages/*\/parts.tsx files. The one implementation now lives in
 * utils/datetime.ts alongside the timezone-aware formatters; re-exporting keeps every
 * existing `from './parts'` import site working unchanged.
 */
export { formatRelative } from '../../utils/datetime';

/** Best "last seen" timestamp for a session row. */
export function lastSeen(row: SessionListRow): string | undefined {
  return row.last_activity_at ?? row.last_context_at ?? row.ended_at ?? row.started_at ?? row.created_at ?? undefined;
}

/**
 * Derive the lifecycle status the StatusPill + grouping use:
 *   ended_at set → ended · else recent activity → live · else → dormant.
 */
export function deriveStatus(row: SessionListRow): SessionStatus {
  if (row.ended_at) return 'ended';
  const seen = lastSeen(row);
  const t = seen ? Date.parse(seen) : NaN;
  if (Number.isNaN(t)) return 'live';
  return Date.now() - t <= SESSIONS_CONFIG.liveWithinMs ? 'live' : 'dormant';
}

/**
 * A list row paired with the status the pill will show for it. The Sessions page
 * groups on THIS, never on a second, looser question.
 */
export interface StatusedRow {
  row: SessionListRow;
  status: SessionStatus;
}

/** The three lifecycle buckets the Sessions page renders, in display order. */
export interface SessionGroups {
  live: StatusedRow[];
  dormant: StatusedRow[];
  ended: StatusedRow[];
}

/**
 * Split rows into the three groups by their DERIVED status — the same value the
 * StatusPill renders.
 *
 * ── WHY THIS FUNCTION EXISTS (the operator 2026-08-09) ───────────────────────
 * The page used to bucket with `st === 'ended' ? endedRows : liveRows`, i.e. the heading
 * asked "is this session NOT ended?" while every pill under it asked "was there recorded
 * activity recently?". Those are different questions, so the screen shipped a header
 * reading "LIVE NOW 4" above four cards each pilled "dormant". A count that contradicts
 * the badges beneath it teaches a user to distrust every other indicator we ship.
 *
 * One question, asked once: the group a row lands in is its status, by construction. A
 * heading can no longer disagree with a pill because neither is computed separately.
 */
export function groupByStatus(rows: StatusedRow[]): SessionGroups {
  const groups: SessionGroups = { live: [], dormant: [], ended: [] };
  for (const entry of rows) groups[entry.status].push(entry);
  return groups;
}

/**
 * The live/dormant threshold as a short human string ("30m", "2h"), derived from
 * SESSIONS_CONFIG.liveWithinMs so the section hints cannot drift from the rule that
 * actually decides the pill (configs-not-hardcoded).
 */
export function liveWindowLabel(ms: number = SESSIONS_CONFIG.liveWithinMs): string {
  const minutes = Math.round(ms / 60000);
  if (minutes < 60) return `${minutes}m`;
  const hours = minutes / 60;
  return Number.isInteger(hours) ? `${hours}h` : `${hours.toFixed(1)}h`;
}

/** A single flattened activity event on the expanded stream timeline. */
export interface TimelineEvent {
  key: string;
  kind: TimelineKind;
  title: string;
  idShort?: string;
  at?: string;
  sub?: string;
  /**
   * The record's TRUE type, stamped by the loop that produced the event — the only
   * place that knows it. It is NOT derivable from `kind`: contextKind() maps a context
   * whose context_type is 'decision' onto kind 'decision', so a `kind`-driven link would
   * send a context id to the decision route. Undefined when the record has no in-app
   * detail route.
   */
  record?: RecordKind;
  /**
   * The record's full id, for the route. `idShort` is a truncated display string and is
   * never a usable route param.
   */
  recordId?: string;
}

function short(id: string | undefined): string | undefined {
  return id ? id.slice(0, 8) : undefined;
}

/**
 * The id chip on a timeline row: a real anchor to the record's detail route when the
 * event carries one, otherwise the same chip as plain text.
 */
export const TimelineRecordId: React.FC<{
  event: TimelineEvent;
  className?: string;
}> = ({ event, className }) => {
  if (!event.idShort) return null;
  const chip = <Code className={className}>{event.idShort}</Code>;
  if (!event.record || !event.recordId) return chip;
  return (
    <Link
      to={recordPath(event.record, event.recordId)}
      className="ra-record-link"
      aria-label={`Open ${event.record} ${event.idShort}`}
      title={`Open ${event.record} ${event.idShort}`}
    >
      {chip}
    </Link>
  );
};

/**
 * Flatten a session detail into one recent-first activity stream — contexts,
 * decisions, tasks, and linked commits merged and sorted by time (mock timeline).
 */
export function buildTimeline(detail: SessionDetail | undefined): TimelineEvent[] {
  if (!detail) return [];
  const events: TimelineEvent[] = [];

  for (const c of detail.contexts ?? []) {
    events.push({
      key: `ctx-${c.id}`,
      kind: contextKind((c as { context_type?: string; type?: string }).context_type ?? c.type),
      title: (c.content ?? '').split('\n')[0].slice(0, 120) || '(context)',
      idShort: short(c.id),
      at: c.created_at,
      record: 'context',
      recordId: c.id,
    });
  }
  for (const d of detail.decisions ?? []) {
    events.push({
      key: `dec-${d.id}`,
      kind: 'decision',
      title: d.title || '(decision)',
      idShort: short(d.id),
      at: d.created_at,
      record: 'decision',
      recordId: d.id,
    });
  }
  for (const t of detail.tasks ?? []) {
    events.push({
      key: `task-${t.id}`,
      kind: 'task',
      title: t.title || '(task)',
      idShort: short(t.id),
      at: t.created_at,
      sub: t.status,
      record: 'task',
      recordId: t.id,
    });
  }
  for (const commit of detail.linked_commits ?? []) {
    // No `record`: there is no commit detail route, and inventing one would render a
    // link that dead-ends. The sha stays plain text until a real destination exists.
    events.push({
      key: `commit-${commit.id}`,
      kind: 'commit',
      title: (commit.message ?? '').split('\n')[0].slice(0, 120) || '(commit)',
      idShort: commit.short_sha,
      at: commit.author_date,
    });
  }

  return events.sort((a, b) => {
    const ta = a.at ? Date.parse(a.at) : 0;
    const tb = b.at ? Date.parse(b.at) : 0;
    return tb - ta;
  });
}
