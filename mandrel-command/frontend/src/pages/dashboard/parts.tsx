/**
 * Small shared Dashboard building blocks: the uppercase section head (mock `.sh`)
 * and the number / relative-time formatters the cards share.
 */
import React from 'react';
import { Label } from '../../components/ui';
import type { ScopeFn } from './hooks';
import { isAttributed } from './config';
import styles from './Dashboard.module.css';

/**
 * The scope EVERY Dashboard card takes. One prop, one shape, no card free to invent its
 * own idea of which project it is showing — that divergence is what let the page describe
 * itself as "Mandrel-wide" while its cards read a single, invisible ambient project.
 *
 * `undefined` means "the page has no scope yet" (the project list is still loading), NOT
 * "every project". Cards render their loading state; the hooks stay disabled. `'all'` is
 * the explicit every-project value and is a real, selected thing the user can see.
 */
export interface DashboardCardProps {
  projectId: string | undefined;
  /**
   * `usePageProject().scope` — pins `X-Project-ID` to THIS page's project for one
   * request. Passed as the function (it throws when there is no project, so it must be
   * called inside a `queryFn`, not during render).
   */
  scope: ScopeFn;
  /**
   * The selected project's NAME, for captions. Carried alongside the id rather than
   * re-derived per card so a caption can never name a different project than the request
   * — the caption saying one thing while the query said another is the original bug.
   */
  projectName?: string | undefined;
}

/** Human label for a card caption: the project name, or a neutral stand-in while it loads. */
export const scopeCaption = (projectName: string | undefined): string =>
  projectName ?? 'this project';

export const SectionHead: React.FC<{
  icon?: React.ReactNode;
  children: React.ReactNode;
  more?: React.ReactNode;
}> = ({ icon, children, more }) => (
  <div className={styles.sectionHead}>
    {icon}
    <Label as="span" tone="faint">
      {children}
    </Label>
    {more && <span className={styles.more}>{more}</span>}
  </div>
);

/** Thousands-grouped integer (tabular). Nullish → em dash. */
export function formatCount(n: number | undefined | null): string {
  if (n == null || Number.isNaN(n)) return '—';
  return n.toLocaleString();
}

/** Coerce a pg NUMERIC/BIGINT-as-string (or number) to a finite number; else 0. */
export function toNum(n: number | string | undefined | null): number {
  const v = typeof n === 'string' ? Number(n) : n;
  return v == null || Number.isNaN(v) ? 0 : v;
}

/** Compact token count: 142000 → "142k", 1_200_000 → "1.2m". Nullish/0 → em dash. */
export function formatTokens(n: number | string | undefined | null): string {
  const v = toNum(n);
  if (v <= 0) return '—';
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}m`;
  if (v >= 1_000) return `${Math.round(v / 1_000)}k`;
  return String(v);
}

/**
 * A session row (subset) the "by actor" breakdown reads. The Command list read
 * model serialises these; the breakdown never reaches past them.
 */
export interface SessionActorRow {
  id: string;
  actor?: string | null;
  project_name?: string;
  project_id?: string;
  // Read the DERIVED counts (`*_count`), not the denormalized `*_created` counters —
  // see the note in pages/sessions/StreamCard.tsx. The `*_created`
  // fields are kept on the type because the API still serialises them (with the same
  // derived value), but this rollup deliberately reads one field each.
  contexts_created?: number;
  context_count?: number;
  tasks_created?: number;
  task_count?: number;
  total_tokens?: number | string;
  ended_at?: string | null;
  last_activity_at?: string;
  started_at?: string;
  created_at?: string;
}

/** One actor's rolled-up activity across the sessions they ran. */
export interface ActorActivity {
  /** null = the unattributed group. */
  actor: string | null;
  sessions: number;
  contexts: number;
  tasks: number;
  tokens: number;
  /** Distinct project names the actor touched. */
  projects: string[];
  /** Most-recent activity across the actor's sessions. */
  lastSeen?: string;
  /**
   * The id of the session `lastSeen` came from — the actor's most recent one. Carried so
   * the row can link to it; it is assigned in the SAME step that assigns
   * `lastSeen` precisely so the timestamp the row displays and the session it navigates
   * to can never describe different sessions.
   *
   * `undefined` when no session in the group supplied a usable timestamp (or an id at
   * all). The row then renders NON-INTERACTIVE rather than linking somewhere arbitrary.
   */
  lastSessionId?: string;
  /** True if any of the actor's sessions is still open (no ended_at). */
  live: boolean;
}

function bestSeen(r: SessionActorRow): string | undefined {
  return r.last_activity_at ?? r.ended_at ?? r.started_at ?? r.created_at ?? undefined;
}

/**
 * Roll a flat session list up by `actor` — session count + summed
 * contexts/tasks/tokens, the distinct projects touched, most-recent activity, and
 * whether any session is still live. Real attributed actors first (by contexts
 * desc), the unattributed group last. Decisions/hourly-strip are NOT included —
 * the list read model does not serialise per-session decisions or per-hour buckets
 * (surfaced, never faked).
 */
export function aggregateByActor(rows: SessionActorRow[]): ActorActivity[] {
  const NULL_KEY = '__unattributed__';
  const map = new Map<string, ActorActivity>();
  for (const r of rows) {
    // Normalize every non-attributed actor (null OR the `anonymous` sentinel) into ONE
    // unattributed bucket, so a header-less/anonymous session never renders as its own
    // "anonymous" row alongside a separate "unattributed" one (an earlier task display part).
    const actor = isAttributed(r.actor) ? r.actor : null;
    const key = actor ?? NULL_KEY;
    let a = map.get(key);
    if (!a) {
      a = {
        actor,
        sessions: 0,
        contexts: 0,
        tasks: 0,
        tokens: 0,
        projects: [],
        lastSeen: undefined,
        lastSessionId: undefined,
        live: false,
      };
      map.set(key, a);
    }
    a.sessions += 1;
    // Derived counts only. `r.contexts_created ?? r.context_count` was the same `??`
    // trap as StreamCard: a zeroed denormalized counter is not nullish, so it won and
    // the per-actor rollup silently under-counted every ended session.
    a.contexts += toNum(r.context_count);
    a.tasks += toNum(r.task_count);
    a.tokens += toNum(r.total_tokens);
    if (r.project_name && !a.projects.includes(r.project_name)) a.projects.push(r.project_name);
    const seen = bestSeen(r);
    if (seen && (!a.lastSeen || Date.parse(seen) > Date.parse(a.lastSeen))) {
      a.lastSeen = seen;
      // ONE assignment for the pair — see the ActorActivity.lastSessionId note. A row
      // whose id came from anywhere else could point at a different session than the
      // timestamp beside it describes.
      a.lastSessionId = r.id || undefined;
    }
    if (!r.ended_at) a.live = true;
  }
  return Array.from(map.values()).sort((x, y) => {
    if ((x.actor === null) !== (y.actor === null)) return x.actor === null ? 1 : -1;
    return y.contexts - x.contexts;
  });
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
