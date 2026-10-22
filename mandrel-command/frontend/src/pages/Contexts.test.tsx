/**
 * Contexts page tests (rail + reader — the Decisions shape). createRoot +
 * async act into jsdom, behind QueryClientProvider + MemoryRouter, with the UNIFIED `api`
 * client mocked. Proves: the list RAIL, the required states (loading / empty / error), the
 * LIVE facet counts, that the rail auto-selects the first row into the reader, and — via the
 * /contexts/:id DEEP-LINK — that the reader lands on THAT record (the permalink target Operator
 * shares publicly), renders the markdown body, and shows the TYPED thread box built from REAL
 * graph edges (the moat), including its honest empty state. Detail action wiring (delete
 * mutation-check, edit, share, related, metadata) is covered in
 * pages/contexts/ContextDetail.test.tsx.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useProjectSelectionStore, resetProjectSelection } from '../stores/projectSelectionStore';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { CONTEXTS_CONFIG } from './contexts/config';
import { DECISIONS_CONFIG } from './decisions/config';

vi.mock('../api', () => ({
  api: {
    contexts: {
      search: vi.fn(),
      stats: vi.fn(),
      get: vi.fn(),
      links: vi.fn(),
      related: vi.fn(),
      update: vi.fn(),
      remove: vi.fn(),
    },
  },
}));

/**
 * PAGE PROJECT (epic 41293984). The page owns its project now — there is no global
 * selector to follow, and no "All Projects" option on this screen. `projectState.projects`
 * is MUTABLE per test so the genuine no-project state (an instance with no projects at
 * all) can be exercised; the default is one concrete project, which is what every render
 * test needs since `scope()` throws rather than sending an unscoped request.
 *
 * The dedicated scoping cases — page project vs ambient default, `?project=`, the mutation
 * probes — live in Contexts.scope.test.tsx.
 */
const PAGE_PROJECT = { id: 'aaaaaaaa-0000-4000-8000-aaaaaaaa0001', name: 'riverbend' };
const projectState = vi.hoisted(() => ({
  projects: [] as { id: string; name: string }[],
  defaultProjectId: undefined as string | undefined,
}));
vi.mock('../contexts/ProjectContext', async () => {
  // The REAL selection store behind the mocked context, so a test can move THE switch
  // (`useProjectSelectionStore.getState().select(id)`) and the page re-renders.
  const { useProjectSelectionStore } = await import('../stores/projectSelectionStore');
  return {
  useProjectContext: () => ({
    selectedProjectId: useProjectSelectionStore((st) => st.selectedProjectId),
    setSelectedProjectId: useProjectSelectionStore.getState().select,
    currentProject: null,
    allProjects: projectState.projects,
    loading: false,
  }),
  useEffectiveProjectId: () => projectState.defaultProjectId,
  };
});
vi.mock('../hooks/useSettings', () => ({
  useSettings: () => ({ defaultProjectId: projectState.defaultProjectId }),
}));

import Contexts from './Contexts';
import { api } from '../api';

const mockApi = api as unknown as {
  contexts: {
    search: ReturnType<typeof vi.fn>;
    stats: ReturnType<typeof vi.fn>;
    get: ReturnType<typeof vi.fn>;
    links: ReturnType<typeof vi.fn>;
    related: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    remove: ReturnType<typeof vi.fn>;
  };
};

const NOW = new Date().toISOString();

const CTX_A = {
  id: 'aaaaaaaa-1111-2222-3333-444444444444',
  project_id: 'p-coordinator',
  project_name: 'riverbend',
  context_type: 'milestone',
  type: 'milestone',
  content: 'Sessions screen mock LOCKED — live streams = actor × project\n\nmore body',
  tags: ['sessions-mock', 'command-redesign'],
  created_at: NOW,
  updated_at: NOW,
};
const CTX_B = {
  id: 'bbbbbbbb-1111-2222-3333-444444444444',
  project_id: 'p-coordinator',
  project_name: 'riverbend',
  context_type: 'decision',
  type: 'decision',
  content: 'Command redesign — visual design language LOCKED',
  tags: ['design-system'],
  created_at: NOW,
  updated_at: NOW,
};

const LINKS = [
  {
    edgeType: 'decided_by',
    direction: 'outgoing',
    otherId: 'dddddddd-1111-2222-3333-444444444444',
    otherType: 'decision',
    otherTitle: 'Sessions page — live stream = (actor × project) as a view',
    otherKind: 'decision',
  },
  {
    edgeType: 'informs',
    direction: 'outgoing',
    otherId: 'eeeeeeee-1111-2222-3333-444444444444',
    otherType: 'task',
    otherTitle: 'Serialize actor on session read',
    otherKind: 'task',
  },
];

const STATS = {
  total_contexts: 1028,
  by_type: { handoff: 42, decision: 41, milestone: 88, completion: 134 },
  by_project: {},
  recent_contexts: 10,
  total_projects: 6,
};

function setHappy() {
  mockApi.contexts.search.mockResolvedValue({
    contexts: [CTX_A, CTX_B],
    total: 45,
    limit: 60,
    offset: 0,
    page: 1,
  });
  mockApi.contexts.stats.mockResolvedValue(STATS);
  // Resolve BY ID — so a deep-link test proves the reader landed on the record the URL
  // asked for, not just "some record".
  mockApi.contexts.get.mockImplementation((id: string) =>
    Promise.resolve([CTX_A, CTX_B].find((c) => c.id === id)),
  );
  mockApi.contexts.links.mockResolvedValue(LINKS);
  mockApi.contexts.related.mockResolvedValue([]);
}

let container: HTMLDivElement;
let root: Root;

function makeClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
}

async function mount(initialPath = '/contexts') {
  container = document.createElement('div');
  document.body.appendChild(container);
  const client = makeClient();
  await act(async () => {
    root = createRoot(container);
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[initialPath]}>
          <Routes>
            <Route path="/contexts" element={<Contexts />} />
            <Route path="/contexts/:id" element={<Contexts />} />
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

beforeEach(() => {
  resetProjectSelection();
  vi.clearAllMocks();
  // Default: one concrete project, which is also the user's default. Every read is gated
  // on having one, so this is the baseline every render test needs.
  projectState.projects = [PAGE_PROJECT];
  projectState.defaultProjectId = PAGE_PROJECT.id;
  setHappy();
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
});

describe('Contexts — rail + reader (the initial view)', () => {
  it('renders the list rail (first-line titles) beside the reader', async () => {
    await mount('/contexts');
    await settle();
    const text = container.textContent ?? '';
    expect(text).toContain('Sessions screen mock LOCKED');
    expect(text).toContain('Command redesign — visual design language LOCKED');
  });

  it('reads ONE window (no pager) — the rail scrolls it', async () => {
    await mount('/contexts');
    await settle();
    // listLimit window, always offset 0: the grid's server-side pager is gone.
    // Asserted against the CONFIG, not a literal — restating the number here would be the
    // very drift an earlier decision is about (a second copy that silently disagrees).
    expect(mockApi.contexts.search).toHaveBeenCalledWith(
      expect.objectContaining({ limit: CONTEXTS_CONFIG.listLimit, offset: 0 }),
      // The second argument is the page's own request scope (epic 41293984); every read on
      // this screen carries it.
      expect.objectContaining({
        headers: expect.objectContaining({ 'X-Project-ID': PAGE_PROJECT.id }),
      }),
    );
    const pager = Array.from(container.querySelectorAll('button')).find(
      (b) => b.getAttribute('aria-label') === 'Next page',
    );
    expect(pager).toBeUndefined();
  });

  it('keeps its rail window in step with the Decisions ledger (cross-page contract)', () => {
    // Contexts and Decisions are the same rail+reader shape. The window
    // size is a contract between them, not a per-page preference — the widths and the scroll
    // cap already drifted for exactly this reason. If you intend them to differ, delete this
    // test deliberately; do not let them wander apart.
    expect(CONTEXTS_CONFIG.listLimit).toBe(DECISIONS_CONFIG.listLimit);
  });

  it('auto-selects the first row into the reader (no empty right column)', async () => {
    await mount('/contexts');
    await settle();
    expect(mockApi.contexts.get).toHaveBeenCalledWith(CTX_A.id);
  });

  it('wires LIVE facet counts from stats (never fabricated)', async () => {
    await mount('/contexts');
    await settle();
    const text = container.textContent ?? '';
    expect(text).toContain('1,028'); // total (toLocaleString)
    expect(text).toContain('88'); // milestone count from by_type
  });
});

describe('Contexts — deep link lands on the RIGHT record in the reader', () => {
  // This is the /r/:id permalink target (Operator shares these links publicly). The rail+reader
  // reversal must not regress it — so assert the reader shows the record the URL named, and
  // specifically NOT the first row it would otherwise auto-select.
  it('renders at /contexts/:id → the reader fetches + shows THAT record', async () => {
    await mount(`/contexts/${CTX_B.id}`);
    await settle();
    expect(mockApi.contexts.get).toHaveBeenCalledWith(CTX_B.id);
    expect(mockApi.contexts.get).not.toHaveBeenCalledWith(CTX_A.id);
    const text = container.textContent ?? '';
    expect(text).toContain('Command redesign — visual design language LOCKED'); // B's body
  });

  it('the reader renders inline (right column), not in a portal/overlay', async () => {
    await mount(`/contexts/${CTX_A.id}`);
    await settle();
    expect(container.textContent).toContain('Sessions screen mock LOCKED');
  });
});

describe('Contexts — the typed thread box (the moat) in the reader', () => {
  it('renders REAL typed edges with their labels + target titles', async () => {
    await mount(`/contexts/${CTX_A.id}`);
    await settle();
    const text = document.body.textContent ?? '';
    expect(mockApi.contexts.links).toHaveBeenCalledWith(CTX_A.id);
    expect(text).toContain('In thread');
    expect(text).toContain('decided by'); // outgoing decided_by label
    expect(text).toContain('informs'); // outgoing informs label
    expect(text).toContain('Serialize actor on session read'); // real target title
  });

  it('shows an honest empty state (no fabricated edges) when there are no typed edges', async () => {
    mockApi.contexts.links.mockResolvedValue([]);
    await mount(`/contexts/${CTX_A.id}`);
    await settle();
    expect(document.body.textContent).toContain('No typed edges yet');
  });
});

describe('Contexts — loading state', () => {
  it('shows a spinner while the list query is in flight', async () => {
    mockApi.contexts.search.mockImplementation(() => new Promise(() => {}));
    mockApi.contexts.stats.mockImplementation(() => new Promise(() => {}));
    await mount('/contexts');
    expect(container.querySelector('[role="status"]')).not.toBeNull();
  });
});

describe('Contexts — empty state', () => {
  it('shows Empty when there are no contexts', async () => {
    mockApi.contexts.search.mockResolvedValue({ contexts: [], total: 0, limit: 60, offset: 0, page: 1 });
    await mount('/contexts');
    await settle();
    expect(container.textContent).toContain('No contexts');
  });
});

describe('Contexts — error state', () => {
  it('surfaces an Alert when the list query fails', async () => {
    mockApi.contexts.search.mockImplementation(() => Promise.reject(new Error('backend down')));
    await mount('/contexts');
    await settle();
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
  });
});

describe('Contexts — search', () => {
  it('re-queries with the typed search term (semantic dispatch), scoped to the page project', async () => {
    // Search is project-scoped in the canonical engine. The page now guarantees a concrete
    // project, so this is the ONLY search path there is (an earlier task → epic 41293984).
    await mount('/contexts');
    await settle();
    const input = container.querySelector('input[aria-label="Search contexts"]') as HTMLInputElement;
    expect(input).not.toBeNull();
    await act(async () => {
      typeInto(input, 'live stream');
    });
    await settle();
    // The search NAMES the project — the whole point of an earlier task was that an
    // unscoped text search 400s. Present-and-correct, not merely "a request went out".
    expect(mockApi.contexts.search).toHaveBeenCalledWith(
      expect.objectContaining({ query: 'live stream', project_id: PAGE_PROJECT.id }),
      expect.objectContaining({
        headers: expect.objectContaining({ 'X-Project-ID': PAGE_PROJECT.id }),
      }),
    );
  });

  it('the "search under All Projects" dead end is UNREACHABLE — the page offers no such option', async () => {
    /**
     * HISTORY (an earlier task → epic 41293984). This test used to reproduce a real bug: with
     * the GLOBAL selector on "All Projects", typing a search fired /api/contexts?query=…,
     * which fails closed with a 400 that the UI rendered as a red "Couldn't load contexts"
     * toast. The fix at the time was a `needsProject` gate that suppressed the request and
     * showed a "Select a project to search" state.
     *
     * That gate is GONE, not because the bug was decided unimportant but because the state
     * that produced it can no longer be reached: this page's selector is built without the
     * All-projects entry, so there is no way to be searching with no project. Rather than
     * leave a branch nothing can enter, the guard now asserts the CONSTRUCTION — that the
     * option is absent — which is what actually makes the dead end unreachable. If someone
     * adds `allowAll` to this page's `usePageProject()` tomorrow, this goes red.
     */
    // an earlier Punch (walkthrough F2): the switch offers NO "All projects". A leftover
    // 'all' in the store is not a scope, so the page searches the default project — never
    // an unscoped search.
    useProjectSelectionStore.getState().select('all');
    await mount('/contexts');
    await settle();
    expect(container.querySelector('[aria-label="Project"]')).toBeNull();
    expect(mockApi.contexts.search).toHaveBeenCalled();
    const calls = mockApi.contexts.search.mock.calls as unknown[][];
    for (const call of calls) {
      expect(call[0]).toMatchObject({ project_id: PAGE_PROJECT.id });
      expect((call[1] as { headers?: Record<string, unknown> } | undefined)?.headers).toMatchObject({
        'X-Project-ID': PAGE_PROJECT.id,
      });
    }
  });

  it('with NO projects at all, it GUIDES rather than firing an unscoped read', async () => {
    // The one genuinely reachable no-project state that is left. `scope()` throws rather
    // than degrading to "send no header" — which several backend controllers read as EVERY
    // project — so the correct behaviour is that nothing is requested and the rail explains.
    projectState.projects = [];
    projectState.defaultProjectId = undefined;
    await mount('/contexts');
    await settle();
    expect(mockApi.contexts.search).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.textContent ?? '').toContain('No project selected');
  });
});
