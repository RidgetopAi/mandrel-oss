/**
 * Contexts bulk actions — the multi-select + bulk toolbar, driven through
 * the SHIPPED page (createRoot into jsdom behind QueryClientProvider + MemoryRouter, the
 * unified `api` mocked). Proves:
 *   - selecting two rows shows the toolbar reading "2 selected";
 *   - bulk delete calls api.contexts.bulkDelete ONCE with both ids AFTER confirm, and NOT
 *     before (mutation probe: drop the confirm gate → the "not before" assertion goes RED);
 *   - bulk tag sends the tags (ids + replacement list = existing + added);
 *   - select-all selects only the rows IN VIEW, and the selection survives a filter change;
 *   - a project switch clears the selection.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useProjectSelectionStore, resetProjectSelection } from '../../stores/projectSelectionStore';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import type { Context } from '../../types/context';

vi.mock('../../api', () => ({
  api: {
    contexts: {
      search: vi.fn(),
      stats: vi.fn(),
      get: vi.fn(),
      links: vi.fn(),
      related: vi.fn(),
      bulkDelete: vi.fn(),
      bulkUpdate: vi.fn(),
    },
  },
}));

const PROJ_A = { id: 'aaaaaaaa-0000-4000-8000-aaaaaaaa0001', name: 'Project A' };
const PROJ_B = { id: 'bbbbbbbb-0000-4000-8000-bbbbbbbb0002', name: 'Project B' };
const projectState = vi.hoisted(() => ({
  projects: [] as { id: string; name: string }[],
  defaultProjectId: undefined as string | undefined,
}));
vi.mock('../../contexts/ProjectContext', async () => {
  // The REAL selection store behind the mocked context, so a test can move THE switch
  // (`useProjectSelectionStore.getState().select(id)`) and the page re-renders.
  const { useProjectSelectionStore } = await import('../../stores/projectSelectionStore');
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
vi.mock('../../hooks/useSettings', () => ({
  useSettings: () => ({ defaultProjectId: projectState.defaultProjectId }),
}));

import Contexts from '../Contexts';
import { planTagAdd } from './BulkToolbar';
import { api } from '../../api';

type Fn = ReturnType<typeof vi.fn>;
const mockApi = api as unknown as {
  contexts: Record<'search' | 'stats' | 'get' | 'links' | 'related' | 'bulkDelete' | 'bulkUpdate', Fn>;
};

const NOW = new Date().toISOString();
const row = (id8: string, kind: string, title: string, tags: string[] = []) =>
  ({
    id: `${id8}-1111-2222-3333-444444444444`,
    project_id: PROJ_A.id,
    context_type: kind,
    type: kind,
    content: title,
    tags,
    created_at: NOW,
    updated_at: NOW,
  }) as unknown as Context;

const ROW_1 = row('11111111', 'milestone', 'First row');
const ROW_2 = row('22222222', 'decision', 'Second row');
const ROW_3 = row('33333333', 'milestone', 'Third row');
const ALL_ROWS = [ROW_1, ROW_2, ROW_3];

function setHappy() {
  // The search honours the `type` filter, so a facet click really narrows the view — and its
  // rows carry the REQUESTED project, as real rows do (the page follows the reader's record
  // back to its project, so rows stamped with the wrong one would undo a switch).
  mockApi.contexts.search.mockImplementation((params: { type?: string; project_id?: string }) => {
    const matched = params.type ? ALL_ROWS.filter((r) => r.type === params.type) : ALL_ROWS;
    const contexts = matched.map((r) => ({ ...r, project_id: params.project_id ?? r.project_id }));
    return Promise.resolve({ contexts, total: contexts.length, limit: 100, offset: 0, page: 1 });
  });
  mockApi.contexts.stats.mockResolvedValue({ total_contexts: 3, by_type: { milestone: 2, decision: 1 } });
  mockApi.contexts.get.mockImplementation((id: string) =>
    Promise.resolve(ALL_ROWS.find((c) => c.id === id)),
  );
  mockApi.contexts.links.mockResolvedValue([]);
  mockApi.contexts.related.mockResolvedValue([]);
  mockApi.contexts.bulkDelete.mockResolvedValue({ deleted: 2 });
  mockApi.contexts.bulkUpdate.mockResolvedValue({ updated: 2 });
}

let container: HTMLDivElement;
let root: Root;

async function mount(initialPath = `/contexts?project=${PROJ_A.id}`) {
  container = document.createElement('div');
  document.body.appendChild(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
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

function typeInto(input: HTMLInputElement, value: string) {
  const proto = Object.getPrototypeOf(input);
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

/** The per-row checkboxes, in rail order (the select-all box is excluded by its label). */
function rowChecks(): HTMLInputElement[] {
  return Array.from(
    container.querySelectorAll<HTMLInputElement>('input[type="checkbox"][aria-label^="Select context"]'),
  );
}
const selectAll = () =>
  container.querySelector<HTMLInputElement>('input[aria-label="Select all in view"]')!;
const toolbar = () => container.querySelector('[role="toolbar"][aria-label="Bulk actions"]');
const toolbarButton = (label: string) =>
  Array.from(toolbar()!.querySelectorAll('button')).find((b) => b.textContent?.trim() === label)!;
const dialog = () => document.querySelector('[role="dialog"]');
const dialogButton = (label: string) =>
  Array.from(dialog()!.querySelectorAll('button')).find((b) => b.textContent?.trim() === label)!;

/** Move THE switch (shell/ProjectSwitch writes the same store) to the named project. */
async function switchProject(name: string) {
  const target = [PROJ_A, PROJ_B].find((p) => p.name === name);
  expect(target, `project ${name}`).toBeDefined();
  await act(async () => {
    useProjectSelectionStore.getState().select(target!.id);
  });
  await settle();
}

async function check(box: HTMLInputElement) {
  await act(async () => {
    box.click();
  });
}

async function selectTwo() {
  const boxes = rowChecks();
  expect(boxes.length, 'three rows, three checkboxes').toBe(3);
  await check(boxes[0]);
  await check(boxes[1]);
}

beforeEach(() => {
  resetProjectSelection();
  vi.clearAllMocks();
  projectState.projects = [PROJ_A, PROJ_B];
  projectState.defaultProjectId = PROJ_A.id;
  setHappy();
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
});

describe('Contexts bulk actions — selection + toolbar', () => {
  it('shows no toolbar with nothing selected, then "2 selected" after two rows', async () => {
    await mount();
    expect(toolbar()).toBeNull();
    await selectTwo();
    expect(toolbar()).not.toBeNull();
    expect(toolbar()!.textContent).toContain('2 selected');
  });

  it('bulk delete calls the client ONCE with both ids after confirm — and not before', async () => {
    await mount();
    await selectTwo();

    await act(async () => {
      toolbarButton('Delete').click();
    });
    // NOTHING has been sent yet — asserted FIRST so a dropped confirm gate fails on exactly
    // this line (the mutated path's witness is the call itself). Then the dialog, naming the count.
    expect(mockApi.contexts.bulkDelete, 'no request before confirm').not.toHaveBeenCalled();
    expect(dialog(), 'confirm dialog').not.toBeNull();
    expect(dialog()!.textContent).toContain('Delete 2 contexts?');

    await act(async () => {
      dialogButton('Delete 2').click();
    });
    await settle();

    expect(mockApi.contexts.bulkDelete).toHaveBeenCalledTimes(1);
    const [ids, config] = mockApi.contexts.bulkDelete.mock.calls[0];
    expect([...ids].sort()).toEqual([ROW_1.id, ROW_2.id].sort());
    // The batch is authorized against the request's project on the backend: the page scope
    // must ride along, or the header falls back to the ambient default project.
    expect(config).toMatchObject({ headers: { 'X-Project-ID': PROJ_A.id } });
    // Done: dialog closed, selection cleared, toolbar gone.
    expect(dialog()).toBeNull();
    expect(toolbar()).toBeNull();
  });

  it('bulk tag sends the tags: ids + the replacement list (existing + added)', async () => {
    await mount();
    await selectTwo();

    await act(async () => {
      toolbarButton('Add tags').click();
    });
    expect(dialog()).not.toBeNull();
    const input = dialog()!.querySelector<HTMLInputElement>('input[aria-label="Tags to add"]')!;
    await act(async () => {
      typeInto(input, 'alpha, beta');
    });
    await act(async () => {
      dialogButton('Add tags').click();
    });
    await settle();

    // Both rows start with no tags, so they share one outcome → exactly one request.
    expect(mockApi.contexts.bulkUpdate).toHaveBeenCalledTimes(1);
    const [ids, updates] = mockApi.contexts.bulkUpdate.mock.calls[0];
    expect([...ids].sort()).toEqual([ROW_1.id, ROW_2.id].sort());
    expect(updates).toEqual({ tags: ['alpha', 'beta'] });
    expect(dialog()).toBeNull();
    // Tagging keeps the selection (the rows are still here) — only delete/move clear it.
    expect(toolbar()!.textContent).toContain('2 selected');
  });

  it('planTagAdd is ADD semantics over a REPLACE endpoint: unions per row, grouped by outcome', () => {
    const selected = new Map<string, Context>([
      [ROW_1.id, { ...ROW_1, tags: ['keep'] }],
      [ROW_2.id, { ...ROW_2, tags: [] }],
      [ROW_3.id, { ...ROW_3, tags: ['keep'] }],
    ]);
    const batches = planTagAdd(selected, ['new']);
    expect(batches).toHaveLength(2);
    expect(batches).toContainEqual({ ids: [ROW_1.id, ROW_3.id], updates: { tags: ['keep', 'new'] } });
    expect(batches).toContainEqual({ ids: [ROW_2.id], updates: { tags: ['new'] } });
    // A row that already has every added tag is not written at all.
    expect(planTagAdd(new Map([[ROW_1.id, { ...ROW_1, tags: ['new'] }]]), ['new'])).toEqual([]);
  });

  it('select-all selects only the rows IN VIEW; the selection survives the filter change', async () => {
    await mount();
    // Narrow the view to the one decision row.
    const facets = container.querySelector('[aria-label="Filter by type"]')!;
    const decisionChip = Array.from(facets.querySelectorAll('button')).find((b) =>
      b.textContent?.startsWith('decision'),
    )!;
    await act(async () => {
      decisionChip.click();
    });
    await settle();
    expect(rowChecks().length, 'one row in view').toBe(1);
    expect(container.textContent).toContain('1 in view');

    await check(selectAll());
    expect(toolbar()!.textContent).toContain('1 selected');
    expect(selectAll().checked).toBe(true);

    // Back to All: three rows, the same ONE still selected — not the other two.
    const allChip = Array.from(facets.querySelectorAll('button')).find((b) =>
      b.textContent?.startsWith('All'),
    )!;
    await act(async () => {
      allChip.click();
    });
    await settle();
    const boxes = rowChecks();
    expect(boxes.length).toBe(3);
    expect(boxes.map((b) => b.checked)).toEqual([false, true, false]);
    expect(toolbar()!.textContent).toContain('1 selected');
    // Select-all over the wider view is now "some" (indeterminate), not "all".
    expect(selectAll().checked).toBe(false);
    expect(selectAll().indeterminate).toBe(true);
  });

  it('a project switch clears the selection', async () => {
    // The switch (not a URL param) puts the page on A, so moving it is what re-scopes.
    useProjectSelectionStore.getState().select(PROJ_A.id);
    await mount('/contexts');
    await selectTwo();
    expect(toolbar()!.textContent).toContain('2 selected');

    await switchProject('Project B');
    expect(toolbar()).toBeNull();
    expect(rowChecks().every((b) => !b.checked)).toBe(true);

    // Cleared, not hidden: coming back to Project A does not resurrect the old selection.
    await switchProject('Project A');
    expect(toolbar()).toBeNull();
    expect(rowChecks().every((b) => !b.checked)).toBe(true);
  });
});
