/**
 * POSITION AGE NOTICE — stale-position VISIBILITY on the write path ( * The reviewer finding on P1 locked model an earlier decision).
 *
 * STANDING PRINCIPLE (the operator): NO HARDCODED VARIABLES. The threshold lives HERE as a named
 * value with a stated default and an env override.
 *
 * ── WHAT THIS IS, AND WHAT IT IS NOT ────────────────────────────────────────────────────
 * Positions have NO TTL, by locked design: "deterministically wrong, visible, correctable".
 * This module is the VISIBLE half of that sentence and nothing more. It never closes, moves
 * or ages out a position. It adds ONE line to a write's report when the position the write
 * attached to was opened longer ago than the threshold, so an agent that reused a stable
 * X-Connection-ID across logical work sessions (our own documented pattern) is told, at the
 * moment it writes, that it may be standing somewhere stale — instead of that fact living
 * only behind a `branch_current` nobody calls.
 *
 * WHY THIS IS TUNABLE AND positionalMembershipConfig's RULES ARE NOT: that file refuses env
 * reads because it defines what membership IS. This threshold changes no edge and no
 * membership — only whether a sentence is appended. Same reasoning as branchHistoryConfig.
 *
 * READ LAZILY (per call), like danglingSpineRefused(): the contract test flips the threshold
 * through the real env var and restores it, and an import-time read would make that probe
 * impossible without a module reload.
 */

import type { BranchPosition } from '../services/branchPosition.js';

export const POSITION_AGE_NOTICE_ENV = 'MANDREL_POSITION_AGE_NOTICE_HOURS';

/**
 * Default threshold, in hours. 24 because a position that survived a calendar day has
 * almost certainly outlived the work session that opened it — the stale scenario named in
 * the task is a reused connection id spanning DAYS, not a long afternoon.
 */
export const POSITION_AGE_NOTICE_HOURS_DEFAULT = 24;

/**
 * The threshold in hours. A finite value >= 0 is honoured (0 = notice on every positioned
 * write, which is the "always tell me" setting); missing, empty, negative or garbage falls
 * back to the default rather than silently disabling the notice — an unparseable knob
 * must not turn a visibility feature OFF.
 */
export function positionAgeNoticeHours(): number {
  const raw = process.env.MANDREL_POSITION_AGE_NOTICE_HOURS; // env-read: MANDREL_POSITION_AGE_NOTICE_HOURS
  if (raw === undefined || raw === '') return POSITION_AGE_NOTICE_HOURS_DEFAULT;
  const v = Number(raw);
  return Number.isFinite(v) && v >= 0 ? v : POSITION_AGE_NOTICE_HOURS_DEFAULT;
}

/**
 * Human age string for a duration: the largest whole unit that is non-zero, one unit only
 * ("9d", "3h", "45m"). One unit because the line is a nudge, not a clock — "9d 3h 12m" reads
 * as precision the notice does not need and buries the number that matters.
 */
export function formatPositionAge(ageMs: number): string {
  const minutes = Math.floor(Math.max(0, ageMs) / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/**
 * THE ONE SENTENCE. Null when there is no position to age, when the session is at TRUNK
 * (an origin='trunk' row is provenance, not somewhere the writer is standing — see
 * branchPosition.ts), or when the position is younger than the threshold.
 *
 * Every write path renders this through the same function so the text cannot drift between
 * task_create / decision_record (positionalResponseLines) and context_store (which composes
 * its own response). The structured report carries the same string as `ageNotice`.
 */
export function positionAgeNotice(
  position: BranchPosition | null,
  nowMs: number = Date.now()
): string | null {
  if (!position || position.origin === 'trunk') return null;
  const opened = position.openedAt instanceof Date
    ? position.openedAt.getTime()
    : new Date(position.openedAt as unknown as string).getTime();
  if (!Number.isFinite(opened)) return null;
  const ageMs = nowMs - opened;
  const thresholdMs = positionAgeNoticeHours() * 3_600_000;
  if (ageMs <= thresholdMs) return null;
  return (
    `Position opened ${formatPositionAge(ageMs)} ago on ${position.spineType} ` +
    `${position.spineId.substring(0, 8)} — branch_close if this is stale ` +
    `(notice after ${positionAgeNoticeHours()}h; ${POSITION_AGE_NOTICE_ENV}).`
  );
}
