/**
 * Decisions — mobile overlay coverage.
 *
 * Mirrors Contexts.overlay.test.tsx — see that file's header for the full gap this closes
 * (jsdom's missing `window.matchMedia` left the overlay branch of `useIsStackedRecordLayout`
 * structurally unreachable, so all 72 pre-existing Contexts/Decisions tests exercised only
 * the INLINE branch and a revert of the overlay would have failed nothing).
 *
 * Covers, both platforms via `setViewportWidth` (`../testUtils/viewport`, installed
 * globally by `setupTests.ts`):
 *  - below the breakpoint: selecting a row renders the reader in the Drawer OVERLAY
 *    (portal to document.body, role="dialog"), not inline in the two-column layout;
 *  - the close control returns to the list (Drawer unmounts, route clears);
 *  - the breakpoint itself, both ways, pinned to `RECORD_LAYOUT_STACK_MAX_WIDTH` (the same
 *    exported constant Contexts uses — one source, not a restated literal);
 *  - the deliberate close-state choice (T3): closing drops the row
 *    highlight (mobile) but the project selection SURVIVES in the persisted store even
 *    though `?project=` leaves the URL — same choice as Contexts, same reasoning.
 *
 * Harness: raw react-dom + React.act + MemoryRouter, same shape as Decisions.test.tsx /
 * Decisions.scope.test.tsx.
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
    decisions: {
      search: vi.fn(),
      stats: vi.fn(),
      get: vi.fn(),
      links: vi.fn(),
      update: vi.fn(),
    },
  },
}));

const PROJ_A = 'aaaaaaaa-1111-4111-8111-111111111111';
const PROJ_B = 'bbbbbbbb-2222-4222-8222-222222222222';

const projectState = vi.hoisted(() => ({
  projects: [] as { id: string; name: string }[],
  defaultProjectId: undefined as string | undefined,
}));
vi.mock('../contexts/ProjectContext', async () => {
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

import Decisions from './Decisions';
import { api } from '../api';
import { apiConfig } from '../config/apiConfig';

const mockApi = api as unknown as {
  decisions: {
    search: ReturnType<typeof vi.fn>;
    stats: ReturnType<typeof vi.fn>;
    get: ReturnType<typeof vi.fn>;
    links: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
};

const NOW = new Date().toISOString();
const dec = (id: string, projectId: string, title: string) => ({
  id,
  project_id: projectId,
  decision_type: 'architecture',
  title,
  problem: `${title} problem`,
  decision: `${title} decision`,
  rationale: `${title} rationale`,
  status: 'active',
  outcomeStatus: 'unknown',
  created_at: NOW,
  updated_at: NOW,
});

const DEC_A = dec('aaaaaaaa-1111-2222-3333-444444444444', PROJ_A, 'First decision');
const DEC_B = dec('bbbbbbbb-1111-2222-3333-444444444444', PROJ_A, 'Second decision');
/** Lives in PROJ_B — reachable only via a `?project=` deep link. */
const DEC_FOREIGN = dec('ffffffff-1111-2222-3333-444444444444', PROJ_B, 'Foreign decision');

const records = new Map([
  [DEC_A.id, DEC_A],
  [DEC_B.id, DEC_B],
  [DEC_FOREIGN.id, DEC_FOREIGN],
]);

function setHappy() {
  // Decisions' list read scopes via the `X-Project-ID` HEADER, not a `project_id` body
  // param (unlike Contexts) — see Decisions.scope.test.tsx / pages/decisions/hooks.ts
  // `useDecisionList`. The fixture must read the header, not the request body.
  mockApi.decisions.search.mockImplementation(
    async (_params: unknown, config?: { headers?: Record<string, unknown> }) => {
      const scoped = config?.headers?.[apiConfig.projectHeader];
      const decisions = scoped === PROJ_B ? [DEC_FOREIGN] : [DEC_A, DEC_B];
      return { decisions, total: decisions.length, limit: 50, offset: 0, page: 1 };
    },
  );
  mockApi.decisions.stats.mockResolvedValue({ total_decisions: 3, by_type: {} });
  mockApi.decisions.get.mockImplementation((id: string) => Promise.resolve(records.get(id)));
  mockApi.decisions.links.mockResolvedValue([]);
}

let container: HTMLDivElement;
let root: Root;

function makeClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
}

async function mount(initialPath = '/decisions') {
  container = document.createElement('div');
  document.body.appendChild(container);
  const client = makeClient();
  await act(async () => {
    root = createRoot(container);
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[initialPath]}>
          <Routes>
            <Route path="/decisions" element={<Decisions />} />
            <Route path="/decisions/:id" element={<Decisions />} />
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

const dialog = () => document.body.querySelector('[role="dialog"]');
const closeButton = () =>
  document.body.querySelector('[aria-label="Close panel"]') as HTMLButtonElement | null;
/**
 * A marker unique to `DecisionReader` (never the list row): "Copy id" is one of the
 * reader's action buttons — `DecisionList` renders no `aria-label`s at all on its rows
 * (`role="listbox"` + plain buttons). Whether this is a descendant of `container` (inline)
 * or exists only via the document.body portal (overlay) is the actual distinguishing fact.
 */
const copyIdButtonIn = (scope: ParentNode) => scope.querySelector('[aria-label="Copy id"]');

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

describe('Decisions — MOBILE OVERLAY (below the breakpoint)', () => {
  it('renders the selected decision in the Drawer overlay, NOT inline in the two-column layout', async () => {
    setViewportWidth(500);
    await mount(`/decisions/${DEC_B.id}`);
    await settle();

    expect(dialog()).not.toBeNull();
    expect(copyIdButtonIn(document.body)).not.toBeNull();
    expect(copyIdButtonIn(container)).toBeNull();
  });

  it('the close control returns to the list (Drawer unmounts, reader gone)', async () => {
    setViewportWidth(500);
    await mount(`/decisions/${DEC_B.id}`);
    await settle();
    expect(dialog()).not.toBeNull();

    await click(closeButton());
    await settle();

    expect(dialog()).toBeNull();
    expect(copyIdButtonIn(document.body)).toBeNull();
  });
});

describe('Decisions — the breakpoint, pinned to RECORD_LAYOUT_STACK_MAX_WIDTH (both ways)', () => {
  it('AT the breakpoint width (<=): the overlay renders', async () => {
    setViewportWidth(RECORD_LAYOUT_STACK_MAX_WIDTH);
    await mount(`/decisions/${DEC_B.id}`);
    await settle();
    expect(dialog()).not.toBeNull();
    expect(copyIdButtonIn(container)).toBeNull();
  });

  it('ONE PIXEL above the breakpoint (>): the reader renders inline, no overlay', async () => {
    setViewportWidth(RECORD_LAYOUT_STACK_MAX_WIDTH + 1);
    await mount(`/decisions/${DEC_B.id}`);
    await settle();
    expect(dialog()).toBeNull();
    expect(copyIdButtonIn(container)).not.toBeNull();
  });
});

describe('Decisions — closing the overlay: the deliberate choice (T3)', () => {
  it('drops the row highlight on mobile — no row shows aria-current after close', async () => {
    setViewportWidth(500);
    await mount(`/decisions/${DEC_B.id}`);
    await settle();
    expect(container.querySelectorAll('[aria-current="true"]').length).toBe(1);

    await click(closeButton());
    await settle();

    // Closed: nothing is being read, so nothing stays highlighted either. (Unlike desktop —
    // see Decisions.test.tsx's 'auto-selects the first row' coverage — where the reader is
    // always visible so a highlighted row is always backed by something on screen.)
    expect(container.querySelectorAll('[aria-current="true"]').length).toBe(0);
  });

  it('drops `?project=` from the URL, but the project selection SURVIVES in the persisted store', async () => {
    setViewportWidth(500);
    await mount(`/decisions/${DEC_FOREIGN.id}?project=${PROJ_B}`);
    await settle();
    expect(dialog()).not.toBeNull();
    expect(useProjectSelectionStore.getState().selectedProjectId).toBe(PROJ_B);

    await click(closeButton());
    await settle();

    expect(useProjectSelectionStore.getState().selectedProjectId).toBe(PROJ_B);
    const lastSearch = mockApi.decisions.search.mock.calls.at(-1) as
      | [unknown, { headers?: Record<string, unknown> } | undefined]
      | undefined;
    expect(lastSearch?.[1]?.headers?.[apiConfig.projectHeader]).toBe(PROJ_B);
  });
});
