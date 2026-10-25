/**
 * Tasks — the ARCHIVED (soft-delete) view.
 *
 * Delete is now a SOFT delete: the backend sets `archived_at` instead of destroying the
 * row, and hides archived rows from every default read. That makes the Archived chip the
 * ONLY way a user can reach a deleted task — so these are the load-bearing behaviours:
 *
 *   (a) the Archived chip's count comes from `stats.archived`, the SEPARATE uncapped
 *       count. Reading it from `by_status` (which is live-only) would render 0 forever;
 *   (b) selecting Archived sends `archived: 'only'` to the transport and NO `status`
 *       param — it is a scope, not a status — and renders THAT query's rows;
 *   (c) no other chip ever sends an `archived` param, so the ordinary board/list reads
 *       are byte-identical to what they always were.
 *
 * Harness mirrors Tasks.statusFilter.test.tsx exactly. The mock is the TRANSPORT
 * (`api.tasks.list`/`stats`), never the code under test, so dropping the `archived`
 * passthrough in `useTaskList` — or pointing the chip count at `by_status` — turns these
 * red.
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
  tasks: Record<string, ReturnType<typeof vi.fn>>;
  projects: { list: ReturnType<typeof vi.fn> };
};

const NOW = new Date().toISOString();

/** The LIVE list — nothing archived here, by construction. */
const LIVE_TASKS = [
  {
    id: 'aaaaaaaa-1111-2222-3333-444444444444',
    project_id: 'p-coordinator',
    title: 'Live in-progress task',
    type: 'feature',
    status: 'in_progress',
    priority: 'high',
    tags: [],
    created_at: NOW,
    updated_at: NOW,
    archived_at: null,
  },
];

/**
 * Returned ONLY when the transport is called with `archived: 'only'`. Its title appears
 * nowhere in LIVE_TASKS, so seeing it in the List proves the dedicated archived read ran —
 * it cannot be a client-side filter over the shared rows.
 */
const ARCHIVED_TASKS = [
  {
    id: 'dddddddd-1111-2222-3333-444444444444',
    project_id: 'p-coordinator',
    title: 'Soft-deleted task in the archive',
    type: 'bug',
    status: 'todo',
    priority: 'medium',
    tags: [],
    created_at: NOW,
    updated_at: NOW,
    archived_at: NOW,
  },
];

/**
 * `archived: 7` is deliberately unlike every by_status number AND unlike the 1-row
 * archived list, so the chip count can only be reading `stats.archived`.
 */
const STATS = {
  total: 525,
  by_status: { todo: 119, in_progress: 5, blocked: 2, completed: 399, cancelled: 12 },
  by_priority: { high: 40, medium: 200, low: 285 },
  by_type: { feature: 300 },
  completion_rate: 76,
  archived: 7,
};

function setHappy() {
  mockApi.tasks.list.mockImplementation((params?: Record<string, unknown>) => {
    if (params?.archived === 'only') {
      return Promise.resolve({ tasks: ARCHIVED_TASKS, total: ARCHIVED_TASKS.length });
    }
    return Promise.resolve({ tasks: LIVE_TASKS, total: LIVE_TASKS.length });
  });
  mockApi.tasks.stats.mockResolvedValue(STATS);
  mockApi.tasks.get.mockResolvedValue(LIVE_TASKS[0]);
  mockApi.tasks.links.mockResolvedValue([]);
  mockApi.tasks.update.mockResolvedValue(LIVE_TASKS[0]);
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

async function mount() {
  container = document.createElement('div');
  document.body.appendChild(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  await act(async () => {
    root = createRoot(container);
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={['/tasks']}>
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

function groupButton(groupLabel: string, label: string): HTMLButtonElement | null {
  const group = container.querySelector(`[aria-label="${groupLabel}"]`);
  const btns = Array.from(group?.querySelectorAll('button') ?? []) as HTMLButtonElement[];
  return btns.find((b) => (b.textContent ?? '').startsWith(label)) ?? null;
}

async function clickGroupButton(groupLabel: string, label: string) {
  const btn = groupButton(groupLabel, label);
  expect(btn).not.toBeNull();
  await act(async () => {
    btn!.click();
  });
  await settle();
}

/** Every `archived` value passed to the transport across all list() calls. */
const archivedParamsSeen = () =>
  mockApi.tasks.list.mock.calls
    .map(([params]) => (params as Record<string, unknown> | undefined)?.archived)
    .filter((a) => a !== undefined);

beforeEach(() => {
  vi.clearAllMocks();
  setHappy();
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
});

describe('Tasks List — the Archived chip', () => {
  it('exists, and its count comes from stats.archived (not by_status, which is live-only)', async () => {
    await mount();
    await settle();
    await clickGroupButton('View', 'List');

    const group = container.querySelector('[aria-label="Filter by status"]');
    expect(group).not.toBeNull();
    // 7 is `stats.archived`. It matches no by_status value and no list length here, so a
    // green can only come from reading the dedicated archived count.
    expect(group?.textContent).toContain('Archived7');
  });

  it('selecting Archived sends archived:"only" (and NO status) and renders those rows', async () => {
    await mount();
    await settle();
    await clickGroupButton('View', 'List');

    // POSITIVE CONTROL: the live rows are what is on screen, and nothing has asked for
    // the archive yet.
    let listbox = container.querySelector('[role="listbox"][aria-label="Tasks"]');
    expect(listbox?.textContent).toContain('Live in-progress task');
    expect(archivedParamsSeen()).toHaveLength(0);

    await clickGroupButton('Filter by status', 'Archived');

    // The dedicated archived read fired — as a SCOPE, carrying no status param — and with
    // the page's own project scope as its second argument (page-scope epic). Without that,
    // the Archived view would list the AMBIENT project's deleted tasks.
    expect(mockApi.tasks.list).toHaveBeenCalledWith(
      expect.objectContaining({ archived: 'only', project_id: TEST_PROJECT.id }),
      expect.objectContaining({
        headers: expect.objectContaining({ 'X-Project-ID': TEST_PROJECT.id }),
      }),
    );
    const archivedCall = mockApi.tasks.list.mock.calls
      .map(([p]) => p as Record<string, unknown>)
      .find((p) => p?.archived === 'only');
    expect(archivedCall).toBeDefined();
    expect(archivedCall?.status).toBeUndefined();

    // ...and the soft-deleted row — absent from the live list — is now reachable.
    listbox = container.querySelector('[role="listbox"][aria-label="Tasks"]');
    expect(listbox?.textContent).toContain('Soft-deleted task in the archive');

    expect(groupButton('Filter by status', 'Archived')?.getAttribute('aria-pressed')).toBe(
      'true',
    );
  });

  it('no ordinary chip ever sends an archived param (default reads are unchanged)', async () => {
    await mount();
    await settle();
    await clickGroupButton('View', 'List');

    for (const label of ['To do', 'In progress', 'Blocked', 'Done', 'Cancelled', 'All']) {
      // eslint-disable-next-line no-await-in-loop
      await clickGroupButton('Filter by status', label);
    }

    expect(archivedParamsSeen()).toHaveLength(0);
  });
});
