/**
 * BELIEF LAYER — shared types (Phase 4, Increment 1).
 *
 * The adjudicator PROVIDER INTERFACE + the verdict/outcome vocabulary. Kept in one place
 * so the pure derivation logic, the ollama provider, the store, and the belief-eval all
 * speak the same shapes and cannot drift.
 *
 * the belief-layer design §3 (adjudication verdicts) + §5 (harness). Increment-1 scope:
 * supersession only — CONTESTS is a valid VERDICT the adjudicator may return (and we
 * RECORD it), but Increment 1 mints NO contests edge (that is Inc-2). See beliefDerivation.
 */

import type { EdgeNodeType } from '../../config/edgeTypes.js';

/** The four pairwise verdicts the Stage-2 adjudicator can return (design §3). */
export const BELIEF_VERDICTS = ['supersedes', 'contests', 'restates', 'unrelated'] as const;
export type BeliefVerdict = (typeof BELIEF_VERDICTS)[number];

/** Which record supersedes which, when the verdict is `supersedes` (else `none`). */
export const BELIEF_DIRECTIONS = ['a_supersedes_b', 'b_supersedes_a', 'none'] as const;
export type BeliefDirection = (typeof BELIEF_DIRECTIONS)[number];

/**
 * Supersession flavour (design §1/§6 case 2): `replaced` = the old record is fully
 * replaced; `fallback_retained` = the old approach is kept as a recoverable fallback
 * (e.g. "reversible: flip back"). `none` when the verdict is not a supersession.
 */
export const BELIEF_MODES = ['replaced', 'fallback_retained', 'none'] as const;
export type BeliefMode = (typeof BELIEF_MODES)[number];

/**
 * A single pairwise adjudication verdict — the structured judgment the Stage-2 provider
 * returns for a candidate pair (a, b). `a` and `b` are the two records exactly as passed
 * to the provider (see AdjudicationRequest); direction/mode are relative to them.
 */
export interface AdjudicatorVerdict {
  /** Did the adjudicator judge a and b to be about the SAME subject/scope/instance? */
  sameSubject: boolean;
  /** The per-pair subject label the adjudicator inferred (audit + future vocabulary). */
  subject: string;
  /** The verdict. */
  verdict: BeliefVerdict;
  /** For a `supersedes` verdict, which record supersedes which; else `none`. */
  direction: BeliefDirection;
  /** For a `supersedes` verdict, the flavour; else `none`. */
  mode: BeliefMode;
  /** The adjudicator's confidence in the verdict, 0..1 (drives the ②↔③ dial). */
  confidence: number;
  /** A short human rationale (rides onto the adjudication row + the minted edge). */
  rationale: string;
}

/** One endpoint of a candidate pair, as fed to the adjudicator. */
export interface AdjudicationRecord {
  id: string;
  type: EdgeNodeType;
  content: string;
  /** Creation timestamp — a recency signal the adjudicator uses to reason about direction. */
  createdAt?: Date | string | null;
}

/** A candidate pair to adjudicate (a, b) plus the Stage-1 cosine that nominated it. */
export interface AdjudicationRequest {
  a: AdjudicationRecord;
  b: AdjudicationRecord;
  /** Stage-1 cosine similarity that nominated this pair (recorded for audit; not a verdict). */
  cosine?: number | null;
}

/**
 * Which cost tier a REAL LLM call belongs to (BL-10 cost ledger). `single` = a non-tiered
 * single-provider call (anthropic / openai-compat / ollama in single-provider mode); `tier1` /
 * `tier2` = the two legs of the composite tiered provider (Groq prescreen / Sonnet confirm).
 */
export const BELIEF_CALL_TIERS = ['tier1', 'tier2', 'single'] as const;
export type BeliefCallTier = (typeof BELIEF_CALL_TIERS)[number];

/**
 * Token usage for ONE real LLM call (BL-10 cost ledger). A single provider populates one of
 * these per adjudicate(); the tiered provider populates one (tier-1 only) or two (tier-1 +
 * tier-2 on escalation) — one per ACTUAL API call, which is exactly one append-only ledger row.
 * All token counts default to 0 when a provider/host does not surface them (never undefined) so
 * cost math is total. Cache fields are Anthropic prompt-cache accounting (BL-12); non-caching
 * hosts leave them 0.
 */
export interface AdjudicationCallUsage {
  /** Which tier produced this call (attribution + the ledger `tier` column). */
  tier: BeliefCallTier;
  /** The provider that made this REAL call (e.g. 'anthropic', 'openai-compat'). */
  provider: string;
  /** The model this REAL call used (e.g. 'claude-sonnet-5', 'openai/gpt-oss-120b'). */
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** Tokens WRITTEN to the prompt cache on a miss (Anthropic cache_creation_input_tokens). */
  cacheCreationTokens: number;
  /** Tokens READ from the prompt cache on a hit (Anthropic cache_read_input_tokens). */
  cacheReadTokens: number;
}

/**
 * THE PROVIDER INTERFACE (design §3/§9a). Local (ollama) vs API is a config flip + a
 * bake-off decision, never a code rewrite. Increment 1 ships the ollama provider.
 */
export interface AdjudicationProvider {
  /** Provider key (e.g. 'ollama') — recorded on every adjudication row. */
  readonly name: string;
  /** Model id (e.g. 'qwen2.5:1.5b') — recorded on every adjudication row. */
  readonly model: string;
  /**
   * Per-REAL-CALL token usage from the MOST RECENT adjudicate() (BL-10 cost ledger). One entry
   * per actual LLM call: a single provider reports exactly one (tier='single'); the composite
   * tiered provider reports one (tier-1 only) or two (tier-1 + tier-2 on escalation). Read
   * SYNCHRONOUSLY right after each awaited adjudicate() — this is serial-safe because the
   * pipeline runs adjudications serially (adjudicatorConcurrency locked at 1), the SAME
   * contract that already governs the tiered provider's name/model getters (BL-11). Optional so
   * a provider that cannot surface usage (or a test fake) simply reports nothing → no ledger
   * row, adjudication unaffected (fail-safe by construction). Reset at the start of each call so
   * a thrown call leaves it empty (never stale usage attributed to a failed request).
   */
  readonly lastUsage?: AdjudicationCallUsage[];
  /** Adjudicate one candidate pair. MUST NOT throw for a well-formed request that the model
   *  simply answered oddly — it returns a best-effort validated verdict; it MAY throw for a
   *  transport/daemon failure (the caller decides whether to degrade or retry). */
  adjudicate(req: AdjudicationRequest): Promise<AdjudicatorVerdict>;
}
