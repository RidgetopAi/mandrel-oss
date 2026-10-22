/**
 * sessionList (Command backend) — the named home for the Sessions LIST read bounds
 * (the operator's standing rule: configs-not-hardcoded — no magic numbers inline).
 *
 * WHY THIS EXISTS (an earlier task §8): `getSessionsList` hard-coded `limit = 1000` as an
 * inline default while the UI pages far smaller. That was already generous; it became a
 * real cost once every returned row carries four correlated count subqueries instead of
 * reading a (broken) denormalized column. Same shape as TASK_LIST_CONFIG: an
 * env-overridable default plus a hard ceiling, so an absurd `?limit=` can never pull
 * unbounded rows.
 *
 * The COUNT used for pagination totals is not bounded by this — only the returned ROWS are.
 *
 * NOT to be confused with mcp-server's `MANDREL_SESSION_LIST_DEFAULT_LIMIT` /
 * `MANDREL_SESSION_LIST_MAX_LIMIT` (config/sessionIdentityConfig.ts), which bound the
 * `session_list` TOOL's identity read model. Different surface, different consumer; the
 * unprefixed names here match this package's siblings (TASK_LIST_*, SEARCH_*).
 */

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name]; // env-read: via-callers
  if (raw === undefined || raw === '') return fallback;
  const parsed = parseInt(raw, 10);
  return Number.isNaN(parsed) || parsed <= 0 ? fallback : parsed;
}

export const SESSION_LIST_CONFIG = {
  /**
   * Default page size when the caller sends no `limit`. 200 comfortably covers the whole
   * prod sessions table (457 rows total, and the UI's own page sizes are far smaller)
   * without being an accidental "return everything".
   */
  defaultLimit: intFromEnv('SESSION_LIST_DEFAULT_LIMIT', 200),
  /** Hard ceiling — any larger `?limit=` is CLAMPED to this. */
  maxLimit: intFromEnv('SESSION_LIST_MAX_LIMIT', 1000),
} as const;

/** Clamp a caller-supplied limit into [1, maxLimit], falling back to the default. */
export function clampSessionListLimit(limit?: number): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit) || limit <= 0) {
    return SESSION_LIST_CONFIG.defaultLimit;
  }
  return Math.min(Math.floor(limit), SESSION_LIST_CONFIG.maxLimit);
}
