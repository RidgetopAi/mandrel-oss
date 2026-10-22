/**
 * Small shared session-detail helpers: absolute + duration formatting, the id8 short-id
 * (re-exported from the projects module so every screen formats identically), and the
 * derived lifecycle status. Timeline construction + the relative-time / count / token
 * formatters are reused from the Sessions module so the two session surfaces stay
 * consistent (single source; no drifting second copy). Pure + unit-friendly.
 */
export { id8 } from '../projects/parts';
export {
  formatCount,
  formatTokens,
  formatRelative,
  buildTimeline,
  TimelineRecordId,
} from '../sessions/parts';
export { contextKind, KIND_TONE } from '../sessions/config';
export type { TimelineEvent } from '../sessions/parts';

import { SESSION_DETAIL_CONFIG } from './config';
import type { SessionStatus } from '../sessions/config';

/**
 * A full absolute timestamp in the BROWSER's zone + locale, or an em-dash when
 * missing/invalid.
 *
 * Re-exported from utils/datetime as `formatDateTime`. The local
 * implementation was `new Date(iso).toLocaleString()` — already correct about the zone,
 * but a second copy of the rule, and the one place a future edit could quietly hardcode a
 * locale the way pages/Profile.tsx had.
 */
export { formatDateTime as formatDate } from '../../utils/datetime';

/**
 * Human duration between two timestamps ("2h 14m" / "47m"). Missing start → em-dash;
 * an open (no end) session measures to now; a negative span clamps to "0m".
 */
export function formatDuration(start?: string | null, end?: string | null): string {
  if (!start) return '—';
  const s = new Date(start);
  if (Number.isNaN(s.getTime())) return '—';
  const e = end ? new Date(end) : new Date();
  if (Number.isNaN(e.getTime())) return '—';
  const diff = e.getTime() - s.getTime();
  if (diff <= 0) return '0m';
  const hours = Math.floor(diff / (1000 * 60 * 60));
  const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

/** A signed net-lines string like "+412 / -87" from added/deleted counts. */
export function formatChurn(added?: number, deleted?: number): string {
  return `+${(added ?? 0).toLocaleString()} / -${(deleted ?? 0).toLocaleString()}`;
}

/**
 * The Activity Score tile value. The score is an unbounded work/effort measure that
 * GROWS with the session (contexts, decisions, tasks completed, time, tokens) —
 * deliberately no "/100" ceiling, higher is simply busier. The detail endpoint sends a
 * number but the generated entity type declares a string, so accept both; a missing or
 * unparsable score renders the honest em-dash, never a fabricated 0.
 */
export function formatScore(score?: number | string | null): string {
  if (score == null || score === '') return '—';
  const n = Number(score);
  if (Number.isNaN(n)) return '—';
  return Math.round(n).toLocaleString();
}

/** The fields the status derivation reads (a loose subset of the detail payload). */
export interface StatusInput {
  ended_at?: string | null;
  last_activity_at?: string;
  last_context_at?: string;
  started_at?: string;
  created_at?: string;
}

/**
 * Derive the lifecycle status the header pill uses:
 *   ended_at set → ended · else recent activity → live · else → dormant.
 * Same threshold as the Sessions LIST (SESSION_DETAIL_CONFIG.liveWithinMs).
 */
export function deriveSessionStatus(s: StatusInput, now: number = Date.now()): SessionStatus {
  if (s.ended_at) return 'ended';
  const seen = s.last_activity_at ?? s.last_context_at ?? s.started_at ?? s.created_at;
  const t = seen ? Date.parse(seen) : NaN;
  if (Number.isNaN(t)) return 'live';
  return now - t <= SESSION_DETAIL_CONFIG.liveWithinMs ? 'live' : 'dormant';
}

/** The StatusPill tone for a derived session status. */
export function statusPillTone(status: SessionStatus): 'active' | 'dormant' | 'ended' {
  return status === 'live' ? 'active' : status === 'dormant' ? 'dormant' : 'ended';
}

/** The first, whitespace-collapsed line of a body (contexts/commits), capped. */
export function firstLine(text: string | undefined | null, cap = 140): string {
  if (!text) return '';
  return (text.split('\n', 1)[0] ?? '').trim().slice(0, cap);
}
