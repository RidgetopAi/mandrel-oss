/**
 * Contexts page project-scoping (epic 41293984 §A1/§A4).
 *
 * ════════════════════════════════════════════════════════════════════════════════════
 *  WHAT THIS GUARDS
 * ════════════════════════════════════════════════════════════════════════════════════
 * The Contexts screen gained its own project selector, and the ambient `X-Project-ID` is
 * now pinned to the user's DEFAULT project rather than to whatever the page is showing.
 * Those two values differ by design, which creates a failure with no exception anywhere:
 * a read whose project rides only on the ambient header returns the DEFAULT project's
 * memory under this page's heading, and nothing goes red.
 *
 * So the anchor is the ARGUMENTS THE PAGE PUT ON THE OUTGOING REQUEST — the `project_id`
 * param and the `X-Project-ID` the page's `scope()` produced — with the ambient default
 * deliberately set to a DIFFERENT project, so "named nothing" and "named the wrong one"
 * are distinguishable failures. `usePageProject`, `scopedRequestConfig`, the URL param and
 * the data hooks are all REAL here; only the network client is mocked.
 *
 * ── WHAT THIS FILE DOES NOT PROVE ────────────────────────────────────────────────────
 * That the header actually scopes the RESPONSE. Asking a mocked client that would be the
 * app agreeing with itself. That half is anchored on rows planted in a second project in
 * real Postgres — backend/src/__tests__/pageScopedProjectScope.db.test.ts (`/api/contexts`
 * read direction, run as ADMIN so an unscoped read returns everything and a leak shows).
 *
 * Harness: raw react-dom + React.act + MemoryRouter (this repo has NO @testing-library).
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useProjectSelectionStore, resetProjectSelection } from '../stores/projectSelectionStore';

/** The project the PAGE selects. */
const PROJ_A = 'aaaaaaaa-1111-4111-8111-111111111111';
/** The user's DEFAULT — the ambient project a mis-scoped request would silently use. */
const PROJ_B = 'bbbbbbbb-2222-4222-8222-222222222222';

const state = vi.hoisted(() => ({
  defaultProjectId: undefined as string | undefined,
  projects: [] as { id: string; name: string }[],
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
    loading: false,
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

import Contexts from './Contexts';
import { api } from '../api';
import { apiConfig } from '../config/apiConfig';

const mockApi = api as unknown as {
  contexts: Record<string, ReturnType<typeof vi.fn>>;
};

const NOW = new Date().toISOString();
const ctx = (id: string, projectId: string, content: string) => ({
  id,
  project_id: projectId,
  context_type: 'milestone',
  type: 'milestone',
  content,
  tags: [],
  created_at: NOW,
  updated_at: NOW,
});

/** A context that lives in A — the project the page selects. */
const CTX_IN_A = ctx('cccccccc-1111-4111-8111-111111111111', PROJ_A, 'A record from project A');
/** A context that lives in B — reachable only by a short link / deep link. */
const CTX_IN_B = ctx('dddddddd-2222-4222-8222-222222222222', PROJ_B, 'A FOREIGN record from B');

/** The fixture "database", keyed by id — what a by-id read resolves against. */
const records = new Map<string, ReturnType<typeof ctx>>();

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
          <Routes>
            <Route path="/contexts" element={<Contexts />} />
            <Route path="/contexts/:id" element={<Contexts />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  await settle();
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

const lastCall = (fn: ReturnType<typeof vi.fn>) =>
  fn.mock.calls.length ? fn.mock.calls[fn.mock.calls.length - 1] : undefined;

/** The `X-Project-ID` a call carried, read off the axios config the page built. */
const headerOf = (call: unknown[] | undefined, argIndex = 1): unknown =>
  (call?.[argIndex] as { headers?: Record<string, unknown> } | undefined)?.headers?.[
    apiConfig.projectHeader
  ];

beforeEach(() => {
  resetProjectSelection();
  vi.clearAllMocks();
  // THE AMBIENT DEFAULT IS B. Every test below points the page at A.
  state.defaultProjectId = PROJ_B;
  state.projects = [
    { id: PROJ_A, name: 'Project A' },
    { id: PROJ_B, name: 'Project B (default)' },
  ];
  /**
   * The list answers with a row FROM THE PROJECT THAT WAS ASKED FOR. Not because the
   * response is the thing under test — every assertion below is on the REQUEST — but
   * because a fixture that always returns project A's row would make the page's
   * follow-the-record behaviour fire on the auto-selected first row in every test, which
   * is a fixture artifact rather than product behaviour. A real backend cannot return B's
   * rows to a request scoped to A; the fixture should not either.
   */
  records.clear();
  records.set(CTX_IN_A.id, CTX_IN_A);
  records.set(CTX_IN_B.id, CTX_IN_B);
  mockApi.contexts.search.mockImplementation(async (params: { project_id?: string }) => {
    const row = params.project_id === PROJ_B ? CTX_IN_B : CTX_IN_A;
    return { contexts: [row], total: 1, limit: 50, offset: 0, page: 1 };
  });
  mockApi.contexts.stats.mockResolvedValue({ total_contexts: 1, by_type: {} });
  // A by-id read returns the record with THAT id, from whatever project it lives in — which
  // is exactly what the backend does (a detail read is authorized against the record's own
  // project, never the request header).
  mockApi.contexts.get.mockImplementation(async (id: string) => records.get(id) ?? CTX_IN_A);
  mockApi.contexts.links.mockResolvedValue([]);
  mockApi.contexts.related.mockResolvedValue([]);
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
});

describe('Contexts — the page owns its project', () => {
  it('renders NO project selector of its own — THE switch is in the shell', async () => {
    await render(`/contexts?project=${PROJ_A}`);
    expect(container.querySelector('[aria-label="Project"]')).toBeNull();
  });

  it('opens at the USER DEFAULT when the URL names no project', async () => {
    await render('/contexts');
    expect(lastCall(mockApi.contexts.search)?.[0]).toMatchObject({ project_id: PROJ_B });
  });

  it('honours `?project=` over the user default — the URL is the source of truth', async () => {
    await render(`/contexts?project=${PROJ_A}`);
    const call = lastCall(mockApi.contexts.search);
    // Present-and-correct, not merely not-wrong: a request naming NOTHING would also
    // satisfy "did not name B", and the backend reads that as every project.
    expect(call?.[0]).toMatchObject({ project_id: PROJ_A });
    expect(headerOf(call)).toBe(PROJ_A);
    expect(headerOf(call)).not.toBe(PROJ_B);
  });

  it('scopes the STATS read too — it takes no project param, so the header IS its scope', async () => {
    await render(`/contexts?project=${PROJ_A}`);
    // stats(config) — the scope is the FIRST argument here, not the second.
    expect(headerOf(lastCall(mockApi.contexts.stats), 0)).toBe(PROJ_A);
  });

  it('a SWITCH change re-reads with the NEW project in both param and scope', async () => {
    useProjectSelectionStore.getState().select(PROJ_A);
    await render('/contexts');
    expect(headerOf(lastCall(mockApi.contexts.search))).toBe(PROJ_A);
    await act(async () => {
      useProjectSelectionStore.getState().select(PROJ_B);
    });
    await settle();

    const call = lastCall(mockApi.contexts.search);
    expect(call?.[0]).toMatchObject({ project_id: PROJ_B });
    expect(headerOf(call)).toBe(PROJ_B);
  });
});

describe('Contexts — a short link into ANOTHER project (§A4, the wedge)', () => {
  it('renders the foreign record instead of an empty reader, and FOLLOWS it with ?project=', async () => {
    /**
     * `/r/<id8>` resolves to `/contexts/<uuid>`. That record can live outside the selected
     * project — a by-id read is authorized against the RECORD's project, not the request
     * header, so it loads fine. The wedge is what surrounds it: the rail would still be
     * showing project A while the reader shows B's record, and this change set deletes the
     * global switcher, which was the only control that could have reconciled them.
     */
    await render(`/contexts/${CTX_IN_B.id}?project=${PROJ_A}`);

    // The reader rendered the FOREIGN record — not an empty state.
    expect(container.textContent ?? '').toContain('A FOREIGN record from B');

    // …and the page followed it: the list re-scoped to the record's own project, so the
    // rail beside the reader is now the right one.
    const call = lastCall(mockApi.contexts.search);
    expect(call?.[0]).toMatchObject({ project_id: PROJ_B });
    expect(headerOf(call)).toBe(PROJ_B);
  });

  it('does NOT follow a record whose project the user cannot select', async () => {
    // Writing a `?project=` that usePageProject then validates away would leave the URL
    // claiming one project while the page shows another — and re-asking every render is
    // the shape that spins.
    const foreign = ctx(
      'eeeeeeee-3333-4333-8333-333333333333',
      'ffffffff-4444-4444-8444-444444444444',
      'a record in a project this user cannot select',
    );
    records.set(foreign.id, foreign);
    await render(`/contexts/eeeeeeee-3333-4333-8333-333333333333?project=${PROJ_A}`);
    expect(lastCall(mockApi.contexts.search)?.[0]).toMatchObject({ project_id: PROJ_A });
  });
});

describe('Contexts — MUTATION probes', () => {
  it('with NO project resolvable at all, the page sends NOTHING rather than an unscoped read', async () => {
    // The §A2 population. `scope()` throws instead of degrading to "omit the header",
    // which several backend controllers read as EVERY project — so nothing must fire.
    state.defaultProjectId = undefined;
    state.projects = [];
    await render('/contexts');
    expect(mockApi.contexts.search).not.toHaveBeenCalled();
    expect(mockApi.contexts.stats).not.toHaveBeenCalled();
  });

  it('a `?project=` naming a project the user cannot select is IGNORED, not sent', async () => {
    await render('/contexts?project=cccccccc-3333-4333-8333-333333333333');
    const call = lastCall(mockApi.contexts.search);
    expect(call?.[0]).toMatchObject({ project_id: PROJ_B });
    expect(headerOf(call)).toBe(PROJ_B);
  });
});
