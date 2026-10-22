/**
 * Guard for utils/datetime.
 *
 * ── THE BUG THIS EXISTS TO CATCH ────────────────────────────────────────────────────────
 * The date-only trap: a `YYYY-MM-DD`, and a Postgres DATE that `res.json` turned into
 * `2026-07-13T00:00:00.000Z`, BOTH parse as MIDNIGHT UTC. Read their LOCAL calendar fields
 * in any negative-UTC-offset browser and you get the PREVIOUS DAY. Every viewer in the
 * Americas would see each chart column labelled one day early with the correct number
 * under it — a wrong label that looks completely normal.
 *
 * ── WHY THIS FILE CAN ONLY FAIL IN A NEGATIVE-OFFSET RUNTIME ────────────────────────────
 * Under TZ=UTC local and UTC calendar fields are identical, so a buggy implementation and
 * a correct one produce the same output and this guard would be hollow. Node freezes the
 * process timezone before any test runs (`process.env.TZ = …` inside a test is a measured
 * no-op), so a test cannot arrange its own zone either.
 *
 * The zone is therefore pinned for the whole runner in `vite.config.ts`
 * (`test.env.TZ = 'America/New_York'`) — see the note there. `assertNegativeOffsetRuntime`
 * below re-checks that premise and FAILS LOUDLY if it ever stops holding, because the
 * failure mode of a broken premise here is a silent green: the assertions still run, they
 * just stop being able to detect the defect.
 */
import { describe, it, expect } from 'vitest';
import {
  shortDayRef,
  longDayRef,
  dateRef,
  dateTimeRef,
} from './dayFormatReference.testkit';
import {
  calendarDayParts,
  formatDayShort,
  formatDayLong,
  formatDate,
  formatDateTime,
  formatRelative,
  EMPTY_DASH,
} from './datetime';

const DAY_ONLY = '2026-07-13';
const DAY_AS_ISO = '2026-07-13T00:00:00.000Z';

/**
 * The premise every assertion below depends on. Not a skip and not a warning: if the
 * runner's zone stops being west of UTC, this guard has quietly stopped guarding and the
 * suite must say so.
 */
function assertNegativeOffsetRuntime(): void {
  // Measured through the SAME mechanism a buggy implementation would use.
  const localDayOfUtcMidnight = new Date(Date.parse(DAY_AS_ISO)).getDate();
  expect(
    localDayOfUtcMidnight,
    `This suite can only detect the date-only trap in a negative-UTC-offset runtime. ` +
      `The runner reports ${Intl.DateTimeFormat().resolvedOptions().timeZone}, where UTC ` +
      `midnight on the 13th is still the 13th locally — so every assertion below would ` +
      `pass with the bug present. Restore test.env.TZ in vite.config.ts.`,
  ).toBe(12);
}

describe('the date-only trap', () => {
  it('PREMISE: the runner is in a negative-offset zone, so a naive read really does shift', () => {
    assertNegativeOffsetRuntime();
    // This is verbatim what `ActivityTrend.shortDate` used to do, and it is wrong:
    expect(new Date(Date.parse(DAY_ONLY)).getDate()).toBe(12);
  });

  it.each([
    ['bare YYYY-MM-DD', DAY_ONLY],
    ['a Postgres DATE serialised by res.json', DAY_AS_ISO],
  ])('formatDayShort does NOT move the day (%s)', (_label, value) => {
    assertNegativeOffsetRuntime();
    // Locale-independent (nit N1): the property under test is WHICH DAY, not the glyphs.
    // The negative leg is what stops this being a tautology — a shifted implementation
    // renders the 12th, and the 12th is what this forbids.
    expect(formatDayShort(value)).toBe(shortDayRef(2026, 7, 13));
    expect(formatDayShort(value)).not.toBe(shortDayRef(2026, 7, 12));
  });

  it.each([
    ['bare YYYY-MM-DD', DAY_ONLY],
    ['a Postgres DATE serialised by res.json', DAY_AS_ISO],
  ])('formatDayLong does NOT move the day (%s)', (_label, value) => {
    assertNegativeOffsetRuntime();
    expect(formatDayLong(value)).toBe(longDayRef(2026, 7, 13));
    expect(formatDayLong(value)).not.toBe(longDayRef(2026, 7, 12));
  });

  it('the two spellings of the same day render identically', () => {
    assertNegativeOffsetRuntime();
    expect(formatDayLong(DAY_ONLY)).toBe(formatDayLong(DAY_AS_ISO));
    expect(formatDayShort(DAY_ONLY)).toBe(formatDayShort(DAY_AS_ISO));
  });

  it('calendarDayParts reads the calendar fields as written', () => {
    assertNegativeOffsetRuntime();
    expect(calendarDayParts(DAY_ONLY)).toEqual({ year: 2026, month: 7, day: 13 });
    expect(calendarDayParts(DAY_AS_ISO)).toEqual({ year: 2026, month: 7, day: 13 });
    // A Date carrying a day bucket sits at UTC midnight; its UTC fields ARE the bucket.
    expect(calendarDayParts(new Date(Date.UTC(2026, 6, 13)))).toEqual({
      year: 2026,
      month: 7,
      day: 13,
    });
  });

  it('the LAST day of a month does not roll back into the previous month', () => {
    // The boundary the off-by-one is loudest at: 2026-08-01 would render "Jul 31".
    assertNegativeOffsetRuntime();
    expect(formatDayLong('2026-08-01')).toBe(longDayRef(2026, 8, 1));
    expect(formatDayLong('2026-08-01')).not.toBe(longDayRef(2026, 7, 31));
    // ...and across a year boundary, where the off-by-one also moves the YEAR.
    expect(formatDayLong('2026-01-01T00:00:00.000Z')).toBe(longDayRef(2026, 1, 1));
    expect(formatDayLong('2026-01-01T00:00:00.000Z')).not.toBe(longDayRef(2025, 12, 31));
  });
});

describe('INSTANTS are converted into the viewer zone — the OPPOSITE rule', () => {
  // 02:30Z on the 13th is 22:30 on the 12th in New York. An instant SHOULD move.
  const INSTANT = '2026-07-13T02:30:00.000Z';

  it('formatDate shows the viewer-local calendar day, not the UTC one', () => {
    assertNegativeOffsetRuntime();
    // The instant is 22:30 on the 12th in the pinned runtime zone.
    expect(formatDate(INSTANT)).toBe(dateRef(2026, 7, 12));
    expect(formatDate(INSTANT)).not.toBe(dateRef(2026, 7, 13));
  });

  it('formatDayShort on the SAME value does not move it — the two rules are distinct', () => {
    assertNegativeOffsetRuntime();
    expect(formatDayShort(INSTANT)).toBe(shortDayRef(2026, 7, 13));
    // Without the negative leg this is the one assertion here that a TAUTOLOGICAL
    // reference survives — a reference that stops depending on the day it is asked
    // about, which is what "fix the failure by updating the expected value" collapses to.
    expect(formatDayShort(INSTANT)).not.toBe(shortDayRef(2026, 7, 12));
  });

  it('formatDateTime carries the local wall-clock time', () => {
    assertNegativeOffsetRuntime();
    expect(formatDateTime(INSTANT)).toBe(dateTimeRef(2026, 7, 12, 22, 30));
    expect(formatDateTime(INSTANT)).not.toBe(dateTimeRef(2026, 7, 13, 2, 30));
  });
});

describe('the absent / unusable population', () => {
  it.each([null, undefined, ''])('formatRelative(%p) is the em dash', (v) => {
    expect(formatRelative(v as string | null | undefined)).toBe(EMPTY_DASH);
  });

  it.each([null, undefined, ''])('formatDateTime(%p) is the em dash', (v) => {
    expect(formatDateTime(v as string | null | undefined)).toBe(EMPTY_DASH);
  });

  it('an unparseable string is the em dash, never "Invalid Date"', () => {
    expect(formatDate('not a date')).toBe(EMPTY_DASH);
    expect(formatDateTime('not a date')).toBe(EMPTY_DASH);
    expect(formatRelative('not a date')).toBe(EMPTY_DASH);
  });

  it('a day formatter falls back to the raw string rather than blanking an axis', () => {
    expect(formatDayShort('not a date')).toBe('not a date');
    expect(formatDayLong('')).toBe('');
    expect(calendarDayParts('not a date')).toBeNull();
    expect(calendarDayParts(null)).toBeNull();
  });

  it('the epoch (0) is a real instant, not treated as absent', () => {
    // The ZERO value: an `if (!value)` guard would have swallowed this one.
    expect(formatDateTime(0)).not.toBe(EMPTY_DASH);
  });
});

describe('formatRelative — the ONE implementation (was copied verbatim into six files)', () => {
  const now = Date.now();
  it.each([
    [now - 5_000, 'now'],
    [now - 90 * 1000, '1m'],
    [now - 38 * 60 * 1000, '38m'],
    [now - 2 * 3600 * 1000, '2h'],
    [now - 3 * 86400 * 1000, '3d'],
  ])('%p → %s', (t, expected) => {
    expect(formatRelative(new Date(t as number).toISOString())).toBe(expected);
  });

  it('a future timestamp clamps to "now" rather than counting down', () => {
    expect(formatRelative(new Date(Date.now() + 60_000).toISOString())).toBe('now');
  });

  it('every page that re-exports it gets the SAME function object', async () => {
    // The consolidation is the point: six copies could drift, one re-export cannot.
    const shared = (await import('./datetime')).formatRelative;
    const modules = await Promise.all([
      import('../pages/dashboard/parts'),
      import('../pages/sessions/parts'),
      import('../pages/tasks/parts'),
      import('../pages/contexts/parts'),
      import('../pages/decisions/parts'),
      import('../pages/projects/parts'),
      import('../pages/sessionDetail/parts'),
      import('../pages/projectDetail/parts'),
    ]);
    for (const m of modules) {
      expect((m as { formatRelative: unknown }).formatRelative).toBe(shared);
    }
  });
});
