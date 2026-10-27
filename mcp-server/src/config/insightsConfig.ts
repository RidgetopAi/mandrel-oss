/**
 * Mandrel Core — project_insights CODE-HEALTH scoring config.
 *
 * STANDING PRINCIPLE (the operator, binds this + all future builds): NO HARDCODED VARIABLES.
 * Every tunable lives HERE — a named value with a sane default + a one-line comment +
 * an env override — never a literal buried in a handler. Mirrors the existing
 * config-driven patterns in the tree (config/recallConfig.ts, config/searchConfig.ts).
 *
 * WHY THIS FILE EXISTS: assessCodeHealth() carried six bare magic numbers (3, 5, 8, 10,
 * 20, 100) inline. The fix for an earlier change rewrites that function, so the literals it
 * governs move here rather than being re-buried. The DEFAULTS below are the EXACT
 * values the pre-fix handler used — this is a mechanical extraction, NOT a re-tuning.
 * Scoring behaviour for a project WITH components is byte-identical to before.
 *
 * Reads env at module load with a safe fallback (bad/missing → the default), exactly
 * like config/recallConfig.ts:envInt.
 */

/** Read a non-negative-number env var, falling back to `fallback` on missing/garbage. */
function envNum(name: string, fallback: number): number {
  const raw = process.env[name]; // env-read: via-callers
  if (raw === undefined || raw === '') return fallback;
  const v = Number(raw);
  return Number.isFinite(v) && v >= 0 ? v : fallback;
}

/**
 * The perfect-score ceiling a health score starts from before penalties are subtracted,
 * and the floor it can never fall below. A score is always clamped into [FLOOR, CEILING].
 * env: INSIGHTS_HEALTH_SCORE_CEILING / INSIGHTS_HEALTH_SCORE_FLOOR
 */
export const HEALTH_SCORE_CEILING = envNum('INSIGHTS_HEALTH_SCORE_CEILING', 100);
export const HEALTH_SCORE_FLOOR = envNum('INSIGHTS_HEALTH_SCORE_FLOOR', 0);

/**
 * Points deducted per unit of AVERAGE complexity. avg complexity 2.0 → -20 points.
 * env: INSIGHTS_HEALTH_AVG_COMPLEXITY_WEIGHT
 */
export const HEALTH_AVG_COMPLEXITY_WEIGHT = envNum('INSIGHTS_HEALTH_AVG_COMPLEXITY_WEIGHT', 10);

/**
 * A single component more complex than this threshold incurs a flat penalty, and raises
 * the "Very complex components exist" issue.
 * env: INSIGHTS_HEALTH_MAX_COMPLEXITY_THRESHOLD / INSIGHTS_HEALTH_MAX_COMPLEXITY_PENALTY
 */
export const HEALTH_MAX_COMPLEXITY_THRESHOLD = envNum('INSIGHTS_HEALTH_MAX_COMPLEXITY_THRESHOLD', 8);
export const HEALTH_MAX_COMPLEXITY_PENALTY = envNum('INSIGHTS_HEALTH_MAX_COMPLEXITY_PENALTY', 20);

/**
 * Average-complexity band boundaries for the qualitative level:
 *   avg < HEALTHY  → 'healthy'
 *   avg < MODERATE → 'moderate'
 *   otherwise      → 'needs_attention'
 * NOTE: these bands are only ever consulted when the project HAS analyzed components.
 * A project with zero components short-circuits to 'no_data' before reaching them —
 * that is the whole point of an earlier task (absent must never render as perfect).
 * env: INSIGHTS_HEALTH_LEVEL_HEALTHY_MAX / INSIGHTS_HEALTH_LEVEL_MODERATE_MAX
 */
export const HEALTH_LEVEL_HEALTHY_MAX = envNum('INSIGHTS_HEALTH_LEVEL_HEALTHY_MAX', 3);
export const HEALTH_LEVEL_MODERATE_MAX = envNum('INSIGHTS_HEALTH_LEVEL_MODERATE_MAX', 5);

/**
 * Average complexity above which the "High average complexity" issue is raised.
 * env: INSIGHTS_HEALTH_HIGH_COMPLEXITY_ISSUE_THRESHOLD
 */
export const HEALTH_HIGH_COMPLEXITY_ISSUE_THRESHOLD = envNum(
  'INSIGHTS_HEALTH_HIGH_COMPLEXITY_ISSUE_THRESHOLD',
  5
);

/**
 * The level string emitted when there is NOTHING to score. Kept as a named constant so
 * every site agrees on one token instead of N drifting literals.
 *
 * The extraction is COMPLETE, not aspirational: this is the only place the bare string
 * 'no_data' is written in product code. All four consumers reference THIS constant —
 * handlers/smartSearch.assessCodeHealth, handlers/smartSearch.assessTeamEfficiency, and
 * both display maps in routes/search.routes (as computed keys). If you add a fifth,
 * import it here rather than typing the literal, or the guarantee in this comment
 * quietly stops being true.
 */
export const HEALTH_LEVEL_NO_DATA = 'no_data';
