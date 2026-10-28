/**
 * TreeWalker story ORDERING — the CANONICAL recall_thread order, MIRRORED (PHASE 2
 * item e, story half).
 *
 * ── WHAT THIS REPLACES ────────────────────────────────────────────────────────────────
 * buildStory used to hand-replicate "recall_thread ordering" as a bespoke 5-slot
 * narrative (an earlier audit PROSE finding). The REAL recall_thread order is
 * mcp-server/src/services/recallThreadCore.ts: anchor pinned first, then causal rank
 * (longest-downstream-chain depth over the causal edge directions), then temporal, then
 * id — cycle-safe. This module mirrors exactly that (same constraint as
 * treewalkerTrustModel.ts: the mcp-server source is not importable here — measured
 * Dockerfile build context + CJS/ESM split; see that module's header).
 *
 * DRIFT GUARD: treewalkerStoryOrderParity.test.ts loads the REAL recallThreadCore off
 * disk, pins every edge type's causal direction against the canonical
 * causalDirectionOf() over the canonical EDGE_TYPES population, and asserts orderThread
 * parity on fixture graphs (chains, cycles, ties). It refuses to pass if the canonical
 * file cannot be found.
 */

/**
 * The causal ordering an edge type contributes, or undefined for the weak/soft edges
 * (related_to, possibly_supersedes, subtask_of… deliberately order nothing).
 * 'forward' = from precedes to · 'reverse' = to precedes from.
 */
const CAUSAL_DIRECTION: Record<string, 'forward' | 'reverse'> = {
  learned_from: 'reverse',
  decided_by: 'forward',
  caused: 'forward',
  informs: 'forward',
  produced_outcome: 'forward',
  built_by: 'reverse',
  proposed_by: 'reverse',
  supersedes: 'reverse',
  depends_on: 'reverse',
};

export function causalDirectionOf(edgeType: string): 'forward' | 'reverse' | undefined {
  return CAUSAL_DIRECTION[edgeType];
}

/**
 * Weak edge types: a node joined ONLY by these sorts after causal/membership-joined nodes.
 * Mirrors the canonical THREAD_WEAK_EDGE_TYPES default (mcp-server config/threadConfig.ts).
 */
export const WEAK_EDGE_TYPES: readonly string[] = ['related_to'];

/** One edge in the walked subgraph (from → to, by type) — the canonical shape. */
export interface OrderEdge {
  from: string;
  to: string;
  type: string;
}

/**
 * Causal "rank" per node: longest-downstream-chain depth in the causal DAG. Higher rank
 * = earlier in the story. Cycle-safe (an on-stack node returns 0). Mirrors the canonical
 * computeCausalRanks exactly.
 */
export function computeCausalRanks(nodeIds: string[], edges: OrderEdge[]): Map<string, number> {
  const idset = new Set(nodeIds);
  const precedes = new Map<string, Set<string>>();
  for (const id of nodeIds) precedes.set(id, new Set());
  for (const e of edges) {
    if (!idset.has(e.from) || !idset.has(e.to)) continue;
    const dir = CAUSAL_DIRECTION[e.type];
    if (!dir) continue; // edge type carries no ordering
    const [a, b] = dir === 'reverse' ? [e.to, e.from] : [e.from, e.to];
    if (a === b) continue; // self-loop contributes no ordering
    precedes.get(a)?.add(b); // a comes before b (a is always in the map — seeded above)
  }

  const rank = new Map<string, number>();
  const onStack = new Set<string>();
  function depthOf(id: string): number {
    const known = rank.get(id);
    if (known !== undefined) return known;
    if (onStack.has(id)) return 0; // cycle backstop — break without recursing
    onStack.add(id);
    let best = 0;
    for (const nxt of precedes.get(id) ?? []) best = Math.max(best, depthOf(nxt) + 1);
    onStack.delete(id);
    rank.set(id, best);
    return best;
  }
  for (const id of nodeIds) depthOf(id);
  return rank;
}

/**
 * The canonical thread order: 1. anchor pinned first · 2. nodes joined by a non-weak
 * (causal/membership) edge before weak-only (related_to) nodes · 3. higher causal rank first ·
 * 4. older created_at first · 5. id (stable). Mirrors the canonical orderThread exactly
 * (incl. missing createdAt sorting LAST via +Infinity).
 */
export function orderThread<T extends { id: string; createdAt: Date | null }>(
  nodes: T[],
  edges: OrderEdge[],
  anchorId: string,
  weakEdgeTypes: readonly string[] = WEAK_EDGE_TYPES,
): T[] {
  const ranks = computeCausalRanks(nodes.map((n) => n.id), edges);
  const weak = new Set(weakEdgeTypes);
  const idset = new Set(nodes.map((n) => n.id));
  const strong = new Set<string>(); // nodes with >=1 non-weak edge to another node in the set
  for (const e of edges) {
    if (weak.has(e.type) || !idset.has(e.from) || !idset.has(e.to)) continue;
    strong.add(e.from);
    strong.add(e.to);
  }
  const time = (n: T): number => (n.createdAt ? n.createdAt.getTime() : Number.POSITIVE_INFINITY);
  return [...nodes].sort((a, b) => {
    if (a.id === anchorId) return -1;
    if (b.id === anchorId) return 1;
    const wa = strong.has(a.id) ? 0 : 1;
    const wb = strong.has(b.id) ? 0 : 1;
    if (wa !== wb) return wa - wb; // weak-only joined nodes after causal/membership ones
    const ra = ranks.get(a.id) ?? 0;
    const rb = ranks.get(b.id) ?? 0;
    if (ra !== rb) return rb - ra; // higher rank first
    const ta = time(a);
    const tb = time(b);
    if (ta !== tb) return ta - tb; // older first
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}
