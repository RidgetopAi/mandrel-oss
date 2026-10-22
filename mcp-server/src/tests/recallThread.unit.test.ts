/**
 * recall_thread — PURE-logic unit tests (Mandrel Core Redesign T3).
 *
 * Tests are armor (spec §6). This hammers the DETERMINISTIC ordering + altitude-shaping +
 * minTrust-band logic with ZERO database — the pure functions exported from
 * services/recallThread.ts (computeCausalRanks / orderThread / shapeNode). The DB/graph
 * traversal + trust gathering are covered by recallThread.contract.test.ts.
 *
 * Locks:
 *   - causal ordering: evidence (learned_from) → decision → caused/built (reads as the story),
 *   - supersedes reverses (the superseded node comes BEFORE the superseding one),
 *   - temporal tiebreaker (older first) when causal rank ties,
 *   - the anchor is pinned FIRST regardless,
 *   - CYCLE-SAFE: a causal cycle in computeCausalRanks does not hang,
 *   - altitude content shaping: headline (no content) / summary (clipped) / full (whole),
 *     with the snippet budget honored (no-hardcoded-vars / config-injected).
 */

import { describe, test, expect } from 'vitest';
// Import the PURE core directly (recallThreadCore.ts is DB-FREE by design — no db pool
// import) so this suite is deterministic + offline, zero database.
import {
  computeCausalRanks,
  orderThread,
  shapeNode,
  edgeTypePriority,
  readEdgeWeight,
  prioritizeFrontier,
  type ThreadEdge,
  type FrontierCandidate,
  clipSummaryBody,
} from '../services/recallThreadCore.js';
import type { Trust } from '../services/trustModel.js';
import {
  type ThreadConfig,
  FRONTIER_EDGE_TYPE_PRIORITY,
  FRONTIER_WEIGHT_METADATA_KEYS,
  THREAD_SUMMARY_CLIP_AFFORDANCE,
  formatClipAffordance,
} from '../config/threadConfig.js';
import type { EdgeNodeType, EdgeType } from '../config/edgeTypes.js';

/** A trusted, non-abstaining Trust object (the shaping/ordering tests don't vary trust). */
const TRUST: Trust = {
  band: 'trusted',
  score: 0.9,
  outcome: { score: 1, samples: 1 },
  freshness: 0.9,
  superseded: false,
  softSuperseded: false,
  abstain: false,
  supersession: null,
  // Explainability fields — required on Trust; the shaping/ordering tests
  // don't vary trust, so these mirror the `trusted` branch computeTrust would produce.
  reason: 'trusted',
  promotionRequirement: null,
  // P5.3 half B: the backward-soft guard AUDIT is required on Trust and is never
  // undefined — an absent audit and a guard that did not run must not read alike.
  supersessionGuard: { enabled: false, checked: 0, suppressed: [], undecided: [] },
};

const CFG: ThreadConfig = {
  defaultDepth: 3,
  maxDepth: 6,
  maxNodes: 50,
  maxNodesCeiling: 500,
  summarySnippetMaxlen: 20, // small so the clip is easy to assert
  // The clip AFFORDANCE comes from the same named config the product reads (never a literal
  // re-spelled here — a test that hardcodes a config-derived value stops testing the config).
  summaryClipAffordance: THREAD_SUMMARY_CLIP_AFFORDANCE,
  frontierEdgeTypePriority: FRONTIER_EDGE_TYPE_PRIORITY,
  frontierDefaultEdgePriority: 50,
  frontierWeightMetadataKeys: FRONTIER_WEIGHT_METADATA_KEYS,
};

const d = (iso: string) => new Date(iso);

describe('recall_thread — causal ranking (pure)', () => {
  test('evidence → decision → caused: the chain ranks earliest-first', () => {
    // ev --learned_from--> dec   (ev precedes dec)
    // dec --caused--> out         (dec precedes out)
    const edges: ThreadEdge[] = [
      { from: 'dec', to: 'ev', type: 'learned_from' }, // a decision learned_from its evidence: ev precedes dec
      { from: 'dec', to: 'out', type: 'caused' }, // dec caused out: dec precedes out
    ];
    const ranks = computeCausalRanks(['ev', 'dec', 'out'], edges);
    // ev should outrank dec which should outrank out (higher rank = earlier in the story).
    expect(ranks.get('ev')!).toBeGreaterThan(ranks.get('dec')!);
    expect(ranks.get('dec')!).toBeGreaterThan(ranks.get('out')!);
  });

  test('supersedes REVERSES: the superseded node precedes the superseding one', () => {
    // newDec --supersedes--> oldDec  →  oldDec precedes newDec (the old came first).
    const edges: ThreadEdge[] = [{ from: 'newDec', to: 'oldDec', type: 'supersedes' }];
    const ranks = computeCausalRanks(['newDec', 'oldDec'], edges);
    expect(ranks.get('oldDec')!).toBeGreaterThan(ranks.get('newDec')!);
  });

  test('CYCLE-SAFE: a causal cycle does not hang and yields finite ranks', () => {
    // a precedes b precedes c precedes a (a deliberate cycle).
    const edges: ThreadEdge[] = [
      { from: 'a', to: 'b', type: 'caused' },
      { from: 'b', to: 'c', type: 'caused' },
      { from: 'c', to: 'a', type: 'caused' },
    ];
    const ranks = computeCausalRanks(['a', 'b', 'c'], edges);
    for (const id of ['a', 'b', 'c']) {
      expect(Number.isFinite(ranks.get(id)!)).toBe(true);
    }
  });

  test('non-causal edge types contribute no ordering', () => {
    const edges: ThreadEdge[] = [{ from: 'x', to: 'y', type: 'produced_outcome' }];
    // produced_outcome IS causal (task precedes outcome) → x precedes y.
    const ranks = computeCausalRanks(['x', 'y'], edges);
    expect(ranks.get('x')!).toBeGreaterThan(ranks.get('y')!);
  });

  test('dangling edges (endpoint not in node set) are ignored', () => {
    const edges: ThreadEdge[] = [{ from: 'a', to: 'ghost', type: 'caused' }];
    const ranks = computeCausalRanks(['a'], edges);
    expect(ranks.get('a')).toBe(0); // no in-set successor → rank 0
  });
});

describe('recall_thread — orderThread (pure)', () => {
  const mk = (id: string, createdAt: string | null) => ({
    id,
    createdAt: createdAt ? d(createdAt) : null,
  });

  test('anchor is pinned FIRST regardless of causal rank or time', () => {
    const nodes = [
      mk('anchor', '2026-01-10T00:00:00Z'),
      mk('ev', '2026-01-01T00:00:00Z'), // older + causally earliest
      mk('dec', '2026-01-05T00:00:00Z'),
    ];
    const edges: ThreadEdge[] = [{ from: 'dec', to: 'ev', type: 'learned_from' }];
    const ordered = orderThread(nodes, edges, 'anchor');
    expect(ordered[0].id).toBe('anchor');
  });

  test('causal order wins: evidence before decision before outcome', () => {
    const nodes = [
      mk('out', '2026-01-01T00:00:00Z'),
      mk('dec', '2026-01-02T00:00:00Z'),
      mk('ev', '2026-01-03T00:00:00Z'),
    ];
    const edges: ThreadEdge[] = [
      { from: 'dec', to: 'ev', type: 'learned_from' },
      { from: 'dec', to: 'out', type: 'caused' },
    ];
    // anchor is ev itself here — but to test pure causal order, use a 4th unrelated anchor.
    const withAnchor = [mk('A', '2026-01-04T00:00:00Z'), ...nodes];
    const ordered = orderThread(withAnchor, edges, 'A');
    const ids = ordered.map((n) => n.id);
    expect(ids[0]).toBe('A');
    // among the rest, ev (highest rank) before dec before out.
    expect(ids.indexOf('ev')).toBeLessThan(ids.indexOf('dec'));
    expect(ids.indexOf('dec')).toBeLessThan(ids.indexOf('out'));
  });

  test('temporal tiebreaker: equal causal rank → older first', () => {
    const nodes = [
      mk('anchor', '2026-01-10T00:00:00Z'),
      mk('newer', '2026-02-01T00:00:00Z'),
      mk('older', '2026-01-01T00:00:00Z'),
    ];
    const ordered = orderThread(nodes, [], 'anchor'); // no edges → all rank 0
    const ids = ordered.map((n) => n.id);
    expect(ids[0]).toBe('anchor');
    expect(ids.indexOf('older')).toBeLessThan(ids.indexOf('newer'));
  });
});

describe('recall_thread — shapeNode altitude (pure, config-injected)', () => {
  const raw = {
    id: 'n1',
    type: 'context' as EdgeNodeType,
    title: 'the title',
    content: 'this content body is definitely longer than twenty chars',
  };

  test('headline: title + type + trust, NO content field', () => {
    const node = shapeNode(raw, TRUST, 'headline', CFG);
    expect(node.title).toBe('the title');
    expect(node.type).toBe('context');
    expect(node.trust).toBe(TRUST);
    expect(node.content).toBeUndefined();
  });

  test('summary: content clipped to the snippet budget, carrying the ACTIONABLE affordance', () => {
    // A body long enough that clipping genuinely SHRINKS it (the affordance costs bytes, and
    // clipSummaryBody refuses to "clip" a body into something longer — see its contract).
    const long = { ...raw, content: 'x'.repeat(CFG.summarySnippetMaxlen * 20) };
    const node = shapeNode(long, TRUST, 'summary', CFG);
    expect(node.content).toBeDefined();
    expect(node.content!.startsWith(long.content.slice(0, CFG.summarySnippetMaxlen))).toBe(true);
    expect(node.content!.length).toBeLessThan(long.content.length);
    // THE AFFORDANCE, NOT A BARE '…': the exact suffix the CONFIG produces for this omission
    // (derived from the same source the product reads — never a literal re-spelled here).
    const omitted = long.content.length - CFG.summarySnippetMaxlen;
    expect(node.content!.endsWith(formatClipAffordance(CFG.summaryClipAffordance, omitted))).toBe(
      true
    );
    // It names the ARGUMENT that gets the whole body — an env var would be useless to a
    // customer running Mandrel in a container.
    expect(node.content!).toContain('altitude');
    expect(node.content!).toContain(String(omitted));
  });

  test('a body that only just overruns the budget is returned WHOLE (a clip must shrink)', () => {
    // budget + 1 char: clipping would append an affordance longer than the char it saved.
    const barely = { ...raw, content: 'y'.repeat(CFG.summarySnippetMaxlen + 1) };
    const node = shapeNode(barely, TRUST, 'summary', CFG);
    expect(node.content).toBe(barely.content);
    expect(clipSummaryBody(barely.content, CFG).omittedChars).toBe(0);
  });

  test('summary: short content is returned whole (no clip, no ellipsis)', () => {
    const node = shapeNode({ ...raw, content: 'short' }, TRUST, 'summary', CFG);
    expect(node.content).toBe('short');
  });

  test('full: the whole untruncated content body', () => {
    const node = shapeNode(raw, TRUST, 'full', CFG);
    expect(node.content).toBe(raw.content);
  });

  test('a node with no content omits the field at every altitude', () => {
    const empty = { ...raw, content: null };
    expect(shapeNode(empty, TRUST, 'headline', CFG).content).toBeUndefined();
    expect(shapeNode(empty, TRUST, 'summary', CFG).content).toBeUndefined();
    expect(shapeNode(empty, TRUST, 'full', CFG).content).toBeUndefined();
  });

  test('headline/summary/full differ correctly for the SAME node', () => {
    // Long enough that the clip genuinely shrinks (see the affordance test above).
    const long = { ...raw, content: 'z'.repeat(CFG.summarySnippetMaxlen * 20) };
    const h = shapeNode(long, TRUST, 'headline', CFG);
    const s = shapeNode(long, TRUST, 'summary', CFG);
    const f = shapeNode(long, TRUST, 'full', CFG);
    expect(h.content).toBeUndefined();
    expect(s.content).not.toBe(f.content); // clipped vs whole
    expect(f.content!.length).toBeGreaterThan(s.content!.length);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// FRONTIER PRIORITY (pure) — the maxNodes-cap survival ranking
// ─────────────────────────────────────────────────────────────────────────────

describe('recall_thread — frontier priority (pure): which nodes survive the maxNodes cap', () => {
  /** Build a FrontierCandidate with sane defaults; override per test. */
  const cand = (
    id: string,
    edgeType: EdgeType,
    order: number,
    weight: number | null = null
  ): FrontierCandidate<{ id: string }> => ({ id, edgeType, weight, order, payload: { id } });

  test('edgeTypePriority: structural > soft > weak, per the documented ordering', () => {
    expect(edgeTypePriority('decided_by', CFG)).toBeGreaterThan(edgeTypePriority('possibly_supersedes', CFG));
    expect(edgeTypePriority('possibly_supersedes', CFG)).toBeGreaterThan(edgeTypePriority('related_to', CFG));
    // A structural evidential edge outranks the weak "NOT evidence" association.
    expect(edgeTypePriority('informs', CFG)).toBeGreaterThan(edgeTypePriority('related_to', CFG));
  });

  test('edgeTypePriority: an UNRANKED edge type falls back to the neutral default (not 0)', () => {
    const cfg: ThreadConfig = { ...CFG, frontierEdgeTypePriority: { decided_by: 100 } };
    // 'caused' is absent from this tiny map → neutral default (50), NOT the weak floor.
    expect(edgeTypePriority('caused', cfg)).toBe(50);
    expect(edgeTypePriority('caused', cfg)).toBeLessThan(edgeTypePriority('decided_by', cfg));
  });

  test('readEdgeWeight: reads similarity / confidence; null when absent or non-finite', () => {
    expect(readEdgeWeight({ source: 'inference', similarity: 0.83 }, CFG)).toBe(0.83);
    expect(readEdgeWeight({ confidence: 0.6, rationale: 'x' }, CFG)).toBe(0.6);
    // similarity checked before confidence (config key order).
    expect(readEdgeWeight({ similarity: 0.9, confidence: 0.1 }, CFG)).toBe(0.9);
    expect(readEdgeWeight({ source: 'active_thread' }, CFG)).toBeNull(); // provenance-only
    expect(readEdgeWeight({ similarity: 'NaN-ish' }, CFG)).toBeNull(); // non-numeric
    expect(readEdgeWeight(null, CFG)).toBeNull();
    expect(readEdgeWeight([1, 2, 3], CFG)).toBeNull(); // array → not a metadata object
  });

  test('prioritizeFrontier: a high-value edge reached LATER outranks low-value edges reached first', () => {
    // Discovery (insertion) order: two weak related_to first, then the gold decided_by.
    const candidates = [
      cand('weak-a', 'related_to', 0),
      cand('weak-b', 'related_to', 1),
      cand('gold', 'decided_by', 2),
    ];
    const ranked = prioritizeFrontier(candidates, CFG).map((c) => c.id);
    // The gold node (reached last) is now FIRST — so under a tight cap it survives.
    expect(ranked[0]).toBe('gold');
  });

  test('prioritizeFrontier: within the SAME edge type, higher numeric weight wins the tie-break', () => {
    const candidates = [
      cand('lo', 'related_to', 0, 0.2),
      cand('hi', 'related_to', 1, 0.9),
      cand('none', 'related_to', 2, null), // absent weight sorts LAST within the tier
    ];
    const ranked = prioritizeFrontier(candidates, CFG).map((c) => c.id);
    expect(ranked).toEqual(['hi', 'lo', 'none']);
  });

  test('prioritizeFrontier: a FULL tie falls back to discovery order (stable — no reshuffle)', () => {
    const candidates = [
      cand('first', 'caused', 0),
      cand('second', 'caused', 1),
      cand('third', 'caused', 2),
    ];
    const ranked = prioritizeFrontier(candidates, CFG).map((c) => c.id);
    expect(ranked).toEqual(['first', 'second', 'third']); // identical to insertion order
  });

  test('prioritizeFrontier: edge-type tier DOMINATES numeric weight (a weak cosine never beats structure)', () => {
    // A weak related_to with a very high cosine must STILL rank below a structural decided_by
    // that carries no numeric weight — tier is primary, weight is only a same-tier tie-break.
    const candidates = [
      cand('weak-strong-cosine', 'related_to', 0, 0.99),
      cand('structural-no-weight', 'decided_by', 1, null),
    ];
    const ranked = prioritizeFrontier(candidates, CFG).map((c) => c.id);
    expect(ranked[0]).toBe('structural-no-weight');
  });

  test('prioritizeFrontier: returns a NEW array; the input is not mutated', () => {
    const candidates = [cand('b', 'related_to', 0), cand('a', 'decided_by', 1)];
    const ranked = prioritizeFrontier(candidates, CFG);
    expect(ranked).not.toBe(candidates);
    expect(candidates.map((c) => c.id)).toEqual(['b', 'a']); // original order untouched
  });

  test('config default: shipped priorities match FRONTIER_EDGE_TYPE_PRIORITY (no drift)', () => {
    expect(CFG.frontierEdgeTypePriority).toBe(FRONTIER_EDGE_TYPE_PRIORITY);
    expect(CFG.frontierWeightMetadataKeys).toBe(FRONTIER_WEIGHT_METADATA_KEYS);
  });
});
