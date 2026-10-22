/**
 * Tasks page project-scoping (an earlier task → 7d68e918 → epic 41293984).
 *
 * ════════════════════════════════════════════════════════════════════════════════════
 *  WHAT CHANGED, AND WHY THIS FILE IS A REWRITE RATHER THAN AN EDIT
 * ════════════════════════════════════════════════════════════════════════════════════
 * The previous version of this guard asserted that the page followed the GLOBAL header
 * selector, and that no in-page selector existed. Both of those are now false by design
 *: the global selector is deleted, and every project-scoped page owns
 * its own selector, backed by the `?project=` URL param and opening at the user's default.
 *
 * More importantly, the old guard's anchor was the wrong one. It spied on the arguments
 * the PAGE handed its own data hooks — the app telling the test what it intended. That
 * cannot see the failure this design introduces:
 *
 *     page selector = A, ambient X-Project-ID = the user's default B.
 *
 * A read whose project rides only on the ambient header returns B's rows; a write with no
 * per-request scope is FILED in B. Nothing errors — both projects authorize. So this guard
 * moved one layer down, to the ARGUMENTS THE PAGE PUT ON THE OUTGOING REQUEST: the
 * `project_id` param and the `X-Project-ID` header config that `usePageProject().scope()`
 * produced. The hooks, `usePageProject`, `scopedRequestConfig` and the URL param are all
 * REAL here; only the network client is mocked.
 *
 * ── THE AMBIENT PROJECT IS DELIBERATELY DIFFERENT FROM THE PAGE'S ────────────────────
 * `defaultProjectId` is set to B in every test while the URL names A. That is what makes
 * "no project named" and "the wrong project named" two DISTINCT failures instead of one
 * indistinguishable blank. A guard where the page and the ambient agree cannot fail.
 *
 * ── WHAT THIS FILE DOES *NOT* PROVE ──────────────────────────────────────────────────
 * That the header actually scopes the response. It can't — that is a fact about Postgres
 * and the backend resolver, and asking a mocked client would be self-agreement. That half
 * is anchored on rows planted in a second project in the real database, in
 * backend/src/__tests__/pageScopedProjectScope.db.test.ts (read AND write direction, run
 * as admin so an unscoped read returns everything and a leak is visible).
 *
 * Harness: raw react-dom + React.act + MemoryRouter (this repo has NO @testing-library).
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useProjectSelectionStore, resetProjectSelection } from '../stores/projectSelectionStore';

/** The project the PAGE selects (via `?project=`). */
const PROJ_A = 'aaaaaaaa-1111-4111-8111-111111111111';
/** The user's DEFAULT — the ambient project a mis-scoped request would silently use. */
const PROJ_B = 'bbbbbbbb-2222-4222-8222-222222222222';

const state = vi.hoisted(() => ({
  defaultProjectId: undefined as string | undefined,
  projects: [] as { id: string; name: string }[],
  loading: false,
}));

vi.mock('../contexts/ProjectContext', async () => {
  // The REAL selection store behind the mocked context, so a test can move THE switch
  // (`useProjectSelectionStore.getState().select(id)`) and the page re-renders.
  const { useProjectSelectionStore } = await import('../stores/projectSelectionStore');
  return {
  useProjectContext: () => ({
    selectedProjectId: useProjectSelectionStore((st) => st.selectedProjectId),
    setSelectedProjectId: useProjectSelectionStore.getState().select,
    allProjects: state.projects,
    loading: state.loading,
    currentProject: null,
  }),
  useEffectiveProjectId: () => state.defaultProjectId,
  };
});
vi.mock('../hooks/useSettings', () => ({
  useSettings: () => ({ defaultProjectId: state.defaultProjectId }),
}));

vi.mock('../api', () => ({
  api: {
    tasks: {
      list: vi.fn(),
      stats: vi.fn(),
      leadTime: vi.fn(),
      throughput: vi.fn(),
      completedByActor: vi.fn(),
      get: vi.fn(),
      links: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      remove: vi.fn(),
      restore: vi.fn(),
    },
    resolve: { record: vi.fn() },
  },
}));

import Tasks from './Tasks';
import { api } from '../api';
import { apiConfig } from '../config/apiConfig';

const mockApi = api as unknown as {
  tasks: Record<string, ReturnType<typeof vi.fn>>;
  resolve: { record: ReturnType<typeof vi.fn> };
};

let container: HTMLDivElement;
let root: Root;
let client: QueryClient;

async function render(url: string) {
  container = document.createElement('div');
  document.body.appendChild(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  await act(async () => {
    root = createRoot(container);
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[url]}>
          <Tasks />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  await settle();
}

async function settle() {
  for (let i = 0; i < 5; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await act(async () => {
      await Promise.resolve();
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

/** The `X-Project-ID` a call carried, read off the axios config the page built. */
function headerOf(call: unknown[] | undefined): unknown {
  const config = call?.[1] as { headers?: Record<string, unknown> } | undefined;
  return config?.headers?.[apiConfig.projectHeader];
}

const lastCall = (fn: ReturnType<typeof vi.fn>) =>
  fn.mock.calls.length ? fn.mock.calls[fn.mock.calls.length - 1] : undefined;

beforeEach(() => {
  resetProjectSelection();
  vi.clearAllMocks();
  // THE AMBIENT DEFAULT IS B. Every test below points the page at A.
  state.defaultProjectId = PROJ_B;
  state.loading = false;
  state.projects = [
    { id: PROJ_A, name: 'Project A' },
    { id: PROJ_B, name: 'Project B (default)' },
  ];
  mockApi.tasks.list.mockResolvedValue({ tasks: [], total: 0 });
  mockApi.tasks.stats.mockResolvedValue({
    total: 0,
    by_status: {},
    by_priority: {},
    by_type: {},
  });
  mockApi.tasks.leadTime.mockResolvedValue({
    distribution: [],
    stats: { totalTasks: 0, averageLeadTime: 0, medianLeadTime: 0, p90LeadTime: 0 },
  });
  mockApi.tasks.throughput.mockResolvedValue([]);
  mockApi.tasks.completedByActor.mockResolvedValue([]);
  mockApi.tasks.get.mockResolvedValue({ id: 'none' });
  mockApi.tasks.links.mockResolvedValue([]);
  mockApi.resolve.record.mockResolvedValue({ status: 'notfound' });
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
});

describe('Tasks — the page owns its project (epic 41293984)', () => {
  it('renders NO project selector of its own — THE switch is in the shell', async () => {
    await render(`/tasks?project=${PROJ_A}`);
    expect(container.querySelector('[aria-label="Project"]')).toBeNull();
    // The search box is unchanged.
    expect(container.querySelector('[aria-label="Search tasks"]')).not.toBeNull();
  });

  it('opens at the USER DEFAULT when the URL names no project', async () => {
    await render('/tasks');
    expect(lastCall(mockApi.tasks.list)?.[0]).toMatchObject({ project_id: PROJ_B });
  });

  it('honours `?project=` over the user default — the URL is the source of truth', async () => {
    await render(`/tasks?project=${PROJ_A}`);
    expect(lastCall(mockApi.tasks.list)?.[0]).toMatchObject({ project_id: PROJ_A });
  });

  it('names the page project in the query param AND the request scope, not merely "not B"', async () => {
    await render(`/tasks?project=${PROJ_A}`);
    const call = lastCall(mockApi.tasks.list);
    // Present-and-correct, not merely not-wrong: a request that named NOTHING would also
    // satisfy "did not name B", and several backend controllers read that as EVERY project.
    expect(call?.[0]).toMatchObject({ project_id: PROJ_A });
    expect(headerOf(call)).toBe(PROJ_A);
    expect(headerOf(call)).not.toBe(PROJ_B);
  });

  it('scopes the STATS read too (it takes no project query param — the header IS its scope)', async () => {
    await render(`/tasks?project=${PROJ_A}`);
    const call = lastCall(mockApi.tasks.stats);
    expect(call?.[0]).toMatchObject({ project_id: PROJ_A });
    expect(headerOf(call)).toBe(PROJ_A);
  });

  it('scopes the ANALYTICS reads (Tasks.tsx:122-124 inherits the same project)', async () => {
    await render(`/tasks?project=${PROJ_A}`);
    // Analytics reads are gated on the Analytics view; switch to it.
    const analyticsBtn = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent?.trim().toLowerCase() === 'analytics',
    );
    expect(analyticsBtn).toBeDefined();
    await act(async () => {
      analyticsBtn!.click();
    });
    await settle();

    for (const fn of [
      mockApi.tasks.leadTime,
      mockApi.tasks.throughput,
      mockApi.tasks.completedByActor,
    ]) {
      const call = lastCall(fn);
      expect(call?.[0]).toMatchObject({ project_id: PROJ_A });
      expect(headerOf(call)).toBe(PROJ_A);
    }
  });

  it('a SWITCH change re-reads with the NEW project in both param and scope', async () => {
    useProjectSelectionStore.getState().select(PROJ_A);
    await render('/tasks');
    expect(headerOf(lastCall(mockApi.tasks.list))).toBe(PROJ_A);
    await act(async () => {
      useProjectSelectionStore.getState().select(PROJ_B);
    });
    await settle();

    const call = lastCall(mockApi.tasks.list);
    expect(call?.[0]).toMatchObject({ project_id: PROJ_B });
    expect(headerOf(call)).toBe(PROJ_B);
  });
});

describe('Tasks — MUTATION probes (a guard that cannot go red is not a guard)', () => {
  it('with NO project resolvable at all, the page sends NOTHING rather than an unscoped read', async () => {
    // The §A2 population: no default, no projects. `scope()` throws instead of degrading
    // to "omit the header", which several controllers read as EVERY project — so the
    // correct behaviour is that the read never fires.
    state.defaultProjectId = undefined;
    state.projects = [];
    await render('/tasks');
    expect(mockApi.tasks.list).not.toHaveBeenCalled();
    expect(mockApi.tasks.stats).not.toHaveBeenCalled();
  });

  it('a `?project=` naming a project the user cannot select is IGNORED, not sent', async () => {
    // A stale or hand-typed id would 403 under the backend's F-04 access check on every
    // request, wedging the page with an error the user cannot act on.
    await render('/tasks?project=cccccccc-3333-4333-8333-333333333333');
    const call = lastCall(mockApi.tasks.list);
    expect(call?.[0]).toMatchObject({ project_id: PROJ_B });
    expect(headerOf(call)).toBe(PROJ_B);
  });
});
