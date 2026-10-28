/**
 * Time-window parser for smart_search queries. Pure, DB-free.
 */
import { describe, test, expect } from 'vitest';
import {
  parseSearchTimeWindow,
  isoDateInZone,
  windowContains,
} from '../services/searchTimeWindow.js';

const UTC = { timeZone: 'UTC' } as const;
const NY = { timeZone: 'America/New_York' } as const;
const iso = (w: { start: Date; end: Date } | null) => w && [w.start.toISOString(), w.end.toISOString()];

describe('parseSearchTimeWindow', () => {
  test('a query with no date has no window and is returned untouched', () => {
    const q = 'what happened overnight with the widget test flake';
    const p = parseSearchTimeWindow(q, UTC);
    expect(p.window).toBeNull();
    expect(p.query).toBe(q);
  });

  test('an impossible date is not a date', () => {
    expect(parseSearchTimeWindow('flake on 2026-02-31', UTC).window).toBeNull();
    expect(parseSearchTimeWindow('flake on 2026-13-01', UTC).window).toBeNull();
  });

  test('a bare ISO date is D 00:00 to D+1 00:00', () => {
    const p = parseSearchTimeWindow('widget flake on 2026-03-10', UTC);
    expect(iso(p.window)).toEqual(['2026-03-10T00:00:00.000Z', '2026-03-11T00:00:00.000Z']);
    expect(p.night).toBe(false);
    expect(p.query).toBe('widget flake on');
  });

  test.each(['overnight', 'night of', 'night', 'last night', 'Overnight'])(
    'date + night word %j is D-1 18:00 to D+1 12:00 and the word is stripped', (w) => {
      const p = parseSearchTimeWindow(`what happened ${w} on 2026-03-10 with the flake`, UTC);
      expect(iso(p.window)).toEqual(['2026-03-09T18:00:00.000Z', '2026-03-11T12:00:00.000Z']);
      expect(p.night).toBe(true);
      expect(p.query).not.toMatch(/2026|night/i);
    });

  test('both "early hours of D" and "evening of D" fall inside a night window', () => {
    const w = parseSearchTimeWindow('overnight 2026-03-10', UTC).window!;
    expect(windowContains(w, '2026-03-10T03:00:00Z')).toBe(true);
    expect(windowContains(w, '2026-03-10T21:00:00Z')).toBe(true);
    expect(windowContains(w, '2026-03-09T05:00:00Z')).toBe(false);
    expect(windowContains(w, '2026-03-12T00:00:00Z')).toBe(false);
  });

  test('hours and words are configurable', () => {
    const p = parseSearchTimeWindow('2026-03-10 graveyard', {
      ...UTC, nightWords: ['graveyard'], nightStartHour: 20, nightEndHour: 6,
    });
    expect(iso(p.window)).toEqual(['2026-03-09T20:00:00.000Z', '2026-03-11T06:00:00.000Z']);
  });

  test('a date-only query leaves nothing to search; the parser says so', () => {
    expect(parseSearchTimeWindow('2026-03-10', UTC).query).toBe('');
  });

  test('the window is computed in the configured zone, DST-aware', () => {
    // EDT (UTC-4) on 2026-03-10: local midnight is 04:00Z.
    expect(iso(parseSearchTimeWindow('x 2026-03-10', NY).window))
      .toEqual(['2026-03-10T04:00:00.000Z', '2026-03-11T04:00:00.000Z']);
    // Across the 2026-03-08 spring-forward: D-1 18:00 EST (UTC-5) = 23:00Z.
    expect(iso(parseSearchTimeWindow('overnight 2026-03-09', NY).window))
      .toEqual(['2026-03-08T22:00:00.000Z', '2026-03-10T16:00:00.000Z']);
  });

  test('a record at 2026-03-10T23:30Z is on 2026-03-10 in UTC and in New York', () => {
    expect(isoDateInZone('2026-03-10T23:30:00Z', 'UTC')).toBe('2026-03-10');
    expect(isoDateInZone('2026-03-10T23:30:00Z', 'America/New_York')).toBe('2026-03-10');
  });

  test('a record at 2026-03-11T02:00Z is on 2026-03-10 in New York but 2026-03-11 in UTC', () => {
    expect(isoDateInZone('2026-03-11T02:00:00Z', 'America/New_York')).toBe('2026-03-10');
    expect(isoDateInZone('2026-03-11T02:00:00Z', 'UTC')).toBe('2026-03-11');
    // …and the New York day window for 2026-03-10 contains it, the UTC one does not.
    expect(windowContains(parseSearchTimeWindow('x 2026-03-10', NY).window!, '2026-03-11T02:00:00Z')).toBe(true);
    expect(windowContains(parseSearchTimeWindow('x 2026-03-10', UTC).window!, '2026-03-11T02:00:00Z')).toBe(false);
  });
});
