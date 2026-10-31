/**
 * Timeline layout — unit tests on the pure module. Thresholds are read from
 * TIMELINE_CONFIG; the 30 h / 11 h gaps are chosen relative to its foldGapHours.
 */
import { describe, it, expect } from 'vitest';
import { buildTimeline, storyBeats, storyRecords } from './timeline';
import { buildStory, type Beat } from './story';
import { STORY_ROLE_ORDER, TIMELINE_CONFIG, type StoryRoleKey } from './config';
import { DEMO_THREAD } from './demoBranch.fixture';
import { SPAWNED_DECISION_TITLE, SPAWNED_IDS, SPAWNED_THREAD } from './spawnedTasksBranch.fixture';

const T0 = Date.parse('2026-10-24T10:00:00.000Z');
const H = 3_600_000;
let seq = 0;
const beat = (role: StoryRoleKey, hoursFromStart: number, title = `${role} ${++seq}`): Beat => {
  const n = ++seq;
  return {
    id: `${n.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`,
    id8: n.toString(16).padStart(8, '0'),
    role,
    title,
    at: new Date(T0 + hoursFromStart * H).toISOString(),
    time: '',
    chips: [],
    leansOn: [],
  };
};
const opts = { timeZone: 'UTC' };

describe('lanes', () => {
  it('are exactly the roles present, in config order', () => {
    const t = buildTimeline([beat('work', 0), beat('decision', 1), beat('review', 2), beat('work', 3)], opts);
    const expected = STORY_ROLE_ORDER.filter((r) => ['work', 'decision', 'review'].includes(r));
    expect(t.lanes.map((l) => l.role)).toEqual(expected);
    expect(t.lanes.map((l) => l.row)).toEqual([0, 1, 2]);
    expect(t.points.every((p) => t.lanes[p.row].role === p.role)).toBe(true);
  });

  it('draws no empty lane', () => {
    const t = buildTimeline([beat('work', 0), beat('work', 1)], opts);
    expect(t.lanes).toHaveLength(1);
  });

  it('an empty branch lays out nothing', () => {
    expect(buildTimeline([], opts)).toMatchObject({ lanes: [], points: [], bands: [], gaps: [] });
  });
});

describe('x positions and folded gaps', () => {
  it('are non-decreasing in createdAt, whatever order the input arrives in', () => {
    const t = buildTimeline([beat('work', 5), beat('work', 0), beat('work', 40), beat('work', 5.5), beat('work', 6)], opts);
    const xs = t.points.map((p) => p.x);
    const ats = t.points.map((p) => Date.parse(p.at));
    expect(ats).toEqual([...ats].sort((a, b) => a - b));
    for (let i = 1; i < xs.length; i++) expect(xs[i]).toBeGreaterThanOrEqual(xs[i - 1]);
  });

  it('folds a 30 h gap to the configured width, reporting its real length', () => {
    const t = buildTimeline([beat('work', 0), beat('work', 30)], opts);
    expect(t.gaps).toHaveLength(1);
    expect(t.gaps[0].hours).toBe(30);
    expect(t.gaps[0].label).toBe('30 h gap');
    expect(t.gaps[0].width).toBe(TIMELINE_CONFIG.foldedGapPx);
    expect(t.points[1].x - t.points[0].x).toBe(TIMELINE_CONFIG.foldedGapPx);
  });

  it('does not fold an 11 h gap; it stays on the linear scale', () => {
    const t = buildTimeline([beat('work', 0), beat('work', 11)], opts);
    expect(t.gaps).toHaveLength(0);
    expect(t.points[1].x - t.points[0].x).toBeCloseTo(11 * TIMELINE_CONFIG.minPxPerHour);
  });

  it('folds only a gap LONGER than the threshold', () => {
    const at = TIMELINE_CONFIG.foldGapHours;
    expect(buildTimeline([beat('work', 0), beat('work', at)], opts).gaps).toHaveLength(0);
    expect(buildTimeline([beat('work', 0), beat('work', at + 0.5)], opts).gaps).toHaveLength(1);
  });

  it('honours a threshold passed in', () => {
    expect(buildTimeline([beat('work', 0), beat('work', 5)], { ...opts, foldGapHours: 4 }).gaps).toHaveLength(1);
  });
});

describe('phase bands', () => {
  it('break at each folded gap and right after each Outcome', () => {
    const recs = [beat('work', 0), beat('outcome', 1), beat('work', 2), beat('work', 40), beat('work', 41)];
    const t = buildTimeline(recs, opts);
    expect(t.bands.map((b) => b.ids.length)).toEqual([2, 1, 2]);
    expect(t.bands[0].ids.at(-1)).toBe(recs[1].id); // the Outcome closes its band
    expect(t.bands[0].closedBy).toBe('outcome');
    expect(t.bands[1].closedBy).toBe('gap');
    expect(t.bands[2].ids).toEqual([recs[3].id, recs[4].id]);
    expect(t.points.map((p) => p.band)).toEqual([0, 0, 1, 2, 2]);
  });

  it('a trailing Outcome opens no empty band', () => {
    const t = buildTimeline([beat('work', 0), beat('outcome', 1)], opts);
    expect(t.bands).toHaveLength(1);
  });

  it('bands tile without overlap and the folded stretch stays unshaded', () => {
    const t = buildTimeline([beat('work', 0), beat('outcome', 1), beat('work', 2), beat('work', 40)], opts);
    expect(t.bands[1].x0).toBeCloseTo(t.bands[0].x1);
    expect(t.bands[2].x0).toBeGreaterThan(t.bands[1].x1);
  });

  it("label: the first Decision's title", () => {
    const t = buildTimeline(
      [beat('work', 0, 'w'), beat('decision', 1, 'first decision'), beat('decision', 2, 'second'), beat('outcome', 3, 'closing outcome')],
      opts,
    );
    expect(t.bands[0].label).toBe('first decision');
  });

  it("label: else the closing Outcome's title", () => {
    const t = buildTimeline([beat('work', 0, 'w'), beat('outcome', 1, 'closing outcome'), beat('work', 2, 'next')], opts);
    expect(t.bands[0].label).toBe('closing outcome');
  });

  it("label: else the first record's title", () => {
    const t = buildTimeline([beat('review', 0, 'first rec'), beat('work', 1, 'second rec')], opts);
    expect(t.bands[0].label).toBe('first rec');
  });

  it('label is the full title, never truncated', () => {
    const long = 'x'.repeat(200);
    const t = buildTimeline([beat('decision', 0, long)], opts);
    expect(t.bands[0].label).toBe(long);
  });
});

describe('fitting the available width', () => {
  const C = TIMELINE_CONFIG;
  // 0 → 20 h in two unfolded steps, so the span is 20 h.
  const short = () => [beat('work', 0), beat('work', 10), beat('work', 20)];

  it('a span that fits at the floor fills the box exactly', () => {
    const W = 900;
    const t = buildTimeline(short(), { ...opts, availableWidth: W });
    expect(t.width).toBe(W);
    expect(t.pxPerHour).toBeGreaterThan(C.minPxPerHour);
    expect(t.points[0].x).toBe(C.edgePadPx);
    expect(t.points[2].x).toBeCloseTo(W - C.edgePadPx);
  });

  it('a span wider than the box at the floor scrolls, at exactly the floor', () => {
    const W = 100;
    const t = buildTimeline(short(), { ...opts, availableWidth: W });
    expect(t.pxPerHour).toBe(C.minPxPerHour);
    expect(t.width).toBeGreaterThan(W);
    expect(t.width).toBeCloseTo(2 * C.edgePadPx + 20 * C.minPxPerHour);
  });

  it('with no measured width it lays out at the floor', () => {
    expect(buildTimeline(short(), opts).pxPerHour).toBe(C.minPxPerHour);
  });

  it('a folded gap keeps its folded width while the rest stretches', () => {
    const W = 1200;
    const t = buildTimeline([beat('work', 0), beat('work', 10), beat('work', 60), beat('work', 70)], { ...opts, availableWidth: W });
    expect(t.gaps[0].width).toBe(C.foldedGapPx);
    expect(t.points[2].x - t.points[1].x).toBe(C.foldedGapPx);
    expect(t.width).toBe(W);
    expect(t.points[3].x).toBeCloseTo(W - C.edgePadPx);
  });

  it('a single record still fills the box', () => {
    expect(buildTimeline([beat('work', 0)], { ...opts, availableWidth: 700 }).width).toBe(700);
  });
});

describe('marker labels at the right edge', () => {
  it('flips a label that would run past the plot, keeps the rest on the right', () => {
    const t = buildTimeline([beat('decision', 0, 'an early decision'), beat('decision', 10, 'a late decision title')], { ...opts, availableWidth: 700 });
    expect(t.points[0].labelFlip).toBe(false);
    expect(t.points[1].labelFlip).toBe(true);
  });
});

describe('space-aware marker labels', () => {
  const C = TIMELINE_CONFIG;
  const long60 = 'Publish from the release branch only after the smoke run passes';
  const charPx = C.bandLabelCharPx;

  it('60 chars with 800 px of free lane shows the full title, no ellipsis', () => {
    expect(long60).toHaveLength(63);
    const title = long60.slice(0, 60).trimEnd();
    const t = buildTimeline([beat('decision', 0, title), beat('work', 1)], { ...opts, availableWidth: 900, minPxPerHour: 800 });
    const p = t.points[0];
    expect(p.labelFlip).toBe(false);
    expect(p.label).toBe(title);
    expect(p.labelLines).toEqual([title]);
    expect(p.label).not.toContain('…');
  });

  it('with room for ~20 chars it wraps to at most markerLabelMaxLines, ellipsis only after that', () => {
    const room = 20 * charPx;
    // the next Decision sits just far enough right to leave ~20 characters
    const gapPx = C.markerGapPx + room + C.markerHalfPx + C.markerLabelGapPx;
    const t = buildTimeline([beat('decision', 0, long60), beat('decision', 1, 'next')], { ...opts, minPxPerHour: gapPx });
    const p = t.points[0];
    expect(p.labelLines.length).toBeLessThanOrEqual(C.markerLabelMaxLines);
    expect(p.labelLines.length).toBeGreaterThan(1);
    for (const l of p.labelLines) expect(l.length).toBeLessThanOrEqual(20);
    expect(p.labelLines[p.labelLines.length - 1].endsWith('…')).toBe(true);
    expect(p.labelLines.slice(0, -1).some((l) => l.includes('…'))).toBe(false);
    // text that fits in the allowed lines is wrapped, never ellipsised
    const short = buildTimeline([beat('decision', 0, 'alpha beta gamma delta epsilon'), beat('decision', 1, 'next')], { ...opts, minPxPerHour: gapPx }).points[0];
    expect(short.labelLines.join(' ')).toBe('alpha beta gamma delta epsilon');
  });

  it('labels 40 px apart in one lane overlap neither each other nor a marker', () => {
    const beats = [beat('decision', 0, long60), beat('decision', 1, long60), beat('decision', 2, long60), beat('decision', 40, long60)];
    const t = buildTimeline(beats, { ...opts, minPxPerHour: 40, availableWidth: 900 });
    const lane = t.points.filter((p) => p.row === t.points[0].row);
    const boxes = lane.filter((p) => p.labelW > 0).map((p) => [p.labelX, p.labelX + p.labelW] as const);
    expect(boxes.length).toBeGreaterThan(0);
    const sortedBoxes = [...boxes].sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < sortedBoxes.length; i++) expect(sortedBoxes[i][0]).toBeGreaterThanOrEqual(sortedBoxes[i - 1][1]);
    for (const p of lane) {
      for (const [l, r] of boxes) {
        if ((l === p.labelX && r === p.labelX + p.labelW)) continue;
        expect(p.x + C.markerHalfPx <= l || p.x - C.markerHalfPx >= r).toBe(true);
      }
      expect(p.labelX).toBeGreaterThanOrEqual(0);
      expect(p.labelX + p.labelW).toBeLessThanOrEqual(t.width + 1e-6);
    }
  });

  it('every point keeps the full title as its accessible name', () => {
    const t = buildTimeline([beat('decision', 0, long60), beat('decision', 1, long60), beat('work', 2, 'w')], { ...opts, minPxPerHour: 30 });
    for (const p of t.points) expect(p.name).toContain(p.title);
    expect(t.points[0].name).toContain(long60);
  });
});

describe('phase-band label rows', () => {
  const C = TIMELINE_CONFIG;
  const long = 'A decision title that is far longer than its narrow band';
  // Outcomes close a band every hour, so each band is a sliver narrower than its label.
  const crowded = () => [
    beat('decision', 0, `${long} one`),
    beat('outcome', 1, 'o1'),
    beat('decision', 2, `${long} two`),
    beat('outcome', 3, 'o2'),
    beat('decision', 4, `${long} three`),
    beat('outcome', 5, 'o3'),
  ];

  it('no two label boxes on one row overlap, and all stay inside the plot', () => {
    const t = buildTimeline(crowded(), { ...opts, availableWidth: 600 });
    const byRow = new Map<number, Array<[number, number]>>();
    for (const b of t.bands) {
      expect(b.labelX).toBeGreaterThanOrEqual(0);
      expect(b.labelX + b.labelW).toBeLessThanOrEqual(t.width + 1e-6);
      byRow.set(b.labelRow, [...(byRow.get(b.labelRow) ?? []), [b.labelX, b.labelX + b.labelW]]);
    }
    expect(Math.max(...t.bands.map((b) => b.labelRow))).toBeGreaterThan(0);
    for (const boxes of byRow.values()) {
      boxes.sort((p, q) => p[0] - q[0]);
      for (let i = 1; i < boxes.length; i++) expect(boxes[i][0]).toBeGreaterThanOrEqual(boxes[i - 1][1]);
    }
    expect(t.labelRows).toBe(Math.max(...t.bands.map((b) => b.labelRow)) + 1);
  });

  it('a label that fits stays inside its band on row 0', () => {
    const t = buildTimeline([beat('decision', 0, 'ok'), beat('work', 10)], { ...opts, availableWidth: 900 });
    expect(t.bands[0].labelRow).toBe(0);
    expect(t.labelRows).toBe(1);
  });

  it('every label carries the full band title', () => {
    const t = buildTimeline(crowded(), { ...opts, availableWidth: 600 });
    expect(t.bands.map((b) => b.label)).toEqual([`${long} one`, `${long} two`, `${long} three`]);
    expect(C.bandLabelRowPx).toBeGreaterThan(0);
  });
});

describe('day ticks, labels and names', () => {
  it('puts a tick at each local midnight inside an unfolded stretch, none in a fold', () => {
    // 10:00 UTC Oct 24 → 10:00 Oct 25 crosses one midnight; the 30 h fold (22→52) crosses another.
    const t = buildTimeline([beat('work', 0), beat('work', 11), beat('work', 22), beat('work', 52)], opts);
    expect(t.ticks.map((k) => k.at)).toEqual(['2026-10-25T00:00:00.000Z']);
    expect(t.ticks[0].label).toBe('Oct 25');
    const mid = t.points[0].x + 14 * TIMELINE_CONFIG.minPxPerHour;
    expect(t.ticks[0].x).toBeCloseTo(mid);
  });

  it('marks Decisions and Outcomes with a label, other roles without; every marker has a name', () => {
    const t = buildTimeline([beat('decision', 0, 'D'), beat('outcome', 1, 'O'), beat('review', 2, 'R')], opts);
    expect(t.points.map((p) => p.label)).toEqual(['D', 'O', '']);
    expect(t.points[0].name).toBe('Decision: D, Oct 24, 10:00');
  });

  it('lays out the committed demo branch from the real story', () => {
    const beats = storyBeats(buildStory(DEMO_THREAD, { timeZone: 'UTC' }));
    const t = buildTimeline(beats, opts);
    expect(t.points).toHaveLength(beats.length);
    expect(t.lanes.map((l) => l.role)).toEqual(['decision', 'outcome', 'problem', 'plan', 'review', 'work']);
    expect(t.gaps.length).toBeGreaterThan(0);
  });
});

describe('the Task lane', () => {
  const records = () => storyRecords(buildStory(SPAWNED_THREAD, opts));
  const lay = () => buildTimeline(records(), opts);
  const tasks = (t: ReturnType<typeof lay>) => t.points.filter((p) => p.role === 'task');

  it('holds the three spawned tasks and the plain task, each once at its own createdAt', () => {
    const t = lay();
    expect(t.lanes.map((l) => l.role)).toContain('task');
    const ts = tasks(t);
    expect(ts.map((p) => p.id).sort()).toEqual([SPAWNED_IDS.done, SPAWNED_IDS.inProgress, SPAWNED_IDS.cancelled, SPAWNED_IDS.plain].sort());
    const created = new Map(SPAWNED_THREAD.nodes.map((n) => [n.id, n.createdAt]));
    for (const p of ts) expect(p.at).toBe(created.get(p.id));
    expect(ts.every((p) => t.lanes[p.row].role === 'task')).toBe(true);
  });

  it('no record appears twice across all lanes, and every member is plotted', () => {
    const t = lay();
    const ids = t.points.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.sort()).toEqual(SPAWNED_THREAD.nodes.map((n) => n.id).sort());
  });

  it('the Story view still carries the spawned tasks as chips, not beats', () => {
    const story = buildStory(SPAWNED_THREAD, opts);
    const beatIds = storyBeats(story).map((b) => b.id);
    expect(beatIds).not.toContain(SPAWNED_IDS.done);
    expect(beatIds).toContain(SPAWNED_IDS.plain);
    expect(storyBeats(story).find((b) => b.id === SPAWNED_IDS.decision)!.chips).toHaveLength(3);
  });

  it('the three statuses map to three distinct states', () => {
    const t = lay();
    const state = (id: string) => t.points.find((p) => p.id === id)!.state;
    expect(state(SPAWNED_IDS.done)).toBe('done');
    expect(state(SPAWNED_IDS.inProgress)).toBe('open');
    expect(state(SPAWNED_IDS.cancelled)).toBe('cancelled');
    expect(state(SPAWNED_IDS.plain)).toBe('open');
    expect(new Set([SPAWNED_IDS.done, SPAWNED_IDS.inProgress, SPAWNED_IDS.cancelled].map(state)).size).toBe(3);
    expect(t.points.filter((p) => p.role !== 'task').every((p) => p.state === undefined)).toBe(true);
  });

  it("each spawned task's accessible name says 'decided by' and the decision's title; the plain task's does not", () => {
    const t = lay();
    for (const id of [SPAWNED_IDS.done, SPAWNED_IDS.inProgress, SPAWNED_IDS.cancelled]) {
      const p = t.points.find((q) => q.id === id)!;
      expect(p.name).toContain(`${TIMELINE_CONFIG.decidedByText} ${SPAWNED_DECISION_TITLE}`);
      expect(p.decidedById).toBe(SPAWNED_IDS.decision);
    }
    expect(t.points.find((p) => p.id === SPAWNED_IDS.plain)!.name).not.toContain(TIMELINE_CONFIG.decidedByText);
  });

  it('a task created inside a long gap shortens that gap like any other record', () => {
    const fold = TIMELINE_CONFIG.foldGapHours;
    const span = fold * 1.5;
    const withRecord = (role: StoryRoleKey) => buildTimeline([beat('work', 0), beat(role, span / 2), beat('work', span)], opts);
    const without = buildTimeline([beat('work', 0), beat('work', span)], opts);
    expect(without.gaps).toHaveLength(1);
    const asTask = withRecord('task');
    const asWork = withRecord('work');
    expect(asTask.gaps).toHaveLength(0);
    expect(asTask.gaps).toEqual(asWork.gaps);
    expect(asTask.width).toBeCloseTo(asWork.width);
  });
});
