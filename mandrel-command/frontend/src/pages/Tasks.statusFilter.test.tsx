/**
 * Tasks — List-view STATUS FILTER. Proves the three load-bearing behaviours:
 *   (a) the chip counts render from the UNCAPPED stats (`stats.by_status` + `total`), not the
 *       capped list;
 *   (b) selecting a specific status ENABLES a dedicated SERVER-SIDE filtered read — the
 *       `status` param reaches the transport (`api.tasks.list`) — and renders THAT query's
 *       rows (a set the shared capped list does not contain, so it can't be client-side
 *       filtering);
 *   (c) 'All' shows the unfiltered shared rows and sends NO `status` param.
 *
 * Same harness as Tasks.test.tsx (createRoot + async act into jsdom, behind
 * QueryClientProvider + MemoryRouter, unified `api` client mocked). The mock is the TRANSPORT
 * (`api.tasks.list`) — NOT the code under test (the Tasks page + useTaskList wiring) — so the
 * `status`-param assertion is mutation-sensitive: drop the `status` passthrough in
 * `useTaskList` and case (b) goes red.
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
    projects: { list: vi.fn() },
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

// The SHARED (unfiltered) list — a mixed set. Note: contains NO blocked task, so a blocked
// result rendered in the List view can ONLY have come from the server-side filtered read.
const SHARED_TASKS = [
  {
    id: 'aaaaaaaa-1111-2222-3333-444444444444',
    project_id: 'p-coordinator',
    title: 'Shared in-progress task',
    type: 'feature',
    status: 'in_progress',
    priority: 'high',
    assigned_to: 'builder',
    tags: [],
    created_at: NOW,
    updated_at: NOW,
  },
  {
    id: 'bbbbbbbb-1111-2222-3333-444444444444',
    project_id: 'p-coordinator',
    title: 'Shared todo task',
    type: 'refactor',
    status: 'todo',
    priority: 'low',
    tags: [],
    created_at: NOW,
    updated_at: NOW,
  },
];

// The dedicated BLOCKED result returned ONLY when the transport is called with status=blocked.
// Its title is absent from SHARED_TASKS, so seeing it in the List proves the server-side path.
const BLOCKED_TASKS = [
  {
    id: 'cccccccc-1111-2222-3333-444444444444',
    project_id: 'p-coordinator',
    title: 'Server-filtered blocked task',
    type: 'feature',
    status: 'blocked',
    priority: 'high',
    assigned_to: 'gate',
    tags: [],
    created_at: NOW,
    updated_at: NOW,
  },
];

// UNCAPPED stats — the chip-count source. Deliberately DIFFERENT from the shared list's shape
// (e.g. Done 399 dwarfs the 2 shared rows, Cancelled 12 has no shared row at all) so a chip
// count can only be reading stats.by_status, never counting the list.
const STATS = {
  total: 525,
  by_status: { todo: 119, in_progress: 5, blocked: 2, completed: 399, cancelled: 12 },
  by_priority: { high: 40, medium: 200, low: 285 },
  by_type: { feature: 300 },
  completion_rate: 76,
};

function setHappy() {
  mockApi.tasks.list.mockImplementation((params?: Record<string, unknown>) => {
    if (params?.status === 'blocked') {
      return Promise.resolve({ tasks: BLOCKED_TASKS, total: BLOCKED_TASKS.length });
    }
    return Promise.resolve({ tasks: SHARED_TASKS, total: SHARED_TASKS.length });
  });
  mockApi.tasks.stats.mockResolvedValue(STATS);
  mockApi.tasks.get.mockResolvedValue(SHARED_TASKS[0]);
  mockApi.tasks.links.mockResolvedValue([]);
  mockApi.tasks.update.mockResolvedValue(SHARED_TASKS[0]);
  mockApi.tasks.leadTime.mockResolvedValue({
    distribution: [],
    stats: { totalTasks: 0, averageLeadTime: 0, medianLeadTime: 0, p90LeadTime: 0 },
  });
  mockApi.tasks.throughput.mockResolvedValue([]);
  mockApi.tasks.completedByActor.mockResolvedValue([]);
  mockApi.projects.list.mockResolvedValue([{ id: 'p-coordinator', name: 'riverbend' }]);
}

let container: HTMLDivElement;
let root: Root;

function makeClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
}

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

/** A button in a named a11y group, matched by its (leading) text label. */
function groupButton(groupLabel: string, label: string): HTMLButtonElement | null {
  const group = container.querySelector(`[aria-label="${groupLabel}"]`);
  const btns = Array.from(group?.querySelectorAll('button') ?? []) as HTMLButtonElement[];
  return btns.find((b) => (b.textContent ?? '').startsWith(label)) ?? null;
}

async function clickView(label: string) {
  const btn = groupButton('View', label);
  await act(async () => {
    btn!.click();
  });
  await settle();
}

async function clickStatusChip(label: string) {
  const btn = groupButton('Filter by status', label);
  expect(btn).not.toBeNull();
  await act(async () => {
    btn!.click();
  });
  await settle();
}

/** Every `status` value passed to the transport across all list() calls. */
function statusParamsSeen(): unknown[] {
  return mockApi.tasks.list.mock.calls
    .map(([params]) => (params as Record<string, unknown> | undefined)?.status)
    .filter((s) => s !== undefined);
}

beforeEach(() => {
  vi.clearAllMocks();
  setHappy();
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
});

describe('Tasks List status filter — chip counts (from uncapped stats)', () => {
  it('renders each chip count from stats.by_status / total, not the list length', async () => {
    await mount();
    await settle();
    await clickView('List');

    const group = container.querySelector('[aria-label="Filter by status"]');
    expect(group).not.toBeNull();
    const chipText = group?.textContent ?? '';
    // All → stats.total; each status → stats.by_status[status]. These come from STATS, which
    // does NOT match the 2-row shared list — so they can only be reading stats.
    expect(chipText).toContain('All525');
    expect(chipText).toContain('To do119');
    expect(chipText).toContain('In progress5');
    expect(chipText).toContain('Blocked2');
    expect(chipText).toContain('Done399');
    expect(chipText).toContain('Cancelled12');
  });
});

describe('Tasks List status filter — selecting a status runs a server-side filtered read', () => {
  it('sends the status param to the transport and renders THAT query rows', async () => {
    await mount();
    await settle();
    await clickView('List');

    // The Board (mounted by default before this switch) runs its OWN per-column
    // server-side reads since an earlier task (PER-COLUMN PAGING) — including one for
    // `status:'blocked'`. That is unrelated to the List view's dedicated filtered read
    // this test is pinning, so clear those calls before checking it.
    mockApi.tasks.list.mockClear();

    // Before selecting: no status param has been sent (shared list only).
    expect(statusParamsSeen()).not.toContain('blocked');

    await clickStatusChip('Blocked');

    // The dedicated server-side read fired WITH the status param — and, since the
    // page-scope epic, with the page's own request scope as its second argument. Asserting BOTH
    // matters: a status-filtered read that forgot the scope would return the AMBIENT
    // project's blocked tasks under this page's heading, with nothing to show it had.
    expect(mockApi.tasks.list).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'blocked', project_id: TEST_PROJECT.id }),
      expect.objectContaining({
        headers: expect.objectContaining({ 'X-Project-ID': TEST_PROJECT.id }),
      }),
    );
    // ...and its rows (absent from the shared capped list) render.
    const listbox = container.querySelector('[role="listbox"][aria-label="Tasks"]');
    expect(listbox?.textContent).toContain('Server-filtered blocked task');
    // The selected chip is marked pressed.
    const blockedChip = groupButton('Filter by status', 'Blocked');
    expect(blockedChip?.getAttribute('aria-pressed')).toBe('true');
  });
});

describe('Tasks List status filter — All is unfiltered + sends no status param', () => {
  it('shows the shared rows and never sends a status param on All', async () => {
    await mount();
    await settle();
    await clickView('List');

    // Same reasoning as the sibling test above: clear the Board's own PER-COLUMN reads
    // before checking the List view's dedicated (unfired, on 'All') read.
    mockApi.tasks.list.mockClear();

    // The shared rows are shown...
    const listbox = container.querySelector('[role="listbox"][aria-label="Tasks"]');
    expect(listbox?.textContent).toContain('Shared todo task');
    // ...and NO list() call ever carried a status param while All is active.
    expect(statusParamsSeen()).toHaveLength(0);
    // The 'All' chip is the pressed one by default.
    const allChip = groupButton('Filter by status', 'All');
    expect(allChip?.getAttribute('aria-pressed')).toBe('true');
  });
});
