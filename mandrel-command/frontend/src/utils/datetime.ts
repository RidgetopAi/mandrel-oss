/**
 * datetime — the SINGLE source for rendering a date or time in the UI.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════
 *  THE DISTINCTION THIS MODULE EXISTS TO ENFORCE: an INSTANT is not a CALENDAR DAY
 * ════════════════════════════════════════════════════════════════════════════════════════
 * Two kinds of value flow out of this backend and they must NOT be rendered the same way:
 *
 *   INSTANT — a moment: `created_at`, `started_at`, `last_activity_at`. Full ISO with a
 *     zone. It denotes one point on the world's timeline, and the right way to show it is
 *     converted into the VIEWER's timezone and formatted in the VIEWER's locale.
 *     → formatDateTime / formatDate / formatTime / formatRelative
 *
 *   CALENDAR DAY — a day BUCKET from a server-side per-day aggregation: `date` on
 *     /api/sessions/trends, `day` on /api/tasks/throughput. It is already bucketed IN THE
 *     VIEWER'S ZONE by the backend (`AT TIME ZONE $tz`, an earlier task — the `tz` param
 *     comes from utils/browserTimeZone.ts). It is a LABEL, not a moment, and converting it
 *     is not just unnecessary, it is WRONG.
 *     → formatDayShort / formatDayLong
 *
 * ── THE DATE-ONLY TRAP (the bug this split prevents) ────────────────────────────────────
 * A bare `YYYY-MM-DD` — and a Postgres DATE serialised through `res.json`, which becomes
 * `"2026-07-13T00:00:00.000Z"` — parses as MIDNIGHT UTC. Feed that to `new Date(...)` and
 * read `.getDate()` in any negative-UTC-offset browser (all of the Americas) and you get
 * THE PREVIOUS DAY. The dashboard's "Jul 13" column would read "Jul 12" for every US
 * viewer, and the number under it would be right — the worst kind of wrong, because
 * nothing looks broken.
 *
 * So the day formatters NEVER convert. They read the calendar fields as WRITTEN in the
 * source string and format them with the timezone pinned to UTC, which for a value that
 * already carries no zone is the identity operation. The locale still comes from the
 * browser, so ordering follows the viewer's conventions (8/13 vs 13/8) without any shift.
 *
 * Guarded by `datetime.test.ts`, which runs the day formatters under a simulated
 * negative-offset browser and asserts the day does not move.
 *
 * ── WHY EVERYTHING LIVES HERE ───────────────────────────────────────────────────────────
 * `formatRelative` was copy-pasted VERBATIM into six `parts.tsx` files (dashboard,
 * sessions, tasks, contexts, decisions, projects). Six copies of a formatting rule is six
 * places for it to drift, and the drift is invisible — every copy renders *something*.
 * Each of those modules now re-exports from here, so the import sites did not have to
 * change and there is exactly one implementation.
 *
 * Locale is deliberately NOT hardcoded: passing `undefined` to Intl means "the runtime's
 * locale", i.e. the browser's. A hardcoded `'en-US'` renders 13/07/2026 as 7/13/2026 for
 * a viewer who reads neither. (configs-not-hardcoded)
 */

/**
 * `undefined` = let Intl use the browser's own locale. Named so a call site reads as a
 * deliberate choice rather than a forgotten argument.
 */
export const BROWSER_LOCALE: string | undefined = undefined;

/** Anything a formatter here will accept. */
export type DateInput = string | number | Date | null | undefined;

const DAY_PREFIX = /^(\d{4})-(\d{2})-(\d{2})/;

/**
 * The Y-M-D of a CALENDAR-DAY value, read as written — no timezone conversion.
 *
 * Accepts `2026-07-13`, `2026-07-13T00:00:00.000Z` (what `res.json` makes of a Postgres
 * DATE) and a `Date` (whose UTC fields are read, because that is where node-pg put the
 * calendar day). Returns `null` for anything that is not a recognisable day.
 */
export function calendarDayParts(
  value: DateInput,
): { year: number; month: number; day: number } | null {
  if (value == null) return null;
  if (typeof value === 'string') {
    const m = DAY_PREFIX.exec(value);
    if (!m) return null;
    return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
  }
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  // UTC fields on purpose: a day bucket that arrived as a Date carries its calendar day
  // at UTC midnight. Reading local fields is exactly the date-only trap.
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

/**
 * A `Date` positioned at UTC midnight of a calendar day, for handing to Intl with
 * `timeZone: 'UTC'`. Round-trips the day unchanged in every browser zone.
 */
function calendarDayToUtcDate(value: DateInput): Date | null {
  const p = calendarDayParts(value);
  if (!p) return null;
  return new Date(Date.UTC(p.year, p.month - 1, p.day));
}

function toInstant(value: DateInput): Date | null {
  if (value == null || value === '') return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Shown when a value is absent or unparseable. One glyph, everywhere. */
export const EMPTY_DASH = '—';

// ── CALENDAR DAYS (chart axes, day buckets) ───────────────────────────────────────────

/**
 * Compact axis label for a day bucket: `8/13` in en-US, `13.8.` in de-DE. NEVER shifts
 * the day. Falls back to the raw input when it is not a day, so a formatter can never
 * blank an axis.
 */
export function formatDayShort(value: DateInput): string {
  const d = calendarDayToUtcDate(value);
  if (!d) return typeof value === 'string' ? value : EMPTY_DASH;
  return new Intl.DateTimeFormat(BROWSER_LOCALE, {
    month: 'numeric',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(d);
}

/**
 * Fuller day label for a chart tooltip: `Aug 13, 2026`. Same no-shift guarantee as
 * {@link formatDayShort}.
 */
export function formatDayLong(value: DateInput): string {
  const d = calendarDayToUtcDate(value);
  if (!d) return typeof value === 'string' ? value : EMPTY_DASH;
  return new Intl.DateTimeFormat(BROWSER_LOCALE, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(d);
}

// ── INSTANTS (timestamps) ─────────────────────────────────────────────────────────────

/** Date only, in the browser's zone + locale. e.g. `Aug 13, 2026`. */
export function formatDate(value: DateInput): string {
  const d = toInstant(value);
  if (!d) return EMPTY_DASH;
  return new Intl.DateTimeFormat(BROWSER_LOCALE, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  }).format(d);
}

/** Time only, in the browser's zone + locale. e.g. `2:14 PM`. */
export function formatTime(value: DateInput): string {
  const d = toInstant(value);
  if (!d) return EMPTY_DASH;
  return new Intl.DateTimeFormat(BROWSER_LOCALE, {
    hour: 'numeric',
    minute: '2-digit',
  }).format(d);
}

/** Date + time, in the browser's zone + locale. e.g. `Aug 13, 2026, 2:14 PM`. */
export function formatDateTime(value: DateInput): string {
  const d = toInstant(value);
  if (!d) return EMPTY_DASH;
  return new Intl.DateTimeFormat(BROWSER_LOCALE, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(d);
}

/**
 * Compact "now / 38m / 2h / 3d" relative time from an ISO timestamp.
 *
 * THE one implementation — this was duplicated verbatim in six pages/*\/parts.tsx files.
 * Timezone-free by construction (it subtracts two instants), which is why it was the copy
 * that never visibly broke and therefore never got consolidated.
 */
export function formatRelative(value: DateInput): string {
  if (value == null || value === '') return EMPTY_DASH;
  const t = value instanceof Date ? value.getTime() : Date.parse(String(value));
  if (Number.isNaN(t)) return EMPTY_DASH;
  const secs = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (secs < 60) return 'now';
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}
