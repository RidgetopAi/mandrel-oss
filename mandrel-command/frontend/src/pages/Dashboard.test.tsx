/**
 * Dashboard render + SCOPE tests.
 *
 * ════════════════════════════════════════════════════════════════════════════════════
 *  WHAT CHANGED, AND WHY THE OLD ASSERTIONS WERE WRONG TO KEEP
 * ════════════════════════════════════════════════════════════════════════════════════
 * This suite used to assert `tasks.throughput` was called with `{ range: '30d' }` and NO
 * project, with the comment "Mandrel-wide → NO project_id". That assertion was true of the
 * code and false about the system: `/api/tasks/throughput`, `/api/dashboard/stats`,
 * `/api/sessions`, `/api/sessions/trends` and `/api/projects` all resolve a
 * `ProjectListScope` on the backend, so a request naming nothing is scoped by the ambient
 * `X-Project-ID` header — one project's numbers under a workspace-wide heading. The guard
 * was pinning the bug in place. It is rewritten, not deleted: every case it covered
 * (data / loading / empty / error / actor rollup) is still here, plus the scope cases.
 *
 * ── THE ANCHOR ───────────────────────────────────────────────────────────────────────
 * The default project is B. The page is pointed at A. Every assertion is that the outgoing
 * call NAMED A — not "did not name B", and not "named something". A request that names
 * nothing would satisfy a weaker assertion while being the exact defect. The strongest
 * form of this guard is not here: it is `backend/src/__tests__/insightPagesProjectScope.db.test.ts`,
 * which plants a row in a second project in real Postgres and asserts it is absent. This
 * suite covers the half that lives in the browser — that the page names its own selection
 * on every one of its six reads, and that changing the selector changes all six.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useProjectSelectionStore, resetProjectSelection } from '../stores/projectSelectionStore';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

/** A — what the page is pointed at. */
const PROJECT_A = 'aaaaaaaa-1111-4111-8111-111111111111';
/** B — the user's DEFAULT project, i.e. the ambient scope a forgotten request lands in. */
const PROJECT_B = 'bbbbbbbb-2222-4222-8222-222222222222';

vi.mock('../api', () => ({
  api: {
    dashboard: { stats: vi.fn() },
    // useDecisionCount reads the REAL corpus count from decisions.stats().total_decisions
    // — NOT decisions.search().total (page size), which showed only 1.
    decisions: { stats: vi.fn() },
    sessions: { trends: vi.fn(), list: vi.fn() },
    projects: { list: vi.fn() },
    tasks: { throughput: vi.fn() },
  },
}));
vi.mock('../contexts/AuthContext', () => ({
  useAuthContext: () => ({ user: { username: 'Operator' } }),
}));

// usePageProject's two inputs. Mocked at the module boundary (the same seam
// hooks/usePageProject.test.tsx uses) so the hook itself runs for real — the URL param
// handling, the default-project fallback and the validity check are all under test here,
// not stubbed.
const settings = vi.hoisted(() => ({ defaultProjectId: undefined as string | undefined }));
const projectList = vi.hoisted(() => ({ value: [] as Array<{ id: string; name: string }> }));
vi.mock('../contexts/ProjectContext', async () => {
  // The REAL selection store behind the mocked context, so a test can move THE switch
  // (`useProjectSelectionStore.getState().select(id)`) and the page re-renders.
  const { useProjectSelectionStore } = await import('../stores/projectSelectionStore');
  return {
  useProjectContext: () => ({
    selectedProjectId: useProjectSelectionStore((st) => st.selectedProjectId),
    setSelectedProjectId: useProjectSelectionStore.getState().select, allProjects: projectList.value, loading: false }),
  };
});
vi.mock('../hooks/useSettings', () => ({
  useSettings: () => ({ defaultProjectId: settings.defaultProjectId }),
}));

import Dashboard from './Dashboard';
import { api } from '../api';

const mockApi = api as unknown as {
  dashboard: { stats: ReturnType<typeof vi.fn> };
  decisions: { stats: ReturnType<typeof vi.fn> };
  sessions: { trends: ReturnType<typeof vi.fn>; list: ReturnType<typeof vi.fn> };
  projects: { list: ReturnType<typeof vi.fn> };
  tasks: { throughput: ReturnType<typeof vi.fn> };
};

const HAPPY_STATS = {
  contexts: 1028,
  projects: 6,
  activeTasks: 27,
  totalTasks: 399,
  recentActivity: { contextsThisWeek: 38, tasksCompletedThisWeek: 4 },
};
const HAPPY_TRENDS = [
  { date: '2026-07-10', total_contexts: 12, session_count: 2, total_tokens_used: 1000, total_tasks_created: 1 },
  { date: '2026-07-11', total_contexts: 18, session_count: 3, total_tokens_used: 2000, total_tasks_created: 2 },
];
// Rows for the "Sessions by actor" panel (serialise `actor`; null = unattributed).
// A `null` actor AND the mcp-server `anonymous` sentinel are the SAME "unattributed"
// thing — they must collapse into one group, never a separate "anonymous" row.
// Row `a1` deliberately keeps `contexts_created: 0` alongside a correct `context_count:
// 31` to pin the REGRESSION from if the rollup ever goes back to
// preferring the denormalized counter, the "31" assertion below goes RED instead of
// silently under-counting.
const HAPPY_BY_ACTOR = [
  { id: 'a1', actor: 'coordinator', project_name: 'riverbend', contexts_created: 0, context_count: 31, tasks_created: 5, task_count: 5, total_tokens: 184000, ended_at: null, last_activity_at: new Date().toISOString() },
  { id: 'a2', actor: null, project_name: 'daisy', contexts_created: 6, context_count: 6, tasks_created: 1, task_count: 1, total_tokens: '42000', ended_at: new Date().toISOString() },
  { id: 'a3', actor: 'anonymous', project_name: 'daisy', contexts_created: 4, context_count: 4, tasks_created: 0, task_count: 0, total_tokens: 8000, ended_at: new Date().toISOString() },
];
const HAPPY_PROJECTS = [
  { id: PROJECT_A, name: 'riverbend', status: 'active', context_count: 1028, session_count: 40, last_activity: new Date().toISOString() },
];
const HAPPY_THROUGHPUT = [
  { day: '2026-07-14', completed: 3, created: 5 },
  { day: '2026-07-15', completed: 7, created: 2 },
];

function setHappy() {
  mockApi.dashboard.stats.mockResolvedValue(HAPPY_STATS);
  mockApi.decisions.stats.mockResolvedValue({ total_decisions: 41 });
  mockApi.sessions.trends.mockResolvedValue(HAPPY_TRENDS);
  mockApi.sessions.list.mockResolvedValue(HAPPY_BY_ACTOR);
  mockApi.projects.list.mockResolvedValue(HAPPY_PROJECTS);
  mockApi.tasks.throughput.mockResolvedValue(HAPPY_THROUGHPUT);
}

let container: HTMLDivElement;
let root: Root;

function makeClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
}

async function mount(url = '/dashboard') {
  container = document.createElement('div');
  document.body.appendChild(container);
  const client = makeClient();
  await act(async () => {
    root = createRoot(container);
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[url]}>
          <Dashboard />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
}

/** Let the mocked queries resolve + dependent renders flush. */
async function settle() {
  for (let i = 0; i < 4; i++) {
    // eslint-disable-next-line no-await-in-loop
    await act(async () => {
      await Promise.resolve();
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

/**
 * THE SIX READS THIS PAGE MAKES, and the project each one actually named — read off the
 * `X-Project-ID` header that `usePageProject().scope()` produced.
 *
 * The header is the anchor, not the positional argument, for two reasons. It is what
 * `scope()` — the real shared primitive, NOT mocked here — actually puts on the request,
 * so this measures the bytes rather than the intent. And it is the ONE spelling common to
 * all six calls: three of them take a params object and three do not, so a params-based
 * assertion would silently cover only half the page.
 *
 * Derived once here rather than restated per test, so a card that stops naming its project
 * fails everywhere at once instead of in the one test someone remembered to update.
 */
function projectsNamed(): Record<string, unknown> {
  const last = (fn: ReturnType<typeof vi.fn>) => fn.mock.calls.at(-1) ?? [];
  const header = (args: unknown[]): unknown => {
    const config = args.find(
      (a) => typeof a === 'object' && a !== null && 'headers' in (a as object),
    ) as { headers?: Record<string, unknown> } | undefined;
    // `NOT_SCOPED` is deliberately distinct from `undefined`: an ABSENT header (nobody
    // called scope()) and a BLANKED one (`all`, an explicit chosen widening) are
    // different things, and collapsing them is exactly the bug — an omission is what the
    // ambient default silently fills in.
    if (!config?.headers || !('X-Project-ID' in config.headers)) return 'NOT_SCOPED';
    return config.headers['X-Project-ID'];
  };
  return {
    'dashboard.stats': header(last(mockApi.dashboard.stats)),
    'decisions.stats': header(last(mockApi.decisions.stats)),
    'sessions.trends': header(last(mockApi.sessions.trends)),
    'sessions.list': header(last(mockApi.sessions.list)),
    'tasks.throughput': header(last(mockApi.tasks.throughput)),
    'projects.list': header(last(mockApi.projects.list)),
  };
}

/** The `project_id`-style QUERY param each params-taking read sent (the `all` channel). */
function queryProjects(): Record<string, unknown> {
  const first = (fn: ReturnType<typeof vi.fn>) =>
    (fn.mock.calls.at(-1)?.[0] ?? {}) as Record<string, unknown>;
  return {
    'sessions.trends': first(mockApi.sessions.trends).projectId,
    'sessions.list': first(mockApi.sessions.list).project_id,
    'tasks.throughput': first(mockApi.tasks.throughput).project_id,
    'decisions.stats': mockApi.decisions.stats.mock.calls.at(-1)?.[0],
  };
}

/** Move THE switch (shell/ProjectSwitch writes the same store) to `id`. */
async function selectProject(id: string) {
  await act(async () => {
    useProjectSelectionStore.getState().select(id);
  });
  await settle();
}

beforeEach(() => {
  resetProjectSelection();
  vi.clearAllMocks();
  setHappy();
  // The DEFAULT is B. Nothing below points at B on purpose — so "named B" is always the
  // failure signature of a card that fell back to the ambient project.
  settings.defaultProjectId = PROJECT_B;
  projectList.value = [
    { id: PROJECT_A, name: 'riverbend' },
    { id: PROJECT_B, name: 'the default project' },
  ];
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
});

// ══════════════════════════════════════════════════════════════════════════════════════
//  SCOPE — the reason this page was rewritten
// ══════════════════════════════════════════════════════════════════════════════════════
describe('Dashboard — project scope', () => {
  it('renders NO project selector of its own — THE switch is in the shell', async () => {
    await mount();
    await settle();
    expect(container.querySelector('button[aria-label="Dashboard project"]')).toBeNull();
  });

  it('opens at the user DEFAULT project, and every one of its six reads names it', async () => {
    await mount();
    await settle();
    for (const [call, named] of Object.entries(projectsNamed())) {
      expect(named, `${call} did not name the default project`).toBe(PROJECT_B);
    }
  });

  it('honours ?project= — all six reads name A while the default is still B', async () => {
    await mount(`/dashboard?project=${PROJECT_A}`);
    await settle();
    for (const [call, named] of Object.entries(projectsNamed())) {
      expect(named, `${call} did not name the URL's project`).toBe(PROJECT_A);
      // The half that matters: it must not have quietly used the ambient default.
      expect(named, `${call} fell back to the ambient default`).not.toBe(PROJECT_B);
    }
  });

  it('CHANGING the switch re-reads every card with the new project', async () => {
    await mount();
    await settle();
    expect(projectsNamed()['dashboard.stats']).toBe(PROJECT_B);

    await selectProject(PROJECT_A);

    for (const [call, named] of Object.entries(projectsNamed())) {
      expect(named, `${call} kept the old project after the selector changed`).toBe(PROJECT_A);
    }
  });

  it("a leftover 'all' in the store is NOT a scope — every card keeps naming the default (F2)", async () => {
    await mount();
    await settle();
    await selectProject('all');
    for (const [call, named] of Object.entries(projectsNamed())) {
      expect(named, `${call} did not name the default project`).toBe(PROJECT_B);
    }
    for (const [call, named] of Object.entries(queryProjects())) {
      expect(named, `${call} sent 'all'`).not.toBe('all');
    }
  });

  it('names NOTHING and reads NOTHING while the project list is still resolving', async () => {
    // The empty population (C3). A page with no scope must not fire an unscoped read —
    // for an admin the backend reads that as every project.
    projectList.value = [];
    settings.defaultProjectId = undefined;
    await mount();
    await settle();
    expect(mockApi.dashboard.stats).not.toHaveBeenCalled();
    expect(mockApi.sessions.trends).not.toHaveBeenCalled();
    expect(mockApi.sessions.list).not.toHaveBeenCalled();
    expect(mockApi.tasks.throughput).not.toHaveBeenCalled();
    expect(mockApi.projects.list).not.toHaveBeenCalled();
    expect(mockApi.decisions.stats).not.toHaveBeenCalled();
  });

  it('no longer claims to be "Mandrel-wide" — the heading names the real scope', async () => {
    await mount(`/dashboard?project=${PROJECT_A}`);
    await settle();
    const text = container.textContent ?? '';
    expect(text).not.toContain('Mandrel-wide');
    expect(text).toContain('riverbend');
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════
//  THE FOUR REQUIRED STATES (carried over from the original suite)
// ══════════════════════════════════════════════════════════════════════════════════════
describe('Dashboard — data state', () => {
  it('renders the greeting with the user name', async () => {
    await mount();
    expect(container.textContent).toContain('Operator');
  });

  it('shows the real KPI values from the unified client', async () => {
    await mount();
    await settle();
    const text = container.textContent ?? '';
    expect(text).toContain('1,028'); // contexts
    expect(text).toContain('27'); // active tasks
    expect(text).toContain('41'); // decisions (decisions.stats total_decisions — real corpus count)
    expect(text).toContain('Projects');
  });

  it('renders the workspace activity chart card', async () => {
    await mount();
    await settle();
    expect(container.textContent).toContain('Contexts / day');
  });

  it('renders the Task throughput card under activity, scoped to the page', async () => {
    await mount();
    await settle();
    const text = container.textContent ?? '';
    expect(text).toContain('Task throughput');
    expect(text).toContain('Throughput vs created');
    expect(mockApi.tasks.throughput).toHaveBeenCalledWith(
      { range: '30d', project_id: PROJECT_B },
      expect.objectContaining({ headers: { 'X-Project-ID': PROJECT_B } }),
    );
  });

  it('renders recently active projects from real data', async () => {
    await mount();
    await settle();
    const text = container.textContent ?? '';
    expect(text).toContain('riverbend');
    expect(text).toContain('Recently active');
  });

  it('renders the "Sessions by actor" breakdown grouped by actor', async () => {
    await mount();
    await settle();
    const text = container.textContent ?? '';
    expect(text).toContain('Sessions by actor');
    expect(text).toContain('coordinator'); // attributed actor group
    expect(text).toContain('unattributed'); // null-actor group (never hidden)
    // 31 comes from `context_count`; the row's `contexts_created` is deliberately 0.
    expect(text).toContain('31');
  });

  it('merges the `anonymous` sentinel into the single unattributed group', async () => {
    await mount();
    await settle();
    const text = container.textContent ?? '';
    expect(text).not.toContain('anonymous');
    expect(text).toContain('unattributed');
    expect(text).toContain('10'); // null (6) + anonymous (4)
  });
});

describe('Dashboard — loading state', () => {
  it('shows a spinner while queries are in flight', async () => {
    const pending = () => new Promise(() => {});
    mockApi.dashboard.stats.mockImplementation(pending);
    mockApi.decisions.stats.mockImplementation(pending);
    mockApi.sessions.trends.mockImplementation(pending);
    mockApi.sessions.list.mockImplementation(pending);
    mockApi.projects.list.mockImplementation(pending);
    await mount();
    expect(container.querySelector('[role="status"]')).not.toBeNull();
  });
});

describe('Dashboard — empty state', () => {
  it('shows Empty panels when there is no data', async () => {
    mockApi.dashboard.stats.mockResolvedValue({ contexts: 0, projects: 0, activeTasks: 0, totalTasks: 0 });
    mockApi.decisions.stats.mockResolvedValue({ total_decisions: 0 });
    mockApi.sessions.trends.mockResolvedValue([]);
    mockApi.sessions.list.mockResolvedValue([]);
    mockApi.projects.list.mockResolvedValue([]);
    mockApi.tasks.throughput.mockResolvedValue([]);
    await mount();
    await settle();
    const text = container.textContent ?? '';
    expect(text).toContain('No projects yet');
    expect(text).toContain('No actor activity yet');
    expect(text).toContain('No activity in this window'); // honest empty throughput
  });
});

describe('Dashboard — error state', () => {
  it('surfaces an Alert when a query fails', async () => {
    const boom = () => Promise.reject(new Error('backend down'));
    mockApi.dashboard.stats.mockImplementation(boom);
    mockApi.decisions.stats.mockImplementation(boom);
    mockApi.sessions.trends.mockImplementation(boom);
    mockApi.sessions.list.mockImplementation(boom);
    mockApi.projects.list.mockImplementation(boom);
    await mount();
    await settle();
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
  });
});
