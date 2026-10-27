/**
 * CURRENT-STATE read model — the config (Amp-orb eval
 * Lane B P2).
 *
 * WHAT THE READ MODEL IS: `recall_thread(altitude:"current")` answers "where does this stand
 * RIGHT NOW and what should I do next?" in ONE bounded response, from the typed-edge graph
 * alone. DETERMINISTIC — same graph in, same answer out. There is NO model call anywhere in
 * the path (Mandrel ships inside customer containers; it must never require an LLM/API key).
 *
 * STANDING PRINCIPLE (the operator, binds this + all future builds): NO HARDCODED VARIABLES. Every
 * knob the read model touches — the status vocabularies it classifies by, the per-section
 * caps, the trust floor for "trusted" outcomes, the gate ladder itself — lives HERE: a named
 * value with a documented default. This mirrors threadConfig.ts / trustConfig.ts /
 * edgeTypes.ts exactly:
 *   - SCALARS + flags are env-overridable (an eval sweep can move them with zero code edit),
 *   - VALUE-POLICY vocabularies (which statuses mean "active", the gate ladder order) are
 *     named-config defaults rather than env scalars, because they are semantics, not knobs —
 *     the same call threadConfig makes for FRONTIER_EDGE_TYPE_PRIORITY.
 *
 * Env reads happen at module load with a safe fallback (bad/missing → the default), exactly
 * like threadConfig.envInt / trustConfig.envFloat.
 */

import { TRUST_BANDS, type TrustBand } from './trustConfig.js';
import { IMPLEMENTATION_STATUS_DEFAULT } from './decisionVocab.js';
import { type ThreadContentAltitude, isContentAltitude } from './threadConfig.js';

/** Read a positive-integer env var, falling back to `fallback` on missing/garbage. */
function envInt(name: string, fallback: number): number {
  const raw = process.env[name]; // env-read: via-callers
  if (raw === undefined || raw === '') return fallback;
  const v = Number(raw);
  return Number.isInteger(v) && v > 0 ? v : fallback;
}

/** Read a [0,1] float env var, falling back to `fallback` on missing/out-of-range/garbage. */
function envUnitFloat(name: string, fallback: number): number {
  const raw = process.env[name]; // env-read: via-callers
  if (raw === undefined || raw === '') return fallback;
  const v = Number(raw);
  return Number.isFinite(v) && v >= 0 && v <= 1 ? v : fallback;
}

/**
 * Read a boolean env var ('true'/'false', case-insensitive); anything else → fallback.
 *
 * NOTE ON THE SHAPE OF THE ENV READ (all four helpers here): the read is its OWN statement,
 * `const raw = process.env[name];`, and the normalising happens on the NEXT line. That is not
 * style — writing it as `const raw = (process.env[name] ?? '').trim()` makes the deploy gate's
 * env-accounting classifier read `const raw = (` as an
 * arrow-function DEFINITION, so it derives a via-callers helper literally named `raw` and then
 * greps the whole repo for calls to it — flagging `git.raw(['ls-tree', …])` in the command
 * backend as an env read with a computed argument. Measured: that exact mutation turned the
 * clean gate RED. Keep the read on its own line.
 */
function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name]; // env-read: via-callers
  const v = (raw ?? '').trim().toLowerCase();
  if (v === 'true') return true;
  if (v === 'false') return false;
  return fallback;
}

/**
 * Read a trust FLOOR from env: either a trust-vocabulary name or a 0–1 score. Anything the
 * vocabulary does not contain (and that is not a valid score) falls back — a floor we cannot
 * interpret must never silently become "no floor at all".
 */
function envTrustFloor(name: string, fallback: TrustBand | number): TrustBand | number {
  const raw = process.env[name]; // env-read: via-callers
  const v = (raw ?? '').trim();
  if (v === '') return fallback;
  if ((TRUST_BANDS as readonly string[]).includes(v)) return v as TrustBand;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : fallback;
}

/** Read a CONTENT altitude from env; a non-content altitude falls back (never a throw here). */
function envContentAltitude(name: string, fallback: ThreadContentAltitude): ThreadContentAltitude {
  const raw = process.env[name]; // env-read: via-callers
  const v = (raw ?? '').trim();
  return isContentAltitude(v) ? v : fallback;
}

// ─────────────────────────────────────────────────────────────────────────────
// THE CLASSIFICATION VOCABULARIES (value policy — named config, not env scalars)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * TASK statuses that mean "this is OPEN work you could pick up right now".
 * Drawn from the `tasks.status` domain (middleware/validation.ts taskStatusEnum:
 * todo | in_progress | blocked | completed | cancelled). `in_progress` is listed FIRST
 * because the classifier's ordering is also the recommendation ordering: the thing already
 * in flight is the thing to continue before starting something new.
 */
export const CURRENT_ACTIVE_TASK_STATUSES: readonly string[] = ['in_progress', 'todo'];

/** TASK statuses that mean "this is STUCK" — the blocker signal. */
export const CURRENT_BLOCKED_TASK_STATUSES: readonly string[] = ['blocked'];

/**
 * DECISION statuses that mean "this decision still STANDS" (technical_decisions.status
 * domain: active | deprecated | superseded | under_review). `under_review` still stands —
 * it is live and being re-examined, which is exactly what an orienting agent must see.
 */
export const CURRENT_STANDING_DECISION_STATUSES: readonly string[] = ['active', 'under_review'];

/**
 * DECISION outcome_status values that mean "the learning loop is still OPEN" (the column
 * defaults to 'unknown'; the GAP1 evaluator writes successful/mixed/failed). A NULL/absent
 * value counts as open too — that is handled in code, not spellable here.
 */
export const CURRENT_OPEN_OUTCOME_STATUSES: readonly string[] = ['unknown', 'too_early'];

/**
 * DECISION implementation_status values that mean "the thing we decided has NOT been built
 * yet" — a HALF-EXECUTED decision.
 *
 * From the technical_decisions.implementation_status domain, which lives in ONE place
 * (config/decisionVocab.ts) — this is a POLICY subset of that vocabulary, not a second copy
 * of it, and a contract test asserts every value here is a member of it. `implemented`,
 * `validated` and `deprecated` are all "no longer waiting on a build": the first two shipped,
 * and a deprecated decision is not going to be built.
 *
 * WHY THIS IS A READ-MODEL CONCERN AT ALL: a decision that is `active`, outcome `unknown` and
 * implementation `planned` for 25 days reads IDENTICALLY, on every orienting surface, to a
 * decision made yesterday. That is how an earlier decision sat at `planned` for 12 days after
 * shipping with nothing to correct it, and how an audit then derived "unstarted" from it
 *. A NULL/absent value counts as UNBUILT — handled in code, not spellable
 * here, because "we do not know whether it was built" must never render as "it was built".
 */
export const CURRENT_UNBUILT_IMPLEMENTATION_STATUSES: readonly string[] = [
  'planned',
  'in_progress',
];

/**
 * THE HISTORICAL SPLIT — "we shipped it" vs "we gave up on it".
 *
 * `historical` is the fallback disposition: a record that is CURRENT (not superseded) but is
 * not part of the current state. Before this task it was ONE word for two opposite outcomes,
 * so a completed deliverable and an abandoned thread read identically to an orienting agent —
 * which is exactly what invites someone to rebuild a thing that already shipped.
 *
 * The split below is DERIVED from lifecycle columns the writer already sets. There is no new
 * field to remember. Where the columns carry no signal the answer is `historical-unknown`,
 * never a guess: an honest unknown beats a confident wrong classification.
 *
 * WHAT THE SPLIT MEANS — CARRIED OUT vs STOPPED, not good vs bad. `completed` says the work
 * was DONE; it says nothing about whether it worked. Outcome QUALITY is a separate axis and
 * already has its own home (outcome_status, and the `trusted-outcome` disposition). Folding
 * the two axes together is how we got one word for two outcomes in the first place.
 */

/** TASK statuses that mean the work was CARRIED OUT. Non-default (`tasks.status` defaults to
 *  'todo'), so this is an explicit signal a writer set, never an unfilled column. */
export const CURRENT_COMPLETED_TASK_STATUSES: readonly string[] = ['completed'];

/** TASK statuses that mean the work STOPPED without being carried out. Also non-default. */
export const CURRENT_ABANDONED_TASK_STATUSES: readonly string[] = ['cancelled'];

/**
 * DECISION implementation_status values that mean the decided thing WAS built.
 * A POLICY subset of IMPLEMENTATION_STATUSES (decisionVocab.ts), asserted by contract test.
 * `deprecated` is deliberately absent: it says the decision was retired, not whether it was
 * ever built, so it must fall through to `historical-unknown`.
 */
export const CURRENT_BUILT_IMPLEMENTATION_STATUSES: readonly string[] = [
  'implemented',
  'validated',
];

/**
 * DECISION implementation_status values that mean the build was STARTED and then stopped.
 *
 * DERIVED, not hand-listed: it is `unbuiltImplementationStatuses` MINUS the column's DB
 * DEFAULT. That subtraction is the whole point. `implementation_status` DEFAULTs to
 * 'planned', so a decision reading 'planned' may equally be one nobody ever touched — the
 * value carries NO information about whether work stopped. Calling that "abandoned" would be
 * a confident wrong classification of, in the general case, most decisions ever recorded.
 * 'in_progress' is a value a writer had to set on purpose, so it does discriminate.
 *
 * Consequence, stated plainly: most closed decisions will classify `historical-unknown`.
 * That is the honest reading of the data we actually store, and it is visible in the output
 * as its own number rather than inflating either side.
 */
export const CURRENT_ABANDONED_IMPLEMENTATION_STATUSES: readonly string[] =
  CURRENT_UNBUILT_IMPLEMENTATION_STATUSES.filter((v) => v !== IMPLEMENTATION_STATUS_DEFAULT);

/**
 * CONTEXT types that carry a FINDING — something discovered that is not yet resolved.
 * From the context_type domain (config/contextTypes.ts CONTEXT_TYPES).
 */
export const CURRENT_FINDING_CONTEXT_TYPES: readonly string[] = ['error'];

/**
 * CONTEXT types that carry an OUTCOME — a recorded result worth surfacing as "what has
 * actually landed". `handoff` is deliberately EXCLUDED: repeating every historical handoff
 * is the precise cost the eval measured (report lines 524-554).
 */
export const CURRENT_OUTCOME_CONTEXT_TYPES: readonly string[] = ['completion', 'milestone'];

/**
 * THE GATE LADDER — first match wins, top to bottom. This is the ONE ordered statement of
 * "what is this project waiting on". Both the `gate` label and the `nextAction` derive from
 * it, so they can never disagree.
 *
 *   blocked          — something is stuck; unstick it before anything else.
 *   in-progress      — open work exists; continue/start it.
 *   awaiting-release — the work is done but no artifact/release head is recorded, so there
 *                      is nothing a consumer can be pointed at. (The eval's "validated but
 *                      unreleased" shape.)
 *   awaiting-outcome — done and released, but a standing decision has no recorded outcome —
 *                      the learning loop is still open.
 *   complete         — the TOTAL rung. Nothing is open.
 *
 * FAIL-CLOSED: the projector THROWS on a configured gate id it does not
 * implement, and THROWS if the ladder falls through without matching. An unrecognized or
 * incomplete ladder is a loud RED, never a silently empty gate.
 */
export const CURRENT_STATE_GATE_IDS = [
  'blocked',
  'in-progress',
  'awaiting-release',
  'awaiting-outcome',
  'complete',
] as const;
export type CurrentStateGateId = (typeof CURRENT_STATE_GATE_IDS)[number];

/** The ladder ORDER actually evaluated (a subset/permutation is legal; totality is checked). */
export const CURRENT_STATE_GATE_LADDER: readonly CurrentStateGateId[] = CURRENT_STATE_GATE_IDS;

/**
 * The gate rung that MUST be last: the total one that matches unconditionally. Named here so
 * the projector's totality check reads from config instead of hardcoding 'complete'.
 */
export const CURRENT_STATE_TERMINAL_GATE: CurrentStateGateId = 'complete';

// ─────────────────────────────────────────────────────────────────────────────
// THE KNOBS
// ─────────────────────────────────────────────────────────────────────────────

/** Per-section caps. A section that hits its cap reports HOW MANY it dropped — never silent. */
export interface CurrentStateLimits {
  /** Max active tasks listed. Env: MANDREL_CURRENT_STATE_MAX_ACTIVE_TASKS. */
  activeTasks: number;
  /** Max blockers/findings listed. Env: MANDREL_CURRENT_STATE_MAX_BLOCKERS. */
  blockers: number;
  /** Max latest trusted outcomes listed. Env: MANDREL_CURRENT_STATE_MAX_OUTCOMES. */
  trustedOutcomes: number;
  /**
   * Max RECENT contexts listed — the non-trust-gated door.
   * Env: MANDREL_CURRENT_STATE_MAX_RECENT_CONTEXTS.
   */
  recentContexts: number;
  /** Max standing decisions listed. Env: MANDREL_CURRENT_STATE_MAX_DECISIONS. */
  decisions: number;
  /**
   * Max superseded record ids echoed as a drill-down SAMPLE. The COUNT is always exact and
   * complete — this only bounds the id list. Env: MANDREL_CURRENT_STATE_MAX_SUPERSEDED_IDS.
   */
  supersededSampleIds: number;
  /**
   * Max record ids echoed as a drill-down SAMPLE per HISTORICAL subtype (completed /
   * abandoned / unknown), so a reader can go look at the shipped ones rather than only
   * knowing how many there were. Counts stay exact regardless.
   * Env: MANDREL_CURRENT_STATE_MAX_HISTORICAL_IDS.
   */
  historicalSampleIds: number;
}

export interface CurrentStateConfig {
  /**
   * The CONTENT depth each node inside a section is rendered at. `headline` by default: the
   * whole point of this altitude is ONE bounded response — a snippet per node at hundreds of
   * nodes is the cost the eval measured. Drill down by re-calling at summary/full.
   * Env: MANDREL_CURRENT_STATE_NODE_ALTITUDE.
   */
  nodeAltitude: ThreadContentAltitude;
  /**
   * The trust floor a record must clear to be reported as a "latest TRUSTED outcome".
   * A vocabulary name OR a 0–1 score — the SAME floor vocabulary `minTrust` uses, evaluated
   * by the SAME clearsMinTrust() (one definition of the rule). Default `ok`:
   * `unproven` (cold-start, zero outcome evidence) must not be reported as trusted.
   * Env: MANDREL_CURRENT_STATE_TRUST_FLOOR.
   */
  trustedOutcomeFloor: TrustBand | number;
  /**
   * The minimum mapped outcome VALUE (0–1, from trustModel's mapDecisionOutcome /
   * mapTaskOutcome — reused, never re-spelled) for a record's own result to count as an
   * outcome worth surfacing. Default 0.5 keeps `mixed` and `successful` and drops `failed`
   * / `cancelled` from the outcomes section (they surface as findings/history instead).
   * Env: MANDREL_CURRENT_STATE_OUTCOME_VALUE_FLOOR.
   */
  outcomeValueFloor: number;
  /**
   * Whether the `awaiting-release` rung is armed. TRUE (default): finished work with NO
   * recorded artifact/release head is a real gate — there is nothing to hand a consumer.
   * Set false for a deployment that does not use artifact references at all, so its finished
   * threads read `complete` instead of parking forever on a release it will never record.
   * Env: MANDREL_CURRENT_STATE_RELEASE_GATE.
   */
  releaseGateRequiresArtifact: boolean;
  /** Per-section caps (see CurrentStateLimits). */
  limits: CurrentStateLimits;
  /** Task statuses meaning "open work" (named-config policy). */
  activeTaskStatuses: readonly string[];
  /** Task statuses meaning "stuck" (named-config policy). */
  blockedTaskStatuses: readonly string[];
  /** Decision statuses meaning "still stands" (named-config policy). */
  standingDecisionStatuses: readonly string[];
  /** Decision outcome_status values meaning "loop still open" (named-config policy). */
  openOutcomeStatuses: readonly string[];
  /** implementation_status values that mean "not built yet" — the half-executed signal. */
  unbuiltImplementationStatuses: readonly string[];
  /** Task statuses meaning the work was CARRIED OUT (the historical split). */
  completedTaskStatuses: readonly string[];
  /** Task statuses meaning the work STOPPED without being carried out. */
  abandonedTaskStatuses: readonly string[];
  /** implementation_status values meaning the decided thing WAS built. */
  builtImplementationStatuses: readonly string[];
  /** implementation_status values meaning the build STARTED and then stopped (default excluded). */
  abandonedImplementationStatuses: readonly string[];
  /** Context types carrying an unresolved FINDING (named-config policy). */
  findingContextTypes: readonly string[];
  /** Context types carrying an OUTCOME (named-config policy). */
  outcomeContextTypes: readonly string[];
  /** The ordered gate ladder (named-config policy). */
  gateLadder: readonly CurrentStateGateId[];
  /** The rung that must match unconditionally and sit last (named-config policy). */
  terminalGate: CurrentStateGateId;
}

/**
 * THE LIVE CONFIG — read once at module load. Defaults are the documented values above;
 * every scalar/flag is env-overridable so an eval sweep needs no code edit.
 */
export const CURRENT_STATE_CONFIG: CurrentStateConfig = {
  nodeAltitude: envContentAltitude('MANDREL_CURRENT_STATE_NODE_ALTITUDE', 'headline'),
  trustedOutcomeFloor: envTrustFloor('MANDREL_CURRENT_STATE_TRUST_FLOOR', 'ok'),
  outcomeValueFloor: envUnitFloat('MANDREL_CURRENT_STATE_OUTCOME_VALUE_FLOOR', 0.5),
  releaseGateRequiresArtifact: envBool('MANDREL_CURRENT_STATE_RELEASE_GATE', true),
  limits: {
    activeTasks: envInt('MANDREL_CURRENT_STATE_MAX_ACTIVE_TASKS', 10),
    blockers: envInt('MANDREL_CURRENT_STATE_MAX_BLOCKERS', 10),
    trustedOutcomes: envInt('MANDREL_CURRENT_STATE_MAX_OUTCOMES', 5),
    recentContexts: envInt('MANDREL_CURRENT_STATE_MAX_RECENT_CONTEXTS', 5),
    decisions: envInt('MANDREL_CURRENT_STATE_MAX_DECISIONS', 10),
    supersededSampleIds: envInt('MANDREL_CURRENT_STATE_MAX_SUPERSEDED_IDS', 20),
    historicalSampleIds: envInt('MANDREL_CURRENT_STATE_MAX_HISTORICAL_IDS', 5),
  },
  activeTaskStatuses: CURRENT_ACTIVE_TASK_STATUSES,
  blockedTaskStatuses: CURRENT_BLOCKED_TASK_STATUSES,
  standingDecisionStatuses: CURRENT_STANDING_DECISION_STATUSES,
  openOutcomeStatuses: CURRENT_OPEN_OUTCOME_STATUSES,
  unbuiltImplementationStatuses: CURRENT_UNBUILT_IMPLEMENTATION_STATUSES,
  completedTaskStatuses: CURRENT_COMPLETED_TASK_STATUSES,
  abandonedTaskStatuses: CURRENT_ABANDONED_TASK_STATUSES,
  builtImplementationStatuses: CURRENT_BUILT_IMPLEMENTATION_STATUSES,
  abandonedImplementationStatuses: CURRENT_ABANDONED_IMPLEMENTATION_STATUSES,
  findingContextTypes: CURRENT_FINDING_CONTEXT_TYPES,
  outcomeContextTypes: CURRENT_OUTCOME_CONTEXT_TYPES,
  gateLadder: CURRENT_STATE_GATE_LADDER,
  terminalGate: CURRENT_STATE_TERMINAL_GATE,
};
