/**
 * analyticsRangeClamp.test.ts — the two clamps on `/api/sessions/*` window+row params
 * (item 1). Pure: `config/analyticsRange.ts` reaches no database.
 *
 * WHY THIS EXISTS AT ALL. `resolveRangeDays` had shipped, was imported into
 * `controllers/session.ts`, was used by two of the three reads in that file — and had NO
 * test anywhere in this backend. The third read still did `parseInt(days)`, so
 * `?days=abc` reached Postgres as the literal `INTERVAL 'NaN days'`, which raises:
 *
 *     ERROR:  invalid input syntax for type interval: "NaN days"
 *
 * That 500'd the Analytics hero chart AND all four KPI tiles, while `contexts-by-actor`
 * on the very same render clamped to 30d and drew normally — two panels under one range
 * label answering two different windows. Verified live against a running backend before
 * and after the fix; these cases pin the resolver the route now goes through.
 *
 * THE POPULATION PROBED IS THE ONE THAT SLIPS THROUGH: not "30" but the values a
 * hand-written parser gets wrong — NaN, empty, absent, zero, negative, fractional, huge,
 * and the non-string types a query parser can hand you (arrays, objects) when the same
 * param appears twice in a URL.
 */
// jest globals (this backend runs jest — see jest.config.js)
import {
  ANALYTICS_RANGE_CONFIG,
  resolveRangeDays,
  resolveRowLimit,
} from '../config/analyticsRange';

const { defaultDays, minDays, maxDays, defaultLimit, minLimit, maxLimit } =
  ANALYTICS_RANGE_CONFIG;

describe('resolveRangeDays — no value can reach SQL as NaN', () => {
  it('passes the legitimate windows through unchanged', () => {
    // Derived from the bounds, not hardcoded, so this cannot disagree with the config
    // the product reads.
    for (const days of [minDays, 7, 30, 90, maxDays]) {
      expect(resolveRangeDays(String(days))).toBe(days);
      expect(resolveRangeDays(days)).toBe(days);
    }
  });

  it('THE DEFECT: a non-numeric string resolves to the default, never NaN', () => {
    for (const raw of ['abc', 'NaN', '', '   ', 'null', '30d', 'e5']) {
      const got = resolveRangeDays(raw);
      expect({ raw, got, finite: Number.isFinite(got) }).toEqual({ raw, got, finite: true });
      expect(Number.isInteger(got)).toBe(true);
      expect(got).toBe(defaultDays);
    }
  });

  it('absent / non-string types resolve to the default', () => {
    // A query parser hands you an ARRAY when the param appears twice (`?days=7&days=9`)
    // and an object for `?days[x]=1`. `parseInt` on either is NaN.
    for (const raw of [undefined, null, {}, [], ['7', '9'], true, NaN, Infinity]) {
      const got = resolveRangeDays(raw);
      expect({ raw, got, finite: Number.isFinite(got) }).toEqual({ raw, got, finite: true });
      expect(got).toBe(defaultDays);
    }
  });

  it('zero and negative windows clamp UP to the minimum, not to "no data"', () => {
    // `?days=-5` used to produce a descending generate_series — an EMPTY chart, which
    // reads as "nothing happened" rather than as a bad request.
    for (const raw of ['0', '-1', '-5', '-99999']) {
      expect(resolveRangeDays(raw)).toBe(minDays);
    }
  });

  it('an oversized window clamps DOWN rather than scanning the table', () => {
    for (const raw of ['99999', String(maxDays + 1), '1e9']) {
      expect(resolveRangeDays(raw)).toBeLessThanOrEqual(maxDays);
    }
    expect(resolveRangeDays('99999')).toBe(maxDays);
  });

  it('a fractional window becomes a whole number of days', () => {
    // make_interval(days => 7.5) is not an error, it is a SILENTLY different window.
    expect(Number.isInteger(resolveRangeDays('7.9'))).toBe(true);
    expect(resolveRangeDays('7.9')).toBe(7);
  });
});

describe('resolveRowLimit — the same failure one parameter over', () => {
  it('THE DEFECT: a non-numeric limit resolves to the default, never NaN', () => {
    // `LIMIT $1` with NaN bound is rejected by Postgres exactly like the interval was.
    for (const raw of ['abc', '', undefined, null, {}, NaN]) {
      const got = resolveRowLimit(raw);
      expect({ raw, got, finite: Number.isFinite(got) }).toEqual({ raw, got, finite: true });
      expect(got).toBe(defaultLimit);
    }
  });

  it('clamps to the bounds and stays an integer', () => {
    expect(resolveRowLimit('0')).toBe(minLimit);
    expect(resolveRowLimit('-3')).toBe(minLimit);
    expect(resolveRowLimit(String(maxLimit + 1))).toBe(maxLimit);
    expect(resolveRowLimit('5.7')).toBe(5);
  });
});
