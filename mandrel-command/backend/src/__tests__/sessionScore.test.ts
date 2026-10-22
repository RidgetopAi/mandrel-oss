/**
 * Unit tests for the shared Activity (work) Score calculator.
 *
 * This is the single source of truth used by BOTH getSessionDetail and
 * getSessionSummaries — the calculator that fixed the list/detail divergence
 * (list used denormalized counters, incl. decisions_created = 0 on every prod row,
 * and under-scored vs detail which counted live). These tests pin the formula's
 * substance (unchanged from the historical formula) and its determinism.
 */
import { calculateActivityScore } from '../services/sessionScore';
import { config } from '../config/environment';

describe('calculateActivityScore', () => {
  test('matches the historical formula exactly', () => {
    // contexts*2 + decisions*3 + tasksCompleted*4 + min(hrs,8)*1.5 + min(tokens/1k,10)*0.5
    // 11 ctx, 3 dec, 6 tasks, 120 min (2h), 4000 tokens
    // = 22 + 9 + 24 + 2*1.5 + 4*0.5 = 22 + 9 + 24 + 3 + 2 = 60.0
    const score = calculateActivityScore({
      contexts: 11,
      decisions: 3,
      tasksCompleted: 6,
      durationMinutes: 120,
      totalTokens: 4000,
    });
    expect(score).toBe(60.0);
  });

  test('is the SAME for the same inputs regardless of caller (determinism)', () => {
    const input = {
      contexts: 8,
      decisions: 1,
      tasksCompleted: 7,
      durationMinutes: 95,
      totalTokens: 23456,
    };
    const a = calculateActivityScore(input);
    const b = calculateActivityScore({ ...input });
    expect(a).toBe(b);
  });

  test('GROWS with effort (more work => higher score, no /100 ceiling)', () => {
    const small = calculateActivityScore({
      contexts: 1, decisions: 0, tasksCompleted: 0, durationMinutes: 10, totalTokens: 100,
    });
    const big = calculateActivityScore({
      contexts: 50, decisions: 20, tasksCompleted: 30, durationMinutes: 400, totalTokens: 50000,
    });
    expect(big).toBeGreaterThan(small);
    // Unbounded high end: a very busy session exceeds the legacy /100 framing.
    expect(big).toBeGreaterThan(100);
  });

  test('caps duration at maxHours and tokens at maxThousandTokens', () => {
    const w = config.activityScore;
    // 100 hours of duration and 1,000,000 tokens both hit their caps.
    const capped = calculateActivityScore({
      contexts: 0, decisions: 0, tasksCompleted: 0,
      durationMinutes: 100 * 60, totalTokens: 1_000_000,
    });
    const expected =
      Math.round((w.maxHours * w.perHour + w.maxThousandTokens * w.perThousandTokens) * 10) / 10;
    expect(capped).toBe(expected);
  });

  test('decisions contribute (the prod bug: list read decisions_created = 0)', () => {
    const withDecisions = calculateActivityScore({
      contexts: 5, decisions: 3, tasksCompleted: 0, durationMinutes: 0, totalTokens: 0,
    });
    const withoutDecisions = calculateActivityScore({
      contexts: 5, decisions: 0, tasksCompleted: 0, durationMinutes: 0, totalTokens: 0,
    });
    // 3 decisions * 3.0 = 9.0 difference — exactly what the list path lost on prod.
    expect(withDecisions - withoutDecisions).toBeCloseTo(9.0, 5);
  });

  test('coerces negative / NaN inputs to 0 (never negative or NaN)', () => {
    const score = calculateActivityScore({
      contexts: -5,
      decisions: NaN,
      tasksCompleted: -1,
      durationMinutes: -100,
      totalTokens: -999,
    });
    expect(score).toBe(0);
  });

  test('returns a number rounded to one decimal place', () => {
    const score = calculateActivityScore({
      contexts: 1, decisions: 0, tasksCompleted: 0, durationMinutes: 7, totalTokens: 333,
    });
    // 1*2 + min(7/60,8)*1.5 + min(0.333,10)*0.5
    // = 2 + 0.175 + 0.1665 = 2.3415 => rounds to 2.3
    expect(score).toBe(2.3);
    expect(Number.isFinite(score)).toBe(true);
  });
});
