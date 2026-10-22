/**
 * TRUST MODEL v1 — the config (Mandrel Core Redesign T2b).
 *
 * THE MOAT (spec §4 Capability 3 + §8.1 "Trust model v1"): every recalled record carries
 * whether to TRUST it — blended from outcome-validated reliability (not age). This module
 * is the SINGLE home for every trust weight / threshold / half-life.
 *
 * STANDING PRINCIPLE (the operator, binds this + all future builds): NO HARDCODED VARIABLES.
 * Every knob the trust math touches lives HERE — a named value with an operator-approved
 * default + a one-line doc comment + an env override — never a literal buried in the
 * trust service. This mirrors recallConfig.ts (T1) and edgeTypes.ts (T2a): the config is
 * the contract, the code reads it. The whole point of the model is that it is TUNABLE
 * (the eval gate can sweep any knob via env with zero code edit).
 *
 * Env reads happen at module load with a safe fallback (bad/missing → the default),
 * exactly like recallConfig.envInt and handlers/context.ts:envFloat.
 */

/** Read a finite-number env var, falling back to `fallback` on missing/garbage. */
function envFloat(name: string, fallback: number): number {
  const raw = process.env[name]; // env-read: via-callers
  if (raw === undefined || raw === '') return fallback;
  const v = Number(raw);
  return Number.isFinite(v) ? v : fallback;
}

/** Read a positive-finite env var (e.g. a half-life in days), else `fallback`. */
function envPositive(name: string, fallback: number): number {
  const v = envFloat(name, fallback);
  return v > 0 ? v : fallback;
}

/** Read a positive-integer env var (e.g. a sample count), else `fallback`. */
function envInt(name: string, fallback: number): number {
  const raw = process.env[name]; // env-read: via-callers
  if (raw === undefined || raw === '') return fallback;
  const v = Number(raw);
  return Number.isInteger(v) && v > 0 ? v : fallback;
}

/**
 * Read a unit-interval [0,1] env var (a multiplier that must never PROMOTE a record),
 * else `fallback`. Out-of-range / garbage → fallback. Used for the soft-supersede
 * demotion multiplier: a demotion is a *shrink*, so > 1 (a promotion) or < 0 is nonsense
 * and is rejected rather than silently trusted.
 */
function envUnit(name: string, fallback: number): number {
  const v = envFloat(name, fallback);
  return v >= 0 && v <= 1 ? v : fallback;
}

/**
 * THE TRUST KNOBS (operator-approved defaults, spec §8.1 "Trust model v1").
 *
 * A record's trust = a blend of an OUTCOME signal (the moat: did the work this record
 * informed actually pan out?) and a FRESHNESS signal (decays with age), capped by
 * SUPERSESSION / CONTRADICTION overrides, mapped to a 0–1 score → a band.
 *
 * Each field is env-overridable so the eval gate can sweep the model without a code edit.
 */
export interface TrustConfig {
  /**
   * weight_outcome — the OUTCOME signal's weight in the blend. Outcome DOMINATES: it is
   * the moat (loop-scored real reliability), so it carries the majority. Env:
   * MANDREL_TRUST_WEIGHT_OUTCOME. Default 0.6 (§8.1).
   */
  weightOutcome: number;
  /**
   * weight_freshness — the FRESHNESS signal's weight in the blend. Recency is the
   * secondary signal (and the SOLE signal at cold-start, before any outcome evidence
   * accrues). Env: MANDREL_TRUST_WEIGHT_FRESHNESS. Default 0.4 (§8.1).
   */
  weightFreshness: number;
  /**
   * freshness_halflife_days — the exponential-decay half-life (in days) for freshness:
   * freshness = 0.5^(age_days / halflife). At one half-life a record is at 0.5; at two,
   * 0.25. Env: MANDREL_TRUST_FRESHNESS_HALFLIFE_DAYS. Default 30 (§8.1).
   */
  freshnessHalflifeDays: number;
  /**
   * trusted_at — the score (inclusive) at/above which a record's band is `trusted`. Env:
   * MANDREL_TRUST_TRUSTED_AT. Default 0.66 (§8.1).
   */
  trustedAt: number;
  /**
   * stale_below — when the FRESHNESS (or, by extension, a freshness-starved score) is
   * BELOW this, the record is `stale` (old enough that it may no longer hold). Env:
   * MANDREL_TRUST_STALE_BELOW. Default 0.40 (§8.1).
   */
  staleBelow: number;
  /**
   * abstain_below — when the score is BELOW this, the AI should ABSTAIN from relying on
   * the record (too weak to trust). Also forced by supersession/contradiction. Env:
   * MANDREL_TRUST_ABSTAIN_BELOW. Default 0.40 (§8.1).
   */
  abstainBelow: number;
  /**
   * min_outcome_samples — the minimum number of COUNTED downstream outcomes required
   * before the outcome signal counts at all. Below this → outcome_score is NULL (no
   * evidence yet → cold-start `unproven`, NOT distrusted). Env:
   * MANDREL_TRUST_MIN_OUTCOME_SAMPLES. Default 1 (§8.1).
   */
  minOutcomeSamples: number;
  /**
   * soft_supersede_demotion — the MULTIPLIER applied to a record's blended score when it is
   * SOFTLY superseded (belief-layer BL-4): an AUTO `supersedes` edge (created_by =
   * 'auto:belief-adjudicator') OR any `possibly_supersedes` edge points at it. A soft
   * supersession is a FALLIBLE, below-hard-bar signal from the belief adjudicator — a strong
   * hint that a newer record replaced this one, but not the human-grade DECLARED signal that
   * hard-caps (band=superseded, abstain). So instead of dropping/abstaining, we DEMOTE: the
   * record is still returned and never lands on the abstain list purely for being soft —
   * "flag when unsure, still show it" — but it ranks BELOW its un-superseded peers.
   *
   * WHY A MULTIPLIER (not a fixed subtraction) and WHY 0.5: a multiplier scales the penalty
   * with the record's OWN confidence — a strong record (score ~0.9) still keeps meaningful
   * standing (→ ~0.45) while a weak one is demoted proportionally, and the score stays in
   * [0,1] by construction (no clamp needed). 0.5 (halve) is the sensible default: a record
   * that would read `trusted` (≥0.66) is pushed to ~0.33, i.e. clearly below its peers and
   * around the stale/abstain boundary, WITHOUT soft supersession itself forcing abstain — a
   * fresh cold-start record (score ~1.0) demotes to ~0.5, which is still ≥ abstain_below
   * (0.4), so it stays visible and non-abstaining, exactly as BL-4 requires. (If a demoted
   * score independently falls below abstain_below the normal score threshold trips — that is
   * allowed; soft supersession just never FORCES it.) Env:
   * MANDREL_TRUST_SOFT_SUPERSEDE_DEMOTION (clamped to [0,1]). Default 0.5.
   */
  softSupersedeDemotion: number;
}

/**
 * THE LIVE CONFIG — read once at module load. Defaults are operator-approved §8.1
 * "Trust model v1" values; every one is env-overridable for the eval sweep.
 */
export const TRUST_CONFIG: TrustConfig = {
  weightOutcome: envFloat('MANDREL_TRUST_WEIGHT_OUTCOME', 0.6),
  weightFreshness: envFloat('MANDREL_TRUST_WEIGHT_FRESHNESS', 0.4),
  freshnessHalflifeDays: envPositive('MANDREL_TRUST_FRESHNESS_HALFLIFE_DAYS', 30),
  trustedAt: envFloat('MANDREL_TRUST_TRUSTED_AT', 0.66),
  staleBelow: envFloat('MANDREL_TRUST_STALE_BELOW', 0.4),
  abstainBelow: envFloat('MANDREL_TRUST_ABSTAIN_BELOW', 0.4),
  minOutcomeSamples: envInt('MANDREL_TRUST_MIN_OUTCOME_SAMPLES', 1),
  softSupersedeDemotion: envUnit('MANDREL_TRUST_SOFT_SUPERSEDE_DEMOTION', 0.5),
};

/**
 * The trust BANDS (spec §8.1). Ordered most→least trustworthy for display. A record's
 * band is its headline trust verdict; `abstain` is the separate "do not rely on this"
 * flag that rides ALONGSIDE the band (e.g. a `superseded` record always abstains).
 *
 * - trusted    — score ≥ trusted_at (proven reliable by downstream outcomes / fresh).
 * - ok         — between stale_below and trusted_at WITH outcome evidence (decent, not
 *                yet "trusted"-grade). [internal-but-real band; "unproven"/"stale" are
 *                the cold-start/age cases below.]
 * - unproven   — NO outcome evidence yet (cold-start) OR a weak blended score: NOT
 *                distrusted — "no outcome signal yet, lean on freshness, and say so".
 * - stale      — freshness/score below stale_below (old enough it may have gone invalid).
 * - superseded — a newer record replaced this one (override/cap → always abstain).
 * - contradicted — a live record asserts the opposite (override/cap → always abstain).
 *                  Detection is deferred to T4; the band + abstain mechanism exist now so
 *                  a future flag can set it.
 */
export const TRUST_BANDS = [
  'trusted',
  'ok',
  'unproven',
  'stale',
  'superseded',
  'contradicted',
] as const;
export type TrustBand = (typeof TRUST_BANDS)[number];

/** A compact human hint per band (emoji + word) for the text channel. */
export const TRUST_BAND_HINT: Record<TrustBand, string> = {
  trusted: '✅ trusted',
  ok: '🟢 ok',
  unproven: '🌱 unproven',
  stale: '🕸️ stale',
  superseded: '⛔ superseded',
  contradicted: '⚠️ contradicted',
};
