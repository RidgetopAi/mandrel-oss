/**
 * Decisions render tests (P2 why-ledger rebuild) — mirrors the Contexts/Tasks test style:
 * createRoot + async act into jsdom, behind QueryClientProvider + MemoryRouter, with the
 * UNIFIED `api` client mocked. Proves the required states (data / loading / empty / error),
 * the list→reader selection, the reader field mapping (rationale / alternatives / success
 * criteria / outcome), the LIVE facet counts, honest empty-field states, the client-side
 * type filter, and — critically — the TYPED thread box built from REAL graph edges (the
 * moat), including its honest empty state (data-gap policy: never fake edges). Structural
 * wiring (no antd, unified client, typed-not-related, no hex) is in Decisions.wiring.test.ts.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

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

/**
 * PAGE PROJECT. The ledger owns its project now — there is no global
 * selector to follow, and no "All Projects" option (the outcome drawer's write has to name
 * a real project). `projectState.projects` is mutable so the genuine no-project state can
 * be exercised; the default is one concrete project, which every render test needs because
 * `scope()` throws rather than sending an unscoped request.
 *
 * The dedicated scoping cases — page project vs ambient default, `?project=`, the write
 * direction, the mutation probes — live in Decisions.scope.test.tsx.
 */
const PAGE_PROJECT = { id: 'aaaaaaaa-0000-4000-8000-aaaaaaaa0001', name: 'riverbend' };
const projectState = vi.hoisted(() => ({
  projects: [] as { id: string; name: string }[],
  defaultProjectId: undefined as string | undefined,
}));
vi.mock('../contexts/ProjectContext', () => ({
  useProjectContext: () => ({ setSelectedProjectId: () => undefined,
    currentProject: null,
    allProjects: projectState.projects,
    loading: false,
  }),
  useEffectiveProjectId: () => projectState.defaultProjectId,
}));
vi.mock('../hooks/useSettings', () => ({
  useSettings: () => ({ defaultProjectId: projectState.defaultProjectId }),
}));

import Decisions from './Decisions';
import { api } from '../api';

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

const DEC_A = {
  id: 'aaaaaaaa-1111-2222-3333-444444444444',
  project_id: 'p-coordinator',
  project_name: 'riverbend',
  title: 'Sessions page — a live stream = (actor x project) as a view',
  problem: 'Operator wants work cleanly separated per project.',
  decision: 'A live stream = one card per (actor x project), a derived view.',
  rationale: 'Delivers per-project separation with zero change to the foundation.',
  decision_type: 'ui_ux',
  impact_level: 'medium',
  status: 'active',
  implementationStatus: 'in_progress',
  successCriteria: 'Sessions page renders streams grouped by (actor x project).',
  outcomeStatus: 'too_early',
  outcomeNotes: null,
  alternatives: ['Stream = actor only (zero build)', 'Re-key session to (actor x project)'],
  affected_components: ['mandrel-command', 'sessions-page'],
  tags: ['command-redesign', 'sessions', 'ref:north-star'],
  created_at: NOW,
  updated_at: NOW,
};
const DEC_B = {
  id: 'bbbbbbbb-1111-2222-3333-444444444444',
  project_id: 'p-coordinator',
  project_name: 'riverbend',
  title: 'Sessions foundation — actor-only identity (the one resolver)',
  problem: 'Need one identity for a session.',
  decision: 'Actor-only identity.',
  rationale: '',
  decision_type: 'architecture',
  impact_level: 'high',
  status: 'active',
  successCriteria: '',
  outcomeStatus: 'successful',
  alternatives: [],
  affected_components: [],
  tags: ['sessions'],
  created_at: NOW,
  updated_at: NOW,
};

const LINKS = [
  {
    edgeType: 'decided_by',
    direction: 'incoming',
    otherId: 'cccccccc-1111-2222-3333-444444444444',
    otherType: 'context',
    otherTitle: 'Sessions screen mock LOCKED — live streams',
    otherKind: 'milestone',
  },
  {
    edgeType: 'caused',
    direction: 'outgoing',
    otherId: 'dddddddd-1111-2222-3333-444444444444',
    otherType: 'task',
    otherTitle: 'Serialize actor on session read',
    otherKind: 'task',
  },
];

const STATS = {
  total_decisions: 41,
  by_type: { architecture: 14, ui_ux: 6, process: 8, deployment: 5 },
  by_impact: { high: 12, medium: 17, low: 12 },
  by_status: { active: 41 },
};

function setHappy() {
  mockApi.decisions.search.mockResolvedValue({
    decisions: [DEC_A, DEC_B],
    total: 2,
    limit: 150,
    page: 1,
  });
  mockApi.decisions.stats.mockResolvedValue(STATS);
  mockApi.decisions.get.mockResolvedValue(DEC_A);
  mockApi.decisions.links.mockResolvedValue(LINKS);
}

let container: HTMLDivElement;
let root: Root;

function makeClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
}

async function mount() {
  container = document.createElement('div');
  document.body.appendChild(container);
  const client = makeClient();
  await act(async () => {
    root = createRoot(container);
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <Decisions />
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

function clickFacet(label: string) {
  const btn = Array.from(container.querySelectorAll('button')).find(
    (b) => (b.textContent ?? '').trim().startsWith(label),
  );
  if (!btn) throw new Error(`facet "${label}" not found`);
  btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

beforeEach(() => {
  vi.clearAllMocks();
  // One concrete project, which is also the user's default — the baseline every render
  // test needs, since every read is gated on the page having a project.
  projectState.projects = [PAGE_PROJECT];
  projectState.defaultProjectId = PAGE_PROJECT.id;
  setHappy();
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
});

describe('Decisions — data state', () => {
  it('renders the list and auto-selects the first row into the reader', async () => {
    await mount();
    await settle();
    const text = container.textContent ?? '';
    expect(text).toContain('Sessions page — a live stream');
    expect(text).toContain('Sessions foundation — actor-only identity');
    // reader fetched the selected record by id
    expect(mockApi.decisions.get).toHaveBeenCalledWith(DEC_A.id);
  });

  it('maps the real decision fields into the reader (rationale / alternatives / criteria / outcome)', async () => {
    await mount();
    await settle();
    const text = container.textContent ?? '';
    expect(text).toContain('Delivers per-project separation'); // rationale
    expect(text).toContain('Stream = actor only (zero build)'); // an alternative
    expect(text).toContain('Sessions page renders streams grouped'); // success criteria
    expect(text).toContain('too early'); // outcome label (humanized)
  });

  it('wires LIVE facet counts from stats (never fabricated)', async () => {
    await mount();
    await settle();
    const text = container.textContent ?? '';
    expect(text).toContain('41'); // total_decisions
    expect(text).toContain('14'); // architecture by_type count
  });
});

describe('Decisions — honest empty-field states (data-gap policy)', () => {
  it('renders "not recorded" placeholders for empty rationale / criteria / alternatives', async () => {
    mockApi.decisions.get.mockResolvedValue(DEC_B); // empty rationale / criteria / alternatives
    await mount();
    await settle();
    const text = container.textContent ?? '';
    expect(text).toContain('No rationale recorded.');
    expect(text).toContain('No success criteria recorded.');
    expect(text).toContain('No alternatives recorded.');
  });
});

describe('Decisions — the typed thread box (the moat)', () => {
  it('renders REAL typed edges with their labels + target titles', async () => {
    await mount();
    await settle();
    const text = container.textContent ?? '';
    expect(mockApi.decisions.links).toHaveBeenCalledWith(DEC_A.id);
    expect(text).toContain('What this decision shaped');
    expect(text).toContain('decides'); // incoming decided_by label
    expect(text).toContain('caused'); // outgoing caused label
    expect(text).toContain('Serialize actor on session read'); // real target title
  });

  it('shows an honest empty state (no fabricated edges) when there are no typed edges', async () => {
    mockApi.decisions.links.mockResolvedValue([]);
    await mount();
    await settle();
    expect(container.textContent).toContain('No typed edges yet');
  });
});

describe('Decisions — client-side type filter', () => {
  it('narrows the list to a type with no matches → honest empty (the deployment facet)', async () => {
    await mount();
    await settle();
    clickFacet('deployment'); // neither DEC_A (ui_ux) nor DEC_B (architecture)
    await settle();
    expect(container.textContent).toContain('No decisions');
  });
});

describe('Decisions — loading state', () => {
  it('shows a spinner while the list query is in flight', async () => {
    mockApi.decisions.search.mockImplementation(() => new Promise(() => {}));
    mockApi.decisions.stats.mockImplementation(() => new Promise(() => {}));
    await mount();
    expect(container.querySelector('[role="status"]')).not.toBeNull();
  });
});

describe('Decisions — empty state', () => {
  it('shows Empty when there are no decisions', async () => {
    mockApi.decisions.search.mockResolvedValue({ decisions: [], total: 0, limit: 150, page: 1 });
    await mount();
    await settle();
    expect(container.textContent).toContain('No decisions');
  });
});

describe('Decisions — error state', () => {
  it('surfaces an Alert when the list query fails', async () => {
    mockApi.decisions.search.mockImplementation(() => Promise.reject(new Error('backend down')));
    await mount();
    await settle();
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
  });
});

describe('Decisions — search', () => {
  it('re-queries with the typed search term', async () => {
    await mount();
    await settle();
    const input = container.querySelector('input[aria-label="Search decisions"]') as HTMLInputElement;
    expect(input).not.toBeNull();
    await act(async () => {
      typeInto(input, 'live stream');
    });
    await settle();
    // The search carries the page's own request scope. GET /api/decisions
    // takes no project query param of its own — the backend resolves it from the request —
    // so the header IS the scope, and dropping it would search the ambient project's ledger
    // while the page's heading names another.
    expect(mockApi.decisions.search).toHaveBeenCalledWith(
      expect.objectContaining({ query: 'live stream' }),
      expect.objectContaining({
        headers: expect.objectContaining({ 'X-Project-ID': PAGE_PROJECT.id }),
      }),
    );
  });
});
