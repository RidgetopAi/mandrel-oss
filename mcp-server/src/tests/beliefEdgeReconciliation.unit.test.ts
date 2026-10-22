/**
 * belief EDGE RECONCILIATION — PURE unit tests (Phase 4; Auditor finding #7 + BL-3 two-tier).
 *
 * Locks the RE-ADJUDICATION REVERSIBILITY fix AND the BL-3 two-belief-edge generalization
 * with NO DB: the reconciler's mint/retract behaviour is exercised against an IN-MEMORY fake
 * `links` table that mirrors the real links-service contracts (mintEdge idempotent on
 * (from,to,type) + records metadata; unlinkEdge honours the createdBy provenance guard).
 * Because the fake is faithful, these assertions go RED the moment the mint/retract logic is
 * reverted — proving the behaviour, not just the happy path.
 *
 * The properties under test:
 *   - Auditor #7 (design ca9a33c0; foundation-review 4c0a50ad): "verdicts are DATA and
 *     re-adjudication is REVERSIBLE" — a re-adjudication that no longer supports the prior
 *     edge must WITHDRAW it, an unchanged verdict is idempotent (no churn), and a human-
 *     curated edge is NEVER clobbered (provenance guard).
 *   - BL-3: the SOFT outcome mints a `possibly_supersedes` edge; a direction
 *     flip leaves EXACTLY the right single edge, and `none` retracts BOTH edge types.
 *   - 57f35350: `supersedes` is NOT MINTABLE here at all. The retraction sweep still covers
 *     it, which is what WITHDRAWS a hard edge minted by the pre-57f35350 code when its pair
 *     is re-adjudicated — the tests that SEED a HARD edge and assert it is retracted are
 *     that path, and they are the reason `HARD` still appears in this file.
 *
 * COVERAGE CHANGED BY 57f35350: the tests that CONSTRUCTED a `mint_supersedes` outcome are
 * gone, because the type no longer has that member and the compiler now rejects it — a
 * strictly stronger guard than a runtime assertion. The BEHAVIOURS they covered (direction
 * flip, idempotent re-mint, first-time mint, the human-edge provenance guard) are all still
 * covered below, exercised through the soft outcome, which is the only one that exists.
 */

import { describe, test, expect, beforeEach } from 'vitest';

import { reconcileBeliefEdge } from '../services/belief/edgeReconciliation.js';
import type { ReconcileDeps } from '../services/belief/edgeReconciliation.js';
import type { BeliefOutcome } from '../services/belief/beliefDerivation.js';
import { BELIEF_EDGE_CREATED_BY } from '../config/beliefConfig.js';
import { EDGE_MINT_VIA } from '../config/edgeProvenanceConfig.js';

const A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

const a = { id: A, type: 'context' as const };
const b = { id: B, type: 'context' as const };

const HARD = 'supersedes';
const SOFT = 'possibly_supersedes';

/** An in-memory stand-in for the `links` table, faithful to the real primitive contracts. */
class FakeLinks {
  private edges = new Map<
    string,
    { id: string; createdBy: string | null; via: string | null; metadata: Record<string, unknown> }
  >();
  private seq = 0;

  private key(fromId: string, toId: string, edgeType: string): string {
    return `${fromId}|${toId}|${edgeType}`;
  }

  /** Mirrors mintEdge: idempotent on (from,to,type) — re-mint is a no-op returning the id. */
  mint: ReconcileDeps['mintEdge'] = async (input) => {
    const k = this.key(input.fromId, input.toId, input.edgeType);
    const existing = this.edges.get(k);
    if (existing) return { created: false, edgeId: existing.id };
    const id = `edge-${++this.seq}`;
    this.edges.set(k, {
      id,
      createdBy: input.createdBy ?? null,
      via: input.via ?? null,
      metadata: input.metadata ?? {},
    });
    return { created: true, edgeId: id };
  };

  /** Mirrors unlinkEdge: deletes only if it exists AND (no guard OR created_by matches). */
  unlink: ReconcileDeps['unlinkEdge'] = async (input) => {
    const k = this.key(input.fromId, input.toId, input.edgeType);
    const existing = this.edges.get(k);
    if (!existing) return { removed: false };
    if (input.createdBy !== undefined && existing.createdBy !== input.createdBy) {
      return { removed: false }; // provenance guard: not ours → leave it
    }
    this.edges.delete(k);
    return { removed: true };
  };

  seed(fromId: string, toId: string, edgeType: string, createdBy: string | null): string {
    const id = `edge-${++this.seq}`;
    this.edges.set(this.key(fromId, toId, edgeType), {
      id,
      createdBy,
      // A SEEDED edge stands for a row that already existed; its via is not this
      // reconciler's to claim, and viaOf assertions below only ever read MINTED rows.
      via: null,
      metadata: {},
    });
    return id;
  }

  /** edgeType is REQUIRED, deliberately: it defaulted to HARD, and after 57f35350 HARD is
   *  never minted — so a bare has(a,b) silently asked about the channel under test's
   *  opposite. Making it explicit turns that into a compile error instead of a puzzle. */
  has(fromId: string, toId: string, edgeType: string): boolean {
    return this.edges.has(this.key(fromId, toId, edgeType));
  }

  metaOf(fromId: string, toId: string, edgeType: string): Record<string, unknown> | undefined {
    return this.edges.get(this.key(fromId, toId, edgeType))?.metadata;
  }

  /** The mint_via the reconciler passed for this edge (SK4). */
  viaOf(fromId: string, toId: string, edgeType: string): string | null | undefined {
    return this.edges.get(this.key(fromId, toId, edgeType))?.via;
  }

  get size(): number {
    return this.edges.size;
  }
}

let links: FakeLinks;
let deps: ReconcileDeps;

beforeEach(() => {
  links = new FakeLinks();
  deps = { mintEdge: links.mint, unlinkEdge: links.unlink };
});

const POOL = {} as never; // reconcile forwards this to the (faked) primitives; never touched

const dropOutcome = (reason: 'restates' | 'unrelated'): BeliefOutcome => ({
  action: 'none',
  reason,
});

/**
 * The ONLY supersession outcome the derivation can produce (57f35350): it mints a
 * `possibly_supersedes` edge (from→to) and retracts any belief `supersedes` on the pair.
 */
const softOutcome = (fromId: string, toId: string): BeliefOutcome => ({
  action: 'soft_possibly_superseded',
  fromId,
  toId,
  mode: 'replaced',
  confidence: 0.79,
  direction: fromId === A ? 'a_supersedes_b' : 'b_supersedes_a',
  rationale: 'r',
});

describe('reconcileBeliefEdge — SOFT tier mints possibly_supersedes (BL-3)', () => {
  test('soft outcome on a fresh pair mints EXACTLY ONE possibly_supersedes edge (right direction + metadata), no supersedes', async () => {
    const meta = {
      confidence: 0.79,
      reason: ['below_confidence'],
      provenance: BELIEF_EDGE_CREATED_BY,
      rationale: 'r',
      cosine: 0.7,
      model: 'claude-sonnet-5',
      mode: 'replaced',
    };
    const res = await reconcileBeliefEdge(
      { a, b, outcome: softOutcome(A, B), projectId: null, edgeMetadata: meta },
      POOL,
      deps
    );

    expect(res.mintedEdgeType).toBe(SOFT);
    expect(res.edgeCreated).toBe(true);
    expect(res.mintedEdgeId).not.toBeNull();
    expect(res.retracted).toEqual([]);
    // The SOFT edge exists (a→b), and NO hard edge was minted — exactly one belief edge.
    expect(links.has(A, B, SOFT)).toBe(true);
    expect(links.has(A, B, HARD)).toBe(false);
    expect(links.has(B, A, SOFT)).toBe(false);
    expect(links.size).toBe(1);
    // Metadata is stamped onto the soft edge (self-describing for BL-4).
    expect(links.metaOf(A, B, SOFT)).toMatchObject(meta);
    // SK4: the SOFT edge names its mint path. This is the ONLY executable
    // assertion on this via — belief adjudication needs an LLM provider, so it is not
    // reachable from the tool-surface sweep in edgeProvenanceFailClosed.contract.test.ts,
    // and Reviewer measured that a wrong-but-valid via here passed the entire suite while
    // moving 23% of the prod corpus from guessed to declared.
    expect(links.viaOf(A, B, SOFT)).toBe(EDGE_MINT_VIA.beliefAdjudication);
  });

  test('soft direction is honoured: b_supersedes_a mints possibly_supersedes b→a', async () => {
    const res = await reconcileBeliefEdge(
      { a, b, outcome: softOutcome(B, A), projectId: null, edgeMetadata: {} },
      POOL,
      deps
    );
    expect(res.mintedEdgeType).toBe(SOFT);
    expect(links.has(B, A, SOFT)).toBe(true);
    expect(links.has(A, B, SOFT)).toBe(false);
    expect(links.size).toBe(1);
  });

  test('unchanged SOFT verdict is idempotent: no new row, nothing retracted', async () => {
    links.seed(A, B, SOFT, BELIEF_EDGE_CREATED_BY);
    const res = await reconcileBeliefEdge(
      { a, b, outcome: softOutcome(A, B), projectId: null, edgeMetadata: {} },
      POOL,
      deps
    );
    expect(res.edgeCreated).toBe(false);
    expect(res.mintedEdgeType).toBe(SOFT);
    expect(res.retracted).toEqual([]);
    expect(links.size).toBe(1);
  });
});

describe('reconcileBeliefEdge — TIER SWITCH (hard↔soft mutual exclusion, BL-3)', () => {
  test('stale HARD supersedes re-adjudicated SOFT → supersedes retracted, possibly_supersedes minted', async () => {
    links.seed(A, B, HARD, BELIEF_EDGE_CREATED_BY);

    const res = await reconcileBeliefEdge(
      { a, b, outcome: softOutcome(A, B), projectId: null, edgeMetadata: { confidence: 0.79 } },
      POOL,
      deps
    );

    expect(res.mintedEdgeType).toBe(SOFT);
    expect(res.edgeCreated).toBe(true);
    expect(res.retracted).toEqual([{ fromId: A, toId: B, edgeType: HARD }]);
    // Exactly the right single edge remains: soft present, hard gone.
    expect(links.has(A, B, SOFT)).toBe(true);
    expect(links.has(A, B, HARD)).toBe(false);
    expect(links.size).toBe(1);
  });

  // DELETED by 57f35350: 'stale SOFT re-adjudicated HARD → supersedes minted'. That
  // transition is not merely untested, it is unconstructible — `mint_supersedes` is not a
  // member of BeliefOutcome, so the test could not be written without a cast. Its inverse
  // (stale HARD re-adjudicated SOFT) is the transition that matters now and is the test
  // directly above this comment.

  test('SOFT with a direction FLIP vs a stale soft edge: old soft retracted, new soft minted', async () => {
    links.seed(A, B, SOFT, BELIEF_EDGE_CREATED_BY); // stale a→b soft

    const res = await reconcileBeliefEdge(
      { a, b, outcome: softOutcome(B, A), projectId: null, edgeMetadata: {} }, // now b→a
      POOL,
      deps
    );

    expect(res.mintedEdgeType).toBe(SOFT);
    expect(links.has(B, A, SOFT)).toBe(true);
    expect(links.has(A, B, SOFT)).toBe(false);
    expect(res.retracted).toEqual([{ fromId: A, toId: B, edgeType: SOFT }]);
    expect(links.size).toBe(1);
  });
});

describe('reconcileBeliefEdge — DROP TO NONE retracts BOTH belief edge types (BL-3)', () => {
  test('none retracts a stale HARD supersedes edge', async () => {
    links.seed(A, B, HARD, BELIEF_EDGE_CREATED_BY);
    const res = await reconcileBeliefEdge(
      { a, b, outcome: dropOutcome('restates'), projectId: null, edgeMetadata: {} },
      POOL,
      deps
    );
    expect(res.mintedEdgeId).toBeNull();
    expect(res.mintedEdgeType).toBeNull();
    expect(res.retracted).toEqual([{ fromId: A, toId: B, edgeType: HARD }]);
    expect(links.size).toBe(0);
  });

  test('none retracts a stale SOFT possibly_supersedes edge', async () => {
    links.seed(A, B, SOFT, BELIEF_EDGE_CREATED_BY);
    const res = await reconcileBeliefEdge(
      { a, b, outcome: dropOutcome('unrelated'), projectId: null, edgeMetadata: {} },
      POOL,
      deps
    );
    expect(res.mintedEdgeId).toBeNull();
    expect(res.retracted).toEqual([{ fromId: A, toId: B, edgeType: SOFT }]);
    expect(links.has(A, B, SOFT)).toBe(false);
    expect(links.size).toBe(0);
  });

  test('none retracts BOTH types if (inconsistently) both are present on the pair', async () => {
    // A hypothetical inconsistent prior state — none must sweep the pair clean of ALL
    // belief edges regardless of tier/direction.
    links.seed(A, B, HARD, BELIEF_EDGE_CREATED_BY);
    links.seed(B, A, SOFT, BELIEF_EDGE_CREATED_BY);

    const res = await reconcileBeliefEdge(
      { a, b, outcome: dropOutcome('restates'), projectId: null, edgeMetadata: {} },
      POOL,
      deps
    );

    expect(res.retracted).toEqual(
      expect.arrayContaining([
        { fromId: A, toId: B, edgeType: HARD },
        { fromId: B, toId: A, edgeType: SOFT },
      ])
    );
    expect(res.retracted).toHaveLength(2);
    expect(links.size).toBe(0);
  });
});

describe('reconcileBeliefEdge — RETRACTION / IDEMPOTENCY (fails-when-reverted)', () => {
  test('a legacy HARD supersedes → none (restates): the edge is RETRACTED, id cleared', async () => {
    links.seed(A, B, HARD, BELIEF_EDGE_CREATED_BY);
    const res = await reconcileBeliefEdge(
      { a, b, outcome: dropOutcome('restates'), projectId: null, edgeMetadata: {} },
      POOL,
      deps
    );
    expect(res.mintedEdgeId).toBeNull();
    expect(res.edgeCreated).toBe(false);
    expect(res.retracted).toEqual([{ fromId: A, toId: B, edgeType: HARD }]);
    expect(links.has(A, B, HARD)).toBe(false);
    expect(links.size).toBe(0);
  });

  test('DIRECTION FLIP (a→b becomes b→a): old edge retracted, new edge minted', async () => {
    const oldId = links.seed(A, B, SOFT, BELIEF_EDGE_CREATED_BY);
    const res = await reconcileBeliefEdge(
      { a, b, outcome: softOutcome(B, A), projectId: null, edgeMetadata: { confidence: 0.79 } },
      POOL,
      deps
    );
    expect(links.has(B, A, SOFT)).toBe(true);
    expect(links.has(A, B, SOFT)).toBe(false);
    expect(res.edgeCreated).toBe(true);
    expect(res.mintedEdgeId).not.toBeNull();
    expect(res.mintedEdgeId).not.toBe(oldId);
    expect(res.retracted).toEqual([{ fromId: A, toId: B, edgeType: SOFT }]);
    expect(links.size).toBe(1);
  });

  test('unchanged verdict: mint is a no-op, nothing retracted, edge id preserved', async () => {
    const existingId = links.seed(A, B, SOFT, BELIEF_EDGE_CREATED_BY);
    const res = await reconcileBeliefEdge(
      { a, b, outcome: softOutcome(A, B), projectId: null, edgeMetadata: { confidence: 0.79 } },
      POOL,
      deps
    );
    expect(res.edgeCreated).toBe(false);
    expect(res.mintedEdgeId).toBe(existingId);
    expect(res.retracted).toEqual([]);
    expect(links.has(A, B, SOFT)).toBe(true);
    expect(links.size).toBe(1);
  });

  test('first-time mint (no prior edge): mints the SOFT edge only, retracts nothing', async () => {
    const res = await reconcileBeliefEdge(
      { a, b, outcome: softOutcome(A, B), projectId: null, edgeMetadata: { confidence: 0.79 } },
      POOL,
      deps
    );
    expect(res.edgeCreated).toBe(true);
    expect(res.mintedEdgeId).not.toBeNull();
    expect(res.mintedEdgeType).toBe(SOFT);
    expect(res.retracted).toEqual([]);
    expect(links.has(A, B, SOFT)).toBe(true);
    // 57f35350: the reconciler never creates a `supersedes` row, on ANY outcome.
    expect(links.has(A, B, HARD)).toBe(false);
    expect(links.viaOf(A, B, SOFT)).toBe(EDGE_MINT_VIA.beliefAdjudication);
  });

  test('none verdict with no prior edge: no-op (nothing to retract, nothing minted)', async () => {
    const res = await reconcileBeliefEdge(
      { a, b, outcome: dropOutcome('unrelated'), projectId: null, edgeMetadata: {} },
      POOL,
      deps
    );
    expect(res.mintedEdgeId).toBeNull();
    expect(res.edgeCreated).toBe(false);
    expect(res.retracted).toEqual([]);
    expect(links.size).toBe(0);
  });
});

describe('reconcileBeliefEdge — PROVENANCE (never clobber a human edge)', () => {
  test('a human-curated supersedes edge is NOT retracted on a drop verdict', async () => {
    links.seed(A, B, HARD, 'link'); // explicit link, not the belief adjudicator
    const res = await reconcileBeliefEdge(
      { a, b, outcome: dropOutcome('restates'), projectId: null, edgeMetadata: {} },
      POOL,
      deps
    );
    expect(res.retracted).toEqual([]);
    expect(links.has(A, B, HARD)).toBe(true);
  });

  test('a human-curated HARD supersedes edge is NOT retracted when we mint the soft edge', async () => {
    // The declared exclusion edge a human made must survive a belief pass on the same pair —
    // the provenance guard, in the direction that matters after 57f35350: the declared hard
    // edge is now the ONLY kind of hard edge, and the adjudicator must not touch it.
    links.seed(A, B, HARD, 'link'); // human hard edge on the same pair
    const res = await reconcileBeliefEdge(
      { a, b, outcome: softOutcome(A, B), projectId: null, edgeMetadata: { confidence: 0.79 } },
      POOL,
      deps
    );
    expect(res.mintedEdgeType).toBe(SOFT);
    expect(links.has(A, B, SOFT)).toBe(true);
    expect(links.has(A, B, HARD)).toBe(true); // human edge survives
    expect(res.retracted).toEqual([]);
  });
});
