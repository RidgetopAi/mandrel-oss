/**
 * RECIPROCAL-RANK FUSION (SEARCH P2b — BUILD 2).
 *
 * ═══ WHY BY RANK AND NOT BY SCORE ═══
 * The two channels' scores are on incomparable scales, and — measured — our own three
 * SEMANTIC sources already are. P1 read per-source noise ceilings of 0.58 (decision), 0.55
 * (task), 0.54 (context) on the known-negatives: the same number means a different thing
 * depending on which table produced it. `ts_rank` is a third scale again, unbounded and
 * dependent on document length. Normalising three quantities that do not mean the same thing
 * requires choosing constants that say how much a decision's 0.55 is worth against a
 * context's 0.55, and an earlier decision rejected exactly that.
 *
 * A RANK carries no scale. "This channel put it first" means the same thing in every channel,
 * so fusing on rank sidesteps the normalisation problem rather than guessing at it.
 *
 * ═══ THE FORM ═══
 *     fused(d) = Σ_c  1 / (k + rank_c(d))       over the channels c that returned d
 * A document no channel returned scores 0 and is not in the output — the fused set is exactly
 * the UNION of the channels. See HYBRID_SEARCH_CONFIG.rrfK for why `k` is not the tuned
 * constant this decision rejected, and for the sweep that measures the order's insensitivity
 * to it.
 *
 * This module is PURE — no database, no config reads beyond the k handed to it — because the
 * k-sensitivity claim above has to be checkable without standing up a corpus.
 */

import type { FusionChannel } from '../config/hybridSearchConfig.js';

/** One channel's ordered output. `ranked[0]` is that channel's rank 1. */
export interface RankedChannel {
  readonly channel: FusionChannel;
  readonly ranked: readonly string[];
}

export interface FusedEntry {
  readonly id: string;
  /** Σ 1/(k + rank) over the channels that returned this id. */
  readonly fused: number;
  /** 1-based rank per channel that returned it. A channel that did not is absent. */
  readonly ranks: Readonly<Partial<Record<FusionChannel, number>>>;
}

/**
 * Fuse ranked id lists into one map of id → fused score.
 *
 * A DUPLICATE ID WITHIN ONE CHANNEL takes its BEST (first) rank and the later occurrence is
 * ignored, rather than being summed. Summing would let a channel that returned the same
 * record twice out-vote a channel that returned it once — an artefact of a retrieval bug
 * becoming a ranking signal. Callers are not required to de-duplicate; this is the choke
 * point every channel passes through, which is where the rule belongs.
 */
export function fuseByRank(channels: readonly RankedChannel[], k: number): Map<string, FusedEntry> {
  if (!(k > 0) || !Number.isFinite(k)) {
    // FAIL LOUD, not "fall back to a default". A k of 0 or NaN silently produces Infinity or
    // NaN fused scores, which sort in an arbitrary order — a search that has quietly stopped
    // ranking looks exactly like a search that ranked badly.
    throw new Error(`[rankFusion] k must be a finite positive number, got ${k}`);
  }
  const out = new Map<string, { id: string; fused: number; ranks: Partial<Record<FusionChannel, number>> }>();
  for (const { channel, ranked } of channels) {
    for (let i = 0; i < ranked.length; i++) {
      const id = ranked[i];
      const rank = i + 1;
      let e = out.get(id);
      if (!e) {
        e = { id, fused: 0, ranks: {} };
        out.set(id, e);
      }
      if (e.ranks[channel] !== undefined) continue; // best rank wins; see above
      e.ranks[channel] = rank;
      e.fused += 1 / (k + rank);
    }
  }
  return out as Map<string, FusedEntry>;
}
