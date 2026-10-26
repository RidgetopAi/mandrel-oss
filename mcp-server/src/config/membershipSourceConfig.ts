/**
 * HOW A BRANCH MEMBERSHIP'S BRANCH WAS OBTAINED — `branch_memberships.source`
 * (SK2, migration 086).
 *
 * A membership row answers "which branch was this record written on". That answer has two
 * possible QUALITIES, and a caller must be able to tell them apart — a count that merges
 * them is a confident wrong number, which is the defect this whole task exists to remove.
 *
 * WHY ITS OWN FILE RATHER THAN edgeProvenanceConfig.ts: this is not an edge property. It
 * belongs to the membership row, which is stored independently of any edge precisely because
 * the positional `informs` edge can be deduped away by an earlier tag mint on the same
 * (from,to,edge_type) triple. Filing it under EDGE provenance is what made round 3 look
 * reasonable while it stored a first-class fact on a contested row.
 */
export const MEMBERSHIP_SOURCE = {
  /**
   * From the LIVE POSITION at mint time (services/positionalMint.ts). A FACT, and the only
   * value any code path writes.
   */
  recorded: 'recorded',
  /**
   * Backfilled by migration 086 from a pre-086 `links.mint_via='position'` row, taking the
   * edge's attachment point as the branch. An APPROXIMATION — correct for a directly-attached
   * member, and WRONG (under-counting) for a tip-attached capture, whose true root is
   * unrecoverable. A CLOSED class: nothing mints it, so its count can only shrink. Consumers
   * must SURFACE it (branch_history reports approximateMembers / possiblyIncomplete / exact),
   * never hide it.
   */
  legacyApprox: 'legacy-approx',
  /**
   * DECLARED AFTER THE FACT by a human, through `branch_assign` (P3, 
   * migration 090). A FACT — and arguably a stronger one than `recorded`, which is an
   * observation the system made at mint time without anyone asserting anything. It exists
   * because the system opens positions the author never asked for (auto/byproduct opens),
   * so the SYSTEM manufactures wrong memberships and somebody has to be able to correct
   * them. NOT an approximation: see MEMBERSHIP_SOURCE_TRUST below. The full audit trail of
   * every assign/unassign lives in `branch_membership_moves`; this value is the
   * DENORMALIZED summary of it on the hot read path, not a second source of truth.
   */
  assigned: 'assigned',
} as const;

export type MembershipSource = (typeof MEMBERSHIP_SOURCE)[keyof typeof MEMBERSHIP_SOURCE];

/** Every source value, as an array. Consumer: the APPROXIMATE_SOURCES derivation below. */
export const MEMBERSHIP_SOURCE_VALUES: readonly MembershipSource[] = Object.freeze(
  Object.values(MEMBERSHIP_SOURCE)
) as readonly MembershipSource[];

/**
 * ★ WHICH SOURCES ARE APPROXIMATIONS — the positive set, and the ONLY correct way to ask.
 *
 * Read this before adding a value to MEMBERSHIP_SOURCE above.
 *
 * Every consumer that needs "was this member's branch DERIVED rather than known" used to
 * compute it as `spineSource !== MEMBERSHIP_SOURCE.recorded` — a NEGATED EQUALITY standing in
 * for a set. That proxy is exactly right for two values and silently wrong for three: the
 * moment a value exists that is neither `recorded` nor an approximation, every such site
 * classifies it as approximate and reports a DECLARED fact as "branch INFERRED, not
 * recorded", and drops `exact:false` on a branch that is perfectly exact. A confident wrong
 * number that UNDERSTATES trust in our strongest kind of fact — and nothing goes red, because
 * a proxy that is behaviour-identical against today's population cannot be caught by a test
 * written against today's population either.
 *
 * THE CASE THIS WAS WRITTEN AHEAD OF, AND WHICH HAS NOW LANDED (P3):
 * `source='assigned'`, written when a human deliberately assigns a record to a
 * branch after the fact. That is a DECLARED
 * fact — arguably STRONGER than `recorded`, which is an observation the system made at mint
 * time without anyone asserting anything. It belongs on the TRUSTED side of this split, not
 * the approximate one, and the whole point of a positive set is that it lands there by
 * DEFAULT instead of by remembering to exclude it.
 *
 * WHY THE Record AND NOT JUST THE SET: MEMBERSHIP_SOURCE_TRUST is exhaustive over
 * MembershipSource, so adding a value to MEMBERSHIP_SOURCE is a COMPILE ERROR until it is
 * classified here. The failure this guards is not a wrong classification, it is an
 * UNCONSIDERED one — and a hand-listed set of strings cannot force the consideration.
 * APPROXIMATE_SOURCES is DERIVED from the Record so the two can never drift apart.
 */
export type MembershipSourceTrust =
  /** The branch is a fact: observed at mint time, or asserted outright by an author. */
  | 'trusted'
  /** The branch was inferred from something else, and may be wrong. Consumers must surface it. */
  | 'approximate';

export const MEMBERSHIP_SOURCE_TRUST: Readonly<Record<MembershipSource, MembershipSourceTrust>> =
  Object.freeze({
    [MEMBERSHIP_SOURCE.recorded]: 'trusted',
    [MEMBERSHIP_SOURCE.legacyApprox]: 'approximate',
    // THE CASE THIS RECORD WAS BUILT FOR (P3). A human said so. Nothing was
    // inferred, so nothing is approximate, and every consumer below classifies it correctly
    // by DEFAULT rather than by remembering to exclude it.
    [MEMBERSHIP_SOURCE.assigned]: 'trusted',
  });

/**
 * The approximate sources, derived from MEMBERSHIP_SOURCE_TRUST. `ReadonlySet` is a
 * compile-time guarantee only — a Set has no runtime freeze — which is sufficient because
 * nothing in the product has any reason to mutate it.
 */
export const APPROXIMATE_SOURCES: ReadonlySet<MembershipSource> = new Set(
  MEMBERSHIP_SOURCE_VALUES.filter((v) => MEMBERSHIP_SOURCE_TRUST[v] === 'approximate')
);

/**
 * THE OTHER BRANCH CARRIER — the `branch:<slug>` TAG.
 *
 * A task's branch is written down two unrelated ways. `branch_memberships` (this module's
 * subject) points at a SPINE RECORD and is declared through positional mint. A `branch:`
 * TAG names a WORKSTREAM as a free slug and lives in `tasks.tags`. They are NOT two copies
 * of one fact: a slug is not a record id, so neither implies the other, and no rule turns
 * one into the other.
 *
 * Mandrel itself had no notion of the tag carrier at all — the prefix existed only as
 * `branchTagPrefix` in the runtime branch-board's config, on the far side of a repo
 * boundary. That is why "which branch is this task on?" was answered from the tag alone by
 * every consumer that could see one: the server never offered the other answer.
 * MEASURED on prod 2026-08-31, 157 open tasks in project riverbend: 57 tag / 28 membership
 * / 14 membership-and-no-tag / 43 tag-and-no-membership / 86 neither.
 *
 * Declared here so the read surface that now reports BOTH carriers derives the prefix from
 * one named place rather than a string literal in a route.
 */
export const BRANCH_TAG_PREFIX = 'branch:';
