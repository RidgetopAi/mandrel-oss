/**
 * Decisions page project-scoping — READ and, more importantly, WRITE (an earlier epic §A1/§A4).
 *
 * ════════════════════════════════════════════════════════════════════════════════════
 *  WHY THE WRITE HALF IS THE POINT OF THIS FILE
 * ════════════════════════════════════════════════════════════════════════════════════
 * `PUT /api/decisions/:id` is one of the three `requireWriteProjectId` controllers. It
 * resolves a project from the REQUEST — header beats body — and hands it to MCP
 * `decision_update`, which uses it to SCOPE THE decisionId LOOKUP. A write carries no query
 * param, so with no per-request scope the resolved project is the AMBIENT default.
 *
 * Once the page selector and the ambient default are allowed to differ — which this change
 * set does deliberately — that is a silent failure: the update is attempted against the
 * wrong project, and there is no version of "the ambient default" that is right, because
 * the correct project is neither the ambient one NOR necessarily the page's. It is THE
 * DECISION'S OWN: a decision reached by a `/r/<id8>` short link lives somewhere else
 * entirely, and naming the page's project would ask the tool to find that id in a project
 * that does not contain it.
 *
 * So the write assertions below are not "a project was named". They are "THE RECORD'S
 * project was named", with the page's project and the ambient default both set to
 * different values so that either mistake is visible.
 *
 * ── THE READ HALF ────────────────────────────────────────────────────────────────────
 * Same anchor as Contexts/Tasks: the arguments the page put on the outgoing request, with
 * the ambient default deliberately different from the page's selection so "named nothing"
 * and "named the wrong one" are distinguishable failures.
 *
 * ── WHAT THIS FILE DOES NOT PROVE ────────────────────────────────────────────────────
 * That the resolved project actually reaches the row. That is a fact about the backend
 * resolver and is anchored in backend/src/__tests__/pageScopedProjectScope.db.test.ts
 * (`POST /api/decisions`, asserting the projectId this backend FORWARDS, with an ambient
 * mutation twin and an unscoped-is-refused twin) and, for the update path specifically, in
 * backend/src/__tests__/recordPagesWriteScope.db.test.ts.
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
    decisions: {
      search: vi.fn(),
      stats: vi.fn(),
      get: vi.fn(),
      links: vi.fn(),
      update: vi.fn(),
    },
  },
}));

import Decisions from './Decisions';
import { api } from '../api';
import { apiConfig } from '../config/apiConfig';

const mockApi = api as unknown as { decisions: Record<string, ReturnType<typeof vi.fn>> };

const NOW = new Date().toISOString();
const dec = (id: string, projectId: string, title: string) => ({
  id,
  project_id: projectId,
  decision_type: 'architecture',
  title,
  description: `${title} description`,
  rationale: `${title} rationale`,
  status: 'active',
  outcomeStatus: 'unknown',
  created_at: NOW,
  updated_at: NOW,
});

const DEC_IN_A = dec('cccccccc-1111-4111-8111-111111111111', PROJ_A, 'Decision in A');
const DEC_IN_B = dec('dddddddd-2222-4222-8222-222222222222', PROJ_B, 'FOREIGN decision in B');

/**
 * A project the user cannot SELECT but can still read a record from — e.g. an admin, or a
 * grant that reaches the record without the project appearing in their picker. This is the
 * only configuration in which the page's project and the record's project genuinely
 * DISAGREE at write time, because `useRecordProjectSync` deliberately does not follow a
 * record into a project the selector does not offer.
 *
 * It exists because a mutation probe found the guard without it was hollow: swapping the
 * drawer's scope from `decision.project_id` to the PAGE's project left every test green,
 * since the page had already followed the record into its project by the time the drawer
 * opened. The two values were never actually different, so the assertion "the record's
 * project was named" was true for the wrong reason.
 */
const PROJ_C = 'cccccccc-9999-4999-8999-999999999999';
const DEC_IN_C = dec('eeeeeeee-3333-4333-8333-333333333333', PROJ_C, 'UNSELECTABLE-project decision');

/** The fixture "database", keyed by id — what a by-id read resolves against. */
const records = new Map<string, ReturnType<typeof dec>>();

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
            <Route path="/decisions" element={<Decisions />} />
            <Route path="/decisions/:id" element={<Decisions />} />
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

const headerOf = (call: unknown[] | undefined, argIndex: number): unknown =>
  (call?.[argIndex] as { headers?: Record<string, unknown> } | undefined)?.headers?.[
    apiConfig.projectHeader
  ];

const click = (el: Element | null | undefined) =>
  act(() => {
    el?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });

/** The drawer + its buttons render through a portal to document.body. */
const buttonByText = (scope: ParentNode, text: string) =>
  (Array.from(scope.querySelectorAll('button')).find(
    (b) => (b.textContent ?? '').trim() === text,
  ) ?? null) as HTMLButtonElement | null;

beforeEach(() => {
  resetProjectSelection();
  vi.clearAllMocks();
  // THE AMBIENT DEFAULT IS B. Every read test below points the page at A.
  state.defaultProjectId = PROJ_B;
  state.projects = [
    { id: PROJ_A, name: 'Project A' },
    { id: PROJ_B, name: 'Project B (default)' },
  ];
  records.clear();
  records.set(DEC_IN_A.id, DEC_IN_A);
  records.set(DEC_IN_B.id, DEC_IN_B);
  records.set(DEC_IN_C.id, DEC_IN_C);
  // The ledger answers with a row from the project that was asked for — a real backend
  // cannot return B's rows to a request scoped to A, and a fixture that did would make the
  // page's follow-the-record behaviour fire on the auto-selected row in every test.
  mockApi.decisions.search.mockImplementation(
    async (_params: unknown, config?: { headers?: Record<string, unknown> }) => {
      const scoped = config?.headers?.[apiConfig.projectHeader];
      return { decisions: [scoped === PROJ_B ? DEC_IN_B : DEC_IN_A], total: 1 };
    },
  );
  mockApi.decisions.stats.mockResolvedValue({ total_decisions: 1, by_type: {} });
  mockApi.decisions.get.mockImplementation(async (id: string) => records.get(id) ?? DEC_IN_A);
  mockApi.decisions.links.mockResolvedValue([]);
  mockApi.decisions.update.mockResolvedValue(undefined);
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
});

describe('Decisions — READ: the page owns its project', () => {
  it('renders NO project selector of its own — THE switch is in the shell', async () => {
    await render(`/decisions?project=${PROJ_A}`);
    expect(container.querySelector('[aria-label="Project"]')).toBeNull();
  });

  it('opens at the USER DEFAULT when the URL names no project', async () => {
    await render('/decisions');
    expect(headerOf(lastCall(mockApi.decisions.search), 1)).toBe(PROJ_B);
  });

  it('honours `?project=` — and names it, rather than merely not naming the default', async () => {
    await render(`/decisions?project=${PROJ_A}`);
    // GET /api/decisions takes no project query param of its own; the backend resolves it
    // from the request, so the header IS the scope here.
    expect(headerOf(lastCall(mockApi.decisions.search), 1)).toBe(PROJ_A);
    expect(headerOf(lastCall(mockApi.decisions.search), 1)).not.toBe(PROJ_B);
  });

  it('scopes the STATS read too (the facet counts describe the ledger on screen)', async () => {
    await render(`/decisions?project=${PROJ_A}`);
    // stats(projectId, config) — the scope is the SECOND argument.
    expect(headerOf(lastCall(mockApi.decisions.stats), 1)).toBe(PROJ_A);
  });

  it('a SWITCH change re-reads with the NEW project', async () => {
    useProjectSelectionStore.getState().select(PROJ_A);
    await render('/decisions');
    expect(headerOf(lastCall(mockApi.decisions.search), 1)).toBe(PROJ_A);
    await act(async () => {
      useProjectSelectionStore.getState().select(PROJ_B);
    });
    await settle();
    expect(headerOf(lastCall(mockApi.decisions.search), 1)).toBe(PROJ_B);
  });
});

describe('Decisions — a short link into ANOTHER project (§A4, the wedge)', () => {
  it('renders the foreign decision instead of an empty reader, and FOLLOWS it with ?project=', async () => {
    await render(`/decisions/${DEC_IN_B.id}?project=${PROJ_A}`);
    expect(container.textContent ?? '').toContain('FOREIGN decision in B');
    // The ledger beside the reader re-scoped to the record's own project.
    expect(headerOf(lastCall(mockApi.decisions.search), 1)).toBe(PROJ_B);
  });
});

describe('Decisions — WRITE: the outcome drawer (the requireWriteProjectId path)', () => {
  /** Open the reader's Edit affordance and land in the outcome drawer. */
  async function openDrawer(url: string) {
    await render(url);
    const editBtn = container.querySelector('button[aria-label="Record outcome"]');
    expect(editBtn).not.toBeNull();
    await click(editBtn);
    await settle();
  }

  it('scopes the update to the DECISION\'s project when the page is on the same project', async () => {
    await openDrawer(`/decisions/${DEC_IN_A.id}?project=${PROJ_A}`);
    const save = buttonByText(document.body, 'Save outcome');
    expect(save).not.toBeNull();
    await click(save);
    await settle();

    const call = lastCall(mockApi.decisions.update);
    expect(call?.[0]).toBe(DEC_IN_A.id);
    // update(id, updates, config) — the scope is the THIRD argument.
    expect(headerOf(call, 2)).toBe(PROJ_A);
    // …and NOT the ambient default, which is where an unscoped write would have resolved.
    expect(headerOf(call, 2)).not.toBe(PROJ_B);
  });

  it('THE CROSS-PROJECT CASE — a decision reached by short link is updated in ITS OWN project', async () => {
    /**
     * The page is on A (URL), the ambient default is B, and the decision lives in B. All
     * three values are distinct in principle; the ONLY correct one is the record's.
     * Scoping to the page would send A and the MCP tool would look for this id in A.
     */
    await openDrawer(`/decisions/${DEC_IN_B.id}?project=${PROJ_A}`);
    const save = buttonByText(document.body, 'Save outcome');
    expect(save).not.toBeNull();
    await click(save);
    await settle();

    const call = lastCall(mockApi.decisions.update);
    expect(call?.[0]).toBe(DEC_IN_B.id);
    expect(headerOf(call, 2)).toBe(PROJ_B);
  });

  it('THE DISAGREEING CASE — page on A, record in an UNSELECTABLE project: the write names the RECORD\'s', async () => {
    /**
     * This is the case that actually distinguishes "scope to the record" from "scope to the
     * page". Everywhere else the page has already followed the record, so the two agree and
     * either implementation passes — which is precisely what a mutation probe caught.
     *
     * Product-wise, the record's project is the only correct answer: MCP `decision_update`
     * scopes the decisionId lookup by the project it is given, so naming A would ask it to
     * find a decision that is not in A.
     */
    await openDrawer(`/decisions/${DEC_IN_C.id}?project=${PROJ_A}`);
    await click(buttonByText(document.body, 'Save outcome'));
    await settle();

    const call = lastCall(mockApi.decisions.update);
    expect(call?.[0]).toBe(DEC_IN_C.id);
    expect(headerOf(call, 2)).toBe(PROJ_C);
    // Neither the page's project nor the ambient default.
    expect(headerOf(call, 2)).not.toBe(PROJ_A);
    expect(headerOf(call, 2)).not.toBe(PROJ_B);
  });

  it('MUTATION — the update is never sent unscoped', async () => {
    // Proof this suite can see the defect: every update call recorded above carried a real
    // project header. A build that dropped `scope()` would send `undefined` here.
    await openDrawer(`/decisions/${DEC_IN_A.id}?project=${PROJ_A}`);
    await click(buttonByText(document.body, 'Save outcome'));
    await settle();
    expect(mockApi.decisions.update).toHaveBeenCalled();
    for (const call of mockApi.decisions.update.mock.calls) {
      expect(headerOf(call, 2)).toBeTruthy();
    }
  });
});

describe('Decisions — MUTATION probes on the reads', () => {
  it('with NO project resolvable at all, the page sends NOTHING rather than an unscoped read', async () => {
    state.defaultProjectId = undefined;
    state.projects = [];
    await render('/decisions');
    expect(mockApi.decisions.search).not.toHaveBeenCalled();
    expect(mockApi.decisions.stats).not.toHaveBeenCalled();
  });

  it('a `?project=` naming a project the user cannot select is IGNORED, not sent', async () => {
    await render('/decisions?project=cccccccc-3333-4333-8333-333333333333');
    expect(headerOf(lastCall(mockApi.decisions.search), 1)).toBe(PROJ_B);
  });
});
