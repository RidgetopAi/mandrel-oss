/**
 * TreeWalker render + SCOPE tests — mounts the page into jsdom (createRoot + act, the repo
 * pattern) behind QueryClientProvider + MemoryRouter with the unified `api` mocked. The
 * backend thread endpoint is LIVE (TREEWALKER_CONFIG.backendReady === true),
 * so these prove: (1) with no explicit anchor the screen reads the no-arg RESUME
 * endpoint (not the explicit one); (2) a resolved thread renders the anchor readout + spine +
 * nodes; (3) a genuinely-empty thread still renders the HONEST empty state (never fabricated);
 * (4) the Graph/Story view toggle works.
 *
 * ── WHAT THE SELECTOR WORK CHANGED ───────────────────────────────────
 * The page used to take its project from `useEffectiveProjectId()` — i.e. from the global
 * switcher this epic deletes — so these tests stubbed that hook and never asserted what the
 * REQUEST carried. It now owns a selector, and the assertions moved with it: the thread read
 * must carry an `X-Project-ID` naming THIS PAGE's project. The read is header-scoped with no
 * path or query alternative (`TreeWalkerController.getResumeThread` resolves the newest
 * `ref:resume` context through `resolveListScope`), so an unscoped call is not an empty walk
 * — for an admin it walks every project's threads. "It named A" is therefore the assertion,
 * never "it did not name B".
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { useProjectSelectionStore, resetProjectSelection } from '../stores/projectSelectionStore';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { ThreadGraph } from '../api/domains/treewalker';

vi.mock('../api', () => ({
  api: {
    treewalker: {
      getThread: vi.fn(),
      getResumeThread: vi.fn(),
      getBranches: vi.fn(async () => ({ branches: [], total: 0, cap: 30 })),
    },
  },
}));

// usePageProject's two inputs, mocked at the module boundary so the hook itself runs for
// real — the ?project= handling, the default-project fallback and the scope() config are
// all exercised here rather than stubbed. `allProjects` doubles as the selector's options
// AND the head-note's name source, which is the point: one source, so the label and the
// request cannot name different projects.
let mockAllProjects: Array<{ id: string; name: string }> = [];
let mockDefaultProjectId: string | undefined = undefined;
vi.mock('../contexts/ProjectContext', async () => {
  // The REAL selection store behind the mocked context, so a test can move THE switch
  // (`useProjectSelectionStore.getState().select(id)`) and the page re-renders.
  const { useProjectSelectionStore } = await import('../stores/projectSelectionStore');
  return {
  useProjectContext: () => ({
    selectedProjectId: useProjectSelectionStore((st) => st.selectedProjectId),
    setSelectedProjectId: useProjectSelectionStore.getState().select, allProjects: mockAllProjects, loading: false }),
  };
});
vi.mock('../hooks/useSettings', () => ({
  useSettings: () => ({ defaultProjectId: mockDefaultProjectId }),
}));

/** The project this page is pointed at, and the DEFAULT it must not silently fall back to. */
const PROJECT_A = 'aaaaaaaa-1111-4111-8111-111111111111';
const PROJECT_B = 'bbbbbbbb-2222-4222-8222-222222222222';

import TreeWalker from './TreeWalker';
import { api } from '../api';

const mockApi = api as unknown as {
  treewalker: { getThread: ReturnType<typeof vi.fn>; getResumeThread: ReturnType<typeof vi.fn> };
};

/** The trunk head the backend serves (the project's newest handoff) — the jump target. */
const TRUNK_HEAD = 'e4bbf00d-0000-4000-8000-00000000aaaa';

const SAMPLE: ThreadGraph = {
  anchor: { branchLabel: 'command-redesign', anchorId: 'a0000000-0000-4000-8000-000000000001', recordCount: 2 },
  // PHASE 2: every tier label is DATA-derived by the backend (root doc title, handoff
  // count, spine name) — this fixture mirrors that wire shape.
  spine: [
    { tier: 'root', label: '★ CANONICAL — north star', id: 'ca000000-0000-4000-8000-00000000000c' },
    { tier: 'tree', label: 'tree:mandrel-product' },
    { tier: 'trunk', label: 'handoffs · 3', id: TRUNK_HEAD },
    { tier: 'branch', label: 'command-redesign', id: 'b0000000-0000-4000-8000-000000000002' },
  ],
  trunkAnchorId: TRUNK_HEAD,
  nodes: [
    { id: 'b0000000-0000-4000-8000-000000000002', kind: 'task', title: 'command-redesign', trust: 'ok', isSpine: true },
    { id: 'a0000000-0000-4000-8000-000000000001', kind: 'handoff', title: '★ Handoff resume', trust: 'unproven', isCurrent: true },
  ],
  edges: [],
  story: [
    { id: 'a0000000-0000-4000-8000-000000000001', kind: 'handoff', title: '★ Handoff resume', trust: 'unproven', relation: 'you are here · ', relationTerm: 'resume point', marker: 'now' },
  ],
};

const EMPTY: ThreadGraph = {
  anchor: { branchLabel: 'thread', anchorId: '', recordCount: 0 },
  spine: [],
  nodes: [],
  edges: [],
  story: [],
  trunkAnchorId: null,
};

let container: HTMLDivElement;
let root: Root;

function mount(ui: React.ReactElement, url = '/treewalker') {
  container = document.createElement('div');
  document.body.appendChild(container);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() => {
    root = createRoot(container);
    root.render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={[url]}>{ui}</MemoryRouter>
      </QueryClientProvider>,
    );
  });
}

/** The `X-Project-ID` the last resume-thread read actually carried. */
function scopedProjectOfLastRead(
  fn: ReturnType<typeof vi.fn> = mockApi.treewalker.getResumeThread,
): unknown {
  const config = fn.mock.calls.at(-1)?.[0] as { headers?: Record<string, unknown> } | undefined;
  if (!config?.headers || !('X-Project-ID' in config.headers)) return 'NOT_SCOPED';
  return config.headers['X-Project-ID'];
}

/** Flush the react-query read to settled (macrotask turns so the query resolves + re-renders). */
async function flush() {
  for (let i = 0; i < 5; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

beforeEach(() => {
  resetProjectSelection();
  mockApi.treewalker.getThread.mockReset();
  mockApi.treewalker.getResumeThread.mockReset();
  // The page has a real project by default, because with NO project the read is correctly
  // gated off and every render assertion below would be testing the empty state instead of
  // the thing it names. The default is B and the page is pointed at A wherever scope is
  // under test, so "fell back to the ambient default" is always a visible, distinct failure.
  mockAllProjects = [
    { id: PROJECT_A, name: 'acme-widgets' },
    { id: PROJECT_B, name: 'the default project' },
  ];
  mockDefaultProjectId = PROJECT_A;
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
});

// ══════════════════════════════════════════════════════════════════════════════════════
//  SCOPE — the page owns its project, and the request says so
// ══════════════════════════════════════════════════════════════════════════════════════
describe('TreeWalker — project scope', () => {
  it('renders NO project selector of its own — THE switch is in the shell', async () => {
    mockApi.treewalker.getResumeThread.mockResolvedValue(SAMPLE);
    mount(<TreeWalker />);
    await flush();
    expect(container.querySelector('button[aria-label="TreeWalker project"]')).toBeNull();
  });

  it('the thread read NAMES the page project in X-Project-ID', async () => {
    mockApi.treewalker.getResumeThread.mockResolvedValue(SAMPLE);
    mount(<TreeWalker />);
    await flush();
    expect(scopedProjectOfLastRead()).toBe(PROJECT_A);
  });

  it('?project= wins over the user default — the read names B, not the default A', async () => {
    mockApi.treewalker.getResumeThread.mockResolvedValue(SAMPLE);
    mount(<TreeWalker />, `/treewalker?project=${PROJECT_B}`);
    await flush();
    expect(scopedProjectOfLastRead()).toBe(PROJECT_B);
    // Present-and-correct, not merely not-wrong: an unscoped read would walk every
    // project the caller can see, which is a different bug with the same symptom.
    expect(scopedProjectOfLastRead()).not.toBe('NOT_SCOPED');
  });

  it('changing the switch re-reads the thread for the newly named project', async () => {
    mockApi.treewalker.getResumeThread.mockResolvedValue(SAMPLE);
    mount(<TreeWalker />);
    await flush();
    expect(scopedProjectOfLastRead()).toBe(PROJECT_A);

    await act(async () => {
      useProjectSelectionStore.getState().select(PROJECT_B);
    });
    await flush();

    expect(scopedProjectOfLastRead()).toBe(PROJECT_B);
  });

  it('THE EMPTY POPULATION — with no project at all, it reads NOTHING rather than everything', async () => {
    mockAllProjects = [];
    mockDefaultProjectId = undefined;
    mockApi.treewalker.getResumeThread.mockResolvedValue(SAMPLE);
    mount(<TreeWalker />);
    await flush();
    expect(mockApi.treewalker.getResumeThread).not.toHaveBeenCalled();
    expect(mockApi.treewalker.getThread).not.toHaveBeenCalled();
  });
});

describe('TreeWalker — live resume-anchor read', () => {
  it('renders the page heading + subtitle', () => {
    mockApi.treewalker.getResumeThread.mockResolvedValue(SAMPLE);
    mount(<TreeWalker />);
    expect(container.textContent).toMatch(/TreeWalker/);
    expect(container.textContent).toMatch(/how much to trust it/i);
  });

  it('reads the no-arg RESUME endpoint (not the explicit-anchor one) when no anchor is selected', async () => {
    mockApi.treewalker.getResumeThread.mockResolvedValue(SAMPLE);
    mount(<TreeWalker />);
    await flush();
    expect(mockApi.treewalker.getResumeThread).toHaveBeenCalledTimes(1);
    expect(mockApi.treewalker.getThread).not.toHaveBeenCalled();
  });

  it('renders the resolved thread: anchor readout, spine lineage, and nodes', async () => {
    mockApi.treewalker.getResumeThread.mockResolvedValue(SAMPLE);
    mount(<TreeWalker />);
    await flush();
    expect(container.querySelector('[data-testid="tw-anchor"]')?.textContent).toMatch(/Walking/);
    expect(container.querySelector('[data-testid="tw-anchor"]')?.textContent).toMatch(/command-redesign/);
    // PHASE 2 item f: the branch tier is named by the spine itself — no `branch:` prefix.
    expect(container.querySelector('[data-testid="tw-spine"]')?.textContent).toMatch(/command-redesign/);
    expect(container.querySelector('[data-testid="tw-spine"]')?.textContent).not.toMatch(/branch:command-redesign/);
  });
});

describe('TreeWalker — Jump to trunk NAVIGATES (PHASE 2 item d)', () => {
  it('clicking Jump to trunk re-anchors the walk on the trunk head (explicit-anchor read)', async () => {
    mockApi.treewalker.getResumeThread.mockResolvedValue(SAMPLE);
    mockApi.treewalker.getThread.mockResolvedValue(SAMPLE);
    mount(<TreeWalker />);
    await flush();
    expect(mockApi.treewalker.getThread).not.toHaveBeenCalled();

    const jumpBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      /Jump to trunk/i.test(b.textContent ?? ''),
    );
    expect(jumpBtn).toBeTruthy();
    expect((jumpBtn as HTMLButtonElement).disabled).toBe(false);
    act(() => jumpBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await flush();

    // The handler is not inert: it navigates — the screen re-reads the thread anchored
    // on the trunk head the backend served (the project's newest handoff).
    expect(mockApi.treewalker.getThread).toHaveBeenCalledTimes(1);
    expect(mockApi.treewalker.getThread.mock.calls[0][0]).toBe(TRUNK_HEAD);
  });

  it('with NO trunk head (no handoffs) the jump control is disabled — never a dead click', async () => {
    mockApi.treewalker.getResumeThread.mockResolvedValue({ ...SAMPLE, trunkAnchorId: null });
    mount(<TreeWalker />);
    await flush();
    const jumpBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      /Jump to trunk/i.test(b.textContent ?? ''),
    );
    expect((jumpBtn as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('TreeWalker — BranchRail resume surface (PHASE 2 item c)', () => {
  it('lists branches newest-first as served, and clicking one re-anchors on its spine', async () => {
    const SPINE_ID = 'b0000000-0000-4000-8000-000000000002';
    mockApi.treewalker.getResumeThread.mockResolvedValue(SAMPLE);
    mockApi.treewalker.getThread.mockResolvedValue(SAMPLE);
    mockApi.treewalker.getBranches.mockResolvedValue({
      branches: [
        { spineId: SPINE_ID, spineType: 'task', name: 'phase2-derived-tiers', named: true, members: 7, lastActiveAt: '2026-08-13T00:00:00Z', open: true, isTopLevel: true, sectionCount: 0 },
        { spineId: 'c0000000-0000-4000-8000-000000000003', spineType: 'decision', name: 'older-branch', named: false, members: 2, lastActiveAt: '2026-08-10T00:00:00Z', open: false, isTopLevel: true, sectionCount: 0 },
      ],
      total: 2,
      cap: 30,
    });
    mount(<TreeWalker />);
    await flush();

    const rail = container.querySelector('[data-testid="tw-branches"]');
    expect(rail?.textContent).toMatch(/phase2-derived-tiers/);
    // Order preserved as served (newest-active first).
    expect(rail?.textContent?.indexOf('phase2-derived-tiers')).toBeLessThan(
      rail?.textContent?.indexOf('older-branch') ?? -1,
    );

    const branchBtn = Array.from(rail?.querySelectorAll('button') ?? []).find((b) =>
      /phase2-derived-tiers/.test(b.textContent ?? ''),
    );
    act(() => branchBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await flush();
    expect(mockApi.treewalker.getThread).toHaveBeenCalledTimes(1);
    expect(mockApi.treewalker.getThread.mock.calls[0][0]).toBe(SPINE_ID);
  });

  it('honest empty state when a project has no branches', async () => {
    mockApi.treewalker.getResumeThread.mockResolvedValue(SAMPLE);
    mockApi.treewalker.getBranches.mockResolvedValue({ branches: [], total: 0, cap: 30 });
    mount(<TreeWalker />);
    await flush();
    expect(container.querySelector('[data-testid="tw-branches"]')?.textContent).toMatch(
      /no branches yet/i,
    );
  });
});

describe('TreeWalker — honest empty thread (no fabricated data)', () => {
  it('renders the honest empty canvas + story state for a genuinely-empty thread', async () => {
    mockApi.treewalker.getResumeThread.mockResolvedValue(EMPTY);
    mount(<TreeWalker />);
    await flush();
    expect(container.querySelector('[data-testid="tw-canvas"]')?.textContent).toMatch(
      /No records on this thread yet/i,
    );
    expect(container.querySelector('[data-testid="tw-story"]')?.textContent).toMatch(
      /No story steps yet/i,
    );
    // The empty spine falls back to the honest placeholder, not a fabricated lineage.
    expect(container.querySelector('[data-testid="tw-spine"]')?.textContent).toMatch(
      /thread lineage appears here/i,
    );
  });
});

describe('TreeWalker — Graph/Story view toggle', () => {
  it('hides the canvas when Story view is selected, restores it on Graph', async () => {
    mockApi.treewalker.getResumeThread.mockResolvedValue(SAMPLE);
    mount(<TreeWalker />);
    await flush();
    // Default = Graph: the canvas is present.
    expect(container.querySelector('[data-testid="tw-canvas"]')).not.toBeNull();

    const storyBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      /^\s*Story\s*$/i.test(b.textContent ?? ''),
    );
    expect(storyBtn).toBeTruthy();
    act(() => storyBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(container.querySelector('[data-testid="tw-canvas"]')).toBeNull();

    const graphBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      /^\s*Graph\s*$/i.test(b.textContent ?? ''),
    );
    act(() => graphBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(container.querySelector('[data-testid="tw-canvas"]')).not.toBeNull();
  });
});

describe('TreeWalker — head note derives from the active project', () => {
  it('shows "<project name> · work map" when a project resolves — never a hardcoded company name', async () => {
    mockApi.treewalker.getResumeThread.mockResolvedValue(SAMPLE);
    mount(<TreeWalker />);
    await flush();
    expect(container.textContent).toContain('acme-widgets · work map');
    // The class this test pins: company branding baked into the shipped page.
    expect(container.textContent).not.toMatch(/riverbend/i);
  });

  it('falls back to the neutral "work map" (no company fallback) when no project resolves', async () => {
    mockAllProjects = [];
    mockDefaultProjectId = undefined;
    mockApi.treewalker.getResumeThread.mockResolvedValue(EMPTY);
    mount(<TreeWalker />);
    await flush();
    expect(container.textContent).toContain('work map');
    expect(container.textContent).not.toMatch(/riverbend/i);
  });
});
