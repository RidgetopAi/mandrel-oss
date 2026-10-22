/**
 * Calendar date-math unit tests — the pure week/day logic the grid depends on.
 * Deterministic (no clock/locale reliance beyond the injected `now`).
 */
import { describe, it, expect } from 'vitest';
import {
  startOfWeek,
  weekDays,
  toDateKey,
  apiDateKey,
  daysBetween,
  addWeeks,
  dayPosition,
  formatWeekRange,
  weekdayShort,
  startOfMonth,
  addMonths,
  monthGridDays,
  isSameMonth,
  formatMonthLabel,
  formatDayLabel,
  parseDateKey,
} from './dates';

describe('startOfWeek', () => {
  it('anchors to Sunday (weekStartsOn=0)', () => {
    // 2026-07-15 is a Wednesday → week starts Sunday 2026-07-12.
    const ws = startOfWeek(new Date(2026, 6, 15, 9, 30), 0);
    expect(toDateKey(ws)).toBe('2026-07-12');
    expect(ws.getHours()).toBe(0);
  });
  it('anchors to Saturday (weekStartsOn=6) — the mock example', () => {
    const ws = startOfWeek(new Date(2026, 6, 15), 6);
    expect(toDateKey(ws)).toBe('2026-07-11');
  });
});

describe('weekDays', () => {
  it('returns 7 consecutive days from the start', () => {
    const days = weekDays(new Date(2026, 6, 12));
    expect(days).toHaveLength(7);
    expect(days.map(toDateKey)).toEqual([
      '2026-07-12', '2026-07-13', '2026-07-14', '2026-07-15',
      '2026-07-16', '2026-07-17', '2026-07-18',
    ]);
  });
});

describe('apiDateKey', () => {
  it('accepts a date-only bucket and a full ISO timestamp', () => {
    expect(apiDateKey('2026-07-13')).toBe('2026-07-13');
    expect(apiDateKey('2026-07-13T09:12:00.000Z')).toBe('2026-07-13');
    expect(apiDateKey(undefined)).toBe('');
    expect(apiDateKey('garbage')).toBe('');
  });
});

describe('daysBetween / addWeeks', () => {
  it('measures whole days and shifts by weeks', () => {
    expect(daysBetween(new Date(2026, 6, 12), new Date(2026, 6, 15))).toBe(3);
    expect(toDateKey(addWeeks(new Date(2026, 6, 12), 1))).toBe('2026-07-19');
    expect(toDateKey(addWeeks(new Date(2026, 6, 12), -1))).toBe('2026-07-05');
  });
});

describe('dayPosition', () => {
  const now = new Date(2026, 6, 15, 12, 0);
  it('classifies past/today/future relative to now', () => {
    expect(dayPosition(new Date(2026, 6, 14), now)).toBe('past');
    expect(dayPosition(new Date(2026, 6, 15, 1), now)).toBe('today');
    expect(dayPosition(new Date(2026, 6, 16), now)).toBe('future');
  });
});

describe('formatWeekRange', () => {
  it('same month', () => {
    expect(formatWeekRange(new Date(2026, 6, 12))).toBe('Jul 12 – 18, 2026');
  });
  it('crossing months', () => {
    expect(formatWeekRange(new Date(2026, 5, 29))).toBe('Jun 29 – Jul 5, 2026');
  });
  it('crossing years', () => {
    expect(formatWeekRange(new Date(2025, 11, 28))).toBe('Dec 28, 2025 – Jan 3, 2026');
  });
});

describe('weekdayShort', () => {
  it('is locale-independent', () => {
    expect(weekdayShort(new Date(2026, 6, 12))).toBe('Sun');
    expect(weekdayShort(new Date(2026, 6, 15))).toBe('Wed');
  });
});

describe('startOfMonth / addMonths', () => {
  it('startOfMonth floors to the 1st at local midnight', () => {
    const d = startOfMonth(new Date(2026, 6, 15, 9, 30));
    expect(toDateKey(d)).toBe('2026-07-01');
    expect(d.getHours()).toBe(0);
  });
  it('addMonths steps months and clamps the day to the target month length', () => {
    expect(toDateKey(addMonths(new Date(2026, 6, 16), 1))).toBe('2026-08-16');
    expect(toDateKey(addMonths(new Date(2026, 6, 16), -1))).toBe('2026-06-16');
    // Jan 31 + 1mo → Feb 28 (no overflow into March), 2026 is not a leap year.
    expect(toDateKey(addMonths(new Date(2026, 0, 31), 1))).toBe('2026-02-28');
    // Crossing the year boundary.
    expect(toDateKey(addMonths(new Date(2026, 11, 10), 1))).toBe('2027-01-10');
  });
});

describe('monthGridDays', () => {
  it('returns a full 6×7 grid starting on the week-start weekday', () => {
    const days = monthGridDays(new Date(2026, 6, 15), 0); // July 2026, Sunday-start
    expect(days).toHaveLength(42);
    // July 1 2026 is a Wednesday → grid starts Sunday Jun 28.
    expect(toDateKey(days[0])).toBe('2026-06-28');
    expect(toDateKey(days[41])).toBe('2026-08-08');
    // The month's own 1st and last day are present.
    expect(days.map(toDateKey)).toContain('2026-07-01');
    expect(days.map(toDateKey)).toContain('2026-07-31');
  });
});

describe('isSameMonth', () => {
  it('compares year + month', () => {
    expect(isSameMonth(new Date(2026, 6, 1), new Date(2026, 6, 31))).toBe(true);
    expect(isSameMonth(new Date(2026, 6, 31), new Date(2026, 7, 1))).toBe(false);
    expect(isSameMonth(new Date(2025, 6, 1), new Date(2026, 6, 1))).toBe(false);
  });
});

describe('formatMonthLabel / formatDayLabel', () => {
  it('formats month + day labels locale-independently', () => {
    expect(formatMonthLabel(new Date(2026, 6, 15))).toBe('July 2026');
    expect(formatDayLabel(new Date(2026, 6, 15))).toBe('Wednesday, Jul 15, 2026');
  });
});

describe('parseDateKey', () => {
  it('round-trips a valid key and rejects garbage/overflow', () => {
    expect(toDateKey(parseDateKey('2026-07-16')!)).toBe('2026-07-16');
    expect(parseDateKey('')).toBeNull();
    expect(parseDateKey(undefined)).toBeNull();
    expect(parseDateKey('2026-7-1')).toBeNull(); // not zero-padded
    expect(parseDateKey('2026-02-31')).toBeNull(); // overflow (Feb has no 31st)
  });
});
