/**
 * GRAPH-AWARE PROJECT INSIGHTS — the coverage config
 * (Amp-orb eval Lane B P2, report lines 558-581).
 *
 * WHAT THIS REPLACES. `identifyKnowledgeGaps()` / `identifyDecisionGaps()` were raw COUNT
 * thresholds with zero edge reads:
 *     if (decisionStats.total < 5) -> 'Low decision count - consider documenting more
 *                                     technical choices'
 * That is verbatim the advice the Amp-orb evaluator received on a project that had exactly
 * the decisions it needed and every task complete. The evaluator's verdict: `recall_thread`
 * was SUBSTANTIALLY MORE ACCURATE than `project.insights`. A health signal that rewards
 * VOLUME is a health signal nobody should trust.
 *
 * THE RULE THIS CONFIG ENCODES: an insight fires on COVERAGE (a ratio of the graph, or a
 * signal the current-state read model already derived) — NEVER on an absolute record count.
 * There is no knob below that compares a population size to a magic number, and there must
 * never be one. The property is guarded, not just asserted: projectCoverage.unit.test.ts
 * scales a graph ×1/×3/×17 with the ratios held constant and requires the fired finding-code
 * set to be IDENTICAL. A count-triggered rule cannot survive that test.
 *
 * STANDING PRINCIPLE (the operator, binds this + all future builds): NO HARDCODED VARIABLES. Every
 * tunable lives HERE — named, documented, env-overridable — mirroring currentStateConfig.ts:
 *   - SCALARS + flags are env-overridable (an eval sweep moves them with zero code edit),
 *   - VALUE-POLICY vocabularies (which edge types GROUND a record, which decision statuses
 *     mean "retired") are named-config defaults rather than env scalars, because they are
 *     semantics, not knobs.
 *
 * Env reads happen at module load with a safe fallback (bad/missing → the default), exactly
 * like currentStateConfig.envInt / envUnitFloat.
 */

import { EDGE_TYPES } from './edgeTypes.js';
import { TRUST_BANDS, type TrustBand } from './trustConfig.js';

/** Read a [0,1] float env var, falling back to `fallback` on missing/out-of-range/garbage. */
function envUnitFloat(name: string, fallback: number): number {
  const raw = process.env[name]; // env-read: via-callers
  const v = Number(raw);
  if (raw === undefined || raw === '') return fallback;
  return Number.isFinite(v) && v >= 0 && v <= 1 ? v : fallback;
}

/** Read a positive-integer env var, falling back to `fallback` on missing/garbage. */
function envInt(name: string, fallback: number): number {
  const raw = process.env[name]; // env-read: via-callers
  const v = Number(raw);
  if (raw === undefined || raw === '') return fallback;
  return Number.isInteger(v) && v > 0 ? v : fallback;
}

/**
 * Read a trust FLOOR from env: a trust-vocabulary name or a 0–1 score. Anything the
 * vocabulary does not contain (and that is not a valid score) falls back — a floor we cannot
 * interpret must never silently become "no floor at all". Same shape as
 * currentStateConfig.envTrustFloor (the two configs describe the SAME floor vocabulary and
 * are both evaluated by the SAME clearsMinTrust predicate).
 */
function envTrustFloor(name: string, fallback: TrustBand | number): TrustBand | number {
  const raw = process.env[name]; // env-read: via-callers
  const v = (raw ?? '').trim();
  if (v === '') return fallback;
  if ((TRUST_BANDS as readonly string[]).includes(v)) return v as TrustBand; // trust-render-exempt: matches a floor ARGUMENT against the vocabulary; renders no verdict
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : fallback;
}

// ─────────────────────────────────────────────────────────────────────────────
// THE EDGE-TYPE PARTITION (value policy — and a fail-closed one)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GROUNDING edge types: an edge of one of these types is real evidence that a record is
 * connected to the reasoning around it — a plan, a decision, the work that produced it, or
 * the outcome it produced. "Are active tasks linked to plans/decisions/outcomes?" is answered
 * by asking whether the task carries at least one of these.
 */
export const COVERAGE_GROUNDING_EDGE_TYPES: readonly string[] = [
  'decided_by',
  'caused',
  'built_by',
  'learned_from',
  'proposed_by',
  'informs',
  'produced_outcome',
  'depends_on',
  // The structural parent edge (migration 080), minted at task_create from the explicit
  // `parentTaskId` param (an earlier task — position never mints it). Classified GROUNDING
  // for the same reason depends_on is: it connects a task to the work-structure around it
  // (its parent) — it is real, declared structure, not an inference fallback.
  'subtask_of',
];

/**
 * WEAK edge types: present, but NOT grounding. `related_to` is the no-orphan inference
 * fallback — it is minted precisely when the system could NOT establish
 * a real relationship, so counting it as grounding would let the weakest possible signal
 * manufacture the coverage this module exists to measure.
 */
export const COVERAGE_WEAK_EDGE_TYPES: readonly string[] = ['related_to'];

/**
 * SUPERSESSION edge types: lifecycle, not grounding. A record is not "connected to its
 * reasoning" because something replaced it.
 */
export const COVERAGE_SUPERSESSION_EDGE_TYPES: readonly string[] = [
  'supersedes',
  'possibly_supersedes',
];

/**
 * FAIL-CLOSED VOCABULARY TOTALITY (a past incident — an unrecognized input must be a loud RED,
 * never a silent pass).
 *
 * The three buckets above must PARTITION the live edge-type domain exactly. If someone adds a
 * twelfth edge type to edgeTypes.ts and does not classify it here, the honest failure modes
 * are: silently treat it as grounding (OVERSTATES coverage — a health signal that lies
 * upward, the exact disease this task fixes) or silently treat it as weak (UNDERSTATES). We
 * take neither. The module THROWS at load, naming the offender.
 *
 * This is the choke point: every edge type must pass through EDGE_TYPES, and every member of
 * EDGE_TYPES must be accounted for here. There is no shape to guess at and no allow-list to
 * drift.
 */
export function assertEdgeTypePartitionTotal(
  domain: readonly string[] = EDGE_TYPES,
  grounding: readonly string[] = COVERAGE_GROUNDING_EDGE_TYPES,
  weak: readonly string[] = COVERAGE_WEAK_EDGE_TYPES,
  supersession: readonly string[] = COVERAGE_SUPERSESSION_EDGE_TYPES
): void {
  const buckets: Array<[string, readonly string[]]> = [
    ['grounding', grounding],
    ['weak', weak],
    ['supersession', supersession],
  ];

  // 1. Every classified value must EXIST in the domain (a stale entry left behind by a
  //    rename is just as wrong as a missing one, and far harder to notice).
  for (const [name, list] of buckets) {
    for (const t of list) {
      if (!domain.includes(t)) {
        throw new Error(
          `coverageConfig: '${t}' is classified as ${name} but is not a live edge type ` +
            `(EDGE_TYPES = [${domain.join(', ')}]). Remove the stale entry — a classification ` +
            `for an edge type that no longer exists silently narrows the partition check.`
        );
      }
    }
  }

  // 2. No value may appear in two buckets (an edge type that is both grounding and weak has
  //    no defined meaning, and whichever check runs first would win by accident).
  const seen = new Map<string, string>();
  for (const [name, list] of buckets) {
    for (const t of list) {
      const prior = seen.get(t);
      if (prior !== undefined) {
        throw new Error(
          `coverageConfig: edge type '${t}' is classified as BOTH ${prior} and ${name}. ` +
            `Each edge type must land in exactly one bucket.`
        );
      }
      seen.set(t, name);
    }
  }

  // 3. Every live edge type must be classified. THIS is the rung that catches a new edge type.
  const unclassified = domain.filter((t) => !seen.has(t));
  if (unclassified.length > 0) {
    throw new Error(
      `coverageConfig: edge type(s) [${unclassified.join(', ')}] are not classified as ` +
        `grounding / weak / supersession. Graph-aware insights must know what every edge ` +
        `MEANS before it can report coverage — an unclassified edge type would otherwise be ` +
        `silently treated as one or the other and quietly move every coverage ratio. ` +
        `Classify it in config/coverageConfig.ts.`
    );
  }
}

// Enforced at module load: the partition is a precondition of every ratio computed from it.
assertEdgeTypePartitionTotal();

// ─────────────────────────────────────────────────────────────────────────────
// THE OTHER VOCABULARIES (value policy — named config, not env scalars)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * DECISION statuses that mean "this decision has been RETIRED" (technical_decisions.status
 * domain: active | deprecated | superseded | under_review). A retired decision should be
 * retired IN THE GRAPH too — superseded by something, so a reader lands on the replacement.
 * A retired status with no supersession signal is a dead end, and that is what
 * `undeclared-supersession` reports.
 */
export const COVERAGE_RETIRED_DECISION_STATUSES: readonly string[] = ['superseded', 'deprecated'];

// ─────────────────────────────────────────────────────────────────────────────
// THE KNOBS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The ratio below which a coverage dimension is reported as a finding. Deliberately a RATIO
 * of a measured population, never a population size: a project with 2 fully-grounded
 * decisions is at ratio 1.0 and says nothing, while a project with 200 records of which half
 * are orphaned is at 0.5 and says so. This is the knob that replaced `total < 5`.
 */
export interface CoverageThresholds {
  /** Active tasks carrying ≥1 grounding edge. Env: MANDREL_INSIGHTS_GROUNDING_FLOOR. */
  activeTaskGrounding: number;
  /** Landed tasks backed by ≥1 trusted-outcome neighbour. Env: MANDREL_INSIGHTS_EVIDENCE_FLOOR. */
  completedTaskEvidence: number;
  /** Records carrying ≥1 edge of any type. Env: MANDREL_INSIGHTS_CONVERGENCE_FLOOR. */
  branchConvergence: number;
  /** Records carrying a session attribution. Env: MANDREL_INSIGHTS_ATTRIBUTION_FLOOR. */
  sessionAttribution: number;
  /** Historical records that clear the trust floor. Env: MANDREL_INSIGHTS_HISTORY_TRUST_FLOOR_RATIO. */
  historicalTrust: number;
}

export interface CoverageConfig {
  /** The per-dimension ratio floors (see CoverageThresholds). */
  floors: CoverageThresholds;
  /**
   * The trust floor a record must clear to count as PROVEN — both for "is this completed
   * task's evidence any good" and for "are these historical records trustworthy". A
   * vocabulary name or a 0–1 score, evaluated by the SAME clearsMinTrust() every other read
   * model uses (one definition of the rule).
   * Env: MANDREL_INSIGHTS_TRUST_FLOOR.
   */
  trustFloor: TrustBand | number;
  /**
   * Max records HYDRATED + trust-annotated for one insights call. The scope is reported
   * exactly (`recordsInProject` vs `recordsExamined` vs `truncated`), so a capped read is a
   * STATED sample, never a silently partial answer.
   * Env: MANDREL_INSIGHTS_MAX_NODES.
   */
  maxNodes: number;
  /**
   * Max record ids echoed as a per-finding drill-down SAMPLE. Finding COUNTS are always
   * exact and complete — this bounds the id list only.
   * Env: MANDREL_INSIGHTS_MAX_SAMPLE_IDS.
   */
  maxSampleIds: number;
  /** Max findings rendered in the human channel (the machine channel carries them all).
   *  Env: MANDREL_INSIGHTS_MAX_RENDERED_FINDINGS. */
  maxRenderedFindings: number;
  /** Edge types that GROUND a record (named-config policy). */
  groundingEdgeTypes: readonly string[];
  /** Edge types that exist but do not ground (named-config policy). */
  weakEdgeTypes: readonly string[];
  /** Lifecycle/supersession edge types (named-config policy). */
  supersessionEdgeTypes: readonly string[];
  /** Decision statuses meaning "retired" (named-config policy). */
  retiredDecisionStatuses: readonly string[];
}

/**
 * THE LIVE CONFIG — read once at module load. Defaults are the documented values above; every
 * scalar is env-overridable so an eval sweep needs no code edit.
 *
 * On the FLOOR defaults: they are deliberately demanding (0.9 / 0.8) because these dimensions
 * are things a well-kept graph really does achieve — the eval's own project scored 1.0 on
 * task/outcome coverage. A floor is the point at which we SAY something; it is not a score.
 */
export const COVERAGE_CONFIG: CoverageConfig = {
  floors: {
    activeTaskGrounding: envUnitFloat('MANDREL_INSIGHTS_GROUNDING_FLOOR', 0.9),
    completedTaskEvidence: envUnitFloat('MANDREL_INSIGHTS_EVIDENCE_FLOOR', 0.8),
    branchConvergence: envUnitFloat('MANDREL_INSIGHTS_CONVERGENCE_FLOOR', 0.9),
    sessionAttribution: envUnitFloat('MANDREL_INSIGHTS_ATTRIBUTION_FLOOR', 0.9),
    historicalTrust: envUnitFloat('MANDREL_INSIGHTS_HISTORY_TRUST_FLOOR_RATIO', 0.8),
  },
  trustFloor: envTrustFloor('MANDREL_INSIGHTS_TRUST_FLOOR', 'ok'),
  maxNodes: envInt('MANDREL_INSIGHTS_MAX_NODES', 300),
  maxSampleIds: envInt('MANDREL_INSIGHTS_MAX_SAMPLE_IDS', 5),
  maxRenderedFindings: envInt('MANDREL_INSIGHTS_MAX_RENDERED_FINDINGS', 6),
  groundingEdgeTypes: COVERAGE_GROUNDING_EDGE_TYPES,
  weakEdgeTypes: COVERAGE_WEAK_EDGE_TYPES,
  supersessionEdgeTypes: COVERAGE_SUPERSESSION_EDGE_TYPES,
  retiredDecisionStatuses: COVERAGE_RETIRED_DECISION_STATUSES,
};
