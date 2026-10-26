/**
 * Sessions render tests (P1 screen rebuild) — mirrors the Dashboard test style:
 * createRoot + async act into jsdom, behind QueryClientProvider + MemoryRouter,
 * with the UNIFIED `api` client mocked. Proves the four required states
 * (data / loading / empty / error), the Live-now vs Earlier grouping, the expanded
 * timeline, the search-filter behaviour, and — new with an earlier epic — the page's own
 * PROJECT SCOPE. Structural wiring (no antd, unified client, no hex) is asserted in
 * Sessions.wiring.test.ts.
 *
 * ── WHAT CHANGED, AND WHAT THE SCOPE ASSERTIONS ARE ANCHORED ON ──────────────────────
 * The page used to open on 'all' and filter by project CLIENT-SIDE. It now opens on the
 * user's DEFAULT project and names that project in the REQUEST. So "which project is this
 * screen showing" stopped being a rendering question and became a wire question, and the
 * assertions follow it there: they read the params AND the `X-Project-ID` the outgoing
 * request would actually carry, after the real axios request interceptor has run.
 *
 * That last part matters. Reading the config the page produced would let a page that
 * forgot to scope itself still pass, because the ambient interceptor would fill in the
 * DEFAULT project and the response would look right. Running it through the real
 * interceptor makes "named nothing" and "named the wrong project" both visible — the
 * ambient value in localStorage below is deliberately a DIFFERENT project from the one the
 * page is showing, so a silent fallback cannot masquerade as a pass.
 *
 * The real anchor for scope correctness is a row planted in a second project in the real
 * database: `backend/src/__tests__/pageScopedProjectScope.db.test.ts`. This file guards the
 * half that lives in the browser — that the page ASKS for the right project.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useProjectSelectionStore, resetProjectSelection } from '../stores/projectSelectionStore';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { Project } from '../types/project';

vi.mock('../api', () => ({
  api: {
    sessions: { list: vi.fn(), get: vi.fn(), update: vi.fn(), start: vi.fn() },
  },
}));

/** The project the page shows. */
const PROJECT_A: Project = {
  id: 'aaaaaaaa-1111-4111-8111-111111111111',
  name: 'riverbend',
} as Project;
/** The user's DEFAULT project — also the ambient header. A mis-scoped read lands here. */
const PROJECT_B: Project = {
  id: 'bbbbbbbb-2222-4222-8222-222222222222',
  name: 'daisy',
} as Project;

const settings = vi.hoisted(() => ({ defaultProjectId: undefined as string | undefined }));
const projectList = vi.hoisted(() => ({
  value: [] as Array<{ id: string; name: string }>,
  unavailable: false,
}));
vi.mock('../contexts/ProjectContext', async () => {
  // The REAL selection store behind the mocked context, so a test can move THE switch
  // (`useProjectSelectionStore.getState().select(id)`) and the page re-renders.
  const { useProjectSelectionStore } = await import('../stores/projectSelectionStore');
  return {
  useProjectContext: () => ({
    selectedProjectId: useProjectSelectionStore((st) => st.selectedProjectId),
    setSelectedProjectId: useProjectSelectionStore.getState().select,
    allProjects: projectList.value,
    loading: false,
    projectsUnavailable: projectList.unavailable,
  }),
  };
});
vi.mock('../hooks/useSettings', () => ({
  useSettings: () => ({ defaultProjectId: settings.defaultProjectId }),
}));

import Sessions from './Sessions';
import { api } from '../api';
import { apiConfig } from '../config/apiConfig';
import { PROJECT_URL_PARAM } from '../hooks/usePageProject';

const mockApi = api as unknown as {
  sessions: {
    list: ReturnType<typeof vi.fn>;
    get: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    start: ReturnType<typeof vi.fn>;
  };
};

/**
 * Run a config the page produced through the REAL axios request interceptor and return the
 * `X-Project-ID` that would actually go on the wire. See the header for why this, and not
 * the raw config, is what the scope assertions read.
 */
async function headerOnTheWire(config: unknown): Promise<unknown> {
  const { apiClient } = await import('../services/api');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const instance = (apiClient as any).instance ?? (apiClient as any)._instance;
  const handlers = instance.interceptors.request.handlers.filter(Boolean);
  const cfg = (config ?? {}) as Record<string, unknown>;
  let out = { ...cfg, headers: { ...((cfg.headers as object) ?? {}) }, url: '/x', method: 'get' };
  for (const h of handlers) {
    // eslint-disable-next-line no-await-in-loop
    out = await h.fulfilled(out);
  }
  return (out.headers as Record<string, unknown>)[apiConfig.projectHeader];
}

/** The (params, config) pair of the most recent `api.sessions.list` call. */
function lastListCall(): [Record<string, unknown>, unknown] {
  const calls = mockApi.sessions.list.mock.calls;
  expect(calls.length, 'the page should have requested the session list').toBeGreaterThan(0);
  return calls[calls.length - 1] as [Record<string, unknown>, unknown];
}

const NOW = new Date().toISOString();
const YESTERDAY = new Date(Date.now() - 1000 * 60 * 60 * 26).toISOString();

const LIVE_SESSION = {
  id: 'sess-live-0001',
  display_id: 'live-01',
  project_id: 'p-coordinator',
  project_name: 'riverbend',
  title: 'Live work',
  actor: 'tick',
  started_at: NOW,
  ended_at: null,
  last_activity_at: NOW,
  contexts_created: 23,
  tasks_created: 4,
  total_tokens: '142000',
  ai_model: 'Opus 4.8',
};
const ENDED_SESSION = {
  id: 'sess-ended-0002',
  display_id: 'ended-02',
  project_id: 'p-daisy',
  project_name: 'daisy',
  title: 'Old work',
  actor: null, // unstamped → the "unattributed" treatment
  started_at: YESTERDAY,
  ended_at: YESTERDAY,
  last_activity_at: YESTERDAY,
  contexts_created: 38,
  tasks_created: 6,
  total_tokens: '256000',
};

const HAPPY_DETAIL = {
  id: 'sess-live-0001',
  project_id: 'p-coordinator',
  project_name: 'riverbend',
  started_at: NOW,
  created_at: NOW,
  duration_minutes: 42,
  total_tokens: 142000,
  prompt_tokens: 0,
  completion_tokens: 0,
  contexts_created: 23,
  decisions_created: 2,
  tasks_created: 4,
  tasks_completed: 1,
  tasks_updated: 0,
  api_requests: 0,
  contexts: [
    { id: 'ctx-1', context_type: 'milestone', content: 'Dashboard mock LOCKED', created_at: NOW },
  ],
  decisions: [
    { id: 'dec-1', decision_type: 'design', title: 'Sessions live stream view', status: 'active', created_at: NOW },
  ],
  tasks: [{ id: 'task-1', title: 'Rebuild Sessions', type: 'feature', status: 'in_progress', priority: 'high', created_at: NOW }],
  code_components: [],
  commits_contributed: 1,
  linked_commits: [
    { id: 'c-1', commit_sha: 'df5fd78abc', short_sha: 'df5fd78', message: 'docs: mock', author_name: 'Coordinator', author_email: 'r@x', author_date: NOW, confidence_score: 1, link_type: 'auto', author_match: true },
  ],
  git_correlation_confidence: 1,
  productivity_score: 7,
  files_modified_count: 5,
  ai_model: 'Opus 4.8',
};

function setHappy() {
  mockApi.sessions.list.mockResolvedValue([LIVE_SESSION, ENDED_SESSION]);
  mockApi.sessions.get.mockResolvedValue(HAPPY_DETAIL);
}

let container: HTMLDivElement;
let root: Root;

function makeClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
}

async function mount(initialUrl = '/sessions') {
  container = document.createElement('div');
  document.body.appendChild(container);
  const client = makeClient();
  await act(async () => {
    root = createRoot(container);
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[initialUrl]}>
          <Sessions />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
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

/** Set a controlled <input> value the React-compatible way, then fire `input`. */
function typeInto(input: HTMLInputElement, value: string) {
  const proto = Object.getPrototypeOf(input);
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

/**
 * The stream cards' accordion headers, and only those: the toolbar Selects are also
 * `aria-expanded` buttons, so the bare attribute selector would let a closed dropdown
 * stand in for a collapsed card.
 */
function streamHeads(): HTMLButtonElement[] {
  return Array.from(
    container.querySelectorAll<HTMLButtonElement>(
      'button[aria-controls^="session-stream-body-"]',
    ),
  );
}

function click(el: Element) {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

beforeEach(() => {
  resetProjectSelection();
  vi.clearAllMocks();
  localStorage.clear();
  projectList.value = [
    { id: PROJECT_A.id, name: PROJECT_A.name },
    { id: PROJECT_B.id, name: PROJECT_B.name },
  ];
  projectList.unavailable = false;
  settings.defaultProjectId = PROJECT_B.id;
  // THE AMBIENT SCOPE IS B, DELIBERATELY — every scope assertion below is meaningful only
  // because a silent fallback would produce a DIFFERENT, visible answer.
  localStorage.setItem('aidis_selected_project', JSON.stringify({ id: PROJECT_B.id }));
  localStorage.setItem('aidis_current_project', JSON.stringify({ id: PROJECT_B.id }));
  setHappy();
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  localStorage.clear();
});

describe('Sessions — data state', () => {
  it('groups sessions into Live now and Earlier', async () => {
    await mount();
    await settle();
    const text = container.textContent ?? '';
    expect(text).toContain('Live now');
    expect(text).toContain('Earlier');
    expect(text).toContain('riverbend');
    expect(text).toContain('daisy');
  });

  /**
   * INTENT CHANGED, deliberately. This used to assert the first live card mounted
   * EXPANDED (`defaultOpen={i === 0}`) and rendered its timeline unprompted. The operator's
   * requirement is now the opposite: every card loads collapsed. The old assertion was
   * guarding real behaviour, so it is not weakened — it is inverted, and the timeline
   * half it also covered moved into the click case below so nothing stopped being tested.
   */
  it('mounts every card COLLAPSED and fetches no session detail', async () => {
    await mount();
    await settle();
    const heads = Array.from(streamHeads());
    expect(heads.length).toBeGreaterThan(0);
    expect(heads.map((h) => h.getAttribute('aria-expanded'))).toEqual(
      heads.map(() => 'false'),
    );
    expect(mockApi.sessions.get).not.toHaveBeenCalled();
    expect(container.textContent ?? '').not.toContain('Sessions live stream view');
  });

  it('expands a stream on click and renders its activity timeline', async () => {
    await mount();
    await settle();
    const head = streamHeads()[0];
    await act(async () => click(head));
    await settle();
    const text = container.textContent ?? '';
    expect(head.getAttribute('aria-expanded')).toBe('true');
    // detail-driven stat row + a merged timeline event
    expect(text).toContain('Decisions');
    expect(text).toContain('Sessions live stream view'); // decision title from detail
    expect(mockApi.sessions.get).toHaveBeenCalledWith('sess-live-0001');
  });
});

describe('Sessions — loading state', () => {
  it('shows a spinner while the list query is in flight', async () => {
    mockApi.sessions.list.mockImplementation(() => new Promise(() => {}));
    await mount();
    await settle();
    expect(container.querySelector('[role="status"]')).not.toBeNull();
  });
});

describe('Sessions — empty state', () => {
  it('shows Empty when there are no sessions', async () => {
    mockApi.sessions.list.mockResolvedValue([]);
    await mount();
    await settle();
    expect(container.textContent).toContain('No sessions');
  });
});

describe('Sessions — error state', () => {
  it('surfaces an Alert when the list query fails', async () => {
    mockApi.sessions.list.mockImplementation(() => Promise.reject(new Error('backend down')));
    await mount();
    await settle();
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
  });
});

describe('Sessions — actor attribution', () => {
  it('renders the actor chip for an attributed session', async () => {
    await mount();
    await settle();
    // the "who" chip is on the COLLAPSED card header
    expect(container.textContent ?? '').toContain('tick');
    // …and the expanded body repeats it in the meta line, once the card is opened
    await act(async () => click(streamHeads()[0]));
    await settle();
    expect(container.textContent ?? '').toContain('actor tick');
  });

  it('shows the neutral "unattributed" treatment when actor is null', async () => {
    await mount();
    await settle();
    // the ended card has actor: null → chip reads "unattributed" (never hidden)
    expect(container.textContent).toContain('unattributed');
  });
});

describe('Sessions — actor filter', () => {
  it('re-fetches the list sliced by the chosen actor', async () => {
    await mount();
    await settle();
    // the distinct actors are derived from the loaded list → only 'tick'
    const trigger = container.querySelector(
      'button[aria-label="Filter by actor"]',
    ) as HTMLButtonElement;
    expect(trigger).not.toBeNull();

    await act(async () => {
      click(trigger);
    });
    await settle();

    const option = Array.from(container.querySelectorAll('[role="option"]')).find(
      (el) => (el.textContent ?? '').trim() === 'tick',
    );
    expect(option).not.toBeUndefined();

    await act(async () => {
      click(option as Element);
    });
    await settle();

    // the list is re-fetched server-side with the actor slice (the ?actor= param) — and
    // still carries the page's project scope, in BOTH halves of the request.
    expect(mockApi.sessions.list).toHaveBeenCalledWith(
      expect.objectContaining({ actor: 'tick', project_id: PROJECT_B.id }),
      expect.objectContaining({
        headers: expect.objectContaining({ [apiConfig.projectHeader]: PROJECT_B.id }),
      }),
    );
  });
});

describe('Sessions — project scope (an earlier epic §E)', () => {
  it('opens on the USER DEFAULT project, not "all"', async () => {
    await mount();
    await settle();
    const [params, config] = lastListCall();
    // The request NAMES the default project…
    expect(params.project_id).toBe(PROJECT_B.id);
    // …not the 'all' sentinel this page used to open on.
    expect(params.project_id).not.toBe('all');
    // …and it names it on the header too, which is what a WRITE from this page rides on.
    expect(await headerOnTheWire(config)).toBe(PROJECT_B.id);
  });

  it('honours ?project= over the default, and the request names THAT project', async () => {
    await mount(`/sessions?${PROJECT_URL_PARAM}=${PROJECT_A.id}`);
    await settle();
    const [params, config] = lastListCall();
    expect(params.project_id).toBe(PROJECT_A.id);
    // Stated three ways so no failure mode reads as a pass: it named A, it did NOT name
    // the ambient default B, and it did not name nothing (which the backend reads as
    // "every project" for an admin).
    const sent = await headerOnTheWire(config);
    expect(sent).toBe(PROJECT_A.id);
    expect(sent).not.toBe(PROJECT_B.id);
    expect(sent).toBeDefined();
  });

  it('MUTATION — without the page scope the SAME request carries the ambient default', async () => {
    // This is what the page produces if a future edit drops `project.scope()`. Asserted
    // explicitly so "the header was right" above cannot be true for the wrong reason: the
    // interceptor really would have supplied B, silently.
    await mount(`/sessions?${PROJECT_URL_PARAM}=${PROJECT_A.id}`);
    await settle();
    expect(await headerOnTheWire({})).toBe(PROJECT_B.id);
  });

  it('changing THE switch re-requests — the filter is SERVER-SIDE, not client-side', async () => {
    await mount();
    await settle();
    expect((lastListCall()[0] as Record<string, unknown>).project_id).toBe(PROJECT_B.id);
    // No per-page filter any more; the shell switch writes this store.
    expect(container.querySelector('[aria-label="Filter by project"]')).toBeNull();
    await act(async () => {
      useProjectSelectionStore.getState().select(PROJECT_A.id);
    });
    await settle();

    const [params, config] = lastListCall();
    expect(params.project_id).toBe(PROJECT_A.id);
    expect(await headerOnTheWire(config)).toBe(PROJECT_A.id);
  });

  it("a ?project=all deep link is IGNORED — the page reads the default, never 'all' (F2)", async () => {
    await mount(`/sessions?${PROJECT_URL_PARAM}=all`);
    await settle();
    const [params, config] = lastListCall();
    expect(params.project_id).toBe(PROJECT_B.id);
    expect(await headerOnTheWire(config)).toBe(PROJECT_B.id);
  });
});

describe('Sessions — filter behaviour', () => {
  /** Type a query into the page's search box and let the render settle. */
  async function search(q: string): Promise<string> {
    const input = container.querySelector(
      'input[aria-label="Search sessions"]',
    ) as HTMLInputElement;
    expect(input).not.toBeNull();
    await act(async () => {
      typeInto(input, q);
    });
    await settle();
    return container.textContent ?? '';
  }

  it('searches the ACTOR — the field whose absence made "builder" return nothing', async () => {
    await mount();
    await settle();
    // 'tick' is the live session's actor and appears in no other searched field of the
    // ended session, so a hit here can only have come from `actor`.
    const text = await search('tick');
    expect(text).toContain('Live work');
    expect(text).not.toContain('Old work');
  });

  it('a short query does not match INSIDE a word', async () => {
    mockApi.sessions.list.mockResolvedValue([
      { ...LIVE_SESSION, title: 'Building the guide', actor: 'coordinator' },
      ENDED_SESSION,
    ]);
    await mount();
    await settle();
    const text = await search('ui');
    // The old substring filter matched b-ui-ld and g-ui-de. Neither card should survive.
    expect(text).not.toContain('Building the guide');
    expect(text).not.toContain('Old work');
    expect(text).toContain('No sessions');
  });

  it('the placeholder names what is actually searched', async () => {
    await mount();
    await settle();
    const input = container.querySelector(
      'input[aria-label="Search sessions"]',
    ) as HTMLInputElement;
    const placeholder = input.getAttribute('placeholder') ?? '';
    expect(placeholder).not.toBe('Search activity');
    for (const field of ['title', 'actor', 'project', 'goal', 'tags']) {
      expect(placeholder.toLowerCase()).toContain(field);
    }
  });

  it('filters the list by the search box', async () => {
    await mount();
    await settle();
    const input = container.querySelector('input[aria-label="Search sessions"]') as HTMLInputElement;
    expect(input).not.toBeNull();
    await act(async () => {
      typeInto(input, 'daisy');
    });
    await settle();
    const text = container.textContent ?? '';
    expect(text).toContain('daisy');
    expect(text).not.toContain('Live work');
  });
});

describe('Sessions — the EMPTY and ABSENT populations (C3)', () => {
  /**
   * The values that slip through a scope guard are not the interesting ones — they are
   * zero, empty and absent. Both cases below end in the same requirement: the page must
   * NOT issue a request that names no project. For an admin the backend reads "no project"
   * as EVERY project, so a page that quietly degrades to unscoped does not look broken; it
   * looks like a page showing more data than it should.
   */
  it('NO PROJECTS AT ALL — the page issues no request rather than an unscoped one', async () => {
    projectList.value = [];
    settings.defaultProjectId = undefined;
    await mount();
    await settle();
    expect(
      mockApi.sessions.list,
      'a page with no project must not ask the backend for "everything"',
    ).not.toHaveBeenCalled();
    // …and it says so, instead of spinning forever on a query that will never run.
    expect(container.querySelector('[role="status"]')).toBeNull();
  });

  it('NO DEFAULT SET — falls back to a concrete project, never to unscoped', async () => {
    settings.defaultProjectId = undefined;
    await mount();
    await settle();
    const [params, config] = lastListCall();
    // Some project — never undefined, never 'all'. Which one is the central fallback
    // ladder's business (hooks/usePageProject.ts); that it is CONCRETE is this page's.
    expect([PROJECT_A.id, PROJECT_B.id]).toContain(params.project_id);
    expect(await headerOnTheWire(config)).toBeDefined();
  });

  it('a ?project= the user cannot select is IGNORED, not forwarded as a 403', async () => {
    await mount(`/sessions?${PROJECT_URL_PARAM}=cccccccc-3333-4333-8333-333333333333`);
    await settle();
    const [params] = lastListCall();
    expect(params.project_id).toBe(PROJECT_B.id);
  });

  it('THE LIST COULD NOT BE READ — the page says so instead of rendering "No sessions"', async () => {
    // The third member of the same population, and the one that reached a user: with no
    // resolvable project the list query never runs, so every query-derived state is
    // false and the branch that would otherwise win reads as a measured empty project.
    projectList.value = [];
    projectList.unavailable = true;
    await mount();
    await settle();
    expect(mockApi.sessions.list).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Can't reach the server");
    expect(container.textContent).not.toContain('No sessions match the current filters.');
  });
});
