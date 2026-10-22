/**
 * RECIPROCAL-RANK FUSION — unit test (SEARCH P2b, BUILD 2).
 *
 * services/rankFusion.ts is pure on purpose, and this file is why: the claims made about the
 * RRF constant in config/hybridSearchConfig.ts — that it cannot create or suppress the empty
 * state, and that it is a damper rather than a per-channel weight — are ARITHMETIC claims,
 * and arithmetic claims should be checkable without a corpus, an embedder or a database.
 *
 * WHAT THIS FILE DOES NOT CLAIM. It does not assert that the SHIPPED ordering is insensitive
 * to k. Measured on the real question sets, it is not: every score metric is identical at
 * k ∈ {1,10,30,60,120,600} and rank 1 is identical on 335 of 335 question-runs, but the order
 * of positions 2-5 on the exact-token arm moves. That is a finding about a corpus, it is
 * reported in RESULTS-P2b.md, and pretending a unit test had established it would be exactly
 * the kind of prose-coverage claim that passes a gate while being false.
 */

import { describe, test, expect } from 'vitest';
import { fuseByRank } from '../services/rankFusion.js';
import { HYBRID_SEARCH_CONFIG, FUSION_CHANNELS, maxFusedScore } from '../config/hybridSearchConfig.js';

const K = HYBRID_SEARCH_CONFIG.rrfK;

describe('fuseByRank — the arithmetic the config comment asserts', () => {
  test('the fused set is EXACTLY the union of the channels, at every k', () => {
    const channels = [
      { channel: 'semantic' as const, ranked: ['a', 'b'] },
      { channel: 'lexical-ident' as const, ranked: ['c'] },
      { channel: 'lexical-prose' as const, ranked: ['b', 'd'] },
    ];
    // THE EMPTY-STATE CLAIM: no value of k adds or removes a document. This is the property
    // that distinguishes k from a similarity FLOOR, which P1 measured to be impossible.
    for (const k of [0.001, 1, 60, 1e6]) {
      const ids = [...fuseByRank(channels, k).keys()].sort();
      expect(ids).toEqual(['a', 'b', 'c', 'd']);
    }
  });

  test('a document no channel returned is absent, not zero-scored', () => {
    const fused = fuseByRank([{ channel: 'semantic', ranked: ['a'] }], K);
    expect(fused.has('zzz')).toBe(false);
  });

  test('EMPTY channels, and an empty channel LIST, produce an empty fusion', () => {
    // The empty and absent populations (C3) — these are the inputs that slip through.
    expect(fuseByRank([], K).size).toBe(0);
    expect(fuseByRank(FUSION_CHANNELS.map((c) => ({ channel: c, ranked: [] })), K).size).toBe(0);
  });

  test('a duplicate id within one channel takes its BEST rank and is not summed', () => {
    const dup = fuseByRank([{ channel: 'semantic', ranked: ['a', 'b', 'a'] }], K);
    const single = fuseByRank([{ channel: 'semantic', ranked: ['a', 'b'] }], K);
    expect(dup.get('a')!.fused).toBeCloseTo(single.get('a')!.fused, 12);
    expect(dup.get('a')!.ranks.semantic).toBe(1);
  });

  test('agreement across channels beats a single first place — the whole point of fusing', () => {
    const fused = fuseByRank(
      [
        { channel: 'semantic', ranked: ['solo', 'agreed'] },
        { channel: 'lexical-prose', ranked: ['agreed'] },
      ],
      K,
    );
    expect(fused.get('agreed')!.fused).toBeGreaterThan(fused.get('solo')!.fused);
  });

  test('k is a DAMPER, not a per-channel weight: it applies identically to every channel', () => {
    // Swapping which channel produced which list cannot change any fused score, for any k.
    const asIs = fuseByRank(
      [{ channel: 'semantic', ranked: ['x', 'y'] }, { channel: 'lexical-prose', ranked: ['y'] }],
      K,
    );
    const swapped = fuseByRank(
      [{ channel: 'lexical-prose', ranked: ['x', 'y'] }, { channel: 'semantic', ranked: ['y'] }],
      K,
    );
    for (const id of ['x', 'y']) {
      expect(asIs.get(id)!.fused).toBeCloseTo(swapped.get(id)!.fused, 12);
    }
  });

  test('a small k is STEEP and a large k is FLAT — the mechanism behind the measured k-finding', () => {
    // One channel's rank 1 versus two channels' rank 3. Small k: the solo first place wins.
    // Large k: agreement wins. This is not a defect; it is what k means, and it is why the
    // exact-token arm — where the two channels disagree most — is the arm whose positions
    // 2-5 move with k on the real corpus.
    const build = (k: number) =>
      fuseByRank(
        [
          { channel: 'semantic', ranked: ['solo', 'p', 'agreed'] },
          { channel: 'lexical-prose', ranked: ['q', 'r', 'agreed'] },
        ],
        k,
      );
    const steep = build(0.5);
    expect(steep.get('solo')!.fused).toBeGreaterThan(steep.get('agreed')!.fused);
    const flat = build(600);
    expect(flat.get('agreed')!.fused).toBeGreaterThan(flat.get('solo')!.fused);
  });

  test('a non-positive or non-finite k THROWS rather than silently producing NaN/Infinity', () => {
    // COULD-NOT-COMPUTE MUST NOT LOOK LIKE A RANKING. NaN and Infinity both sort in an
    // arbitrary order, so a search that has stopped ranking would look exactly like a search
    // that ranked badly.
    for (const bad of [0, -1, NaN, Infinity]) {
      expect(() => fuseByRank([{ channel: 'semantic', ranked: ['a'] }], bad)).toThrow(/finite positive/);
    }
  });

  test('maxFusedScore is the real ceiling, so the displayed relevance stays inside [0,1]', () => {
    const top = FUSION_CHANNELS.map((c) => ({ channel: c, ranked: ['a'] }));
    const fused = fuseByRank(top, K).get('a')!.fused;
    expect(fused).toBeCloseTo(maxFusedScore(K), 12);
    expect(fused / maxFusedScore(K)).toBeCloseTo(1, 12);
  });

  test('rescaling by maxFusedScore is MONOTONE — it cannot reorder what it describes', () => {
    const fused = fuseByRank(
      [
        { channel: 'semantic', ranked: ['a', 'b', 'c', 'd'] },
        { channel: 'lexical-ident', ranked: ['c', 'a'] },
      ],
      K,
    );
    const rows = [...fused.values()];
    const byRaw = [...rows].sort((x, y) => y.fused - x.fused).map((r) => r.id);
    const byScaled = [...rows].sort((x, y) => y.fused / maxFusedScore(K) - x.fused / maxFusedScore(K)).map((r) => r.id);
    expect(byScaled).toEqual(byRaw);
  });
});
