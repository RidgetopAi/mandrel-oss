/**
 * analyticsRange (Command backend) — the named home for the WINDOW bound of a
 * range-scoped analytics aggregation (configs-not-hardcoded: no magic day counts
 * inline, and no unbounded `?days=` reaching SQL).
 *
 * Sibling of config/analyticsTime.ts, which owns the other half of a range-scoped
 * read (WHICH timezone the days are bucketed in). This one owns HOW MANY days.
 *
 * WHY A CLAMP AND NOT A RAW parseInt: `getSessionTrends` splices its day count into
 * the SQL text (`INTERVAL '${days} days'`). That is not an injection surface — the
 * value has been through `parseInt` — but `parseInt('abc')` is `NaN`, which reaches
 * Postgres as the literal `INTERVAL 'NaN days'` and raises. Reads here bind the day
 * count as a PARAMETER (`make_interval(days => $n)`), which cannot take a NaN at all,
 * so the value must be a real integer before it is bound. This function is where it
 * becomes one.
 */

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name]; // env-read: via-callers
  if (raw === undefined || raw === '') return fallback;
  const parsed = parseInt(raw, 10);
  return Number.isNaN(parsed) || parsed <= 0 ? fallback : parsed;
}

export const ANALYTICS_RANGE_CONFIG = {
  /** Window used when the caller sends no `days` (matches the Analytics page default). */
  defaultDays: intFromEnv('ANALYTICS_DEFAULT_RANGE_DAYS', 30),
  /** Smallest accepted window — a zero/negative window is a caller bug, not "no data". */
  minDays: intFromEnv('ANALYTICS_MIN_RANGE_DAYS', 1),
  /** Hard ceiling; a larger `?days=` is CLAMPED rather than scanning the whole table. */
  maxDays: intFromEnv('ANALYTICS_MAX_RANGE_DAYS', 365),
  /**
   * Row-count bounds for a ranked analytics list (`?limit=`). Deliberately NOT env-backed
   * like the three above: these are not a deployment knob, and a new `process.env` name
   * has to be declared on the product env surface or it REDs the deploy gate.
   */
  defaultLimit: 10,
  minLimit: 1,
  maxLimit: 100,
} as const;

/**
 * Resolve a request `days` query param into a safe integer window.
 * Absent / non-numeric / NaN → the default. Out of range → clamped to the bound.
 */
export function resolveRangeDays(raw?: unknown): number {
  const parsed =
    typeof raw === 'number' ? raw : typeof raw === 'string' ? parseInt(raw, 10) : NaN;
  if (!Number.isFinite(parsed)) return ANALYTICS_RANGE_CONFIG.defaultDays;
  return Math.min(
    Math.max(Math.floor(parsed), ANALYTICS_RANGE_CONFIG.minDays),
    ANALYTICS_RANGE_CONFIG.maxDays,
  );
}

/**
 * Resolve a request `limit` query param into a safe row count for a ranked analytics list.
 * Absent / non-numeric / NaN → the default. Out of range → clamped.
 *
 * Same failure as `resolveRangeDays` one parameter over: a raw `parseInt(limit)` reaches
 * `LIMIT $1` as NaN, which Postgres rejects — so a malformed `?limit=` 500s the panel
 * rather than answering it. Both params on the same route now resolve through this file.
 */
export function resolveRowLimit(raw?: unknown): number {
  const parsed =
    typeof raw === 'number' ? raw : typeof raw === 'string' ? parseInt(raw, 10) : NaN;
  if (!Number.isFinite(parsed)) return ANALYTICS_RANGE_CONFIG.defaultLimit;
  return Math.min(
    Math.max(Math.floor(parsed), ANALYTICS_RANGE_CONFIG.minLimit),
    ANALYTICS_RANGE_CONFIG.maxLimit,
  );
}
