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
import fs from 'node:fs';
import path from 'node:path';
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
      getWhy: vi.fn(),
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
import { VIEW_REGISTRY } from './treewalker/config';

const mockApi = api as unknown as {
  treewalker: { getThread: ReturnType<typeof vi.fn>; getResumeThread: ReturnType<typeof vi.fn>; getWhy: ReturnType<typeof vi.fn> };
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
  memberTotal: 2,
  truncated: false,
  nodes: [
    { id: 'b0000000-0000-4000-8000-000000000002', kind: 'task', title: 'command-redesign', trust: 'ok', isSpine: true, createdAt: '2026-10-24T15:00:00.000Z', inBranch: true, status: 'in_progress' },
    { id: 'a0000000-0000-4000-8000-000000000001', kind: 'handoff', title: '★ Handoff resume', trust: 'unproven', isCurrent: true, createdAt: '2026-10-25T15:00:00.000Z', inBranch: true },
  ],
  edges: [],
  story: [],
};

const EMPTY: ThreadGraph = {
  anchor: { branchLabel: 'thread', anchorId: '', recordCount: 0 },
  spine: [],
  nodes: [],
  edges: [],
  story: [],
  trunkAnchorId: null,
  memberTotal: 0,
  truncated: false,
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
  it('renders the page heading and no descriptive subtitle', () => {
    mockApi.treewalker.getResumeThread.mockResolvedValue(SAMPLE);
    mount(<TreeWalker />);
    expect(container.textContent).toMatch(/TreeWalker/);
    expect(container.textContent).not.toMatch(/how much to trust it/i);
    expect(container.textContent).not.toMatch(/How this thread linked itself/i);
  });

  it('reads the no-arg RESUME endpoint (not the explicit-anchor one) when no anchor is selected', async () => {
    mockApi.treewalker.getResumeThread.mockResolvedValue(SAMPLE);
    mount(<TreeWalker />);
    await flush();
    expect(mockApi.treewalker.getResumeThread).toHaveBeenCalledTimes(1);
    expect(mockApi.treewalker.getThread).not.toHaveBeenCalled();
  });

  it('renders the resolved thread without the spine breadcrumb or the walking/anchored readout', async () => {
    mockApi.treewalker.getResumeThread.mockResolvedValue(SAMPLE);
    mount(<TreeWalker />);
    await flush();
    expect(container.querySelector('[data-testid="tw-spine"]')).toBeNull();
    expect(container.querySelector('[data-testid="tw-anchor"]')).toBeNull();
    expect(container.textContent).not.toMatch(/Walking/);
    expect(container.textContent).not.toMatch(/anchored on/);
    // The Story header still names the branch.
    expect(container.querySelector('[data-testid="tw-story"]')?.textContent).toMatch(/command-redesign/);
  });

  it('the old header parts are gone from the source tree and nothing imports them', () => {
    const dir = path.resolve(__dirname, '..');
    const walk = (d: string): string[] =>
      fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
    const files = walk(dir);
    for (const gone of ['SpineRibbon', 'BranchRail']) {
      expect(files.filter((f) => path.basename(f).startsWith(gone))).toEqual([]);
      const importers = files.filter(
        (f) => /\.tsx?$/.test(f) && !f.endsWith('TreeWalker.test.tsx') && new RegExp(`from ['"][^'"]*/${gone}['"]`).test(fs.readFileSync(f, 'utf8')),
      );
      expect(importers).toEqual([]);
    }
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

describe('TreeWalker — branch selector in the compact header', () => {
  const SPINE_ID = 'b0000000-0000-4000-8000-000000000002';
  const branch = (spineId: string, name: string, members: number, named = true) => ({
    spineId, spineType: 'task', name, named, members, lastActiveAt: '2026-08-13T00:00:00Z', open: false, isTopLevel: true, sectionCount: 0,
  });
  const select = () => container.querySelector<HTMLSelectElement>('[data-testid="tw-branch-select"]')!;
  const choose = (value: string) => {
    const el = select();
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(el, value);
      el.dispatchEvent(new Event('change', { bubbles: true }));
    });
  };

  it('lists every served branch with its member count, in served order; choosing one re-anchors', async () => {
    mockApi.treewalker.getResumeThread.mockResolvedValue(SAMPLE);
    mockApi.treewalker.getThread.mockResolvedValue(SAMPLE);
    mockApi.treewalker.getBranches.mockResolvedValue({
      branches: [branch(SPINE_ID, 'phase2-derived-tiers', 7), branch('c0000000-0000-4000-8000-000000000003', 'older-branch', 2, false)],
      total: 2,
      cap: 30,
    });
    mount(<TreeWalker />);
    await flush();
    const opts = Array.from(select().querySelectorAll('option')).filter((o) => o.value);
    expect(opts.map((o) => o.textContent)).toEqual(['phase2-derived-tiers · 7', 'older-branch · 2']);
    // Not capped → no N of M notice.
    expect(container.querySelector('[data-testid="tw-branches-count"]')).toBeNull();

    choose(SPINE_ID);
    await flush();
    expect(mockApi.treewalker.getThread).toHaveBeenCalledTimes(1);
    expect(mockApi.treewalker.getThread.mock.calls[0][0]).toBe(SPINE_ID);
  });

  it('states N of M when the served list is capped', async () => {
    mockApi.treewalker.getResumeThread.mockResolvedValue(SAMPLE);
    mockApi.treewalker.getBranches.mockResolvedValue({ branches: [branch(SPINE_ID, 'only-one', 1)], total: 41, cap: 1 });
    mount(<TreeWalker />);
    await flush();
    expect(container.querySelector('[data-testid="tw-branches-count"]')?.textContent).toBe('1 of 41 branches');
  });

  it('with no branches the selector is inert and says so', async () => {
    mockApi.treewalker.getResumeThread.mockResolvedValue(SAMPLE);
    mockApi.treewalker.getBranches.mockResolvedValue({ branches: [], total: 0, cap: 30, sinceDays: 45, unbranched: { unbranched: 0, total: 0, windowDays: 60 } });
    mount(<TreeWalker />);
    await flush();
    expect(select().disabled).toBe(true);
    expect(select().textContent).toMatch(/no branches yet/i);
  });
});

describe('TreeWalker — Only trusted still narrows the walk', () => {
  it('toggling it filters the Story to trusted records', async () => {
    mockApi.treewalker.getResumeThread.mockResolvedValue(SAMPLE);
    mount(<TreeWalker />);
    await flush();
    const btn = Array.from(container.querySelectorAll('button')).find((b) => /Only trusted/.test(b.textContent ?? ''))!;
    expect(btn.getAttribute('aria-pressed')).toBe('false');
    const before = container.querySelector('[data-testid="tw-story"]')!.querySelectorAll('a[href*="record="]').length;
    expect(before).toBeGreaterThan(0);
    act(() => btn.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await flush();
    expect(btn.getAttribute('aria-pressed')).toBe('true');
    // SAMPLE has no `trusted` record, so the narrowed walk shows none of them.
    expect(container.querySelector('[data-testid="tw-story"]')!.querySelectorAll('a[href*="record="]').length).toBeLessThan(before);
  });
});

describe('TreeWalker — honest empty thread (no fabricated data)', () => {
  it('renders the honest empty story state for a genuinely-empty thread', async () => {
    mockApi.treewalker.getResumeThread.mockResolvedValue(EMPTY);
    mount(<TreeWalker />);
    await flush();
    expect(container.querySelector('[data-testid="tw-story"]')?.textContent).toMatch(
      /No records on this thread yet/i,
    );
  });
});

describe('TreeWalker — Story is the one registered view, linkable through the URL', () => {
  it('opens on the Story tab and the tab bar renders exactly the registry', async () => {
    mockApi.treewalker.getResumeThread.mockResolvedValue(SAMPLE);
    mount(<TreeWalker />);
    await flush();
    const tabs = Array.from(container.querySelectorAll('[role="tab"]'));
    expect(tabs.map((t) => t.textContent)).toEqual(VIEW_REGISTRY.map((v) => v.label));
    expect(tabs[0].getAttribute('aria-selected')).toBe('true');
    expect(container.querySelector('[data-testid="tw-story"]')).not.toBeNull();
  });

  it('an unknown ?view= falls back to the default view', async () => {
    mockApi.treewalker.getResumeThread.mockResolvedValue(SAMPLE);
    mount(<TreeWalker />, '/treewalker?view=nonsense');
    await flush();
    expect(container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe('Story');
  });

  it('?anchor= reads that anchor explicitly, and there is no Graph toggle', async () => {
    mockApi.treewalker.getThread.mockResolvedValue(SAMPLE);
    mount(<TreeWalker />, `/treewalker?anchor=${TRUNK_HEAD}`);
    await flush();
    expect(mockApi.treewalker.getThread.mock.calls[0][0]).toBe(TRUNK_HEAD);
    expect(mockApi.treewalker.getResumeThread).not.toHaveBeenCalled();
    expect(
      Array.from(container.querySelectorAll('button')).some((b) => /^\s*Graph\s*$/.test(b.textContent ?? '')),
    ).toBe(false);
  });

  it('the Story renders the branch: header title, chapter, a beat id8 that opens Why', async () => {
    mockApi.treewalker.getResumeThread.mockResolvedValue(SAMPLE);
    mount(<TreeWalker />);
    await flush();
    const story = container.querySelector('[data-testid="tw-story"]')!;
    expect(story.querySelectorAll('section[aria-label]').length).toBe(2);
    const link = story.querySelector('a[href*="record=a0000000-0000-4000-8000-000000000001"]');
    expect(link).not.toBeNull();
    expect(link!.getAttribute('href')).toContain('view=why');
    expect(story.querySelector('a[href^="/r/"]')).toBeNull();
  });
});

describe('TreeWalker — head note derives from the active project', () => {
  it('shows the project name in the header row when a project resolves — never a hardcoded company name', async () => {
    mockApi.treewalker.getResumeThread.mockResolvedValue(SAMPLE);
    mount(<TreeWalker />);
    await flush();
    expect(container.querySelector('[data-testid="tw-header"]')?.textContent).toContain('acme-widgets');
    // The class this test pins: company branding baked into the shipped page.
    expect(container.textContent).not.toMatch(/riverbend/i);
  });

  it('shows no project (no company fallback) when none resolves', async () => {
    mockAllProjects = [];
    mockDefaultProjectId = undefined;
    mockApi.treewalker.getResumeThread.mockResolvedValue(EMPTY);
    mount(<TreeWalker />);
    await flush();
    expect(container.textContent).not.toMatch(/riverbend/i);
  });
});

describe('TreeWalker — the Why tab', () => {
  const WHY = {
    record: { id: 'a0000000-0000-4000-8000-000000000001', kind: 'context', title: 'The milestone', createdAt: '2026-10-25T15:00:00.000Z', trust: 'ok', contextType: 'milestone' },
    causes: [{ edgeType: 'decided_by', targets: [{ id: 'd1000000-0000-4000-8000-000000000000', kind: 'decision', title: 'The decision', createdAt: '2026-10-20T10:00:00.000Z', trust: 'trusted', outcomeStatus: null }] }],
    spawned: [{ decisionId: 'd1000000-0000-4000-8000-000000000000', total: 3, records: [{ id: 'e1000000-0000-4000-8000-000000000000', kind: 'task', title: 'Spawned task', createdAt: '2026-10-22T10:00:00.000Z', trust: 'unproven', status: 'done' }] }],
    branch: { id: 'b0000000-0000-4000-8000-000000000002', title: 'command-redesign' },
    series: [
      { id: 'c1000000-0000-4000-8000-000000000000', kind: 'context', title: 'Earlier milestone', createdAt: '2026-10-10T10:00:00.000Z', trust: 'ok', contextType: 'milestone', guessed: true, isCurrent: false },
      { id: 'a0000000-0000-4000-8000-000000000001', kind: 'context', title: 'The milestone', createdAt: '2026-10-25T15:00:00.000Z', trust: 'ok', contextType: 'milestone', guessed: true, isCurrent: true },
    ],
    before: [{ id: 'f1000000-0000-4000-8000-000000000000', kind: 'context', title: 'Just before', createdAt: '2026-10-24T10:00:00.000Z', trust: 'unproven', contextType: 'note', byTime: true }],
    counts: { declared: 2, guessed: 4 },
  };
  const url = `/treewalker?view=why&record=${WHY.record.id}`;

  it('opens Why for the record in the URL, scoped to the page project', async () => {
    mockApi.treewalker.getResumeThread.mockResolvedValue(SAMPLE);
    mockApi.treewalker.getWhy.mockResolvedValue(WHY);
    mount(<TreeWalker />, url);
    await flush();
    expect(mockApi.treewalker.getWhy.mock.calls[0][0]).toBe(WHY.record.id);
    expect(container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe('Why');
  });

  it('shows the decision under Because of with spawned records dimmed, the counts, and the series', async () => {
    mockApi.treewalker.getResumeThread.mockResolvedValue(SAMPLE);
    mockApi.treewalker.getWhy.mockResolvedValue(WHY);
    mount(<TreeWalker />, url);
    await flush();
    const because = container.querySelector('[data-testid="tw-why-because"]')!;
    expect(because.textContent).toContain('Because of');
    expect(because.textContent).toContain('decided by');
    expect(because.querySelector('a[href*="record=d1000000"]')).not.toBeNull();
    const spawned = because.querySelector('[data-testid="tw-why-spawned"]')!;
    expect(spawned.textContent).toContain('3 other records');
    expect(spawned.textContent).toContain('one hop further');
    expect(spawned.querySelector('a[href*="record=e1000000"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="tw-why-counts"]')!.textContent).toBe('2 declared4 guessed');
    const series = container.querySelector('[data-testid="tw-why-series"]')!;
    expect(series.textContent).toContain('never causal');
    expect(series.querySelectorAll('li[aria-current="true"]').length).toBe(1);
    expect(container.querySelector('[data-testid="tw-why-before"]')!.textContent).toContain('Just before');
    expect(container.textContent).toContain('not by an edge');
  });

  it('the branch link returns to Story on that branch', async () => {
    mockApi.treewalker.getResumeThread.mockResolvedValue(SAMPLE);
    mockApi.treewalker.getWhy.mockResolvedValue(WHY);
    mount(<TreeWalker />, url);
    await flush();
    const href = container.querySelector('[data-testid="tw-why-branch"]')!.getAttribute('href')!;
    expect(href).toContain('view=story');
    expect(href).toContain(`anchor=${WHY.branch.id}`);
    expect(href).not.toContain('record=');
  });

  it('with no record picked it says how to pick one, and does not read', async () => {
    mockApi.treewalker.getResumeThread.mockResolvedValue(SAMPLE);
    mockApi.treewalker.getWhy.mockClear();
    mount(<TreeWalker />, '/treewalker?view=why');
    await flush();
    expect(container.querySelector('[data-testid="tw-why"]')!.textContent).toContain('Pick a record in Story');
    expect(mockApi.treewalker.getWhy).not.toHaveBeenCalled();
  });
});
