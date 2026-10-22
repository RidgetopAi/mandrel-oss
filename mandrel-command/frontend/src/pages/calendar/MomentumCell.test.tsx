/**
 * Momentum-cell render tests — proves the per-day momentum
 * treatment paints correctly on ALL THREE calendar views (Month / Week / Day):
 *   • a ring (SVG) + the momentum NUMBER + the sessions·contexts COUNTS render per cell;
 *   • a `hasData=false` day renders a BLANK cell (no ring, no number);
 *   • the ring carries the correct BAND (data-band) for its score band.
 * Raw react-dom + React.act harness (mirrors CalendarToolbar.test.tsx) — the grids are
 * pure presentational components, so no query client / router is needed.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { MomentumSeriesPoint } from '../../api/domains/momentumSeries';
import { MonthGrid } from './MonthGrid';
import { WeekGrid } from './WeekGrid';
import { DayView } from './DayView';
import { momentumBand } from './momentumCells';

function keyToDate(key: string): Date {
  const [y, m, d] = key.split('-').map((n) => parseInt(n, 10));
  return new Date(y, m - 1, d);
}
function point(date: string, score: number, sessions: number, contexts: number, hasData = true): MomentumSeriesPoint {
  return { date, momentum: { score, delta: score - 50 }, sessions, contexts, tasks: 0, hasData };
}

// A representative span: one day per band + a quiet (no-data) day.
const HI = '2026-07-06'; // 85 → band hi
const GOOD = '2026-07-07'; // 70 → band good
const MID = '2026-07-08'; // 50 → band mid
const LOW = '2026-07-09'; // 30 → band low
const QUIET = '2026-07-10'; // hasData=false → blank
const DAYS = [HI, GOOD, MID, LOW, QUIET];

const MOMENTUM = new Map<string, MomentumSeriesPoint>([
  [HI, point(HI, 85, 3, 22)],
  [GOOD, point(GOOD, 70, 2, 14)],
  [MID, point(MID, 50, 1, 6)],
  [LOW, point(LOW, 30, 0, 2)],
  [QUIET, point(QUIET, 0, 0, 0, false)],
]);
const NO_TASKS = new Map();

let container: HTMLDivElement;
let root: Root;

function render(node: React.ReactElement) {
  container = document.createElement('div');
  document.body.appendChild(container);
  act(() => {
    root = createRoot(container);
    root.render(node);
  });
}

function cellFor(key: string): HTMLElement {
  const el = container.querySelector(
    `button[aria-label^="Open day summary for ${key}"]`,
  ) as HTMLElement;
  expect(el, `cell for ${key} should exist`).toBeTruthy();
  return el;
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
});

describe('MonthGrid — momentum on every cell', () => {
  beforeEach(() => {
    render(
      <MonthGrid
        days={DAYS.map(keyToDate)}
        month={keyToDate(HI)}
        momentum={MOMENTUM}
        tasksByDay={NO_TASKS}
        onSelectDate={vi.fn()}
        selectedKey={undefined}
      />,
    );
  });

  it('renders a ring + number + counts on each day WITH data', () => {
    for (const key of [HI, GOOD, MID, LOW]) {
      const cell = cellFor(key);
      const p = MOMENTUM.get(key)!;
      const ring = cell.querySelector('svg[role="img"]');
      expect(ring, `ring for ${key}`).toBeTruthy();
      expect(cell.querySelector('[data-testid="mo-val"]')?.textContent).toBe(String(p.momentum.score));
      const counts = cell.querySelector('[data-testid="mo-counts"]')?.textContent ?? '';
      expect(counts).toContain(`${p.contexts}c`);
    }
  });

  it('renders a BLANK cell (no ring, no number) for a hasData=false day', () => {
    const cell = cellFor(QUIET);
    expect(cell.querySelector('svg[role="img"]')).toBeNull();
    expect(cell.querySelector('[data-testid="mo-val"]')).toBeNull();
  });

  it('paints the correct band (data-band) for each score band', () => {
    expect(cellFor(HI).querySelector('svg')?.getAttribute('data-band')).toBe(momentumBand(85).key);
    expect(cellFor(GOOD).querySelector('svg')?.getAttribute('data-band')).toBe(momentumBand(70).key);
    expect(cellFor(MID).querySelector('svg')?.getAttribute('data-band')).toBe(momentumBand(50).key);
    expect(cellFor(LOW).querySelector('svg')?.getAttribute('data-band')).toBe(momentumBand(30).key);
    // The bands resolve to the expected keys.
    expect([momentumBand(85).key, momentumBand(70).key, momentumBand(50).key, momentumBand(30).key]).toEqual([
      'hi', 'good', 'mid', 'low',
    ]);
  });
});

describe('WeekGrid — momentum on every cell', () => {
  beforeEach(() => {
    render(
      <WeekGrid
        days={DAYS.map(keyToDate)}
        momentum={MOMENTUM}
        tasksByDay={NO_TASKS}
        onSelectDate={vi.fn()}
        selectedKey={undefined}
      />,
    );
  });

  it('renders ring + number + counts for a day with data', () => {
    const cell = cellFor(GOOD);
    expect(cell.querySelector('svg[role="img"]')).toBeTruthy();
    expect(cell.querySelector('[data-testid="mo-val"]')?.textContent).toBe('70');
    expect(cell.querySelector('[data-testid="mo-counts"]')?.textContent).toBe('2s·14c');
  });

  it('renders no momentum block for a hasData=false day', () => {
    const cell = cellFor(QUIET);
    expect(cell.querySelector('svg[role="img"]')).toBeNull();
    expect(cell.querySelector('[data-testid="mo-val"]')).toBeNull();
  });

  it('omits the leading sessions token when there were no sessions ("·2c")', () => {
    expect(cellFor(LOW).querySelector('[data-testid="mo-counts"]')?.textContent).toBe('·2c');
  });
});

describe('DayView — momentum on the single-day panel', () => {
  it('renders ring + number + counts when the day has data', () => {
    render(
      <DayView
        day={keyToDate(HI)}
        momentum={MOMENTUM}
        tasksByDay={NO_TASKS}
        onSelectDate={vi.fn()}
        selectedKey={undefined}
      />,
    );
    const cell = cellFor(HI);
    expect(cell.querySelector('svg[role="img"]')?.getAttribute('data-band')).toBe('hi');
    expect(cell.querySelector('[data-testid="mo-val"]')?.textContent).toBe('85');
    expect(cell.querySelector('[data-testid="mo-counts"]')?.textContent).toBe('3s·22c');
  });

  it('renders no momentum block for a quiet day', () => {
    render(
      <DayView
        day={keyToDate(QUIET)}
        momentum={MOMENTUM}
        tasksByDay={NO_TASKS}
        onSelectDate={vi.fn()}
        selectedKey={undefined}
      />,
    );
    const cell = cellFor(QUIET);
    expect(cell.querySelector('svg[role="img"]')).toBeNull();
    expect(cell.querySelector('[data-testid="mo-val"]')).toBeNull();
  });
});
