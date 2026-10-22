/**
 * browserTimeZone — the SINGLE source for the viewer's IANA timezone.
 *
 * WHY (an earlier task — whole-class per-day-in-UTC bug): server-side per-day
 * aggregations (session trends → Calendar/Dashboard, task throughput, contexts/day) used
 * to GROUP BY the UTC calendar day, while the UI renders day-cells in the viewer's local
 * timezone. So an evening-local record (e.g. 8pm EDT = 00:00 UTC next day) bucketed onto
 * the wrong day. The fix: the client sends its zone (this value) as a `tz` query param and
 * the backend buckets with `AT TIME ZONE $tz`, defaulting to UTC when absent.
 *
 * Returns e.g. "America/New_York", or `undefined` when the runtime can't report a zone —
 * so a caller can spread it into a params object without emitting an empty `tz=` (the
 * backend then safely defaults to UTC). Keep the `Intl` lookup here only (no magic-string
 * timezones sprinkled through the API layer — configs-not-hardcoded).
 */
export function getBrowserTimeZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}
