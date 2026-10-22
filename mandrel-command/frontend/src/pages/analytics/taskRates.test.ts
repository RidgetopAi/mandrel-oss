/**
 * The Work-mix FLOW arithmetic and the Sessions-rhythm current-hour mark.
 *
 * Both are pure and exported precisely so they can be asserted exactly rather than
 * inferred from a rendered string. The numbers below are hand-computed — that is the
 * point: a test that recomputes the implementation's own expression agrees with the bug.
 *
 * What these DO NOT prove, stated so nobody reads more into them: they cannot prove which
 * SQL population each figure came from. That wiring — that `Completed / day` reads the
 * completed-in-window count and not the cohort's `Done` — is pinned in Analytics.test.tsx
 * against a rendered page, where the two fixtures are deliberately different numbers.
 */
import { describe, it, expect } from 'vitest';
import {
  computeTaskRates,
  openCount,
  formatRate,
  formatSignedRate,
} from './WorkMix';
import { currentHourInZone, hourLabel, rhythmRows } from './SessionRhythm';
import { OPEN_STATUSES, WORK_MIX, TASK_RATES } from './config';

describe('computeTaskRates — the per-day flow figures', () => {
  const base = {
    createdInWindow: 376,
    completedInWindow: 288,
    medianLeadTimeDays: 0.5,
    openNow: 163,
    windowDays: 30,
  };

  it('divides each population by the window, and nets them WITH direction', () => {
    // The prod figures measured for this task (project riverbend, trailing 30d,
    // 2026-08-10): 376 created excl. cancelled, 288 completed by `completed_at`.
    const r = computeTaskRates(base)!;
    expect(r.createdPerDay).toBeCloseTo(376 / 30, 10);
    expect(r.completedPerDay).toBeCloseTo(288 / 30, 10);
    expect(r.netPerDay).toBeCloseTo(376 / 30 - 288 / 30, 10);
    // Positive: the backlog is growing. The measured backlog delta over that same window
    // was +89 open tasks (74 -> 163), i.e. ~+2.97/day — which is what this reproduces.
    expect(r.netPerDay).toBeGreaterThan(0);
    expect(formatSignedRate(r.netPerDay)).toBe('+2.9');
  });

  it('CREATED AND COMPLETED ARE INDEPENDENT INPUTS — completed may exceed created', () => {
    // The discriminator, in arithmetic form. A task created BEFORE the window and
    // completed INSIDE it counts toward completed and not toward created, so completed can
    // legitimately be the larger number. An implementation that derived one from the other
    // (e.g. read the cohort's Done for both) could not produce this.
    const r = computeTaskRates({ ...base, createdInWindow: 10, completedInWindow: 25 })!;
    expect(r.completedPerDay).toBeGreaterThan(r.createdPerDay);
    expect(r.netPerDay).toBeLessThan(0);
    expect(formatSignedRate(r.netPerDay)).toBe('−0.5');
    expect(TASK_RATES.netDirection(r.netPerDay)).toBe('backlog shrinking');
  });

  it('ZERO COMPLETIONS ⇒ NO MEDIAN, even though the backend sends 0', () => {
    // The empty population, and the reason it is dangerous: services/task.ts returns a
    // ZEROED stats block for a window with no completions, so `medianLeadTime` arrives as
    // the number 0. Printed verbatim that reads "0.0 days to done" — the value a
    // perfectly fast team would show — for a window in which nothing was finished.
    const r = computeTaskRates({
      ...base,
      completedInWindow: 0,
      medianLeadTimeDays: 0,
    })!;
    expect(r.medianDaysToDone).toBeNull();
    expect(r.completedPerDay).toBe(0);
    // A real 0 median WITH completions is a different statement and must survive.
    const fast = computeTaskRates({ ...base, completedInWindow: 4, medianLeadTimeDays: 0 })!;
    expect(fast.medianDaysToDone).toBe(0);
  });

  it('an ENTIRELY empty window is zeros and nulls, never NaN', () => {
    const r = computeTaskRates({
      createdInWindow: 0,
      completedInWindow: 0,
      medianLeadTimeDays: 0,
      openNow: 0,
      windowDays: 7,
    })!;
    expect(r.createdPerDay).toBe(0);
    expect(r.completedPerDay).toBe(0);
    expect(r.netPerDay).toBe(0);
    expect(r.medianDaysToDone).toBeNull();
    expect(formatSignedRate(r.netPerDay)).toBe('0.0');
  });

  it('refuses to divide by a zero/absent window rather than printing Infinity', () => {
    // Unreachable through the range control today, which is exactly why it is asserted:
    // an Infinity rendered as a rate is indistinguishable from a real spike.
    expect(computeTaskRates({ ...base, windowDays: 0 })).toBeNull();
    expect(computeTaskRates({ ...base, windowDays: -1 })).toBeNull();
    expect(computeTaskRates({ ...base, windowDays: Number.NaN })).toBeNull();
  });

  it('passes an UNKNOWN open count through as null, not as zero', () => {
    // "0 open" is a claim; "we have not been told" is not. They must not render alike.
    const r = computeTaskRates({ ...base, openNow: null })!;
    expect(r.openNow).toBeNull();
  });
});

describe('openCount — the OPEN statuses, derived from the bar not restated', () => {
  it('sums to-do + in-progress + blocked, and never Done or cancelled', () => {
    const n = openCount({
      by_status: { completed: 2772, in_progress: 9, blocked: 14, todo: 300, cancelled: 88 },
    });
    expect(n).toBe(323);
  });

  it('an absent payload is null (unknown), an empty one is 0 (known-empty)', () => {
    expect(openCount(undefined)).toBeNull();
    expect(openCount({})).toBeNull();
    expect(openCount({ by_status: {} })).toBe(0);
  });

  it('OPEN_STATUSES is exactly the bar vocabulary minus Done', () => {
    // The population, asserted against its source rather than re-listed. A status added to
    // WORK_MIX must become open work here without a second edit.
    expect(OPEN_STATUSES).toEqual(
      WORK_MIX.map((s) => s.status).filter((s) => s !== 'completed'),
    );
    expect(OPEN_STATUSES).not.toContain('completed');
    expect(OPEN_STATUSES as string[]).not.toContain('cancelled');
  });
});

describe('rate formatting', () => {
  it('fixes the decimals so a rate never renders as a float tail', () => {
    expect(formatRate(376 / 30)).toBe('12.5');
    expect(formatRate(0)).toBe('0.0');
    expect(formatRate(Number.POSITIVE_INFINITY)).toBe('—');
  });

  it('ALWAYS carries the sign — it is the whole content of the net figure', () => {
    expect(formatSignedRate(2.93)).toBe('+2.9');
    expect(formatSignedRate(-2.93)).toBe('−2.9');
    expect(formatSignedRate(0)).toBe('0.0');
  });

  it('a value that rounds to zero is 0.0, never a signed zero', () => {
    // "−0.0" reads as a shrinking backlog; "+0.0" reads as a growing one. Neither is true
    // of −0.04, and the sign is the part of this figure people act on.
    expect(formatSignedRate(-0.04)).toBe('0.0');
    expect(formatSignedRate(0.04)).toBe('0.0');
  });
});

describe('currentHourInZone — "now" in the zone the SERVER bucketed with', () => {
  // A fixed instant: 2026-08-10T18:30:00Z. 18 in UTC, 14 in New York (EDT, UTC-4),
  // 3 the NEXT day in Tokyo (JST, UTC+9). Three different buckets for one instant is the
  // whole reason the zone has to be the request's and not the renderer's.
  const instant = new Date('2026-08-10T18:30:00Z');

  it('reads the hour in the given IANA zone', () => {
    expect(currentHourInZone('UTC', instant)).toBe(18);
    expect(currentHourInZone('America/New_York', instant)).toBe(14);
    expect(currentHourInZone('Asia/Tokyo', instant)).toBe(3);
  });

  it('THE THIRD STATE: an unknown zone falls back to UTC, matching the backend', () => {
    // `getBrowserTimeZone()` returns undefined when the runtime cannot report a zone, and
    // the request then omits `tz`, so the backend buckets in UTC. Taking the renderer's
    // local hour here would confidently mark a bar up to 12 buckets from the truth.
    expect(currentHourInZone(undefined, instant)).toBe(currentHourInZone('UTC', instant));
  });

  it('midnight is hour 0, not 24 (some ICU builds format it as 24)', () => {
    expect(currentHourInZone('UTC', new Date('2026-08-10T00:15:00Z'))).toBe(0);
    expect(hourLabel(currentHourInZone('UTC', new Date('2026-08-10T00:15:00Z')))).toBe('12a');
  });
});

describe('rhythmRows — exactly one bucket is marked', () => {
  const patterns = Array.from({ length: 24 }, (_, h) => ({
    hour: h,
    total_tokens: 0,
    session_count: h,
    average_tokens_per_session: 0,
  }));
  const TINT = 'TINT';

  it('THE DISCRIMINATOR: a NON-current hour carries no colour at all', () => {
    const rows = rhythmRows(patterns, hourLabel(14), TINT);
    const marked = rows.filter((r) => r.color !== undefined);
    expect(marked).toHaveLength(1);
    expect(marked[0].hour).toBe('2p');
    expect(marked[0].color).toBe(TINT);
    // Every other row must OMIT the key, not carry a different colour: BarChartCard's
    // `?? s.color` fallback is what keeps the ordinary bars on the chart's own palette,
    // and it only fires on an absent value.
    for (const r of rows.filter((x) => x.hour !== '2p')) {
      expect('color' in r, `${r.hour} must not be tinted`).toBe(false);
    }
  });

  it('marks the right bucket for every hour of the day', () => {
    for (let h = 0; h < 24; h += 1) {
      const rows = rhythmRows(patterns, hourLabel(h), TINT);
      expect(rows.filter((r) => r.color !== undefined).map((r) => r.hour)).toEqual([
        hourLabel(h),
      ]);
    }
  });

  it('preserves the counts it was given, including a zero bucket', () => {
    const rows = rhythmRows(patterns, hourLabel(0), TINT);
    expect(rows).toHaveLength(24);
    expect(rows[0].sessions).toBe(0);
    expect(rows[23].sessions).toBe(23);
  });

  it('an absent payload is no rows and no mark — never a tint with nothing under it', () => {
    expect(rhythmRows(undefined, '2p', TINT)).toEqual([]);
    expect(rhythmRows([], '2p', TINT)).toEqual([]);
  });
});
