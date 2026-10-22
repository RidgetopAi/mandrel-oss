/**
 * Mandrel Core — TASK tool config.
 *
 * STANDING PRINCIPLE (the operator, binds this + all future builds): NO HARDCODED VARIABLES.
 * Every tunable lives HERE — a named value with a sane default + a one-line comment +
 * an env override — never a literal buried in a handler/schema. Mirrors the existing
 * config-driven patterns in the tree (config/searchConfig.ts, config/recallConfig.ts).
 *
 * Reads env at module load with a safe fallback (bad/missing → the default), exactly
 * like config/searchConfig.ts:envInt.
 */

/** Read a positive-integer env var, falling back to `fallback` on missing/garbage. */
function envInt(name: string, fallback: number): number {
  const raw = process.env[name]; // env-read: via-callers
  if (raw === undefined || raw === '') return fallback;
  const v = Number(raw);
  return Number.isInteger(v) && v > 0 ? v : fallback;
}

/**
 * Maximum number of task ids a SINGLE task_bulk_update call may carry.
 *
 * WHY THIS DEFAULT (500, not the old hardcoded 50): the old cap of 50 rejected any
 * real bulk sweep — a 90+ id update failed zod validation and the bridge surfaced that
 * rejection as a bare `null` to the caller ("works at 11, null at ~92").
 * The bulk UPDATE itself is a single atomic statement (`WHERE id = ANY($n)` — ONE array
 * param regardless of array length), so a large id list is cheap and safe at the DB
 * layer; the only barrier was this validation cap. 500 comfortably covers real board
 * sweeps while still bounding the per-id short-id resolution loop and any accidental
 * runaway. Tune via env without a code edit.
 *
 * Exceeding this still fails with a CLEAR, actionable zod error ("'task_ids' is too big
 * (maximum N items)") — never a silent no-op / null.
 *
 * env: TASK_BULK_MAX_IDS
 */
export const TASK_BULK_MAX_IDS = envInt('TASK_BULK_MAX_IDS', 500);

/**
 * Maximum number of task ids the `dependencies` arg of task_create may carry.
 *
 * WHY 10: a task depending on more than a handful of prerequisites is a modeling smell
 * (that's a phase/epic, not a task), so this is an anti-abuse/legibility bound, not a
 * capability limit. Was a hardcoded `.max(10)` literal in the zod schema (an earlier task
 * touched that line to route each dependency through the short-id resolver) — lifted here
 * so the cap is a named, env-tunable value like every other task bound, not a magic number.
 *
 * env: TASK_MAX_DEPENDENCIES
 */
export const TASK_MAX_DEPENDENCIES = envInt('TASK_MAX_DEPENDENCIES', 10);

/**
 * Maximum number of `{ text, owner, proof? }` clauses `punch.doneWhen` may carry.
 * Anti-abuse/legibility bound, the same reasoning
 * as TASK_MAX_DEPENDENCIES above: a punch with dozens of done-when clauses is a modeling
 * smell, not a real completion contract.
 *
 * env: TASK_MAX_PUNCH_CLAUSES
 */
export const TASK_MAX_PUNCH_CLAUSES = envInt('TASK_MAX_PUNCH_CLAUSES', 20);

/**
 * Maximum number of repo-relative paths/globs `punch.touches` may carry.
 *
 * env: TASK_MAX_PUNCH_TOUCHES
 */
export const TASK_MAX_PUNCH_TOUCHES = envInt('TASK_MAX_PUNCH_TOUCHES', 50);

// =============================================================================
// SEMANTIC TASK SEARCH (tranche B — "turn the task source on")
// =============================================================================
// tasksHandler.searchTasks() is the vector reader over the `tasks` embedding column that
// migration 088 baked. Its two numeric knobs live here rather than as literals in the
// handler, per the standing no-hardcoded-variables rule. The SCORE-SHAPE knobs (per-source
// weight, importance, type weight) deliberately do NOT live here — they belong to the
// cross-source merge contract and live in config/searchMergeConfig.ts beside the decision
// ones, because a scale is only meaningful next to the other scales it is compared with.

/** Read a finite-float env var, falling back to `fallback` on missing/garbage. */
function envFloat(name: string, fallback: number): number {
  const raw = process.env[name]; // env-read: via-callers
  if (raw === undefined || raw === '') return fallback;
  const v = Number(raw);
  return Number.isFinite(v) ? v : fallback;
}

/**
 * TRIGRAM ADMISSION FLOOR for semantic task search — a row whose `word_similarity` to the
 * query is at or below this is not admitted as a candidate on the lexical path.
 *
 * ADMISSION, NEVER RANKING (the rule an earlier task established for decisions): a lexical
 * signal decides whether a row is a CANDIDATE, and must never decide how HIGH it ranks —
 * it is not on the same scale as a cosine and no other source has it. searchTasks() uses
 * this value in exactly one place, the WHERE gate.
 *
 * The default matches the decision gate's shipped 0.1 so the two sources admit on the same
 * lexical threshold; there it is still a literal, here it is named. Raising it narrows the
 * lexical rescue (fewer un-embedded/legacy rows admitted); lowering it widens it.
 *
 * env: SEARCH_TASK_TRGM_ADMIT_FLOOR
 */
export const TASK_SEARCH_TRGM_ADMIT_FLOOR = envFloat('SEARCH_TASK_TRGM_ADMIT_FLOOR', 0.1);

/**
 * Page size searchTasks() uses when the caller names none. Mirrors the `request.limit || 20`
 * that searchDecisions() applies, lifted out of the expression so the two are comparable and
 * either can be retuned without a code edit. smart_search always passes an explicit
 * over-fetch, so this governs only direct callers.
 *
 * env: SEARCH_TASK_DEFAULT_LIMIT
 */
export const TASK_SEARCH_DEFAULT_LIMIT = envInt('SEARCH_TASK_DEFAULT_LIMIT', 20);
