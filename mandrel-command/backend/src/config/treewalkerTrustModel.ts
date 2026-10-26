/**
 * TreeWalker trust — the CANONICAL trust model, MIRRORED (PHASE 2 item e).
 *
 * ── WHAT THIS REPLACES ────────────────────────────────────────────────────────────────
 * TreeWalker used to hand-replicate a private trust vocabulary (proven/soaking/unproven/
 * stale) from raw columns (an earlier audit — "the same record can read proven on one
 * screen and stale on another", with no parity test). That derivation is DELETED. This
 * module carries the canonical model — the same bands, the same math, the same config
 * knobs as mcp-server/src/services/trustModel.ts + config/trustConfig.ts — so a record
 * shows ONE trust verdict on every screen.
 *
 * ── WHY A MIRROR AND NOT AN IMPORT (MEASURED, NOT ASSUMED) ────────────────────────────
 * `mandrel-command/backend/Dockerfile` copies `backend/` (and package.json manifests)
 * into the build — `mcp-server/src` is never in the build context, so a source import
 * compiles locally and FAILS the container build. The mcp-server package is also ESM
 * ('.js'-suffixed imports) while this backend is CommonJS. Same measured constraint and
 * same remedy as frontend/src/config/fieldLimits.ts: MIRROR + an executable drift guard.
 * `__tests__/treewalkerTrustParity.test.ts` loads the REAL mcp-server modules off disk
 * and (1) pins the band vocabulary, the config defaults and the belief stamp to the
 * canonical exports, and (2) runs BOTH computeTrust implementations over a fixture
 * matrix (incl. stale + superseded records) asserting identical band/score/abstain —
 * and refuses to pass if the canonical file cannot be found.
 *
 * Env knobs use the SAME names as the canonical config, so a tuned deployment tunes
 * both surfaces together — the two can disagree only by env drift between processes,
 * which compose sets identically for both containers.
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

/** Read a unit-interval [0,1] env var (a multiplier that must never promote), else `fallback`. */
function envUnit(name: string, fallback: number): number {
  const v = envFloat(name, fallback);
  return v >= 0 && v <= 1 ? v : fallback;
}

/**
 * The canonical trust BANDS (mcp-server config/trustConfig.ts TRUST_BANDS — pinned by
 * the parity test). Ordered most→least trustworthy for display.
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

/**
 * The belief adjudicator's provenance stamp (mcp-server config/beliefConfig.ts
 * BELIEF_EDGE_CREATED_BY — pinned by the parity test). A `supersedes` edge whose
 * created_by is THIS value is a SOFT (auto) supersession; any other `supersedes`
 * edge is DECLARED and hard-caps.
 */
export const BELIEF_EDGE_CREATED_BY = 'auto:belief-adjudicator';

/**
 * The OUT edge types over which a record inherits downstream ground-truth outcome —
 * the moat path (mcp-server services/trust.ts OUTCOME_OUT_EDGE_TYPES — pinned by the
 * parity test).
 */
export const OUTCOME_OUT_EDGE_TYPES = ['informs', 'decided_by', 'learned_from'] as const;

/** The canonical trust knobs (same names, same env vars, same defaults — pinned). */
export interface TrustConfig {
  weightOutcome: number;
  weightFreshness: number;
  freshnessHalflifeDays: number;
  trustedAt: number;
  staleBelow: number;
  abstainBelow: number;
  minOutcomeSamples: number;
  softSupersedeDemotion: number;
}

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

/** One downstream ground-truth outcome, mapped to [0,1] (null = ignored, not a zero). */
export interface OutcomeSample {
  value: number | null;
  source: 'decision' | 'task';
}

/** The signals the canonical math blends (mirrors trustModel.ts TrustSignals). */
export interface TrustSignals {
  outcomes: OutcomeSample[];
  ageDays: number;
  supersededDeclared: boolean;
  supersededSoft: boolean;
  contradicted: boolean;
}

/** The verdict TreeWalker renders (the canonical Trust object's band/score/abstain). */
export interface TrustVerdict {
  band: TrustBand;
  score: number;
  abstain: boolean;
}

/** freshness = 0.5^(age/halflife); age clamped >= 0 (canonical freshnessFromAge). */
export function freshnessFromAge(ageDays: number, config: TrustConfig = TRUST_CONFIG): number {
  const age = Math.max(0, ageDays);
  return Math.pow(0.5, age / config.freshnessHalflifeDays);
}

/** Mean of counted outcomes; below min_outcome_samples → null (canonical aggregateOutcome). */
export function aggregateOutcome(
  outcomes: OutcomeSample[],
  config: TrustConfig = TRUST_CONFIG,
): { score: number | null; samples: number } {
  const counted = outcomes.filter((o) => o.value !== null) as { value: number }[];
  const samples = counted.length;
  if (samples < config.minOutcomeSamples) return { score: null, samples };
  return { score: counted.reduce((acc, o) => acc + o.value, 0) / samples, samples };
}

/** decision.outcome_status → [0,1] | null (canonical mapDecisionOutcome). */
export function mapDecisionOutcome(status: string | null | undefined): number | null {
  switch (status) {
    case 'successful':
      return 1;
    case 'mixed':
      return 0.5;
    case 'failed':
      return 0;
    default:
      return null; // too_early / unknown / null → no evidence, not a zero
  }
}

/** task.status → [0,1] | null (canonical mapTaskOutcome — secondary signal).
 *
 *  WHY `cancelled` MAPS TO NULL, NOT 0. A cancellation says the work
 *  STOPPED; it does not say the idea was WRONG. Measured on this project's own data: a
 *  task reap cancelled 10 tasks — 4 throwaway smoke fixtures whose own descriptions said
 *  "safe to delete", 3 duplicates, 1 superseded proposal, 2 whose premise never
 *  materialised. ZERO were failures. Mapping that to 0 makes it a full-weight FAILURE
 *  sample, and with min_outcome_samples=1 a SINGLE hygiene cancellation drove a record's
 *  whole outcome signal to 0 — dropping it first wherever trust orders results. Absence
 *  of evidence must not be recorded as evidence of failure. `null` here means
 *  "contributes NO sample" (aggregateOutcome filters non-null before it counts or means),
 *  which is a different thing from a sample worth zero.
 *
 *  MIRROR NOTE: this must stay byte-for-byte equivalent to the canonical
 *  mcp-server/src/services/trustModel.ts mapTaskOutcome. The parity test drives BOTH
 *  mappers over the full status vocabulary, so a divergence here is a RED, not a screen
 *  that quietly disagrees with the MCP surface. */
export function mapTaskOutcome(status: string | null | undefined): number | null {
  switch (status) {
    case 'completed':
      return 1;
    default:
      return null;
  }
}

/**
 * The canonical trust math (mirrors trustModel.ts computeTrust — the band/score/abstain
 * subset TreeWalker renders; the explanation fields stay in the canonical module).
 * Order of operations is the canonical one: caps → outcome → freshness → blend → soft
 * demotion → band → abstain.
 */
export function computeTrustVerdict(
  signals: TrustSignals,
  config: TrustConfig = TRUST_CONFIG,
): TrustVerdict {
  const outcome = aggregateOutcome(signals.outcomes, config);
  const freshness = freshnessFromAge(signals.ageDays, config);

  const declared = signals.supersededDeclared;
  const soft = signals.supersededSoft && !declared;

  let score: number;
  if (outcome.score === null) {
    score = freshness; // cold-start: lean on freshness alone
  } else {
    const wo = config.weightOutcome;
    const wf = config.weightFreshness;
    const denom = wo + wf;
    score = denom > 0 ? (wo * outcome.score + wf * freshness) / denom : (outcome.score + freshness) / 2;
  }
  if (soft) score = score * config.softSupersedeDemotion;

  const overridden: TrustBand | null = declared
    ? 'superseded'
    : signals.contradicted
    ? 'contradicted'
    : null;

  let band: TrustBand;
  if (overridden) {
    band = overridden;
  } else if (freshness < config.staleBelow || score < config.staleBelow) {
    band = 'stale';
  } else if (outcome.score === null) {
    band = 'unproven';
  } else if (score >= config.trustedAt) {
    band = 'trusted';
  } else {
    band = 'ok';
  }

  const abstain = score < config.abstainBelow || declared || signals.contradicted;
  return { band, score, abstain };
}
