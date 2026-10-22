/**
 * TRUST MODEL v1 — the PURE math core (Mandrel Core Redesign T2b). THE MOAT.
 *
 * This module is DB-FREE on purpose. It holds the trust SIGNAL TYPES + the pure functions
 * that turn gathered signals into a Trust object:
 *   - computeTrust()      — signals + injected TrustConfig → Trust (band/score/abstain).
 *   - aggregateOutcome()  — mean of counted downstream outcomes (too_early/unknown ignored).
 *   - freshnessFromAge()  — exponential decay by age (0.5^(age/halflife)).
 *   - mapDecisionOutcome()/mapTaskOutcome() — ground-truth status → [0,1] | null.
 *
 * Keeping the math here (no `pg` / no db pool import) means the unit tests hammer it with
 * the config INJECTED and ZERO database — deterministic, offline, fast. The DB/graph
 * signal-GATHERING lives in services/trust.ts, which imports these. (one
 * definition of the rule, testable in isolation.)
 */

import {
  TRUST_CONFIG,
  TRUST_BAND_HINT,
  type TrustConfig,
  type TrustBand,
} from '../config/trustConfig.js';
// Types only — this module stays DB-free AND walk-free. The reachability walk itself lives in
// services/declaredReachability.ts and is driven by services/trust.ts (which holds the pool);
// the pure math only carries the VERDICT it was handed, exactly as it only forwards the BL-5
// supersession receipt it was handed.
import type { ReachVerdict, UndecidedCause } from './declaredReachability.js';

/**
 * SUPERSESSION RECEIPT (belief BL-5 — "show receipts", THE MOAT PITCH). When a record is
 * superseded, the Trust object doesn't just say THAT it's superseded — it says WHICH record
 * did it and WHY. Built by trustForRecord() from the DECIDING inbound supersession edge (the
 * declared one for hard; the highest-confidence auto edge for soft) and passed into
 * computeTrust() via TrustSignals — the pure math only FORWARDS it (never fabricates it).
 */
export interface SupersessionReceipt {
  /** The superseding record's id (the supersession edge's from_id, or a decision's
   *  own superseded_by column for the declared column-only case). */
  supersededBy: string;
  /** Which tier decided it: 'declared' (hard cap) or 'soft' (auto/possible demote). */
  tier: 'declared' | 'soft';
  /** Adjudicator confidence from the edge metadata; null for a declared column-only
   *  supersession or a declared edge with no metadata. */
  confidence: number | null;
  /** The human-readable why — the adjudicator rationale, or the joined soft reason[];
   *  null for a declared column-only supersession with no edge metadata. */
  reason: string | null;
}

/**
 * ONE soft supersession candidate that the BACKWARD-SOFT GUARD adjudicated (P5.3 half B,
 * an earlier task). See config/supersessionGuardConfig.ts for the rule and the
 * measured prod cycle that forced it.
 *
 * A finding is recorded for a soft candidate ONLY when the guard did something other than
 * wave it through — i.e. it was SUPPRESSED (a declared chain runs the other way) or the
 * check came back UNDECIDED. Ordinary honored candidates are counted in `checked` and carry
 * no finding, so the list is short and every entry means something.
 */
export interface BackwardSoftFinding {
  /** The record the soft edge claims supersedes this one (the edge's from_id), FULL id. */
  candidate: string;
  /** The adjudicator's confidence on that edge; null when the metadata carried none. */
  confidence: number | null;
  /** The reachability verdict over the DECLARED subgraph, from THIS record to `candidate`. */
  verdict: ReachVerdict;
  /** Declared hops in the witnessed path when `verdict === 'reached'`; null otherwise. */
  hops: number | null;
  /** Which stopper produced an `undecided` verdict; null on every other verdict. */
  undecidedCause: UndecidedCause | null;
  /** What the guard DID: dropped the candidate, or left it standing. */
  action: 'suppressed' | 'honored';
}

/**
 * THE BACKWARD-SOFT GUARD'S AUDIT (P5.3 half B) — always present on a Trust object, even
 * when it is all zeroes, and that is the whole contract. A suppression nobody can see is
 * indistinguishable from a bug, and an ABSENT audit is indistinguishable from a guard that
 * did not run. `checked: 0` says "there were no soft candidates"; a missing object would say
 * nothing at all.
 */
export interface SupersessionGuardAudit {
  /** Whether the guard was enabled for this computation (config kill switch). */
  enabled: boolean;
  /** How many soft supersession candidates were adjudicated. */
  checked: number;
  /** The candidates the guard DROPPED because a declared chain runs the other way. */
  suppressed: BackwardSoftFinding[];
  /**
   * The candidates whose check came back UNDECIDED (a cycle in the declared subgraph, or the
   * hop bound ran out). These are NOT folded into either of the other two counts — that
   * collapse is the failure mode this field exists to prevent. Their `action` records what
   * the configured `undecidedPolicy` did with them.
   */
  undecided: BackwardSoftFinding[];
}

/** An empty audit — the value every path that did no adjudication reports. Never `undefined`. */
export function emptySupersessionGuardAudit(enabled = false): SupersessionGuardAudit {
  return { enabled, checked: 0, suppressed: [], undecided: [] };
}

/**
 * TRUST REASON — WHICH BRANCH of computeTrust produced
 * this verdict. Not a new band and not new math: it NAMES the path the existing math
 * already took, so a rendered `🌱 unproven (1.00)` can never read as a self-contradiction
 * ("unproven" + a high score) with no adjacent explanation.
 *
 * The taxonomy is traced from computeTrust's own control flow (there is no invented
 * category here):
 *   - 'declared-superseded' — the DECLARED supersession hard cap (band=superseded, abstain).
 *   - 'contradicted'        — the contradiction cap (band=contradicted, abstain).
 *   - 'soft-demoted'        — a soft/auto supersession multiplied the score down
 *                             (softSupersedeDemotion). Reported ahead of the band branch
 *                             because the demotion is what moved the number.
 *   - 'stale'               — freshness (or the score) fell below stale_below.
 *   - 'cold-start'          — outcome.score === null: NO counted downstream outcome, so
 *                             score = freshness alone. THIS is the case the evaluator
 *                             flagged: honest, but unreadable without the sentence.
 *   - 'trusted'             — has outcome evidence AND score >= trusted_at.
 *   - 'ok'                  — has outcome evidence, between stale_below and trusted_at.
 *   - 'degraded'            — the signal GATHER failed (the DB/graph query threw) and the
 *                             caller fell back to a conservative freshness-only verdict. NOT
 *                             an evidence claim: saying "no counted downstream outcome yet"
 *                             about a record whose outcomes were never READ would be a lie
 *                             (nit N3). Highest precedence — nothing else was measured.
 */
export const TRUST_REASONS = [
  'cold-start',
  'stale',
  'soft-demoted',
  'declared-superseded',
  'contradicted',
  'trusted',
  'ok',
  'degraded',
] as const;
export type TrustReason = (typeof TRUST_REASONS)[number];

/** One downstream ground-truth outcome, already mapped to [0,1] (or null = ignored). */
export interface OutcomeSample {
  /** The mapped outcome value in [0,1], or null when this signal must be IGNORED
   *  (too_early / unknown decision outcome — no evidence, not a zero). */
  value: number | null;
  /** Where it came from (for observability / tests). */
  source: 'decision' | 'task';
}

/** The raw signals computeTrust() blends — gathered by trustForRecord(), or hand-built
 *  by a unit test. Keeping this a plain data bag is what makes the math unit-testable. */
export interface TrustSignals {
  /** Mapped downstream outcomes (decision/task). too_early/unknown are NOT in here. */
  outcomes: OutcomeSample[];
  /** The record's own age in days (>= 0). Negative is clamped to 0 (future-dated row). */
  ageDays: number;
  /**
   * DECLARED supersession (belief BL-4) — a HARD, human-grade signal → band=superseded +
   * abstain, capping regardless of score. True when a decision's own `superseded_by` column
   * is set, OR a `supersedes` edge points AT this record whose `created_by` is NOT the belief
   * adjudicator (a human / the `link` tool / a write-time declaration). Declared WINS over
   * soft (precedence): a record with both is treated as hard-superseded.
   */
  supersededDeclared: boolean;
  /**
   * SOFT supersession (belief BL-4) — a FALLIBLE, below-hard-bar signal from the belief
   * adjudicator → DEMOTE the score, do NOT abstain, do NOT drop. True when an AUTO
   * `supersedes` edge (created_by = 'auto:belief-adjudicator') OR any `possibly_supersedes`
   * edge points AT this record. Ignored when supersededDeclared is set (declared wins).
   */
  supersededSoft: boolean;
  /** True if the record is flagged contradicted. T4 sets this; T2b only honors it. */
  contradicted: boolean;
  /**
   * SUPERSESSION RECEIPT (belief BL-5) — the deciding inbound supersession edge's
   * "who + why", pre-built by trustForRecord() from the DB read. computeTrust() FORWARDS
   * this onto the Trust output when there IS a supersession consequence (declared or soft),
   * matching the winning tier — it never fabricates it. Absent/null when not superseded.
   */
  supersessionReceipt?: SupersessionReceipt | null;
  /**
   * DEGRADED FALLBACK (nit N3): set ONLY by a caller whose signal GATHER failed (e.g.
   * trustForRecords' per-record catch), so the verdict below is a conservative
   * freshness-only default rather than a measurement. It changes NO number — it exists so
   * the verdict does not go on to CLAIM "no counted downstream outcome yet" about outcomes
   * that were never read. Absent/false on every normal path.
   */
  degraded?: boolean;
  /**
   * BACKWARD-SOFT GUARD AUDIT (P5.3 half B) — built by `trustForRecord` when it adjudicated
   * soft supersession candidates against the declared subgraph. Forwarded verbatim onto
   * `Trust.supersessionGuard`; absent → an all-zero audit.
   *
   * ⚠️ THE SUPPRESSION ITSELF HAS ALREADY HAPPENED BY THE TIME THIS ARRIVES. The caller
   * clears `supersededSoft` / `supersessionReceipt` for a suppressed candidate before it
   * calls this function; the audit is the RECEIPT for that, not the instruction. Keeping it
   * that way is what stops the pure math from growing a second, drifting copy of the rule.
   */
  supersessionGuard?: SupersessionGuardAudit;
}

/** The computed trust object surfaced per record (spec §4 / §8.1 output shape). */
export interface Trust {
  /** Headline verdict band. */
  band: TrustBand;
  /** Blended 0–1 score, or null at cold-start (no outcome evidence → unproven). */
  score: number | null;
  /** The outcome sub-signal. */
  outcome: {
    /** Mean of COUNTED outcomes in [0,1], or null when < min_outcome_samples. */
    score: number | null;
    /** How many outcomes were COUNTED (too_early/unknown excluded). */
    samples: number;
  };
  /** The freshness sub-signal in [0,1] (0.5^(age/halflife)). */
  freshness: number;
  /**
   * Whether a newer record HARD-supersedes this one via a DECLARED signal (override →
   * abstain). BL-4: this is the DECLARED consequence only — a soft/auto supersession sets
   * `softSuperseded` instead and leaves this false.
   */
  superseded: boolean;
  /**
   * SOFT supersession flag (belief BL-4): a below-hard-bar auto/possible supersession
   * demoted this record's score but did NOT abstain or drop it. false when the record is
   * hard (declared) superseded — declared wins, so the two are mutually exclusive here.
   */
  softSuperseded: boolean;
  /** The AI should NOT rely on this record (low score OR declared-superseded OR contradicted). */
  abstain: boolean;
  /**
   * SUPERSESSION RECEIPT (belief BL-5) — WHO superseded this record and WHY. Present only
   * when the record is superseded (declared → tier 'declared'; soft → tier 'soft'), matching
   * the winning tier; null otherwise. Forwarded verbatim from TrustSignals (built by the DB
   * read in trustForRecord) — the pure math never fabricates it.
   */
  supersession: SupersessionReceipt | null;
  /**
   * WHICH BRANCH produced this verdict. DERIVED at compute time from the
   * path computeTrust actually took — never stored, never an input signal. Carried on the
   * Trust object so `structuredContent` gets the explanation too, not just the text channel.
   */
  reason: TrustReason;
  /**
   * WHAT WOULD PROMOTE this record, in the model's own terms — derived from TRUST_CONFIG
   * (min_outcome_samples / trusted_at / stale_below / soft_supersede_demotion), NEVER from
   * hardcoded numbers, so an env-tuned deployment explains ITS thresholds. null when the
   * trust math offers no promotion path (already `trusted`, or capped by a declared
   * supersession / contradiction).
   */
  promotionRequirement: string | null;
  /**
   * BACKWARD-SOFT GUARD AUDIT (P5.3 half B) — what the guard adjudicated on
   * the way to this verdict. ALWAYS PRESENT, including as an all-zero audit: the guard's
   * whole contract is that a suppression is never silent, and an optional field cannot hold
   * that contract (an absent audit and a guard that did not run read identically).
   *
   * FORWARDED, never computed here: the reachability walk needs the graph, and this module
   * is DB-free. `computeTrust` copies through what `trustForRecord` handed it and defaults
   * to `emptySupersessionGuardAudit()` when nothing was adjudicated.
   */
  supersessionGuard: SupersessionGuardAudit;
}

/**
 * FRESHNESS — exponential decay by age. freshness = 0.5^(age_days / halflife_days).
 * At age 0 → 1.0; at one half-life → 0.5; at two → 0.25. Age is clamped to >= 0 so a
 * future-dated row never reads as MORE than fresh. Pure; halflife injected via config.
 */
export function freshnessFromAge(ageDays: number, config: TrustConfig): number {
  const age = Math.max(0, ageDays);
  const hl = config.freshnessHalflifeDays; // config guarantees > 0
  return Math.pow(0.5, age / hl);
}

/**
 * OUTCOME aggregation — mean of the COUNTED downstream outcomes.
 *
 * Counts only samples with a non-null mapped value (too_early/unknown were already
 * dropped to null by the gatherer / the mapper). If the count is BELOW
 * min_outcome_samples → returns { score: null, samples } so the record reads as
 * cold-start `unproven` (NO evidence yet), NOT distrusted. Pure; config injected.
 */
export function aggregateOutcome(
  outcomes: OutcomeSample[],
  config: TrustConfig
): { score: number | null; samples: number } {
  const counted = outcomes.filter((o) => o.value !== null) as { value: number }[];
  const samples = counted.length;
  if (samples < config.minOutcomeSamples) {
    return { score: null, samples };
  }
  const mean = counted.reduce((acc, o) => acc + o.value, 0) / samples;
  return { score: mean, samples };
}

/** Map a decision.outcome_status to a [0,1] value, or null when it must be IGNORED. */
export function mapDecisionOutcome(status: string | null | undefined): number | null {
  switch (status) {
    case 'successful':
      return 1;
    case 'mixed':
      return 0.5;
    case 'failed':
      return 0;
    // too_early / unknown / null → NO evidence → ignored (not a zero).
    default:
      return null;
  }
}

/** Map a task.status to a [0,1] value, or null when it doesn't carry an outcome yet.
 *  Secondary signal: only `completed` is ground-truth EVIDENCE; everything else is either
 *  in-flight or evidence-free.
 *
 *  WHY `cancelled` MAPS TO NULL, NOT 0. A cancellation says the work
 *  STOPPED; it does not say the idea was WRONG. Measured on this project's own data: a
 *  task reap cancelled 10 tasks — 4 throwaway smoke fixtures whose own descriptions said
 *  "safe to delete", 3 duplicates, 1 superseded proposal, 2 whose premise never
 *  materialised. ZERO were failures. Mapping that to 0 makes it a full-weight FAILURE
 *  sample, and with min_outcome_samples=1 a SINGLE hygiene cancellation drove a record's
 *  whole outcome signal to 0 — which briefing selection then drops first. Absence of
 *  evidence must not be recorded as evidence of failure. `null` here means "contributes
 *  NO sample" (aggregateOutcome filters non-null before it counts or means), which is a
 *  different thing from a sample worth zero.
 *
 *  DELIBERATELY NOT MODELLED: the subset of cancellations that genuinely ARE failures.
 *  Recovering that needs a cancellation-REASON taxonomy the data does not carry today;
 *  until it does, the honest reading of `cancelled` is "no evidence either way". */
export function mapTaskOutcome(status: string | null | undefined): number | null {
  switch (status) {
    case 'completed':
      return 1;
    default:
      return null;
  }
}

/**
 * THE PURE TRUST MATH (spec §8.1). Gathered signals + injected config → Trust object.
 *
 * Order of operations (overrides BEFORE blend, per spec "overrides (caps), not blends"):
 *   1. SUPERSESSION / CONTRADICTION consequence — PROVENANCE-WEIGHTED (belief BL-4):
 *        - DECLARED supersession (human/write-time / link-tool / decision.superseded_by) →
 *          HARD cap: band=superseded, abstain=true, regardless of score (unchanged behavior).
 *        - SOFT supersession (auto belief `supersedes` OR any `possibly_supersedes`) → DEMOTE
 *          the blended score by config.softSupersedeDemotion, set softSuperseded=true, and
 *          do NOT force abstain / do NOT drop. Declared WINS if both are present.
 *        - CONTRADICTION → band=contradicted, abstain=true (declared supersession wins if both).
 *      Declared/contradicted still report the blended score (informative) but force band/abstain.
 *   2. OUTCOME: aggregate downstream outcomes → outcome_score (or null = cold-start).
 *   3. FRESHNESS: 0.5^(age/halflife).
 *   4. COMBINE:
 *        - outcome_score NULL → COLD-START: score = freshness alone (lean on freshness),
 *          band = `unproven` unless freshness is so low it's `stale`. NOT distrusted.
 *        - else score = (w_o*outcome + w_f*freshness) / (w_o + w_f)   [renormalized].
 *   5. BAND: superseded/contradicted handled in (1). Else, in order:
 *        - freshness < stale_below OR score < stale_below → stale (too old to trust)
 *        - outcome_score NULL                          → unproven (COLD-START — never
 *          `trusted`, regardless of how fresh: "trusted" REQUIRES outcome evidence. A
 *          fresh-but-unproven record can have a HIGH score but the band stays unproven so
 *          the AI knows it lacks validation. NOT distrusted — abstain stays false if fresh.)
 *        - score >= trusted_at                         → trusted (has outcome evidence)
 *        - else                                        → ok
 *   6. ABSTAIN = score < abstain_below OR superseded OR contradicted.
 */
export function computeTrust(signals: TrustSignals, config: TrustConfig = TRUST_CONFIG): Trust {
  const outcome = aggregateOutcome(signals.outcomes, config);
  const freshness = freshnessFromAge(signals.ageDays, config);

  // PROVENANCE of supersession (BL-4). DECLARED is the hard, human-grade cap; SOFT is the
  // fallible auto/possible signal that only demotes. DECLARED WINS — a record with both is
  // treated as hard-superseded, so `soft` is only the pure soft-only case.
  const declared = signals.supersededDeclared;
  const soft = signals.supersededSoft && !declared;

  // COMBINE → blended score.
  let score: number;
  if (outcome.score === null) {
    // COLD-START: no outcome evidence → lean entirely on freshness.
    score = freshness;
  } else {
    const wo = config.weightOutcome;
    const wf = config.weightFreshness;
    const denom = wo + wf;
    // Guard a degenerate all-zero weight config: fall back to a plain mean so we never
    // divide by zero (config is the contract, but be defensive).
    score = denom > 0 ? (wo * outcome.score + wf * freshness) / denom : (outcome.score + freshness) / 2;
  }

  // SOFT SUPERSEDE DEMOTION (BL-4): a below-hard-bar auto/possible supersession is a strong
  // hint, not a verdict — DEMOTE the SCORE (config multiplier, in [0,1] so this only shrinks),
  // but never abstain/drop the record here. It said "ranks below its un-superseded peers"
  // until an earlier task measured that NO read path sorts by trust — the demotion moves the
  // score and the band, and nothing else. The
  // demoted score flows into band + the score-based abstain threshold below (so a demotion
  // MAY independently trip abstain — that's allowed; soft supersession just never forces it).
  if (soft) {
    score = score * config.softSupersedeDemotion;
  }

  // OVERRIDES (caps) take precedence for band + abstain. DECLARED supersession is the hard
  // cap; a SOFT supersession is NOT an override (it demoted the score above instead).
  const overridden: TrustBand | null = declared
    ? 'superseded'
    : signals.contradicted
    ? 'contradicted'
    : null;

  let band: TrustBand;
  if (overridden) {
    band = overridden;
  } else if (freshness < config.staleBelow || score < config.staleBelow) {
    // Too old (or too weak) to lean on → stale, regardless of outcome evidence.
    band = 'stale';
  } else if (outcome.score === null) {
    // COLD-START: no outcome evidence yet → `unproven`, NEVER `trusted` (trusted requires
    // demonstrated outcomes). Honest: a fresh record can have a high freshness-driven score
    // but it has not been validated by what it informed. NOT distrusted (abstain false if fresh).
    band = 'unproven';
  } else if (score >= config.trustedAt) {
    band = 'trusted';
  } else {
    band = 'ok';
  }

  // ABSTAIN is forced by DECLARED supersession / contradiction, or an independently-weak
  // (possibly demoted) score. SOFT supersession never forces abstain — it only demoted score.
  const abstain = score < config.abstainBelow || declared || signals.contradicted;

  // EXPLAINABILITY — name the branch we JUST took, and derive what would
  // promote the record from the config. Pure bookkeeping on the verdict above: it reads the
  // same flags/band the math already produced and changes NO number.
  const reason = reasonFor({
    degraded: signals.degraded === true,
    declared,
    contradicted: signals.contradicted,
    soft,
    band,
  });
  const promotionRequirement = promotionRequirementFor(
    reason,
    outcome.score === null,
    band,
    config
  );

  return {
    band,
    // Score is always meaningful to report; only the COLD-START outcome sub-signal is null.
    score,
    outcome,
    freshness,
    // `superseded` is the HARD (declared) consequence only; a soft one sets softSuperseded.
    superseded: declared,
    softSuperseded: soft,
    abstain,
    // BL-5 RECEIPT: forward the pre-built receipt ONLY when there is a supersession
    // consequence (declared or soft). Pure forwarding — trustForRecord built it to match the
    // winning tier (declared-wins), so no re-selection here. Null when not superseded.
    supersession: declared || soft ? signals.supersessionReceipt ?? null : null,
    reason,
    promotionRequirement,
    // BACKWARD-SOFT GUARD AUDIT (P5.3 half B): forwarded verbatim, defaulted to an all-zero
    // audit. Never `undefined` — see the field doc on `Trust` for why absence is not allowed
    // to be a state here.
    supersessionGuard: signals.supersessionGuard ?? emptySupersessionGuardAudit(),
  };
}

/**
 * Map the branch computeTrust took → the TrustReason token. PRECEDENCE mirrors the math's
 * own precedence: the two CAPS first (declared supersession, then contradiction — declared
 * wins there too), then the SOFT demotion (it is what moved the score, so it out-explains
 * the resulting band), then the band branch itself. Kept as one small pure function so the
 * taxonomy has exactly ONE definition.
 */
function reasonFor(v: {
  degraded: boolean;
  declared: boolean;
  contradicted: boolean;
  soft: boolean;
  band: TrustBand;
}): TrustReason {
  // A degraded fallback measured NOTHING — it must not claim any of the branches below.
  if (v.degraded) return 'degraded';
  if (v.declared) return 'declared-superseded';
  if (v.contradicted) return 'contradicted';
  if (v.soft) return 'soft-demoted';
  if (v.band === 'stale') return 'stale';
  if (v.band === 'unproven') return 'cold-start';
  if (v.band === 'trusted') return 'trusted';
  return 'ok';
}

/** Format a config threshold for display without inventing precision (0.66 → "0.66"). */
function num(v: number): string {
  return String(v);
}

/** "1 counted downstream outcome" / "2 counted downstream outcomes" — the sample noun. */
function outcomeNoun(n: number): string {
  return `counted downstream outcome${n === 1 ? '' : 's'}`;
}

/**
 * WHAT WOULD PROMOTE this record — derived ENTIRELY from TRUST_CONFIG (no hardcoded
 * thresholds: an env-tuned deployment explains its OWN numbers). Returns null where the
 * trust math offers no promotion path:
 *   - a DECLARED supersession / a contradiction are CAPS, not scores — no amount of
 *     outcome evidence lifts them (the fix is at the graph, not the math), and
 *   - `trusted` is already the top band.
 */
function promotionRequirementFor(
  reason: TrustReason,
  outcomeIsNull: boolean,
  band: TrustBand,
  config: TrustConfig
): string | null {
  // Already at the top band (e.g. a soft-demoted record that is STILL `trusted`): there is
  // nothing left to promote, whatever the reason branch was.
  if (band === 'trusted') return null;
  // The evidence clause every non-capped reason needs while there is still NO counted
  // outcome (the cold-start floor: min_outcome_samples).
  const evidenceClause = `>= ${config.minOutcomeSamples} ${outcomeNoun(config.minOutcomeSamples)}`;
  switch (reason) {
    case 'declared-superseded':
    case 'contradicted':
    case 'trusted':
      return null;
    // A degraded verdict has no promotion path because nothing was measured — the remedy is
    // to re-read the record, not to earn evidence.
    case 'degraded':
      return null;
    case 'cold-start':
      return `${evidenceClause}, then score >= ${num(config.trustedAt)}`;
    case 'stale':
      return outcomeIsNull
        ? `${evidenceClause} and freshness/score >= ${num(config.staleBelow)} to leave stale, then score >= ${num(config.trustedAt)}`
        : `freshness/score >= ${num(config.staleBelow)} to leave stale, then score >= ${num(config.trustedAt)}`;
    case 'soft-demoted':
      return outcomeIsNull
        ? `resolve the soft supersession (score is demoted x${num(config.softSupersedeDemotion)}), plus ${evidenceClause}, then score >= ${num(config.trustedAt)}`
        : `resolve the soft supersession (score is demoted x${num(config.softSupersedeDemotion)}), then score >= ${num(config.trustedAt)}`;
    case 'ok':
      return `score >= ${num(config.trustedAt)}`;
  }
}

/**
 * BL-5 — render the supersession RECEIPT clause for the TEXT channel (the moat pitch made
 * visible). Returns '' when there's no receipt. Inserted right AFTER the band token so a HARD
 * record reads "⛔ superseded by <id8>" and a SOFT one reads
 * "possibly superseded by <id8> (conf 0.85) — shown; check <id8> before relying on this".
 * Centralized here (one
 * definition) so all recall surfaces render the receipt identically.
 *
 * IT NO LONGER SAYS "shown, ranked lower". That clause is an assertion about
 * the CALLER'S ORDERING, and this function has four callers with four different orderings —
 * search.routes applies trust AFTER the relevance sort and documents that "order is
 * unchanged", recallThreadCore's orderThread sorts anchor → causal rank → time → id, and
 * currentStateCore sorts byRecencyThenId. A central renderer cannot truthfully assert an
 * ordering property of surfaces that do not perform it, and the demotion it CAN vouch for is
 * the one it applied: the score. So it states that, and points at the record to check — which
 * is also the actionable half a reader can do something with.
 */
export function supersessionReceiptHint(trust: Trust): string {
  const r = trust.supersession;
  if (!r) return '';
  const short = shortId(r.supersededBy);
  if (r.tier === 'declared') {
    // The band token is already "⛔ superseded" → appended reads "⛔ superseded by <id8>".
    return ` by ${short}`;
  }
  const conf = r.confidence === null ? '' : ` (conf ${r.confidence.toFixed(2)})`;
  return ` — possibly superseded by ${short}${conf} — shown; check ${short} before relying on this`;
}

/**
 * TRUST EXPLANATION — the ONE renderer for a trust
 * verdict, sitting directly beside supersessionReceiptHint() (the BL-5 "show receipts"
 * precedent this follows). Every render site calls THIS; nobody re-implements a band token,
 * a score, a cold-start clause or an abstain marker.
 *
 * WHY IT EXISTS (the bug it closes): the same hint was hand-written at FOUR render sites and
 * TWO had already degraded — search.routes truncated the cold-start clause to ", cold-start",
 * and recall_thread's node headline had lost the clause AND the score entirely, so the
 * surface an orienting agent reads printed a bare band. And no surface printed the evidence
 * count or what would promote the record, so an honest `🌱 unproven (1.00)` (freshness 1.00,
 * ZERO outcome evidence) read as a self-contradiction to an outside evaluator.
 *
 * PRESENTATION ONLY — reads the Trust object, computes NO trust. Every number it prints
 * (thresholds, sample floor, demotion) comes from the Trust object or TRUST_CONFIG.
 */
export interface TrustExplanation {
  /** The band, and its emoji token (the ONE place TRUST_BAND_HINT is read). */
  band: TrustBand;
  bandHint: string;
  /** The blended score, and its display form ('n/a' in the theoretically-null case). */
  score: number | null;
  scoreText: string;
  /** WHICH branch produced the verdict, and the human sentence for it. */
  reason: TrustReason;
  reasonText: string;
  /** How much counted outcome evidence stands behind it. */
  evidenceSamples: number;
  evidenceText: string;
  /** What would promote the record (config-derived), or null when there is no path. */
  promotionRequirement: string | null;
  /** BL-5 receipt clause (''), unchanged — kept here so a site never re-derives it. */
  receipt: string;
  /**
   * The ABSTAIN marker ("do not rely on this"), or ''. ONE spelling for every surface —
   * recall_thread used to hand-roll its own ' ⛔ABSTAIN' at the call site while the other
   * three rendered ' · abstain', which is the same drift this task exists to end. It is
   * already folded into BOTH `compact` and `line`; it is exposed only so a surface that
   * composes its own layout can place it without re-inventing the string.
   */
  abstainMark: string;
  /**
   * COMPACT one-liner for DENSE lists (recall_thread renders many nodes): band + receipt +
   * score + the reason sentence + the evidence count + the abstain marker. No promotion
   * clause — that rides in structuredContent (trust.reason / trust.promotionRequirement).
   */
  compact: string;
  /**
   * The FULL one-line hint for a per-record recall row ("🔐 Trust: …"): compact + the
   * promotion requirement.
   */
  line: string;
  /**
   * MACHINE-LEAN trust signal (WS1 "clean the pipes", D2) — what every MCP
   * text surface renders. Terse key:value, NO emoji and NO prose sentences: band + score,
   * plus the supersession flag when present (that annotation was audited as correct and
   * load-bearing — the INFORMATION stays, the packaging goes) and the abstain marker.
   *   `trust:unproven score:1.00`
   *   `trust:superseded score:0.10 superseded_by:a1b2c3d4 tier:declared abstain`
   *   `trust:weak score:0.31 superseded_by:a1b2c3d4 tier:auto conf:0.87`
   * The WHY prose (`reasonText`) and promotion clause still exist on this object and in
   * structuredContent.trust — a caller that wants them reads the structured channel.
   */
  signal: string;
}

export function explainTrust(trust: Trust, config: TrustConfig = TRUST_CONFIG): TrustExplanation {
  const band = trust.band as TrustBand;
  const bandHint = TRUST_BAND_HINT[band] ?? String(trust.band);
  const scoreText = trust.score === null ? 'n/a' : trust.score.toFixed(2);
  const receipt = supersessionReceiptHint(trust);
  const samples = trust.outcome.samples;
  // A degraded verdict never READ the outcomes, so "0 counted downstream outcomes" would be
  // the same false evidentiary claim the reason sentence refuses to make (nit N3).
  const evidenceText =
    trust.reason === 'degraded'
      ? 'not read — the signal gather failed'
      : `${samples} ${outcomeNoun(samples)}`;
  const reasonText = reasonSentence(trust, config);
  // ONE abstain marker for every surface, folded into BOTH renderings (nit N2): the dense
  // node list and the per-record row must not disagree about how "do not rely on this" looks.
  // (This IS the definition site; the guard's rules skip this file, so no marker comment
  // belongs here — an inert marker reads as load-bearing to the next person. Nit N5.)
  const abstainMark = trust.abstain ? ' · ⛔ abstain' : '';

  // ONE composition, reused (nit N4). `core` is written ONCE and both renderings are built
  // from it, so the two can no longer drift apart even in miniature — which is precisely the
  // failure this whole task exists to end. ` · ` separates the LABELLED parts; a labelled
  // separator rather than another em-dash, because the reason sentences and the BL-5 receipt
  // already contain em-dashes and reusing one made the line unparseable.
  const scorePart = trust.score === null ? '' : ` (${scoreText})`;
  const core = `${bandHint}${receipt}${scorePart} · why: ${reasonText} · evidence: ${evidenceText}`;
  const promo = trust.promotionRequirement ? ` · to promote: ${trust.promotionRequirement}` : '';
  // The abstain marker closes BOTH renderings (it is the loudest thing on the line, so it
  // goes last); the promotion clause only exists on the full row, ahead of it.
  const compact = `${core}${abstainMark}`;
  const line = `🔐 Trust: ${core}${promo}${abstainMark}`;

  // The machine-lean signal (WS1): band + score + supersession flag +
  // abstain, terse key:value, zero emoji/prose. Composed HERE — the one renderer — so no
  // surface can hand-roll its own spelling (the same single-source rule as `line`).
  const supersessionPart = trust.supersession
    ? ` superseded_by:${shortId(trust.supersession.supersededBy)}` +
      ` tier:${trust.supersession.tier}` +
      (trust.supersession.confidence === null
        ? ''
        : ` conf:${trust.supersession.confidence.toFixed(2)}`)
    : '';
  const signal =
    `trust:${band} score:${scoreText}${supersessionPart}${trust.abstain ? ' abstain' : ''}`;

  return {
    band,
    bandHint,
    score: trust.score,
    scoreText,
    reason: trust.reason,
    reasonText,
    evidenceSamples: samples,
    evidenceText,
    promotionRequirement: trust.promotionRequirement,
    receipt,
    abstainMark,
    compact,
    line,
    signal,
  };
}

/**
 * The human sentence for each branch — the piece that makes `🌱 unproven (1.00)` legible:
 * "no counted downstream outcome yet — score is freshness alone". One definition, read by
 * every render site through explainTrust().
 */
function reasonSentence(trust: Trust, config: TrustConfig): string {
  switch (trust.reason) {
    case 'degraded':
      // NEVER an evidence claim (nit N3): the outcomes were not read, so we say exactly that.
      return 'trust signals could not be read (degraded fallback) — this is NOT an evidence claim; treat the record as unevaluated';
    case 'declared-superseded':
      return 'a newer record declared-supersedes this one — do not rely on it';
    case 'contradicted':
      return 'a live record asserts the opposite — do not rely on it';
    case 'soft-demoted':
      // States the demotion this function actually applied, and stops there.
      // "ranked lower" was a claim about the reading surface's sort order; see
      // supersessionReceiptHint above for why a shared renderer may not make one.
      return `a soft (auto) supersession demoted the score x${num(config.softSupersedeDemotion)} — the demotion is in the score; the record is still shown`;
    case 'stale': {
      // HONEST about WHICH input tripped it: the band fires on freshness OR score being
      // below stale_below, and either one alone is possible (a record with a failed
      // downstream outcome can be stale while still fresh).
      const freshLow = trust.freshness < config.staleBelow;
      const scoreLow = trust.score !== null && trust.score < config.staleBelow;
      const which =
        freshLow && scoreLow
          ? `freshness ${trust.freshness.toFixed(2)} and score ${trust.score!.toFixed(2)} are`
          : freshLow
          ? `freshness ${trust.freshness.toFixed(2)} is`
          : `score ${trust.score === null ? 'n/a' : trust.score.toFixed(2)} is`;
      return `too old/weak to lean on — ${which} below stale_below ${num(config.staleBelow)}`;
    }
    case 'cold-start':
      return 'no counted downstream outcome yet — score is freshness alone';
    case 'trusted':
      return `outcome evidence puts the score at/above trusted_at ${num(config.trustedAt)}`;
    case 'ok':
      return `has outcome evidence but the score is below trusted_at ${num(config.trustedAt)}`;
  }
}

/** First 8 hex chars of a record id (dashes stripped) — the compact form used in text hints. */
function shortId(id: string): string {
  return id.replace(/-/g, '').slice(0, 8);
}
