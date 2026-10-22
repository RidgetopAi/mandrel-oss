import { config } from '../config/environment';

/**
 * Inputs to the activity (work) score. These are the RAW work signals of a session.
 * Callers must pass LIVE counts (counted off the session_id linkage) so the same
 * session always yields the same score regardless of which surface asks — the list
 * (getSessionSummaries) and the detail (getSessionDetail) views previously diverged
 * because the list read denormalized counters (decisions_created = 0 for every prod
 * row) while the detail counted live. This is the single shared calculator both use.
 */
export interface ActivityScoreInput {
  /** Number of contexts created during the session (live count via session_id). */
  contexts: number;
  /** Number of technical decisions recorded during the session (live via session_id). */
  decisions: number;
  /** Number of tasks COMPLETED in the session (live via session_id). */
  tasksCompleted: number;
  /** Wall-clock session duration in minutes. */
  durationMinutes: number;
  /** Total tokens used by the session. */
  totalTokens: number;
}

/**
 * Compute a session's Activity Score — a single work/activity number that GROWS with
 * effort (no /100 ceiling). Weights live in config.activityScore (named, env-tunable,
 * not hardcoded). The substance is the historical formula, unchanged:
 *
 *   contexts*2 + decisions*3 + tasksCompleted*4 + min(hours,8)*1.5 + min(tokens/1k,10)*0.5
 *
 * Returns the score rounded to one decimal place. Negative/NaN inputs are coerced to 0
 * so a malformed row can never produce a negative or NaN score.
 */
export function calculateActivityScore(input: ActivityScoreInput): number {
  const w = config.activityScore;

  const contexts = nonNegative(input.contexts);
  const decisions = nonNegative(input.decisions);
  const tasksCompleted = nonNegative(input.tasksCompleted);
  const durationMinutes = nonNegative(input.durationMinutes);
  const totalTokens = nonNegative(input.totalTokens);

  const contextScore = contexts * w.perContext;
  const decisionScore = decisions * w.perDecision;
  const taskScore = tasksCompleted * w.perTaskCompleted;
  const durationScore = Math.min(durationMinutes / 60, w.maxHours) * w.perHour;
  const tokenScore = Math.min(totalTokens / 1000, w.maxThousandTokens) * w.perThousandTokens;

  const total = contextScore + decisionScore + taskScore + durationScore + tokenScore;

  return Math.round(total * 10) / 10;
}

// Coerce to a non-negative finite number. Inputs may arrive as strings from the pg
// driver (NUMERIC/BIGINT columns come back as strings), so we Number()-coerce at the
// boundary; anything non-finite or <= 0 collapses to 0. This is what guarantees the
// detail path (which passes raw row values like duration_minutes = "60.0000") scores
// identically to the list path (which pre-parses) — the root of an earlier off-by
// divergence where a string duration silently scored 0.
function nonNegative(n: number): number {
  const num = typeof n === 'number' ? n : Number(n);
  return Number.isFinite(num) && num > 0 ? num : 0;
}
