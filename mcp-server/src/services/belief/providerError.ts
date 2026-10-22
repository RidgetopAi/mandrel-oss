/**
 * BELIEF PROVIDER CALL ERROR (observability).
 *
 * A TYPED error for a failed adjudication LLM call, so the attempt ledger can record WHICH tier
 * failed and WITH WHAT STATUS instead of re-parsing a prose message. This is the C3/C1 rule
 * applied to our own telemetry: an HTTP status is structured data; `HTTP 400 for model: …` is
 * prose, and a ledger that regexes prose is a second guard that can rot.
 *
 * WHY IT CARRIES A TIER. The tiered provider composes two sub-providers; a sub-provider does not
 * know which leg it is. So the sub-provider throws with `tier: 'single'` (what it honestly knows)
 * and TieredAdjudicator RE-TAGS the tier as it rethrows — the same re-tagging the cost ledger
 * already does for usage (tierUsage), one pattern, not two.
 *
 * The error's MESSAGE is unchanged from the plain-Error form it replaces, so anything reading the
 * message (logs, existing tests) is unaffected. Only the extra fields are new.
 */

import type { BeliefCallTier } from './types.js';

/** Where an adjudication attempt died. Mirrors the DB CHECK in migration 097. */
export const BELIEF_FAILURE_STAGES = [
  'provider',
  'provider_init',
  'pairing',
  'derivation',
  'persist',
  'unknown',
] as const;
export type BeliefFailureStage = (typeof BELIEF_FAILURE_STAGES)[number];

/** A failed REAL adjudication call, with structured attribution. */
export class BeliefProviderCallError extends Error {
  readonly provider: string;
  readonly model: string;
  /** Which tier made the call. Sub-providers throw 'single'; the tiered provider re-tags. */
  tier: BeliefCallTier;
  /** The provider's HTTP status, when the failure was an HTTP response. Undefined otherwise. */
  readonly httpStatus?: number;

  constructor(
    message: string,
    init: { provider: string; model: string; tier?: BeliefCallTier; httpStatus?: number; cause?: unknown }
  ) {
    super(message);
    this.name = 'BeliefProviderCallError';
    this.provider = init.provider;
    this.model = init.model;
    this.tier = init.tier ?? 'single';
    this.httpStatus = init.httpStatus;
    if (init.cause !== undefined) (this as { cause?: unknown }).cause = init.cause;
  }
}

/** Structured description of ANY thrown value, for the attempt ledger. */
export interface FailureDescription {
  stage: BeliefFailureStage;
  tier: BeliefCallTier | null;
  errorClass: string;
  httpStatus: number | null;
  message: string;
  provider: string | null;
  model: string | null;
}

/**
 * Describe a thrown value for the ledger. A BeliefProviderCallError yields full attribution; any
 * other throw yields its constructor name + message at the stage the caller says it happened.
 * NEVER throws itself — a telemetry classifier that can throw is a new failure mode.
 */
export function describeFailure(e: unknown, fallbackStage: BeliefFailureStage): FailureDescription {
  if (e instanceof BeliefProviderCallError) {
    return {
      stage: 'provider',
      tier: e.tier,
      errorClass: e.name,
      httpStatus: e.httpStatus ?? null,
      message: e.message,
      provider: e.provider,
      model: e.model,
    };
  }
  const err = e as { name?: unknown; message?: unknown; constructor?: { name?: string } };
  const errorClass =
    (typeof err?.name === 'string' && err.name) || err?.constructor?.name || typeof e;
  const message = typeof err?.message === 'string' ? err.message : String(e);
  return {
    stage: fallbackStage,
    tier: null,
    errorClass,
    httpStatus: null,
    message,
    provider: null,
    model: null,
  };
}
