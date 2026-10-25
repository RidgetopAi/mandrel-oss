/**
 * Tasks render tests (P2 live-thread rebuild) — mirrors the Contexts test style:
 * createRoot + async act into jsdom, behind QueryClientProvider + MemoryRouter, with the
 * UNIFIED `api` client mocked. Proves the required states (data / loading / empty / error),
 * the board grouping by REAL status, card render (type/priority/assignee), the Board↔List
 * toggle, the progress ops bar from real stats, and — critically — the TYPED build-story
 * box built from REAL graph edges (the moat), plus the honest data-gap states (live-build
 * feed not wired; analytics is its own screen). Structural wiring (no antd, unified client,
 * typed-not-dependencies, no hex) is asserted in Tasks.wiring.test.ts.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

vi.mock('../api', () => ({
  api: {
    tasks: {
      list: vi.fn(),
      stats: vi.fn(),
      get: vi.fn(),
      links: vi.fn(),
      update: vi.fn(),
      leadTime: vi.fn(),
      throughput: vi.fn(),
      completedByActor: vi.fn(),
    },
    projects: {
      list: vi.fn(),
    },
  },
}));

/**
 * PAGE PROJECT (page-scope epic). The page owns its project now — there is no global
 * selector to follow. These render tests need SOME concrete project so the reads are
 * enabled (`scope()` throws rather than silently sending unscoped), so a single fixture
 * project is provided and is BOTH the user's default and the only selectable one. The
 * dedicated scoping cases — page project vs ambient default, `?project=`, the mutation
 * probes — live in Tasks.scope.test.tsx, deliberately not duplicated here.
 */
const TEST_PROJECT = { id: 'f0f0f0f0-1111-4111-8111-f0f0f0f0f0f0', name: 'Test Project' };

vi.mock('../contexts/ProjectContext', () => ({
  useProjectContext: () => ({ setSelectedProjectId: () => undefined,
    currentProject: null,
    allProjects: [TEST_PROJECT],
    loading: false,
  }),
  useEffectiveProjectId: () => TEST_PROJECT.id,
}));
vi.mock('../hooks/useSettings', () => ({
  useSettings: () => ({ defaultProjectId: TEST_PROJECT.id }),
}));

import Tasks from './Tasks';
import { api } from '../api';

const mockApi = api as unknown as {
  tasks: {
    list: ReturnType<typeof vi.fn>;
    stats: ReturnType<typeof vi.fn>;
    get: ReturnType<typeof vi.fn>;
    links: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    leadTime: ReturnType<typeof vi.fn>;
    throughput: ReturnType<typeof vi.fn>;
    completedByActor: ReturnType<typeof vi.fn>;
  };
  projects: { list: ReturnType<typeof vi.fn> };
};

const NOW = new Date().toISOString();

const TASK_INPROG = {
  id: 'aaaaaaaa-1111-2222-3333-444444444444',
  project_id: 'p-coordinator',
  project_name: 'riverbend',
  title: 'Size-aware dispatch timeout',
  description: 'scale the budget',
  type: 'feature',
  status: 'in_progress',
  priority: 'high',
  assigned_to: 'builder',
  tags: ['runtime'],
  created_at: NOW,
  updated_at: NOW,
};
const TASK_TODO = {
  id: 'bbbbbbbb-1111-2222-3333-444444444444',
  project_id: 'p-coordinator',
  project_name: 'riverbend',
  title: 'Serialize actor on session read',
  description: 'analytics gap',
  type: 'refactor',
  status: 'todo',
  priority: 'low',
  tags: [],
  created_at: NOW,
  updated_at: NOW,
};
const TASK_BLOCKED = {
  id: 'cccccccc-1111-2222-3333-444444444444',
  project_id: 'p-coordinator',
  project_name: 'riverbend',
  title: 'Tenant isolation — blast-radius shrink',
  type: 'feature',
  status: 'blocked',
  priority: 'high',
  assigned_to: 'gate',
  tags: [],
  created_at: NOW,
  updated_at: NOW,
};
const TASK_DONE = {
  id: 'dddddddd-1111-2222-3333-444444444444',
  project_id: 'p-coordinator',
  project_name: 'riverbend',
  title: 'tick declares X-Actor-ID=tick to Mandrel',
  type: 'feature',
  status: 'completed',
  priority: 'medium',
  assigned_to: 'tick',
  tags: [],
  created_at: NOW,
  updated_at: NOW,
};

const ALL_TASKS = [TASK_INPROG, TASK_TODO, TASK_BLOCKED, TASK_DONE];

const LINKS = [
  {
    edgeType: 'decided_by',
    direction: 'outgoing',
    otherId: 'eeeeeeee-1111-2222-3333-444444444444',
    otherType: 'decision',
    otherTitle: 'Dispatch timeout scales with task size',
    otherKind: 'decision',
  },
  {
    edgeType: 'produced_outcome',
    direction: 'outgoing',
    otherId: 'ffffffff-1111-2222-3333-444444444444',
    otherType: 'context',
    otherTitle: 'Size-aware dispatch timeout shipped',
    otherKind: 'completion',
  },
];

const STATS = {
  total: 525,
  by_status: { completed: 399, in_progress: 5, blocked: 2, todo: 119 },
  by_priority: { high: 40, medium: 200, low: 285 },
  by_type: { feature: 300, refactor: 100, bug: 125 },
  completion_rate: 76,
};

const LEAD_TIME = {
  distribution: [{ leadTimeDays: 1, count: 3, label: '< 1 day' }],
  stats: { totalTasks: 42, averageLeadTime: 1.8, medianLeadTime: 1.2, p90LeadTime: 4.5 },
};

function setHappy() {
  mockApi.tasks.list.mockResolvedValue({ tasks: ALL_TASKS, total: ALL_TASKS.length });
  mockApi.tasks.stats.mockResolvedValue(STATS);
  mockApi.tasks.get.mockResolvedValue(TASK_INPROG);
  mockApi.tasks.links.mockResolvedValue(LINKS);
  mockApi.tasks.update.mockResolvedValue(TASK_INPROG);
  mockApi.tasks.leadTime.mockResolvedValue(LEAD_TIME);
  mockApi.tasks.throughput.mockResolvedValue([]);
  mockApi.tasks.completedByActor.mockResolvedValue([]);
  mockApi.projects.list.mockResolvedValue([{ id: 'p-coordinator', name: 'riverbend' }]);
}

let container: HTMLDivElement;
let root: Root;

function makeClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
}

// Render behind a real /tasks + /tasks/:id route pair so a deep-link path pre-selects a
// task and OPENS the CRUD drawer (edit mode) — the detail moved from the below-board panel
// into the drawer, so the build-story assertions land on the deep-linked drawer. Default
// '/tasks' leaves the drawer closed (board-only assertions).
async function mount(initialPath = '/tasks') {
  container = document.createElement('div');
  document.body.appendChild(container);
  const client = makeClient();
  await act(async () => {
    root = createRoot(container);
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[initialPath]}>
          <Routes>
            <Route path="/tasks" element={<Tasks />} />
            <Route path="/tasks/:id" element={<Tasks />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
}

async function settle() {
  for (let i = 0; i < 6; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await act(async () => {
      await Promise.resolve();
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

function typeInto(input: HTMLInputElement, value: string) {
  const proto = Object.getPrototypeOf(input);
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function toggleButton(label: string): HTMLButtonElement | null {
  const group = container.querySelector('[aria-label="View"]');
  const btns = Array.from(group?.querySelectorAll('button') ?? []) as HTMLButtonElement[];
  return btns.find((b) => (b.textContent ?? '').includes(label)) ?? null;
}

beforeEach(() => {
  vi.clearAllMocks();
  setHappy();
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
});

describe('Tasks — board data state', () => {
  it('renders all four status columns with card titles grouped by real status', async () => {
    await mount();
    await settle();
    const text = container.textContent ?? '';
    expect(text).toContain('To do');
    expect(text).toContain('In progress');
    expect(text).toContain('Blocked');
    expect(text).toContain('Done');
    // card titles from each status group
    expect(text).toContain('Size-aware dispatch timeout');
    expect(text).toContain('Serialize actor on session read');
    expect(text).toContain('Tenant isolation — blast-radius shrink');
    expect(text).toContain('tick declares X-Actor-ID=tick to Mandrel');
  });

  it('auto-selects the first in-progress task into the thread detail (fetched by id)', async () => {
    await mount();
    await settle();
    expect(mockApi.tasks.get).toHaveBeenCalledWith(TASK_INPROG.id);
    expect(mockApi.tasks.links).toHaveBeenCalledWith(TASK_INPROG.id);
  });

  it('renders the assignee actor chip on an assigned card', async () => {
    await mount();
    await settle();
    expect(container.textContent).toContain('builder'); // assignee of the in-progress task
  });
});

describe('Tasks — progress ops bar (real stats)', () => {
  it('wires the progress counts + percentage from stats (never fabricated)', async () => {
    await mount();
    await settle();
    const text = container.textContent ?? '';
    expect(text).toContain('399 / 525 · 76%'); // done / total · pct
    expect(text).toContain('Done 399');
    expect(text).toContain('To do 119');
  });

  it('shows the honest "building now" list from real in-progress tasks', async () => {
    await mount();
    await settle();
    expect(container.textContent).toContain('Building now');
    // in-progress task surfaced with its real assignee
    expect(container.textContent).toContain('builder');
  });
});

describe('Tasks — the typed build-story box (the moat)', () => {
  // The build story now lives INSIDE the task CRUD drawer (edit mode), which opens on the
  // /tasks/:id deep-link. The drawer renders through a portal to document.body, so these
  // assert on document.body — the moat is reused via <BuildStory>, not lost.
  it('renders REAL typed edges with their labels + target titles', async () => {
    await mount(`/tasks/${TASK_INPROG.id}`);
    await settle();
    const text = document.body.textContent ?? '';
    expect(text).toContain('Build story');
    expect(text).toContain('decided by'); // outgoing decided_by label
    expect(text).toContain('produced'); // outgoing produced_outcome label
    expect(text).toContain('Dispatch timeout scales with task size'); // real target title
    expect(text).toContain('Size-aware dispatch timeout shipped');
  });

  it('shows an honest empty state (no fabricated edges) when there are no typed edges', async () => {
    mockApi.tasks.links.mockResolvedValue([]);
    await mount(`/tasks/${TASK_INPROG.id}`);
    await settle();
    expect(document.body.textContent).toContain('No typed edges yet');
  });
});

describe('Tasks — Board/List toggle', () => {
  it('switches to the dense List view over the same tasks', async () => {
    await mount();
    await settle();
    const listBtn = toggleButton('List');
    expect(listBtn).not.toBeNull();
    await act(async () => {
      listBtn!.click();
    });
    await settle();
    const listbox = container.querySelector('[role="listbox"][aria-label="Tasks"]');
    expect(listbox).not.toBeNull();
    expect(container.textContent).toContain('Serialize actor on session read');
  });

  it('switches to the in-page Analytics view (real KPIs + range selector, not a new screen)', async () => {
    await mount();
    await settle();
    const anBtn = toggleButton('Analytics');
    await act(async () => {
      anBtn!.click();
    });
    await settle();
    const text = container.textContent ?? '';
    // Real live KPIs render from stats + lead-time (never fabricated).
    expect(text).toContain('Completion rate');
    expect(text).toContain('Avg cycle time');
    expect(text).toContain('Oldest open tasks');
    // The range selector is present (view-mode, same /tasks route).
    expect(container.querySelector('[aria-label="Range"]')).not.toBeNull();
    // It is NOT a separate screen — the old placeholder is gone.
    expect(text).not.toContain('Task analytics is its own screen');
    // Lead-time endpoint is queried only on this view.
    expect(mockApi.tasks.leadTime).toHaveBeenCalled();
  });
});

describe('Tasks — search', () => {
  it('filters the loaded tasks client-side by the typed term', async () => {
    await mount();
    await settle();
    const input = container.querySelector('input[aria-label="Search tasks"]') as HTMLInputElement;
    expect(input).not.toBeNull();
    await act(async () => {
      typeInto(input, 'isolation');
    });
    await settle();
    const text = container.textContent ?? '';
    expect(text).toContain('Tenant isolation — blast-radius shrink');
    expect(text).not.toContain('Serialize actor on session read');
  });
});

describe('Tasks — loading state', () => {
  it('shows a spinner while the list query is in flight', async () => {
    mockApi.tasks.list.mockImplementation(() => new Promise(() => {}));
    mockApi.tasks.stats.mockImplementation(() => new Promise(() => {}));
    await mount();
    expect(container.querySelector('[role="status"]')).not.toBeNull();
  });
});

describe('Tasks — empty state', () => {
  it('shows Empty when there are no tasks', async () => {
    // The Board's own empty gate reads the REAL, uncapped `/tasks/stats` total (an earlier task
    // — PER-COLUMN PAGING), not any one column's fetch, so BOTH must agree the
    // project is empty. `list` still empties out too, matching what a genuinely empty
    // project's shared read would return.
    mockApi.tasks.list.mockResolvedValue({ tasks: [], total: 0 });
    mockApi.tasks.stats.mockResolvedValue({ ...STATS, total: 0, by_status: {} });
    await mount();
    await settle();
    expect(container.textContent).toContain('No tasks');
  });
});

describe('Tasks — error state', () => {
  it('surfaces a page-level Alert when the stats query fails (the Board\'s own gate)', async () => {
    mockApi.tasks.stats.mockImplementation(() => Promise.reject(new Error('backend down')));
    await mount();
    await settle();
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
  });

  it('a single column surfaces its OWN inline error without blanking the rest of the board', async () => {
    mockApi.tasks.list.mockImplementation(() => Promise.reject(new Error('backend down')));
    await mount();
    await settle();
    // The page-level gate (stats) is still happy, so the board itself renders — each
    // column's OWN per-column read is what failed, and says so inline (the real error
    // message, via `apiErrorMessage`).
    expect(container.textContent).toContain('backend down');
  });
});
