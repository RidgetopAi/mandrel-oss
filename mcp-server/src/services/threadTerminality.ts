/**
 * THREAD TERMINALITY — the PURE rule half (BRANCH-2).
 *
 * "A shared record is a DESTINATION, not a CORRIDOR." A node is ADMITTED but NOT EXPANDED
 * when the limbs it declares do not sufficiently overlap the anchor's cone.
 *
 * Pure: no database, no logger, no config module import at the decision site (the config is
 * passed in). That is what lets the rule be exercised — including its empty and
 * never-derived populations — without a DB, and what keeps ONE definition of the rule that
 * both the product and its tests read.
 *
 * Everything that touches Postgres lives in threadTerminalityWalk.ts. Nothing here decides
 * what a limb IS — that is BRANCH-1 (services/declaredLimbs.ts), whose derivation is
 * asserted byte-identical to the measured Python rule by declaredLimbsGoldenParity.
 */

import type { ThreadTerminalityConfig } from '../config/threadTerminalityConfig.js';

/**
 * WHY a node was or was not expanded. Every walked node gets exactly one of these, and the
 * telemetry counts them — this enum IS the "log why each node was terminal" guard.
 */
export const TERMINALITY_REASONS = [
  /** The anchor. Always expandable: refusing it would return a one-node thread. */
  'anchor',
  /** Overlap with the anchor's cone is at or above the threshold — walk on through. */
  'expandable',
  /** Limbs were DERIVED and the set is EMPTY: the record says nothing about where it
   *  belongs, so it cannot vouch for the walk continuing. */
  'unassignable',
  /** `declared_limbs` is NULL — never derived. NOT the same as empty (C1's third state).
   *  Whether this is terminal is a config decision; the count is reported either way. */
  'not-derived',
  /** Limbs were derived and non-empty, but mostly name OTHER lines of work. */
  'below-threshold',
] as const;

export type TerminalityReason = (typeof TERMINALITY_REASONS)[number];

/**
 * A record's materialised limb set.
 *   `null`  → the column is NULL: NEVER DERIVED. We do not know what it names.
 *   `[]`    → derived, and it names nothing resolvable: UNASSIGNABLE.
 * The two are different facts and this module never collapses them.
 */
export type DeclaredLimbs = readonly string[] | null;

export interface ExpandDecision {
  canExpand: boolean;
  reason: TerminalityReason;
  /** |limbs ∩ cone| / |limbs|, or null when there is no derived, non-empty limb set. */
  overlap: number | null;
}

/**
 * cone(anchor) = {anchor} ∪ the limb roots the anchor NAMES.
 *
 * The measured rule (`C4`) builds its cone by walking `epic:`-declared parents first and
 * then widening by one round of declared names. The parent walk is a NO-OP on every
 * population we can measure — `epic:` is declared exactly ONCE across the 192 pinned
 * records — and BRANCH-1 materialises `limbs = declared ∪ ancestors` as a single set with
 * no peer/ancestor split, so the parent chain is not reconstructible from the column.
 *
 * That is not assumed to be harmless: scoring the eval's cone against this one over the
 * 14 labeled anchors returns the SAME node set on all 14 (identical micro P/R), differing
 * only in the size of one anchor's cone (an earlier change, 3 vs 5 members) without changing what
 * that walk returns. Epic ancestors/descendants are explicitly out of scope for this task.
 */
export function buildAnchorCone(anchorId: string, anchorLimbs: DeclaredLimbs): ReadonlySet<string> {
  const cone = new Set<string>([anchorId]);
  for (const limb of anchorLimbs ?? []) cone.add(limb);
  return cone;
}

/**
 * overlap(r) = |limbs(r) ∩ cone| / |limbs(r)| — "how much of what this record names is the
 * branch you asked for".
 *
 * A RATIO and not a count, for a measured reason: on anchor an earlier change three multi-topic
 * session handoffs are labeled IN while on an earlier change five records of the identical shape
 * are labeled OUT. No threshold on a COUNT separates those; the fraction does, because on
 * an earlier change the whole day genuinely was that branch.
 *
 * Throws on an empty set rather than returning 0 or NaN: "no limbs" is a different state
 * with its own branch above, and silently scoring it 0 would fold the third state into the
 * second.
 */
export function limbOverlapFraction(
  limbs: readonly string[],
  cone: ReadonlySet<string>
): number {
  if (limbs.length === 0) {
    throw new Error('limbOverlapFraction: empty limb set has no overlap — handle it as unassignable');
  }
  const distinct = new Set(limbs);
  let hit = 0;
  for (const limb of distinct) if (cone.has(limb)) hit++;
  return hit / distinct.size;
}

/**
 * THE RULE. Returns whether the walk may pass THROUGH `nodeId`, and why.
 *
 * ADMIT-BUT-DO-NOT-TRANSIT: a `false` here never removes the node from the thread. The
 * caller stops expanding it; it stays in the returned node set. Nothing is refused
 * membership by this rule, which is why it was measured to raise precision without moving
 * recall on the shipped edge base.
 */
export function decideExpansion(
  nodeId: string,
  anchorId: string,
  limbs: DeclaredLimbs,
  cone: ReadonlySet<string>,
  cfg: ThreadTerminalityConfig
): ExpandDecision {
  if (nodeId === anchorId) return { canExpand: true, reason: 'anchor', overlap: null };
  if (limbs === null) {
    return { canExpand: !cfg.notDerivedTerminal, reason: 'not-derived', overlap: null };
  }
  if (limbs.length === 0) {
    return { canExpand: !cfg.unassignableTerminal, reason: 'unassignable', overlap: null };
  }
  const overlap = limbOverlapFraction(limbs, cone);
  return overlap >= cfg.transitOverlapThreshold
    ? { canExpand: true, reason: 'expandable', overlap }
    : { canExpand: false, reason: 'below-threshold', overlap };
}

// ─────────────────────────────────────────────────────────────────────────────
// TELEMETRY — the required instrument, not a nice-to-have
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Why this exists as a REQUIRED guard (an earlier decision §3): 57% of the live riverbend
 * corpus (1,438 of 2,524 contexts) carries no limb signal at all, versus a much
 * better-tagged eval population. Live behaviour WILL differ from the measured numbers, and
 * the difference has to be OBSERVABLE rather than assumed. `coverage` below is that
 * instrument — it reports the declared-limb coverage of each traversed set, so a
 * stranger-cliff shows up as a number instead of as a complaint.
 */
export interface TerminalityTelemetry {
  coneSize: number;
  /** Nodes the rule judged (frontier members; the anchor included). */
  judged: number;
  expanded: number;
  terminal: number;
  byReason: Record<TerminalityReason, number>;
  /** Declared-limb COVERAGE of the traversed set. `derived` = non-null column. */
  coverage: { derived: number; notDerived: number; unassignable: number };
  /** Every node the rule refused to transit, with its reason. Bounded by the walk's own
   *  maxNodes cap, so no separate truncation (and no truncation to misreport). */
  terminalNodes: Array<{ id: string; reason: TerminalityReason; overlap: number | null }>;
}

export function newTerminalityTelemetry(coneSize: number): TerminalityTelemetry {
  const byReason = Object.fromEntries(TERMINALITY_REASONS.map((r) => [r, 0])) as Record<
    TerminalityReason,
    number
  >;
  return {
    coneSize,
    judged: 0,
    expanded: 0,
    terminal: 0,
    byReason,
    coverage: { derived: 0, notDerived: 0, unassignable: 0 },
    terminalNodes: [],
  };
}

export function recordTerminalityDecision(
  telemetry: TerminalityTelemetry,
  nodeId: string,
  limbs: DeclaredLimbs,
  decision: ExpandDecision
): void {
  telemetry.judged++;
  telemetry.byReason[decision.reason]++;
  if (decision.canExpand) telemetry.expanded++;
  else {
    telemetry.terminal++;
    telemetry.terminalNodes.push({
      id: nodeId,
      reason: decision.reason,
      overlap: decision.overlap,
    });
  }
  if (limbs === null) telemetry.coverage.notDerived++;
  else if (limbs.length === 0) telemetry.coverage.unassignable++;
  else telemetry.coverage.derived++;
}
