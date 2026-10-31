/** Map layout — unit tests on the pure module. Pixel/threshold values are read from MAP_CONFIG. */
import { describe, it, expect } from 'vitest';
import { buildMap, unbranchedStrip, type MapInput } from './map';
import { MAP_CONFIG } from './config';
import type { BranchSummary } from '../../api/domains/treewalker';

const DAY = 86_400_000;
const NOW = Date.parse('2026-10-30T12:00:00.000Z');
const WINDOW = 45;
const ago = (days: number) => new Date(NOW - days * DAY).toISOString();

let seq = 0;
const branch = (over: Partial<BranchSummary> & { first: number; last: number }): BranchSummary => {
  const n = ++seq;
  const { first, last, ...rest } = over;
  return {
    spineId: `${(0xa000 + n).toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`,
    spineType: 'task',
    name: `b${n}`,
    named: true,
    members: 3,
    firstActiveAt: ago(first),
    lastActiveAt: ago(last),
    milestones: [],
    open: false,
    isTopLevel: true,
    sectionCount: 0,
    ...rest,
  };
};
const input = (branches: BranchSummary[], extra: Partial<MapInput> = {}): MapInput => ({
  branches,
  trunk: undefined,
  sinceDays: WINDOW,
  now: NOW,
  ...extra,
});
/** The scale re-derived independently of the module under test. */
const expectedX = (iso: string, plotLeft: number, plotRight: number) =>
  plotLeft + ((Date.parse(iso) - (NOW - WINDOW * DAY)) / (WINDOW * DAY)) * (plotRight - plotLeft);

describe('row packing', () => {
  it('puts two overlapping branches on different rows', () => {
    const a = branch({ first: 30, last: 10 });
    const b = branch({ first: 20, last: 2 });
    const m = buildMap(input([a, b]));
    const rowOf = (id: string) => m.branches.find((x) => x.spineId === id)!.row;
    expect(rowOf(a.spineId)).not.toBe(rowOf(b.spineId));
  });

  it('lets two non-overlapping branches share a row', () => {
    const a = branch({ first: 44, last: 40, name: 'a' });
    const b = branch({ first: 10, last: 5, name: 'b' });
    const m = buildMap(input([a, b]));
    expect(m.branches[0].row).toBe(m.branches[1].row);
    expect(m.branches[0].y).toBe(m.branches[1].y);
  });

  it('never lets two branches on one row overlap, across a busy mix', () => {
    const many = [
      branch({ first: 44, last: 30 }), branch({ first: 40, last: 12 }), branch({ first: 33, last: 20 }),
      branch({ first: 25, last: 3 }), branch({ first: 15, last: 14 }), branch({ first: 8, last: 1 }),
      branch({ first: 2, last: 0 }),
    ];
    const m = buildMap(input(many));
    for (const x of m.branches) {
      for (const y of m.branches) {
        if (x === y || x.row !== y.row) continue;
        const [l, r] = x.x0 <= y.x0 ? [x, y] : [y, x];
        expect(l.x1).toBeLessThan(r.x0);
      }
    }
  });

  it('alternates rows above and below the trunk, nearest row first', () => {
    const m = buildMap(input([branch({ first: 40, last: 5 }), branch({ first: 39, last: 4 }), branch({ first: 38, last: 3 })]));
    expect(m.branches.map((b) => b.side)).toEqual(['above', 'below', 'above']);
    expect(m.branches.map((b) => b.level)).toEqual([0, 0, 1]);
    for (const b of m.branches) expect(b.side === 'above' ? b.y < m.trunk.y : b.y > m.trunk.y).toBe(true);
    // rows of one side are distinct heights
    const ys = m.branches.filter((b) => b.side === 'above').map((b) => b.y);
    expect(new Set(ys).size).toBe(ys.length);
  });

  it('joins both ends of every line to the trunk with a connector', () => {
    const m = buildMap(input([branch({ first: 30, last: 10 })]));
    const b = m.branches[0];
    expect(b.connectors.map((k) => k.x)).toEqual([b.x0, b.x1]);
    for (const k of b.connectors) {
      expect(k.y0).toBe(b.y);
      expect(k.y1).toBe(m.trunk.y);
    }
  });
});

describe('x positions and stations', () => {
  it("puts each station at its milestone date's x on the same scale as the lines", () => {
    const at1 = ago(33);
    const at2 = ago(12);
    const b = branch({
      first: 40,
      last: 5,
      milestones: [
        { id: 'm1', createdAt: at1, title: 'First' },
        { id: 'm2', createdAt: at2, title: 'Second' },
      ],
    });
    const m = buildMap(input([b]));
    const [s1, s2] = m.branches[0].stations;
    expect(s1.x).toBeCloseTo(expectedX(at1, m.plotLeft, m.plotRight), 6);
    expect(s2.x).toBeCloseTo(expectedX(at2, m.plotLeft, m.plotRight), 6);
    expect(s2.x - s1.x).toBeCloseTo((21 / WINDOW) * (m.plotRight - m.plotLeft), 6); // NOT evenly spaced by index
    expect(s1.y).toBe(m.branches[0].y);
    expect(m.branches[0].x0).toBeCloseTo(expectedX(b.firstActiveAt, m.plotLeft, m.plotRight), 6);
  });

  it('is monotonic in time', () => {
    const m = buildMap(input([branch({ first: 40, last: 30 }), branch({ first: 10, last: 2 })]));
    expect(m.branches[0].x0).toBeLessThan(m.branches[1].x0);
  });

  it('cuts a line that began before the window at the left edge and says so', () => {
    const m = buildMap(input([branch({ first: 80, last: 20 })]));
    expect(m.branches[0].x0).toBe(m.plotLeft);
    expect(m.branches[0].clippedStart).toBe(true);
  });
});

describe('labels', () => {
  it('names the branch, its member count and its id8', () => {
    const b = branch({ first: 30, last: 20, name: 'Backstory build', members: 17 });
    const m = buildMap(input([b]));
    expect(m.branches[0].label.text).toBe(`Backstory build · 17 · ${b.spineId.slice(0, 8)}`);
  });

  it("right-aligns the label of a branch ending at the window's right edge, inside the plot", () => {
    const b = branch({ first: 3, last: 0, name: 'A fairly long branch name here' });
    const m = buildMap(input([b]));
    const l = m.branches[0].label;
    expect(l.align).toBe('end');
    expect(l.right).toBeLessThanOrEqual(m.plotRight);
    expect(l.right).toBeLessThanOrEqual(m.width);
    expect(l.x).toBeGreaterThanOrEqual(0);
    expect(l.right).toBeCloseTo(m.branches[0].x1, 6);
  });

  it('left-aligns a label that fits', () => {
    const m = buildMap(input([branch({ first: 40, last: 30, name: 'x' })]));
    expect(m.branches[0].label.align).toBe('start');
    expect(m.branches[0].label.x).toBe(m.branches[0].x0);
  });

  it('keeps every label inside the plot for branches at any date', () => {
    const m = buildMap(input([0, 1, 2, 5, 9, 20, 44].map((d) => branch({ first: d + 1, last: d, name: 'n'.repeat(60) }))));
    for (const b of m.branches) {
      expect(b.label.right).toBeLessThanOrEqual(m.plotRight);
      expect(b.label.x).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('trunk', () => {
  const trunk = {
    count: 214,
    headId: 'h1',
    entries: [
      { id: 'h1', title: 'newest', createdAt: ago(1), superseded: false },
      { id: 'h2', title: 'older', createdAt: ago(9), superseded: true },
      { id: 'h0', title: 'outside the window', createdAt: ago(90), superseded: true },
    ],
  };
  it('states the full handoff count and marks you-are-here at the head handoff', () => {
    const m = buildMap(input([], { trunk }));
    expect(m.trunk.countLabel).toBe('214 handoffs');
    expect(m.trunk.head).toMatchObject({ id: 'h1', label: MAP_CONFIG.youAreHereLabel, clamped: false });
    expect(m.trunk.head!.x).toBeCloseTo(expectedX(ago(1), m.plotLeft, m.plotRight), 6);
    expect(m.trunk.ticks.map((t) => t.id)).toEqual(['h1', 'h2']);
  });
  it('has no head marker without a handoff', () => {
    expect(buildMap(input([])).trunk.head).toBeNull();
  });
});

describe('unbranched strip', () => {
  it('states the served share as a whole percent over the served window', () => {
    expect(unbranchedStrip({ unbranched: 37, total: 100, windowDays: 60 }).text).toBe(
      'Not on any branch: 37% of records in the last 60 days',
    );
    expect(unbranchedStrip({ unbranched: 1, total: 3, windowDays: 60 }).pct).toBe(33);
  });
  it('does not divide by zero on an empty window', () => {
    const s = unbranchedStrip({ unbranched: 0, total: 0, windowDays: 60 });
    expect(s.pct).toBeNull();
    expect(s.text).toBe('No records in the last 60 days.');
  });
});
