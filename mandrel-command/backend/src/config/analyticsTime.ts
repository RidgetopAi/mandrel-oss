/**
 * analyticsTime (Command backend) — the single, named home for the TIMEZONE tunable
 * used by every SERVER-SIDE per-day aggregation (the operator's standing rule:
 * configs-not-hardcoded — no magic tz strings sprinkled inline).
 *
 * THE BUG THIS EXISTS FOR (whole-class / a past incident)
 *   Postgres runs in `Etc/UTC`, so a raw `DATE(x)` / `date_trunc('day', x)` buckets a
 *   timestamp by its UTC calendar day. The UI, meanwhile, computes "today" and the
 *   day-cells in the VIEWER's browser-local timezone. So an evening-EDT record
 *   (e.g. 2026-07-16 00:00:02+00 = 2026-07-15 20:00 EDT) lands in the UTC day 07-16
 *   server-side but should show under the local day 07-15 — the day-GROUPING is wrong
 *   on Calendar, the Dashboard activity trend, and the Tasks throughput chart.
 *
 * THE FIX
 *   The frontend sends its IANA zone (`Intl.DateTimeFormat().resolvedOptions().timeZone`,
 *   e.g. "America/New_York") as a `tz` query param; the backend buckets with
 *   `DATE(x AT TIME ZONE $tz)` / `date_trunc('day', x AT TIME ZONE $tz)`, PARAM-BOUND
 *   (never string-interpolated — no injection surface). When the param is absent we
 *   default to `DEFAULT_AGG_TIMEZONE` (UTC) so an un-`tz`'d caller is byte-identical to
 *   the pre-fix behaviour (backward-compatible; the regression guard holds).
 *
 * WHY VALIDATE
 *   `x AT TIME ZONE 'bogus'` raises a Postgres error ("time zone \"bogus\" not
 *   recognized"). Even though the value is param-bound (safe from injection), an
 *   unrecognised zone would still 500 the query. `resolveAggTimeZone` therefore
 *   validates the raw param as a real IANA zone via `Intl.DateTimeFormat` (throws
 *   `RangeError` on an unknown zone, using Node's ICU tz database which tracks the same
 *   IANA names Postgres uses) and falls back to the default on anything malformed —
 *   defensive: a bad `?tz=` must never 500 and must never silently mis-bucket.
 */

/**
 * The timezone a per-day aggregation buckets in when the caller sends no (or an invalid)
 * `tz`. UTC preserves the historical (pre-fix) bucketing exactly, since Postgres runs
 * `Etc/UTC`. Env-overridable so a deployment can change the default without a code change.
 */
export const DEFAULT_AGG_TIMEZONE: string = process.env.ANALYTICS_DEFAULT_TIMEZONE || 'UTC';

/**
 * Resolve a request `tz` query param into a SAFE IANA timezone string to bucket by.
 * Absent / non-string / malformed / unrecognised → `DEFAULT_AGG_TIMEZONE` (UTC).
 * The returned value is guaranteed to be accepted by Postgres `AT TIME ZONE` (validated
 * against the ICU/IANA tz database), so callers can bind it as a param without risk of
 * an "invalid time zone" 500.
 */
export function resolveAggTimeZone(raw?: unknown): string {
  if (typeof raw !== 'string') return DEFAULT_AGG_TIMEZONE;
  const tz = raw.trim();
  if (!tz) return DEFAULT_AGG_TIMEZONE;
  try {
    // Throws RangeError for an unknown/invalid IANA zone; a no-op for a valid one.
    // eslint-disable-next-line no-new
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz;
  } catch {
    return DEFAULT_AGG_TIMEZONE;
  }
}
