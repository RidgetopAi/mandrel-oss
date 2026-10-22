/**
 * Locale-independent reference formatters for the date guards (nit N1).
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────────────────
 * The date guards pin the test runtime's TIMEZONE (vite.config.ts) because the date-only
 * trap is invisible under UTC. They did NOT pin the LOCALE, and their assertions were
 * locale literals — `'7/13'`, `'Jul 13, 2026'`. Measured 2026-08-08:
 *
 *     LC_ALL=de_DE.UTF-8 npx vitest run src/utils/datetime.test.ts \
 *                                       src/components/charts/dateAxis.test.tsx
 *     -> 13 failed | 20 passed        ('7/13' vs the correct de-DE '13.7.')
 *
 * The product was right and the tests were wrong: `datetime.ts` deliberately passes
 * `undefined` to Intl so the VIEWER's locale wins (BROWSER_LOCALE). Asserting en-US glyphs
 * hardcoded the one thing the module exists to avoid hardcoding.
 *
 * ── WHY NOT JUST PIN THE LOCALE TOO ─────────────────────────────────────────────────────
 * Two options were on the table, and the third is what is implemented here.
 *
 *   (a) Pin LANG/LC_ALL globally, mirroring the TZ pin. Rejected: it makes every date
 *       assertion in the repo silently en-US-only, so a genuine locale regression —
 *       exactly the class N1 is about — becomes undetectable. The TZ pin is different in
 *       kind: it pins the runtime to the value where the bug IS detectable. A locale pin
 *       would pin it to the value where this class of bug is HIDDEN.
 *   (b) Give the formatters an explicit `locale` parameter for tests. Rejected: it adds a
 *       product API seam whose only caller is a test, and it lets a future call site name
 *       a locale — the precise thing the module's contract forbids. It would also stop
 *       testing the real call path, which passes no locale at all.
 *   (c) THIS. Assert the property actually under test — WHICH CALENDAR DAY was rendered —
 *       against a reference built from an EXPLICIT day in the runtime's own locale. The
 *       glyphs and their order are the browser's business and are not asserted; the day
 *       is, and the paired `not.toBe(<the day before>)` leg is what keeps the assertion
 *       from being a tautology.
 *
 * The option bags below MIRROR the ones in `datetime.ts`. That duplication is deliberate
 * and load-bearing: if someone changes a formatter's shape (e.g. month 'short' -> 'long'),
 * these go RED, which is the correct signal for a change users will see. Keep them in sync
 * on purpose, not by import.
 *
 * NOT a `*.test.ts` file: vitest's `include` is `src/**\/*.test.{ts,tsx}`, so this is a
 * helper module and never collected as a suite.
 */

/**
 * Format an EXPLICIT calendar day (and optional wall-clock time) in the runtime's locale,
 * with the zone pinned to UTC so the supplied fields are rendered exactly as given.
 *
 * For a CALENDAR DAY this is the expected output directly. For an INSTANT, pass the day
 * and time the instant lands on IN THE RUNTIME'S ZONE — the resulting glyphs are identical
 * to formatting that instant locally, because the option bag names no zone-dependent field.
 */
function ref(
  options: Intl.DateTimeFormatOptions,
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
): string {
  return new Intl.DateTimeFormat(undefined, { ...options, timeZone: 'UTC' }).format(
    new Date(Date.UTC(year, month - 1, day, hour, minute)),
  );
}

/** Mirrors `formatDayShort` — a compact day-bucket axis label. */
export const shortDayRef = (year: number, month: number, day: number): string =>
  ref({ month: 'numeric', day: 'numeric' }, year, month, day);

/** Mirrors `formatDayLong` — a fuller day-bucket tooltip label. */
export const longDayRef = (year: number, month: number, day: number): string =>
  ref({ year: 'numeric', month: 'short', day: 'numeric' }, year, month, day);

/** Mirrors `formatDate` — an instant's LOCAL calendar day. */
export const dateRef = (year: number, month: number, day: number): string =>
  ref({ year: 'numeric', month: 'short', day: 'numeric' }, year, month, day);

/** Mirrors `formatDateTime` — an instant's LOCAL day + wall-clock time. */
export const dateTimeRef = (
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
): string =>
  ref(
    { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' },
    year,
    month,
    day,
    hour,
    minute,
  );
