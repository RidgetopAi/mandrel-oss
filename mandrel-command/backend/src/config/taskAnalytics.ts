/**
 * taskAnalytics (Command backend) — the single, named home for every Tasks read/analytics
 * tunable (the operator's standing rule: configs-not-hardcoded — no magic numbers/strings inline).
 *
 * Covers three read-boundary concerns for the Tasks page + its Analytics view:
 *   1. LIST bounds — the board/list read is paginated server-side (default + hard-max page
 *      size, offset). Mirrors the frontend `TASKS_CONFIG.listLimit` (2000) as the default so
 *      the two surfaces agree, with an env-overridable hard cap so an absurd `?limit=` can
 *      never pull unbounded rows. (Stats stays a COUNT — never capped — so the KPIs are
 *      unaffected; only the returned ROWS are bounded.)
 *   2. RANGE — the Analytics time window selector (7d / 30d / 90d / All) that scopes the
 *      time-based panels (lead-time / throughput / completed-by-actor). `all` = no window
 *      (the pre-range behaviour). Kept byte-identical to the frontend `RANGE_OPTIONS`
 *      (`pages/tasks/config.ts`) so the client and server can never diverge on what a range
 *      value means.
 *
 * All values are env-overridable so behaviour is tunable per environment without a code
 * change. The parse* helpers are the single, defensive read-boundary: a malformed param is
 * DROPPED to a safe default (never a 500, never an accidental "return everything").
 */

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name]; // env-read: via-callers
  if (raw === undefined || raw === '') return fallback;
  const parsed = parseInt(raw, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

export const TASK_LIST_CONFIG = {
  /**
   * Default page size when the caller sends no (or an invalid) `limit`. Matches the
   * frontend `TASKS_CONFIG.listLimit` (2000, byte-identical) so the board loads the same
   * bound both ways. Raised from 500 → 2000 so a full realistic project (e.g. riverbend's
   * 590 tasks) loads without dropping the tail of the board; the uncapped truth for the
   * counts still lives in `/tasks/stats` (a COUNT). Per-column pagination is the real
   * long-term fix; 2000 is a soft-launch ceiling (== `maxLimit`).
   */
  defaultLimit: intFromEnv('TASK_LIST_DEFAULT_LIMIT', 2000),
  /**
   * Hard ceiling on the page size — any larger `?limit=` is CLAMPED to this so a client
   * can never pull unbounded rows into one response. The list is a bounded read; the
   * uncapped truth lives in `/tasks/stats` (a COUNT).
   */
  maxLimit: intFromEnv('TASK_LIST_MAX_LIMIT', 2000),
} as const;

/**
 * The Analytics range selector — value → window length in DAYS (`null` = unbounded "All").
 * Byte-identical to the frontend `RANGE_OPTIONS.days`. `null` means "no `completed_at`
 * window" (today's lead-time behaviour before ranges existed).
 */
export const TASK_RANGE_DAYS: Readonly<Record<string, number | null>> = {
  '7d': 7,
  '30d': 30,
  '90d': 90,
  all: null,
} as const;

export type TaskRangeValue = keyof typeof TASK_RANGE_DAYS;

/**
 * Default range when the caller sends no (or an invalid) `range`. `all` preserves the
 * pre-range behaviour (no window) so an un-ranged call is backward-compatible.
 */
export const TASK_DEFAULT_RANGE: TaskRangeValue = 'all';

/**
 * Parse a request `range` query param into a window length in DAYS, or `null` for the
 * unbounded "All" window. Absent/unknown values fall back to the default range (defensive:
 * a bad param must never 500 and must never silently widen the window unexpectedly).
 */
export function parseRangeDays(raw?: unknown): number | null {
  const key = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (key && Object.prototype.hasOwnProperty.call(TASK_RANGE_DAYS, key)) {
    return TASK_RANGE_DAYS[key];
  }
  return TASK_RANGE_DAYS[TASK_DEFAULT_RANGE];
}

/**
 * Clamp a raw `limit` query param to `[1, maxLimit]`, defaulting when absent/invalid.
 * Guarantees the list read always carries a sane, bounded LIMIT.
 */
export function clampListLimit(raw?: unknown): number {
  const parsed = typeof raw === 'number' ? raw : parseInt(String(raw ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return TASK_LIST_CONFIG.defaultLimit;
  return Math.min(Math.floor(parsed), TASK_LIST_CONFIG.maxLimit);
}

/**
 * Parse a raw `offset` query param to a non-negative integer (default 0). Absent/invalid
 * → 0 (defensive: never NaN into the SQL OFFSET).
 */
export function parseOffset(raw?: unknown): number {
  const parsed = typeof raw === 'number' ? raw : parseInt(String(raw ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.floor(parsed);
}
