/**
 * BRANCH MEMBERSHIP MOVES — the tunables for `branch_assign` / `branch_unassign`
 * (P3, migration 090).
 *
 * STANDING PRINCIPLE (the operator): no hardcoded variables. The two values below would otherwise
 * be string/number literals in services/branchMembership.ts, and both are things a
 * deployment might reasonably want to change.
 *
 * WHY ITS OWN FILE rather than membershipSourceConfig.ts: that file defines what a membership
 * SOURCE means — a definition, deliberately env-free, because a deployment-varying definition
 * would make the same stored value mean different things in different places. These are
 * operational knobs on the WRITE path. Keeping them apart is the same split
 * branchHistoryConfig.ts already documents against positionalMembershipConfig.ts.
 */

/** Read a positive-integer env var, falling back to `fallback` on missing/garbage. */
function envInt(name: string, fallback: number): number {
  const raw = process.env[name]; // env-read: via-callers
  if (raw === undefined || raw === '') return fallback;
  const v = Number(raw);
  return Number.isInteger(v) && v > 0 ? v : fallback;
}

export const MEMBERSHIP_MOVE_CONFIG = {
  /**
   * What lands in `branch_membership_moves.actor` when the CALLER PRESENTED NO ACTOR.
   *
   * The column is NOT NULL because this table is the accountability half of a tool that
   * rewrites an otherwise immutable historical fact, and a NULL there reads as "no data"
   * when the truth is a specific, knowable thing: this call arrived without an identity.
   * The value states exactly that and claims nothing more — it is deliberately NOT a
   * plausible principal name, so it can never be mistaken for one in an audit read.
   *
   * On prod this never fires: `MANDREL_SESSION_REQUIRE_ACTOR=true` means a write without
   * `X-Actor-ID` is rejected before it reaches a route. It fires for in-process callers —
   * tests, background jobs — which is exactly the population it should describe.
   */
  unknownActor: process.env.MANDREL_MEMBERSHIP_MOVE_UNKNOWN_ACTOR || 'unidentified-caller', // env-read: via-callers

  /**
   * How many free-text bytes of a caller-supplied `reason` are stored. A bound rather than a
   * rejection: an over-long reason is truncated and the row still records WHO moved WHAT and
   * WHEN, which is the part the audit trail exists for.
   */
  maxReasonLength: envInt('MANDREL_MEMBERSHIP_MOVE_MAX_REASON', 1000),

  /**
   * Default ceiling on how many move rows one `readMembershipMoves` call returns. A record's
   * branch is corrected a handful of times at most, so this is orders of magnitude of
   * headroom; it exists so an unbounded read on a shared server is structurally impossible,
   * not because it is expected to bite.
   */
  movesReadLimit: envInt('MANDREL_MEMBERSHIP_MOVE_READ_LIMIT', 200),
} as const;

export type MembershipMoveConfig = typeof MEMBERSHIP_MOVE_CONFIG;
