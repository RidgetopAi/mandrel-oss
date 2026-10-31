/**
 * Story shaping — unit tests on the pure module. Every vocabulary
 * assertion reads the expectation from config, not a restated literal, where the config is
 * the thing under test.
 */
import { describe, it, expect } from 'vitest';
import type { ThreadEdge, ThreadGraph, ThreadNode } from '../../api/domains/treewalker';
import { buildStory, roleOf } from './story';
import { CONTEXT_TYPE_ROLE, STORY_CONFIG, STORY_ROLES } from './config';
import { DEMO_IDS, DEMO_THREAD } from './demoBranch.fixture';

const UTC = 'UTC';

let seq = 0;
const mk = (over: Partial<ThreadNode> & Pick<ThreadNode, 'kind' | 'createdAt'>): ThreadNode => ({
  id: `${(++seq).toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`,
  title: `rec ${seq}`,
  trust: 'unproven',
  inBranch: true,
  ...over,
});
const graphOf = (nodes: ThreadNode[], edges: ThreadEdge[] = [], over: Partial<ThreadGraph> = {}): ThreadGraph => ({
  anchor: { branchLabel: 'b', anchorId: nodes[0]?.id ?? '', recordCount: nodes.length },
  spine: [],
  nodes,
  edges,
  story: [],
  trunkAnchorId: null,
  memberTotal: nodes.length,
  truncated: false,
  ...over,
});
const declared = (source: string, target: string, edgeType: string): ThreadEdge => ({
  id: `e-${source}-${target}`, source, target, edgeType, mintVia: 'tag', provenance: 'declared',
});
const ctx = (iso: string, contextType: string) => mk({ kind: 'context', contextType, createdAt: iso });
const run = (n: number, type = 'reflections') =>
  Array.from({ length: n }, (_, i) => ctx(`2026-10-26T1${i}:00:00.000Z`, type));

describe('role mapping', () => {
  it('maps every kind and every configured contextType; unknown contexts and handoffs are Work', () => {
    expect(roleOf({ kind: 'decision' })).toBe('decision');
    expect(roleOf({ kind: 'task' })).toBe('task');
    for (const [type, role] of Object.entries(CONTEXT_TYPE_ROLE)) {
      expect(roleOf({ kind: 'context', contextType: type })).toBe(role);
    }
    expect(CONTEXT_TYPE_ROLE).toMatchObject({ milestone: 'outcome', error: 'problem', reflections: 'review', planning: 'plan' });
    expect(roleOf({ kind: 'context', contextType: 'note' })).toBe('work');
    expect(roleOf({ kind: 'context', contextType: null })).toBe('work');
    expect(roleOf({ kind: 'handoff', contextType: 'handoff' })).toBe(STORY_CONFIG.defaultContextRole);
  });

  it('roles differ by shape, not hue alone, and each carries a token (never a hex)', () => {
    const shapes = new Set(Object.values(STORY_ROLES).map((r) => r.marker));
    expect(shapes).toEqual(new Set(['square', 'circle', 'dot', 'ring', 'diamond']));
    for (const r of Object.values(STORY_ROLES)) expect(r.colorVar).toMatch(/^--[a-z0-9-]+$/);
  });
});

describe('chapters', () => {
  it('splits on LOCAL calendar days: a fixture spanning local midnight lands in two chapters', () => {
    // 03:00Z and 07:00Z on Oct 27 are 21:00 Oct 26 and 01:00 Oct 27 in Denver (MDT, UTC-6)... one UTC day, two local days.
    const nodes = [ctx('2026-10-27T03:00:00.000Z', 'note'), ctx('2026-10-27T07:00:00.000Z', 'note')];
    const denver = buildStory(graphOf(nodes), { timeZone: 'America/Denver' });
    expect(denver.chapters.map((c) => c.dayKey)).toEqual(['2026-10-26', '2026-10-27']);
    const utc = buildStory(graphOf(nodes), { timeZone: UTC });
    expect(utc.chapters).toHaveLength(1);
  });

  it('orders chapters oldest first and heads each with date and record count', () => {
    const s = buildStory(DEMO_THREAD, { timeZone: UTC });
    expect(s.chapters.map((c) => c.dayKey)).toEqual(['2026-10-24', '2026-10-26', '2026-10-28']);
    expect(s.chapters.map((c) => c.date)).toEqual(['Oct 24', 'Oct 26', 'Oct 28']);
    // Every in-branch record is counted once: beats plus chips.
    expect(s.chapters.reduce((n, c) => n + c.recordCount, 0)).toBe(s.header.recordCount);
  });
});

describe('collapse', () => {
  const itemsOf = (n: number) => buildStory(graphOf(run(n)), { timeZone: UTC }).chapters[0].items;
  it(`${STORY_CONFIG.collapseThreshold} consecutive same-role beats collapse into one group`, () => {
    const items = itemsOf(3);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ type: 'group', group: { role: 'review', count: 3 } });
  });
  it('2 do not collapse', () => {
    expect(itemsOf(2).map((i) => i.type)).toEqual(['beat', 'beat']);
  });
  it('a different role in between breaks the run', () => {
    const [a, b, c] = run(3);
    const mid = ctx('2026-10-26T11:30:00.000Z', 'note');
    const items = buildStory(graphOf([a, b, mid, c]), { timeZone: UTC }).chapters[0].items;
    expect(items.every((i) => i.type === 'beat')).toBe(true);
  });
  it('a run never spans two chapters', () => {
    const nodes = [ctx('2026-10-26T22:00:00.000Z', 'reflections'), ctx('2026-10-26T23:00:00.000Z', 'reflections'), ctx('2026-10-27T01:00:00.000Z', 'reflections')];
    const s = buildStory(graphOf(nodes), { timeZone: UTC });
    expect(s.chapters.flatMap((c) => c.items).every((i) => i.type === 'beat')).toBe(true);
  });
  it('the demo branch collapses its four reflections into one Review group of 4', () => {
    const s = buildStory(DEMO_THREAD, { timeZone: UTC });
    const groups = s.chapters.flatMap((c) => c.items).filter((i) => i.type === 'group');
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ group: { role: 'review', count: 4 } });
  });
});

describe('spawned tasks and ghosts', () => {
  const s = buildStory(DEMO_THREAD, { timeZone: UTC });
  const beats = s.chapters.flatMap((c) => c.items).flatMap((i) => (i.type === 'beat' ? [i.beat] : i.group.beats));

  it('a task decided_by a decision member appears only as a chip under it', () => {
    const decision = beats.find((b) => b.id === DEMO_IDS.decision)!;
    expect(decision.role).toBe('decision');
    expect(decision.chips.map((c) => c.state)).toEqual(['done', 'done', 'open']);
    for (const t of [DEMO_IDS.taskDone1, DEMO_IDS.taskDone2, DEMO_IDS.taskOpen]) {
      expect(beats.find((b) => b.id === t)).toBeUndefined();
    }
    expect(beats.some((b) => b.role === 'task')).toBe(false);
  });

  it('a task decided_by a decision that is NOT a member stays an ordinary beat', () => {
    const ghostDecision = mk({ kind: 'decision', createdAt: '2026-10-20T10:00:00.000Z', inBranch: false });
    const task = mk({ kind: 'task', status: 'todo', createdAt: '2026-10-26T10:00:00.000Z' });
    const out = buildStory(graphOf([task, ghostDecision], [declared(task.id, ghostDecision.id, 'decided_by')]), { timeZone: UTC });
    expect(out.chapters[0].items[0]).toMatchObject({ type: 'beat', beat: { id: task.id, role: 'task' } });
  });

  it('a cancelled task renders as a cancelled chip', () => {
    const d = mk({ kind: 'decision', createdAt: '2026-10-26T10:00:00.000Z' });
    const t = mk({ kind: 'task', status: 'cancelled', createdAt: '2026-10-26T11:00:00.000Z' });
    const out = buildStory(graphOf([d, t], [declared(t.id, d.id, 'decided_by')]), { timeZone: UTC });
    expect(out.chapters[0].items).toHaveLength(1);
    expect((out.chapters[0].items[0] as { beat: { chips: { state: string }[] } }).beat.chips[0].state).toBe('cancelled');
  });

  it('an inBranch:false node never becomes a beat, but a beat with a declared edge to it leans on it', () => {
    expect(beats.some((b) => b.id === DEMO_IDS.ghost)).toBe(false);
    expect(s.header.recordCount).toBe(DEMO_THREAD.nodes.length - 1);
    const leaning = beats.filter((b) => b.leansOn.length > 0);
    expect(leaning).toHaveLength(1);
    expect(leaning[0].leansOn[0]).toMatchObject({ id: DEMO_IDS.ghost, title: 'Earlier: keep one repo for prod and OSS' });
  });
});

describe('header, sidebar, summary', () => {
  const s = buildStory(DEMO_THREAD, { timeZone: UTC });

  it('header counts match the fixture', () => {
    expect(s.header).toEqual({
      title: 'Move the product tree to the OSS branch',
      recordCount: 13,
      span: 'Oct 24 – Oct 28',
      decisions: 1,
      outcomes: 1,
      problems: 1,
      openTasks: 1,
    });
  });

  it('the open-task list is exactly the todo / in_progress task members, chips included', () => {
    expect(s.sidebar.stillOpen).toEqual([
      { id: DEMO_IDS.taskOpen, id8: '000000e3', title: 'Publish the install docs', status: 'in_progress' },
    ]);
  });

  it('where it stands names the newest Outcome and the newest record; the key lists every role', () => {
    expect(s.sidebar.newestOutcome?.title).toBe('v0.70.0 shipped to the OSS branch');
    expect(s.sidebar.newestRecord?.title).toBe('Post-release smoke notes');
    expect(s.sidebar.key.map((k) => k.role)).toEqual(Object.keys(STORY_ROLES));
  });

  it('the summary sentence is identical for identical input and names the counts and both titles', () => {
    expect(buildStory(DEMO_THREAD, { timeZone: UTC }).summary).toBe(s.summary);
    expect(s.summary).toBe(
      'Move the product tree to the OSS branch: 13 records over Oct 24 – Oct 28 — 1 decision, 1 outcome, 1 problem, 1 open. Latest outcome: v0.70.0 shipped to the OSS branch. Newest record: Post-release smoke notes.',
    );
  });

  it('an empty branch is stated, not fabricated', () => {
    const empty = buildStory(graphOf([]), { timeZone: UTC });
    expect(empty.chapters).toEqual([]);
    expect(empty.header.recordCount).toBe(0);
    expect(empty.summary).toMatch(/no records yet/);
  });

  it('reports truncation as newest N of M only when the API says truncated', () => {
    expect(s.truncated).toBeNull();
    const t = buildStory({ ...DEMO_THREAD, truncated: true, memberTotal: 400 }, { timeZone: UTC });
    expect(t.truncated).toEqual({ shown: 13, total: 400 });
  });
});
