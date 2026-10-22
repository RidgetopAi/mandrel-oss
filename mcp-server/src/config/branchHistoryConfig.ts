/**
 * BRANCH HISTORY — the response bounds on `branch_history` (SK2).
 *
 * STANDING PRINCIPLE (the operator): NO HARDCODED VARIABLES. Every bound `branch_history` applies
 * lives HERE as a named value with a stated default and an env override — never a literal in
 * the route. Same shape as threadConfig.ts / recallConfig.ts.
 *
 * WHY THESE ARE TUNABLE AND positionalMembershipConfig's RULES ARE NOT: that file refuses
 * env reads because it defines what membership IS, and a deployment-varying definition would
 * make a declared edge mean different things in different places. These are not the
 * definition — they are RESPONSE BOUNDS on a read. Changing one changes how much of the same
 * answer you get back, never which records are members. Both bounds are reported in the
 * response when they BITE (`omitted` / `truncated`), so a tuned instance cannot quietly hand
 * back a short list that reads as complete.
 */

/** Read a positive-integer env var, falling back to `fallback` on missing/garbage. */
function envInt(name: string, fallback: number): number {
  const raw = process.env[name]; // env-read: via-callers
  if (raw === undefined || raw === '') return fallback;
  const v = Number(raw);
  return Number.isInteger(v) && v > 0 ? v : fallback;
}

export const BRANCH_HISTORY_CONFIG = {
  /**
   * How many members one `branch_history` call returns when the caller names no `limit`.
   * 200 because a branch is a unit of work a person can hold in their head: the largest
   * spine on prod on 2026-08-15 had 9 members (`SELECT count(*) FROM branch_membership
   * GROUP BY spine_id ORDER BY 1 DESC LIMIT 1`), so this is an order of magnitude of
   * headroom and the default is not expected to bite for real branches.
   */
  defaultLimit: envInt('MANDREL_BRANCH_HISTORY_LIMIT', 200),

  /**
   * Hard ceiling on `limit`. A caller asking for more is CLAMPED to this and told so — the
   * request is not rejected, because a bounded honest answer beats an error, and it is not
   * silently honoured, because an unbounded read on a shared server is how one caller's
   * curiosity becomes everyone's latency.
   */
  maxLimit: envInt('MANDREL_BRANCH_HISTORY_MAX_LIMIT', 1000),

  /**
   * How many BAND 3 ids (`tagOnlyNoPosition`) one call returns alongside the count.
   *
   * WHY IDS AT ALL, added by P3: band 3 is now the DISCOVERY SURFACE for
   * `branch_assign` — a precomputed list of exactly the records an author can resolve by
   * declaring their branch. Returning only a count forced a second query to act on it. The
   * COUNT stays complete and unbounded; only the id sample is capped, and the response says
   * so whenever it bites (`tagOnlyNoPositionIdsTruncated`).
   */
  tagOnlyIdLimit: envInt('MANDREL_BRANCH_HISTORY_TAGONLY_IDS', 50),

  // maxDepth / maxWalkNodes were DELETED with the transitive walk (SK2 round 2). Membership
  // is one flat equality on the recorded position spine (migration 086) — there is no
  // frontier to bound, so a bound would be a knob that cannot change any answer.
} as const;

export type BranchHistoryConfig = typeof BRANCH_HISTORY_CONFIG;
