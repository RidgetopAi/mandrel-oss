/**
 * TIERED ADJUDICATOR — Groq tier-1 prescreen → Sonnet tier-2 confirm (BL-11).
 *
 * A COMPOSITE AdjudicationProvider: it does not talk to any LLM itself — it COMPOSES two
 * existing single-providers (the openai-compat Groq provider + the anthropic Sonnet provider,
 * both built by the SAME provider factory) and routes between them:
 *
 *   1. TIER-1 (cheap prescreen) adjudicates EVERY candidate pair, using the SAME shared prompt
 *      (buildAdjudicationPrompt — so the BL-7 rubric applies to both tiers identically).
 *   2. If tier-1's verdict is in the CONFIG-DRIVEN escalation set (default {supersedes,contests}
 *      — the edge-producing family) → ESCALATE to TIER-2. Tier-2's verdict is AUTHORITATIVE:
 *      it is what flows out to deriveBeliefOutcome (mint / soft / none).
 *   3. Otherwise (unrelated / restates — no edge would be minted anyway) TRUST tier-1's cheap
 *      verdict directly — no tier-2 call. This is where the ~70% cost cut comes from.
 *
 * ⚠️ RECALL TRADEOFF (flagged, not solved here — see beliefConfig BELIEF_TIERED_CONFIG doc): a
 * tier-1 FALSE-NEGATIVE (Groq wrongly says unrelated/restates on a real supersession/contest) is
 * NOT recovered by tier-2, because tier-2 is only called on tier-1's escalate-family verdicts.
 * That recall cost is made TUNABLE (widen escalateVerdicts via env) + MEASURABLE (belief-eval
 * gold gate), deliberately not eliminated in v1.
 *
 * COST ATTRIBUTION (BL-10): this provider's `name`/`model` getters return the AUTHORITATIVE
 * tier's provider/model — so recordAdjudication stamps each belief_adjudications row with the
 * tier that actually produced the verdict (Groq for non-escalated, Sonnet for escalated). BL-10
 * reads those columns for authoritative-tier cost, and knows tier-1 ran on EVERY pair (total
 * rows) while tier-2 ran only on the escalated subset (rows whose provider/model == tier2's).
 * `lastRouting` + `tiers` expose the same in-process for a live probe.
 *
 * SERIAL-SAFETY of the getters: the belief pipeline runs adjudications SERIALLY
 * (adjudicatorConcurrency locked at 1; adjudicateNeighbourhood's loop awaits each pair then
 * reads provider.name/model synchronously in the same continuation before the next pair). So
 * `lastAuthoritative` is always the tier that produced the verdict just returned. If concurrency
 * is ever raised, the authoritative tier must instead be threaded through the verdict result —
 * see the note in adjudicate() below.
 */

import { BELIEF_TIERED_CONFIG } from '../../config/beliefConfig.js';
import type { BeliefTieredConfig, BeliefAdjudicatorConfig } from '../../config/beliefConfig.js';
import { logger } from '../../utils/logger.js';
import { BeliefProviderCallError } from './providerError.js';
import { BELIEF_VERDICTS } from './types.js';
import type {
  AdjudicationCallUsage,
  AdjudicationProvider,
  AdjudicationRequest,
  AdjudicatorVerdict,
  BeliefCallTier,
  BeliefVerdict,
} from './types.js';

/** Lightweight identity of a tier (for BL-10 attribution + the routing probe). */
export interface TierIdentity {
  name: string;
  model: string;
}

/** The routing decision for the LAST adjudicated pair — an in-process probe (BL-10 / tests). */
export interface TieredRouting {
  /** Tier-1's verdict (always produced — tier-1 runs on every pair). */
  tier1Verdict: BeliefVerdict;
  /** Did we escalate to tier-2? */
  escalated: boolean;
  /** Which tier produced the AUTHORITATIVE (returned) verdict: 1 or 2. */
  authoritativeTier: 1 | 2;
  /** The authoritative tier's identity (what recordAdjudication stamps on the row). */
  authoritative: TierIdentity;
}

/** Validate/narrow a raw string list to the belief-verdict vocab (unknown tokens dropped). */
function toVerdictSet(raw: string[]): Set<BeliefVerdict> {
  const vocab = new Set<string>(BELIEF_VERDICTS);
  const out = new Set<BeliefVerdict>();
  for (const v of raw) {
    const t = v.trim();
    if (vocab.has(t)) out.add(t as BeliefVerdict);
  }
  return out;
}

/**
 * The composite tiered provider. Constructed with two ALREADY-BUILT sub-providers (dependency
 * injection) so it is trivially testable with fakes and has NO import dependency on the factory
 * (the factory depends on it, not the other way around — no cycle). Use `createTieredAdjudicator`
 * to build one from config via the single-provider factory.
 */
export class TieredAdjudicator implements AdjudicationProvider {
  private readonly tier1: AdjudicationProvider;
  private readonly tier2: AdjudicationProvider;
  private readonly escalateSet: Set<BeliefVerdict>;
  /** The tier whose verdict was returned by the most recent adjudicate() — drives name/model. */
  private lastAuthoritative: AdjudicationProvider;
  /** In-process routing probe for the last pair (BL-10 / live introspection). Null before first call. */
  public lastRouting: TieredRouting | null = null;
  /**
   * Per-REAL-CALL usage from the most recent adjudicate() (BL-10 cost ledger). One entry (tier-1
   * only, when not escalated) or two (tier-1 + tier-2, on escalation) — one per ACTUAL API call,
   * each becoming one append-only ledger row. Re-tagged from each sub-provider's `lastUsage`
   * (which they report as tier='single') to the correct tier1/tier2. Reset per call.
   */
  public lastUsage: AdjudicationCallUsage[] = [];

  constructor(
    tier1: AdjudicationProvider,
    tier2: AdjudicationProvider,
    escalateVerdicts: string[]
  ) {
    this.tier1 = tier1;
    this.tier2 = tier2;
    this.escalateSet = toVerdictSet(escalateVerdicts);
    // Before any call, attribute to tier-1 (the always-run prescreen) as the sensible default.
    this.lastAuthoritative = tier1;
  }

  /** The fixed identities of both tiers (BL-10 reads these to know which models the tiers use). */
  get tiers(): { tier1: TierIdentity; tier2: TierIdentity } {
    return {
      tier1: { name: this.tier1.name, model: this.tier1.model },
      tier2: { name: this.tier2.name, model: this.tier2.model },
    };
  }

  /** The escalation vocabulary actually in effect (post-validation) — for tests/introspection. */
  get escalateVerdicts(): BeliefVerdict[] {
    return [...this.escalateSet];
  }

  /** AUTHORITATIVE tier's provider name — what recordAdjudication stamps on the row (serial-safe). */
  get name(): string {
    return this.lastAuthoritative.name;
  }

  /** AUTHORITATIVE tier's model — what recordAdjudication stamps on the row (serial-safe). */
  get model(): string {
    return this.lastAuthoritative.model;
  }

  /** Re-tag a sub-provider's per-call usage (reported as tier='single') to a specific tier, so
   *  each ledger row is attributed tier1/tier2. A sub-provider that reported nothing → []. */
  private tierUsage(sub: AdjudicationProvider, tier: BeliefCallTier): AdjudicationCallUsage[] {
    return (sub.lastUsage ?? []).map((u) => ({ ...u, tier }));
  }

  /**
   * Call one tier and RE-TAG any failure with WHICH tier it was. A sub-provider
   * cannot know which leg it is, so it throws `tier:'single'` — the same asymmetry the cost
   * ledger already handles by re-tagging usage (tierUsage above). Without this the attempt
   * ledger could record THAT a call failed but not WHICH tier, and "should tier-1 failures fall
   * through to tier-2?" would stay unanswerable. Non-provider throws are wrapped so the tier is
   * never lost; the message is preserved verbatim either way.
   */
  private async callTier(
    sub: AdjudicationProvider,
    tier: 'tier1' | 'tier2',
    req: AdjudicationRequest
  ): Promise<AdjudicatorVerdict> {
    try {
      return await sub.adjudicate(req);
    } catch (e) {
      if (e instanceof BeliefProviderCallError) {
        e.tier = tier;
        throw e;
      }
      throw new BeliefProviderCallError((e as Error)?.message ?? String(e), {
        provider: sub.name,
        model: sub.model,
        tier,
        cause: e,
      });
    }
  }

  async adjudicate(req: AdjudicationRequest): Promise<AdjudicatorVerdict> {
    // Reset usage: a call that throws leaves NO stale usage attributed to it.
    this.lastUsage = [];
    // TIER-1: always runs (the cheap prescreen sees every pair).
    const t1 = await this.callTier(this.tier1, 'tier1', req);
    // Tier-1 ALWAYS produced a real call → capture its cost usage now (before any escalation).
    const tier1Usage = this.tierUsage(this.tier1, 'tier1');

    if (!this.escalateSet.has(t1.verdict)) {
      // No edge would be minted for this verdict family → trust tier-1 directly (the cost win).
      this.lastAuthoritative = this.tier1;
      this.lastUsage = tier1Usage; // one call → one ledger row
      this.lastRouting = {
        tier1Verdict: t1.verdict,
        escalated: false,
        authoritativeTier: 1,
        authoritative: { name: this.tier1.name, model: this.tier1.model },
      };
      logger.info(
        `🧪 belief tiered: ${req.a.id.slice(0, 8)}↔${req.b.id.slice(0, 8)} tier1(${this.tier1.name}/${this.tier1.model})=` +
          `${t1.verdict} → NOT escalated (trusting tier-1)`
      );
      return t1;
    }

    // ESCALATE: tier-1 produced an edge-producing verdict → tier-2 is authoritative.
    // NOTE (concurrency): if adjudicatorConcurrency is ever raised above 1, move the
    // authoritative-tier identity onto the returned verdict instead of this instance field —
    // lastAuthoritative is only safe because the pipeline reads name/model synchronously after
    // this await, serially. See the class doc.
    const t2 = await this.callTier(this.tier2, 'tier2', req);
    this.lastAuthoritative = this.tier2;
    // BOTH tiers made a real call → TWO ledger rows (tier-1 prescreen + tier-2 confirm).
    this.lastUsage = [...tier1Usage, ...this.tierUsage(this.tier2, 'tier2')];
    this.lastRouting = {
      tier1Verdict: t1.verdict,
      escalated: true,
      authoritativeTier: 2,
      authoritative: { name: this.tier2.name, model: this.tier2.model },
    };
    logger.info(
      `🧪 belief tiered: ${req.a.id.slice(0, 8)}↔${req.b.id.slice(0, 8)} tier1(${this.tier1.name}/${this.tier1.model})=` +
        `${t1.verdict} → ESCALATED → tier2(${this.tier2.name}/${this.tier2.model})=${t2.verdict} (authoritative)`
    );
    return t2;
  }
}

/**
 * Build a TieredAdjudicator from config, using the supplied single-provider builder to
 * construct each tier. `build` is the factory's single-provider path (NOT the full
 * getAdjudicationProvider) so a tier configured as `provider: 'tiered'` fails closed with the
 * factory's unknown-provider error rather than recursing.
 */
export function createTieredAdjudicator(
  build: (cfg: BeliefAdjudicatorConfig) => AdjudicationProvider,
  cfg: BeliefTieredConfig = BELIEF_TIERED_CONFIG
): TieredAdjudicator {
  return new TieredAdjudicator(build(cfg.tier1), build(cfg.tier2), cfg.escalateVerdicts);
}
