/**
 * The two window arithmetics the Analytics page does IN THE BROWSER:
 * `computeDelta` (item 5) and `taskRangeParam` (item 4). Both are pure, so both can be
 * asserted exactly rather than inferred from a rendered string.
 *
 * These numbers are hand-computed on purpose and are small enough to verify by eye. That
 * is the point: the bug being pinned was an off-by-one that produced a PLAUSIBLE
 * percentage, so a test that recomputes the implementation's own arithmetic would have
 * agreed with the bug.
 */
import { describe, it, expect } from 'vitest';
import { computeDelta } from './parts';
import { taskRangeParam } from './hooks';
import { RANGE_OPTIONS, ANALYTICS_CONFIG } from './config';

describe('computeDelta — equal halves, and today excluded', () => {
  it('drops the trailing (partial) bucket', () => {
    // 8 points. The last is "today". Settled = 7, even = 6 → halves of 3.
    // prior = 1+1+1 = 3, recent = 2+2+2 = 6 → +100%.
    // The dropped values: values[0] (the odd point) and values[7] (today).
    const d = computeDelta([99, 1, 1, 1, 2, 2, 2, 1000]);
    expect(d).toEqual({ pct: 100, trend: 'up', halfDays: 3 });
  });

  it('THE DEFECT: the odd point no longer goes to the recent half', () => {
    // 8 raw points → settled 7 → the OLD code would have split 7 as 3 prior / 4 recent.
    // Same series, differing only in the value at the oldest position: under the old
    // rule that value changed the answer (it sat in `prior`); under the new rule it is
    // dropped, so both of these must give the SAME delta. If the odd point were still
    // being gifted to `recent`, these two would differ.
    const a = computeDelta([0, 1, 1, 1, 2, 2, 2, 500]);
    const b = computeDelta([1000, 1, 1, 1, 2, 2, 2, 500]);
    expect(a).toEqual(b);
    expect(a!.halfDays).toBe(3);
  });

  it('halves are always the same length, for every window the control offers', () => {
    // The property, over the real range options + the backend row count each produces.
    for (const { value: days } of RANGE_OPTIONS) {
      const series = Array.from({ length: days }, (_, i) => i + 1);
      const d = computeDelta(series);
      expect(d, `days=${days}`).not.toBeNull();
      // days - 1 settled points, rounded down to even, halved.
      const settled = days - 1;
      expect(d!.halfDays).toBe((settled - (settled % 2)) / 2);
    }
  });

  it('reports the half length it actually compared — the label reads from this', () => {
    // 30 raw points → 29 settled → 28 usable → halves of 14. The old label printed
    // `Math.floor(30 / 2)` = 15 beside a comparison against a 16-day half.
    const d = computeDelta(Array.from({ length: 30 }, () => 1));
    expect(d!.halfDays).toBe(14);
    expect(d!.halfDays).not.toBe(15);
  });

  it('is null rather than fabricated when the prior half is empty or the series is short', () => {
    // Zero population, and the divide-by-zero guard.
    expect(computeDelta([])).toBeNull();
    expect(computeDelta([5])).toBeNull();
    expect(computeDelta(Array.from({ length: ANALYTICS_CONFIG.minPointsForDelta }, () => 0)))
      .toBeNull();
    expect(computeDelta([0, 0, 0, 0, 7, 7, 7, 7])).toBeNull(); // prior half sums to 0
  });

  it('signs the trend from the equal-half comparison', () => {
    expect(computeDelta([9, 4, 4, 2, 2, 9])!.trend).toBe('down');
    expect(computeDelta([9, 2, 2, 4, 4, 9])!.trend).toBe('up');
    expect(computeDelta([9, 3, 3, 3, 3, 9])!.trend).toBe('flat');
  });
});

describe('taskRangeParam — the sessions/tasks window vocabularies must line up', () => {
  it('emits a token the backend recognises for every option the control offers', () => {
    // `/api/tasks/*` parses `range` against TASK_RANGE_DAYS and falls back to `all` — i.e.
    // NO WINDOW — for anything it does not recognise. A silent fallback to unbounded is
    // precisely the bug this parameter was added to fix, so the spelling is pinned rather
    // than trusted. Byte-identical to backend config/taskAnalytics.ts TASK_RANGE_DAYS.
    const BACKEND_RANGE_KEYS = ['7d', '30d', '90d', 'all'];
    for (const { value } of RANGE_OPTIONS) {
      expect(BACKEND_RANGE_KEYS).toContain(taskRangeParam(value));
    }
    expect(RANGE_OPTIONS.map((o) => taskRangeParam(o.value))).toEqual(['7d', '30d', '90d']);
  });
});
