/**
 * SCHEDULED GRAPH BACKFILL — the knobs (PHASE 3).
 *
 * THE PRINCIPLE (the operator, standing rule): NO HARDCODED VARIABLES. Every threshold / cap /
 * switch the Phase 3 backfill reads lives HERE, once, with an env override. Mirrors
 * reliableThreadingConfig.ts, whose envBool/envFloat/envInt/assertRange discipline this
 * module follows exactly: a TYPO falls back to the default (must not crash boot), an
 * OUT-OF-RANGE value THROWS at load (a silently-clamped threshold would corrupt the graph
 * at scale, and this job writes thousands of edges per run).
 *
 * WHY PHASE 3 EXISTS (graph audit): all four pre-existing backfills are
 * commands nobody runs — no cron, no timer, no entrypoint — which is why the pre-June
 * orphan backlog never shrank. Shipping a fifth un-run command would repeat the entire
 * failure, so the scheduling is part of the deliverable, not a follow-up.
 */

/** Read a boolean env var, falling back to `fallback` on missing/garbage. */
function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name]; // env-read: via-callers
  if (raw === undefined || raw === '') return fallback;
  const s = raw.trim().toLowerCase();
  if (s === 'true' || s === '1' || s === 'yes' || s === 'on') return true;
  if (s === 'false' || s === '0' || s === 'no' || s === 'off') return false;
  return fallback;
}

/** Read a finite-number env var, falling back on missing/unparseable. Range checked below. */
function envFloat(name: string, fallback: number): number {
  const raw = process.env[name]; // env-read: via-callers
  if (raw === undefined || raw === '') return fallback;
  const v = Number(raw);
  return Number.isFinite(v) ? v : fallback;
}

/** Read an integer env var, falling back on missing/unparseable/non-integer. Range below. */
function envInt(name: string, fallback: number): number {
  const raw = process.env[name]; // env-read: via-callers
  if (raw === undefined || raw === '') return fallback;
  const v = Number(raw);
  return Number.isInteger(v) ? v : fallback;
}

/** Load-time fail-fast on a parsed-but-nonsensical value. */
function assertRange(name: string, value: number, min: number, max: number): number {
  if (!(value >= min && value <= max)) {
    throw new Error(
      `[graphBackfillConfig] ${name}=${value} is out of range [${min}, ${max}] — fix the env override.`
    );
  }
  return value;
}

// ── Provenance stamps + vocabulary ─────────────────────────────────────────────────────

/**
 * THE `created_by` STAMP for every similarity-derived edge this backfill mints is
 * `orphanBackfill.CREATED_BY` ('backfill:orphan-threads'). It is deliberately NOT re-exported
 * or re-spelled here: `services/orphanBackfill.ts` transitively imports `config/database.ts`,
 * which throws at module load without a DB env, and pulling that into a config module would
 * make the config unreadable without credentials. Consumers import it from the service.
 *
 * WHAT MATTERS ABOUT THAT VALUE, and what a future edit must not break: it stays under the
 * `backfill:` prefix and is NOT one of the two declared backfill stamps. Migration 079's
 * `link_provenance` view classifies `backfill:task_tags` / `backfill:task_deps` as DECLARED
 * (their targets were named by a human at origin — threading tags and the explicit
 * `dependencies` field — the backfill only materialises them late) and every OTHER
 * `backfill:%` as GUESSED. So the guessed leg's stamp lands in the GUESSED bucket by the
 * view's default arm, which is exactly right: a cosine guess is a guess however carefully it
 * was made. The contract test asserts this against the real view rather than trusting this
 * paragraph.
 */

/**
 * `metadata.provenance` vocabulary for edges this job writes or repairs. Two values only —
 * the whole point of Phase 3 is that these two never blur:
 *
 *   'backfill' — THIS job minted the edge from a cosine guess. New row, guessed class.
 *   'guess'    — a PRE-EXISTING edge some earlier mechanism guessed, which the repair leg has
 *                measured and labelled honestly. The repair leg NEVER rewrites `created_by`,
 *                so such an edge keeps its original bucket; calling it 'backfill' would be a
 *                lie about who minted it.
 *
 * There is deliberately no 'declared' member: the declared leg's edges are minted by the
 * shared write-path minters (autoMintFromTags / autoMintFromTaskDependencies) whose metadata
 * this job does not author. Their declaredness lives in `created_by`, which is where the
 * meter reads it.
 */
export const EDGE_PROVENANCE = {
  backfill: 'backfill',
  guess: 'guess',
} as const;

export type EdgeProvenance = (typeof EDGE_PROVENANCE)[keyof typeof EDGE_PROVENANCE];

/**
 * `metadata.method` for a similarity-derived edge — WHAT produced the guess, recorded on the
 * edge alongside the score. Named rather than left implicit so a future second method
 * (a lexical or a graph-distance heuristic) is distinguishable in the corpus without a
 * migration.
 */
export const GUESS_METHOD = 'embedding-cosine-nn' as const;

/**
 * The `created_by` stamps whose edges the REPAIR leg considers. These are the
 * similarity-and-anchor-derived mechanisms — the ones that produced a GUESS about which
 * neighbour to point at, and therefore the ones that can be pointing at the wrong one.
 *
 * SCOPE, STATED (C3): this is the guard's population and it is deliberately NOT "every
 * guessed-class stamp". `auto:belief-adjudicator` is guessed-class but its edges are
 * supersession verdicts over a named pair, not nearest-neighbour picks — recomputing a
 * cosine "better neighbour" for one would be meaningless, and re-pointing it would corrupt
 * an adjudication. `backfill` (the bare legacy stamp) IS included: it is the pre-existing
 * bulk mint whose targets nobody has ever measured, which is precisely the population the
 * "make historical guesses honest" half of this task names.
 */
export const REPAIRABLE_CREATED_BY: readonly string[] = [
  'auto:inference',
  'auto:active_thread',
  'backfill',
  'backfill:orphan-threads',
];

// ── Run knobs ──────────────────────────────────────────────────────────────────────────

/**
 * GRAPH_BACKFILL_ENABLED — master switch for the scheduled job. When false the CLI exits 0
 * having done nothing, and says so. Env: MANDREL_GRAPH_BACKFILL_ENABLED. Default true; the
 * timer is what actually decides whether it runs, and a disabled-by-default job that ships
 * with a timer would be the fifth un-run command all over again.
 */
export const GRAPH_BACKFILL_ENABLED: boolean = envBool('MANDREL_GRAPH_BACKFILL_ENABLED', true);

/**
 * GUESS_THRESHOLD — the cosine floor a nearest neighbour must clear before the guessed leg
 * mints. Env: MANDREL_GRAPH_BACKFILL_THRESHOLD. Default 0.6, matching the live
 * INFERENCE_THRESHOLD, so a backfilled guess is held to exactly the same bar as a write-time
 * one — a backfill that mints at a LOWER bar than the live path would be manufacturing graph
 * health, which is the failure the Phase 0 meter exists to catch. Must be a cosine in [0, 1].
 */
export const GUESS_THRESHOLD: number = assertRange(
  'GUESS_THRESHOLD',
  envFloat('MANDREL_GRAPH_BACKFILL_THRESHOLD', 0.6),
  0,
  1
);

/**
 * MAX_ORPHANS_PER_RUN — cap on orphans the guessed leg processes in ONE scheduled run.
 * Env: MANDREL_GRAPH_BACKFILL_MAX_ORPHANS. Default 2000.
 *
 * WHY A CAP AT ALL, given the job is idempotent and could just run to completion: this is a
 * SCHEDULED job on the same Postgres that serves live traffic, and each orphan costs one
 * exact (deliberately un-indexed) vector scan of its project. The cap bounds one run's
 * footprint; the schedule finishes the backlog across runs, and the run report states how
 * many were left. 0 = no cap (what an operator uses for a supervised one-shot drain).
 * Must be >= 0.
 */
export const MAX_ORPHANS_PER_RUN: number = assertRange(
  'MAX_ORPHANS_PER_RUN',
  envInt('MANDREL_GRAPH_BACKFILL_MAX_ORPHANS', 2000),
  0,
  Number.MAX_SAFE_INTEGER
);

/**
 * REPAIR_ENABLED — run the repair leg (re-label + re-point historical guesses).
 * Env: MANDREL_GRAPH_BACKFILL_REPAIR_ENABLED. Default true — "make historical guesses honest"
 * is half the task, not an extra.
 */
export const REPAIR_ENABLED: boolean = envBool('MANDREL_GRAPH_BACKFILL_REPAIR_ENABLED', true);

/**
 * REPAIR_MIN_SIMILARITY — an existing guessed edge whose CURRENT measured cosine to its own
 * target is below this is a re-point CANDIDATE. Env: MANDREL_GRAPH_BACKFILL_REPAIR_MIN_SIM.
 * Default 0.6 (the same floor the live path would refuse to mint at today): an edge we would
 * not mint now is, by our own current standard, pointing somewhere we cannot justify.
 * Must be in [0, 1].
 */
export const REPAIR_MIN_SIMILARITY: number = assertRange(
  'REPAIR_MIN_SIMILARITY',
  envFloat('MANDREL_GRAPH_BACKFILL_REPAIR_MIN_SIM', 0.6),
  0,
  1
);

/**
 * REPAIR_IMPROVEMENT_MARGIN — how much better (in cosine) a replacement neighbour must be
 * before a below-floor edge is actually RE-POINTED. Env:
 * MANDREL_GRAPH_BACKFILL_REPAIR_MARGIN. Default 0.15.
 *
 * WHY A MARGIN AND NOT JUST "better": re-pointing rewrites history, and two candidates a
 * hundredth of a cosine apart are not distinguishable evidence — swapping on that would make
 * the graph churn on noise every run and would make the job non-convergent in practice even
 * though it is idempotent in principle. A margin means only a materially better neighbour
 * displaces the recorded one. Must be in [0, 1].
 */
export const REPAIR_IMPROVEMENT_MARGIN: number = assertRange(
  'REPAIR_IMPROVEMENT_MARGIN',
  envFloat('MANDREL_GRAPH_BACKFILL_REPAIR_MARGIN', 0.15),
  0,
  1
);

/**
 * MAX_REPAIRS_PER_RUN — cap on edges the repair leg examines in one run, for the same
 * footprint reason as MAX_ORPHANS_PER_RUN. Env: MANDREL_GRAPH_BACKFILL_MAX_REPAIRS.
 * Default 2000. 0 = no cap. Must be >= 0.
 */
export const MAX_REPAIRS_PER_RUN: number = assertRange(
  'MAX_REPAIRS_PER_RUN',
  envInt('MANDREL_GRAPH_BACKFILL_MAX_REPAIRS', 2000),
  0,
  Number.MAX_SAFE_INTEGER
);

/**
 * The Phase 3 tunables as one object, mirroring RELIABLE_THREADING_CONFIG's shape. Every
 * field is one of the env-overridable consts above — no default is re-spelled here.
 */
export interface GraphBackfillConfig {
  enabled: boolean;
  guessThreshold: number;
  maxOrphansPerRun: number;
  repairEnabled: boolean;
  repairMinSimilarity: number;
  repairImprovementMargin: number;
  maxRepairsPerRun: number;
}

/** THE LIVE CONFIG. */
export const GRAPH_BACKFILL_CONFIG: GraphBackfillConfig = {
  enabled: GRAPH_BACKFILL_ENABLED,
  guessThreshold: GUESS_THRESHOLD,
  maxOrphansPerRun: MAX_ORPHANS_PER_RUN,
  repairEnabled: REPAIR_ENABLED,
  repairMinSimilarity: REPAIR_MIN_SIMILARITY,
  repairImprovementMargin: REPAIR_IMPROVEMENT_MARGIN,
  maxRepairsPerRun: MAX_REPAIRS_PER_RUN,
};
