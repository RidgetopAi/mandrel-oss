/**
 * Contexts — mobile overlay coverage.
 *
 * ════════════════════════════════════════════════════════════════════════════════════
 *  THE GAP THIS FILE CLOSES
 * ════════════════════════════════════════════════════════════════════════════════════
 * The overlay shipped in an earlier change: below `RECORD_LAYOUT_STACK_MAX_WIDTH`
 * the reader renders inside `Drawer` instead of the inline second column. But jsdom has no
 * `window.matchMedia`, so `useMediaQuery` — and therefore `useIsStackedRecordLayout` —
 * degraded to its fallback `false` for EVERY test, and all 72 pre-existing Contexts/
 * Decisions tests exercised only the INLINE branch. A revert of the overlay branch would
 * have failed nothing. `../testUtils/viewport` (installed globally by `setupTests.ts`)
 * makes the overlay branch reachable by giving jsdom a controllable, real `matchMedia`;
 * this file is the standing guard that actually reaches it.
 *
 * Covers, both platforms via `setViewportWidth`:
 *  - below the breakpoint: selecting a row renders the reader in the Drawer OVERLAY
 *    (portal to document.body, role="dialog"), not inline in the two-column layout;
 *  - the close control returns to the list (Drawer unmounts, route clears);
 *  - the breakpoint itself, both ways, pinned to the SAME exported constant the hook and
 *    the CSS share (`RECORD_LAYOUT_STACK_MAX_WIDTH`) rather than a restated literal;
 *  - the deliberate close-state choice (T3): closing drops the row
 *    highlight (mobile) but the project selection SURVIVES in the persisted store even
 *    though `?project=` leaves the URL.
 *
 * Harness: raw react-dom + React.act + MemoryRouter (this repo has NO @testing-library),
 * same shape as Contexts.test.tsx / Contexts.scope.test.tsx.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { useProjectSelectionStore, resetProjectSelection } from '../stores/projectSelectionStore';
import { setViewportWidth } from '../testUtils/viewport';
import { RECORD_LAYOUT_STACK_MAX_WIDTH } from '../hooks/useIsStackedRecordLayout';

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

/** The project the page selects. A second, different one exercises the `?project=` pin. */
const PROJ_A = 'aaaaaaaa-1111-4111-8111-111111111111';
const PROJ_B = 'bbbbbbbb-2222-4222-8222-222222222222';

const projectState = vi.hoisted(() => ({
  projects: [] as { id: string; name: string }[],
  defaultProjectId: undefined as string | undefined,
}));
vi.mock('../contexts/ProjectContext', async () => {
  // The REAL selection store behind the mocked context (as Contexts.test.tsx /
  // Contexts.scope.test.tsx do), so a test can read what the topbar switch is ACTUALLY
  // holding after the page adopts a `?project=` deep link.
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
  };
};

const NOW = new Date().toISOString();
const CTX_A = {
  id: 'aaaaaaaa-1111-2222-3333-444444444444',
  project_id: PROJ_A,
  project_name: 'Project A',
  context_type: 'milestone',
  type: 'milestone',
  content: 'OVERLAY-TARGET first row content',
  tags: [],
  created_at: NOW,
  updated_at: NOW,
};
const CTX_B = {
  id: 'bbbbbbbb-1111-2222-3333-444444444444',
  project_id: PROJ_A,
  project_name: 'Project A',
  content: 'OVERLAY-TARGET second row content',
  context_type: 'decision',
  type: 'decision',
  tags: [],
  created_at: NOW,
  updated_at: NOW,
};
/** Lives in PROJ_B — reachable only via a `?project=` deep link. */
const CTX_FOREIGN = {
  id: 'ffffffff-1111-2222-3333-444444444444',
  project_id: PROJ_B,
  project_name: 'Project B',
  content: 'OVERLAY-TARGET foreign-project content',
  context_type: 'note',
  type: 'note',
  tags: [],
  created_at: NOW,
  updated_at: NOW,
};

const records = new Map([
  [CTX_A.id, CTX_A],
  [CTX_B.id, CTX_B],
  [CTX_FOREIGN.id, CTX_FOREIGN],
]);

function setHappy() {
  mockApi.contexts.search.mockImplementation(async (params: { project_id?: string }) => {
    const row = params.project_id === PROJ_B ? CTX_FOREIGN : CTX_A;
    const rest = params.project_id === PROJ_B ? [] : [CTX_B];
    return { contexts: [row, ...rest], total: 1, limit: 60, offset: 0, page: 1 };
  });
  mockApi.contexts.stats.mockResolvedValue({ total_contexts: 3, by_type: {} });
  mockApi.contexts.get.mockImplementation((id: string) => Promise.resolve(records.get(id)));
  mockApi.contexts.links.mockResolvedValue([]);
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

const click = (el: Element | null | undefined) =>
  act(() => {
    el?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });

/** The Drawer portal-renders to document.body — never a descendant of `container`. */
const dialog = () => document.body.querySelector('[role="dialog"]');
const closeButton = () =>
  document.body.querySelector('[aria-label="Close panel"]') as HTMLButtonElement | null;
/**
 * A marker unique to `ContextReader` (never the list row): "Edit context" is one of the
 * reader's action buttons. Row titles are the record's own content, which in these
 * fixtures is short enough to also be the row's preview text — so a plain text-content
 * assertion cannot tell "shown in the reader" apart from "also the row's title". Whether
 * this button is a descendant of `container` (inline) or exists only via the document.body
 * portal (overlay) is what actually distinguishes the two branches.
 */
const editButtonIn = (scope: ParentNode) => scope.querySelector('[aria-label="Edit context"]');

beforeEach(() => {
  resetProjectSelection();
  vi.clearAllMocks();
  projectState.projects = [
    { id: PROJ_A, name: 'Project A' },
    { id: PROJ_B, name: 'Project B' },
  ];
  projectState.defaultProjectId = PROJ_A;
  setHappy();
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
});

describe('Contexts — MOBILE OVERLAY (below the breakpoint)', () => {
  it('renders the selected record in the Drawer overlay, NOT inline in the two-column layout', async () => {
    setViewportWidth(500);
    await mount(`/contexts/${CTX_B.id}`);
    await settle();

    expect(dialog()).not.toBeNull();
    // The reader rendered — but ONLY via the portal, never as a descendant of `container`
    // (the app root outside the portal). That is what "overlay, not inline" actually means.
    expect(editButtonIn(document.body)).not.toBeNull();
    expect(editButtonIn(container)).toBeNull();
  });

  it('the close control returns to the list (Drawer unmounts, reader gone)', async () => {
    setViewportWidth(500);
    await mount(`/contexts/${CTX_B.id}`);
    await settle();
    expect(dialog()).not.toBeNull();

    await click(closeButton());
    await settle();

    expect(dialog()).toBeNull();
    expect(editButtonIn(document.body)).toBeNull();
  });
});

describe('Contexts — the breakpoint, pinned to RECORD_LAYOUT_STACK_MAX_WIDTH (both ways)', () => {
  it('AT the breakpoint width (<=): the overlay renders', async () => {
    setViewportWidth(RECORD_LAYOUT_STACK_MAX_WIDTH);
    await mount(`/contexts/${CTX_B.id}`);
    await settle();
    expect(dialog()).not.toBeNull();
    expect(editButtonIn(container)).toBeNull();
  });

  it('ONE PIXEL above the breakpoint (>): the reader renders inline, no overlay', async () => {
    setViewportWidth(RECORD_LAYOUT_STACK_MAX_WIDTH + 1);
    await mount(`/contexts/${CTX_B.id}`);
    await settle();
    expect(dialog()).toBeNull();
    expect(editButtonIn(container)).not.toBeNull();
  });
});

describe('Contexts — closing the overlay: the deliberate choice (T3)', () => {
  it('drops the row highlight on mobile — no row shows aria-current after close', async () => {
    setViewportWidth(500);
    await mount(`/contexts/${CTX_B.id}`);
    await settle();
    // While open, the row the overlay is showing IS highlighted in the (hidden-behind-the-
    // overlay) list.
    expect(container.querySelectorAll('[aria-current="true"]').length).toBe(1);

    await click(closeButton());
    await settle();

    // Closed: nothing is being read, so nothing is highlighted either — the highlight
    // never lies about what's currently open. (Desktop does NOT do this: see the inline
    // 'auto-selects the first row' coverage in Contexts.test.tsx — the reader there is
    // always visible, so a highlighted row is always backed by something on screen.)
    expect(container.querySelectorAll('[aria-current="true"]').length).toBe(0);
  });

  it('drops `?project=` from the URL, but the project selection SURVIVES in the persisted store', async () => {
    setViewportWidth(500);
    // A deep link into a FOREIGN project — the page follows the record and adopts PROJ_B
    // into the persisted topbar selection (useRecordProjectSync / usePageProject).
    await mount(`/contexts/${CTX_FOREIGN.id}?project=${PROJ_B}`);
    await settle();
    expect(dialog()).not.toBeNull();
    expect(useProjectSelectionStore.getState().selectedProjectId).toBe(PROJ_B);

    await click(closeButton());
    await settle();

    // The URL param is gone (closing navigates to the bare list path) — but the store,
    // which is what `usePageProject` actually reads, still says B. The scope was never
    // lost; only the transient URL override was, which is the point of adopting it into
    // the store in the first place.
    expect(useProjectSelectionStore.getState().selectedProjectId).toBe(PROJ_B);
    const lastSearch = mockApi.contexts.search.mock.calls.at(-1);
    expect(lastSearch?.[0]).toMatchObject({ project_id: PROJ_B });
  });
});
