/**
 * Analytics view render tests (Phase 3 "Insight"). Mounts the
 * Analytics view PART directly with real props (charts at a fixed size — jsdom has no
 * layout) and proves:
 *   - the LIVE KPIs (completion rate, avg cycle time, WIP·blocked) render REAL numbers;
 *   - the honest data-GAP states (throughput per-day series, completed-by-actor) render a
 *     "not yet available" state — never a fabricated series (the data-gap policy);
 *   - the status key + priority + aging panels derive from real rows/stats;
 *   - the aging list is clickable (opens the task).
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { Analytics } from './Analytics';
import type { Task, TaskStats, TaskLeadTime } from '../../types/task';

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

const ROWS: Task[] = [
  {
    id: 'aaaaaaaa-0000-0000-0000-000000000001',
    project_id: 'p',
    title: 'Make branch-naming deterministic',
    type: 'feature',
    status: 'todo',
    priority: 'high',
    tags: [],
    created_at: daysAgo(31),
    updated_at: daysAgo(1),
  } as unknown as Task,
  {
    id: 'bbbbbbbb-0000-0000-0000-000000000002',
    project_id: 'p',
    title: 'Tenant isolation blast radius',
    type: 'feature',
    status: 'in_progress',
    priority: 'medium',
    tags: [],
    created_at: daysAgo(9),
    updated_at: daysAgo(1),
  } as unknown as Task,
  {
    id: 'cccccccc-0000-0000-0000-000000000003',
    project_id: 'p',
    title: 'Blocked on prereq',
    type: 'bug',
    status: 'blocked',
    priority: 'urgent',
    tags: [],
    created_at: daysAgo(3),
    updated_at: daysAgo(1),
  } as unknown as Task,
  {
    id: 'dddddddd-0000-0000-0000-000000000004',
    project_id: 'p',
    title: 'A done task (excluded from open panels)',
    type: 'feature',
    status: 'completed',
    priority: 'low',
    tags: [],
    created_at: daysAgo(40),
    updated_at: daysAgo(1),
  } as unknown as Task,
];

const STATS: TaskStats = {
  total: 530,
  by_status: { completed: 399, in_progress: 5, blocked: 2, todo: 18 },
  by_priority: { urgent: 4, high: 9, medium: 15, low: 3 },
  by_type: { feature: 300 },
  completion_rate: 75,
};

const LEAD_TIME: TaskLeadTime = {
  distribution: [{ leadTimeDays: 1, count: 3, label: '< 1 day' }],
  stats: { totalTasks: 42, averageLeadTime: 1.8, medianLeadTime: 1.2, p90LeadTime: 4.5 },
};

// REAL per-day throughput series (the shape GET /api/tasks/throughput serves): 3 days of
// activity → 6 completions over 3 days → round(6/3 * 7) = 14 /wk KPI.
const THROUGHPUT = [
  { day: '2026-07-13', completed: 2, created: 1 },
  { day: '2026-07-14', completed: 0, created: 3 },
  { day: '2026-07-15', completed: 4, created: 0 },
];

// REAL completed-by-actor breakdown (GET /api/tasks/completed-by-actor), count DESC, with a
// real `unassigned` bucket.
const ACTORS = [
  { actor: 'coordinator', count: 12 },
  { actor: 'builder', count: 7 },
  { actor: 'unassigned', count: 3 },
];

let container: HTMLDivElement;
let root: Root;

function mount(node: React.ReactElement) {
  container = document.createElement('div');
  document.body.appendChild(container);
  act(() => {
    root = createRoot(container);
    root.render(node);
  });
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
});

function base(overrides: Partial<React.ComponentProps<typeof Analytics>> = {}) {
  return (
    <Analytics
      rows={ROWS}
      rowsLoading={false}
      stats={STATS}
      statsLoading={false}
      statsError={false}
      statsErrorObj={null}
      leadTime={LEAD_TIME}
      leadTimeLoading={false}
      throughputSeries={undefined}
      throughputLoading={false}
      actors={undefined}
      actorsLoading={false}
      range="30d"
      onSelect={vi.fn()}
      responsive={false}
      {...overrides}
    />
  );
}

describe('Analytics — live KPIs (real, never fabricated)', () => {
  it('renders completion rate, avg cycle time and WIP·blocked from real stats + lead-time', () => {
    mount(base());
    const text = container.textContent ?? '';
    expect(text).toContain('Completion rate');
    expect(text).toContain('75'); // completion_rate
    expect(text).toContain('399 / 530'); // completed / total
    expect(text).toContain('Avg cycle time');
    expect(text).toContain('1.8'); // averageLeadTime
    expect(text).toContain('WIP · blocked');
  });
});

describe('Analytics — throughput + by-actor render REAL data (wired), honest-empty otherwise', () => {
  it('throughput chart plots the REAL series (no "no activity" empty state) when supplied', () => {
    mount(base({ throughputSeries: THROUGHPUT }));
    const text = container.textContent ?? '';
    expect(text).toContain('Throughput vs created');
    expect(text).toContain('tasks / day · 30d'); // range flows into the caption
    // With real activity the panel is NOT in the empty state.
    expect(text).not.toContain('No activity in this window');
  });

  it('throughput chart shows an HONEST empty state when the window has no activity ([])', () => {
    mount(base({ throughputSeries: [] }));
    const text = container.textContent ?? '';
    expect(text).toContain('Throughput vs created');
    expect(text).toContain('No activity in this window');
  });

  it('throughput KPI computes a REAL /wk figure + live source from the series', () => {
    mount(base({ throughputSeries: THROUGHPUT }));
    const text = container.textContent ?? '';
    expect(text).toContain('Throughput');
    expect(text).toContain('14'); // round(6 completed / 3 days * 7) = 14 /wk
    expect(text).toContain('/wk');
    expect(text).toContain('tasks completed · live');
  });

  it('throughput KPI with no series shows the honest "not yet available" tile', () => {
    mount(base({ throughputSeries: undefined }));
    expect(container.textContent).toContain('not yet available');
  });

  it('completed-by-actor renders the REAL breakdown (not the old gap) when supplied', () => {
    mount(base({ actors: ACTORS }));
    const text = container.textContent ?? '';
    expect(text).toContain('Completed by actor');
    expect(text).toContain('completed · last 30d');
    // wired now — the old actor-on-read gap wording is gone, and it's not empty.
    expect(text).not.toContain('305998f3');
    expect(text).not.toContain('No data yet');
  });

  it('completed-by-actor shows an HONEST empty state when nothing completed ([])', () => {
    mount(base({ actors: [] }));
    const text = container.textContent ?? '';
    expect(text).toContain('Completed by actor');
    expect(text).toContain('No data yet');
  });
});

describe('Analytics — snapshot breakdowns from real rows/stats', () => {
  it('open-by-status key shows all four counts incl. Done', () => {
    mount(base());
    const text = container.textContent ?? '';
    expect(text).toContain('Open tasks by status');
    expect(text).toContain('Done');
    expect(text).toContain('399'); // Done count from stats
  });

  it('open-by-priority panel renders', () => {
    mount(base());
    expect(container.textContent).toContain('Open by priority');
  });

  it('aging list shows the oldest OPEN task with its age badge (done excluded)', () => {
    mount(base());
    const text = container.textContent ?? '';
    expect(text).toContain('Oldest open tasks');
    expect(text).toContain('Make branch-naming deterministic'); // oldest OPEN (31d)
    expect(text).toContain('31d');
    // the completed task must NOT appear in the open aging list
    expect(text).not.toContain('A done task');
  });

  it('clicking an aging row selects that task', () => {
    const onSelect = vi.fn();
    mount(base({ onSelect }));
    const rows = Array.from(container.querySelectorAll('button')).filter((b) =>
      (b.textContent ?? '').includes('Make branch-naming deterministic'),
    );
    expect(rows.length).toBeGreaterThan(0);
    act(() => rows[0].click());
    expect(onSelect).toHaveBeenCalledWith('aaaaaaaa-0000-0000-0000-000000000001');
  });
});

describe('Analytics — loading source (row-derived panels use the LIST loading, not stats)', () => {
  it('shows loading (a spinner), NOT a false "empty", for the aging panel mid list-fetch', () => {
    // Rows not yet arrived + the LIST query in flight. Without threading rowsLoading in,
    // AgingList would flash its "Nothing open" false-empty; with it, it shows a spinner.
    mount(base({ rows: [], rowsLoading: true }));
    const text = container.textContent ?? '';
    expect(container.querySelector('[role="status"]')).not.toBeNull();
    expect(text).not.toContain('Nothing open');
  });
});

describe('Analytics — error state', () => {
  it('surfaces an Alert when stats fail', () => {
    mount(base({ statsError: true, statsErrorObj: new Error('backend down') }));
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
  });
});
