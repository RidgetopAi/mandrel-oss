/**
 * DECLARED-SUBGRAPH REACHABILITY — the PURE core of the backward-soft guard
 * (P5.3 half B).
 *
 * ONE question, answered TRI-STATE:
 *
 *   > Following DECLARED supersession edges only, starting at `from`, can I reach `to`
 *   > within `maxHops`?
 *
 * DB-FREE ON PURPOSE, exactly like trustModel.ts is DB-free next to trust.ts. The adjacency
 * map is handed in; the caller (services/trust.ts) is the one that reads Postgres. That is
 * what lets the whole decision procedure be hammered by unit tests with zero database — and
 * it is what makes a mutation probe of the reachability check itself possible at all.
 *
 * ── THE THREE HARD REQUIREMENTS, and where each is enforced ────────────────────────────
 *
 * 1. DECLARED EDGES ONLY. Enforced by CONSTRUCTION rather than by a filter in here: this
 *    function has no notion of an edge tier. It sees an adjacency map, and the only builder
 *    of that map (`services/trust.ts`) selects `edge_type = 'supersedes'` with a non-belief
 *    `created_by`. A soft edge can therefore never be used as evidence to justify or
 *    suppress another soft edge, because a soft edge is not in the input at all. Put the
 *    tier test anywhere else and it becomes a thing a future caller can forget.
 *
 * 2. CYCLE-SAFE AND HOP-BOUNDED. The real data contains a cycle (see
 *    supersessionGuardConfig.ts for the measured prod case), so a naive walk hangs. BFS with
 *    a visited set terminates regardless; the bound is separate and is about ANSWER QUALITY,
 *    not termination.
 *
 * 3. TRI-STATE — reached / ended / undecided. `undecided` is C1's third state ("I could not
 *    measure") and it is NOT a synonym for "no". A cycle in the DECLARED subgraph means the
 *    declared data is not a partial order, so "does X supersede Y" HAS NO well-defined
 *    answer; reporting that as `ended` would be a confident wrong verdict. Same for the hop
 *    bound: running out of budget is not evidence of absence.
 *
 * ── WHY `reached` OUTRANKS `undecided` ─────────────────────────────────────────────────
 * A `reached` verdict is CONSTRUCTIVE: it is backed by a concrete path `from → … → to` that
 * was actually walked, and `hops` is its length. A cycle or an exhausted budget somewhere
 * ELSE in the subgraph cannot falsify a path we have in hand. So BFS returns `reached` the
 * moment it dequeues the target, without waiting to find out whether the rest of the
 * subgraph is well-formed. `undecided` is only ever reported when the walk finished WITHOUT
 * a witness AND something stopped it from being exhaustive.
 */

/** The verdict. Three states, never two. */
export type ReachVerdict = 'reached' | 'ended' | 'undecided';

/** Why a walk came back `undecided` — null on every other verdict. */
export type UndecidedCause = 'cycle' | 'hop-bound';

export interface ReachResult {
  verdict: ReachVerdict;
  /**
   * The length of the witnessed path, in declared hops, when `verdict === 'reached'`.
   * null otherwise — an unreached walk has no path, and reporting 0 would read as
   * "reached at zero hops".
   */
  hops: number | null;
  /** Which of the two stoppers produced `undecided`; null unless `verdict === 'undecided'`. */
  undecidedCause: UndecidedCause | null;
  /** How many distinct nodes the walk visited (the anchor included). Observability only. */
  visited: number;
}

/**
 * Does `from` reach `to` over the DECLARED adjacency, within `maxHops`?
 *
 * @param adjacency  node id → the ids it DECLARED-supersedes (edge direction: key supersedes
 *                   each value). A missing key means "no outgoing declared edges", which is
 *                   different from an empty array only in the caller's bookkeeping.
 * @param maxHops    the hop budget. A non-positive budget means no step may be taken; that is
 *                   a legitimate configuration and it yields `undecided` when `from` HAS
 *                   outgoing edges (we were stopped before we could look) and `ended` when it
 *                   does not (there was nothing to look at — an exhaustive answer).
 *
 * SELF-EDGE: `from === to` returns `reached` at 0 hops. A record cannot supersede itself, so
 * a soft edge claiming it is contradicted by the identity of the record, at zero cost, and
 * the walk never starts.
 */
export function declaredReaches(
  from: string,
  to: string,
  adjacency: ReadonlyMap<string, readonly string[]>,
  maxHops: number
): ReachResult {
  if (from === to) {
    return { verdict: 'reached', hops: 0, undecidedCause: null, visited: 1 };
  }

  const visited = new Set<string>([from]);
  let frontier: string[] = [from];
  let cycleHit = false;

  for (let depth = 1; depth <= maxHops; depth++) {
    const next: string[] = [];
    for (const node of frontier) {
      for (const child of adjacency.get(node) ?? []) {
        if (child === to) {
          // CONSTRUCTIVE WITNESS — return immediately. See the header for why this outranks
          // a cycle found elsewhere.
          return { verdict: 'reached', hops: depth, undecidedCause: null, visited: visited.size + 1 };
        }
        if (visited.has(child)) {
          // We have arrived at a node we already expanded by a DIFFERENT edge. In a
          // supersession graph that is a cycle or a diamond; either way the declared data
          // is not a clean chain, and this walk's "no" would be a claim about data whose
          // ordering is not well-defined. Record it — it only MATTERS if we finish without
          // a witness (checked below).
          cycleHit = true;
          continue;
        }
        visited.add(child);
        next.push(child);
      }
    }
    if (next.length === 0) {
      // EXHAUSTIVE: the declared subgraph reachable from `from` was fully enumerated inside
      // the budget and `to` was not in it. A real, checkable "no" — unless the enumeration
      // itself ran over ill-ordered data.
      return cycleHit
        ? { verdict: 'undecided', hops: null, undecidedCause: 'cycle', visited: visited.size }
        : { verdict: 'ended', hops: null, undecidedCause: null, visited: visited.size };
    }
    frontier = next;
  }

  // THE BUDGET RAN OUT. Whether that STOPPED us is a separate question from whether it
  // EXPIRED: a frontier of nodes that have no outgoing declared edges at all is an
  // exhaustive enumeration that merely happened to finish on the last tick — and, at
  // maxHops <= 0, `from` itself with no outgoing edges is the same exhaustive case. Only an
  // UNEXPANDED frontier is a genuine "I was stopped".
  const stopped = frontier.some((node) => (adjacency.get(node) ?? []).length > 0);
  if (stopped) {
    // The hop bound is reported ahead of the cycle because it is the stopper that actually
    // ended this walk, and it is the one an operator can move (maxHops is a config value).
    return { verdict: 'undecided', hops: null, undecidedCause: 'hop-bound', visited: visited.size };
  }
  return cycleHit
    ? { verdict: 'undecided', hops: null, undecidedCause: 'cycle', visited: visited.size }
    : { verdict: 'ended', hops: null, undecidedCause: null, visited: visited.size };
}
