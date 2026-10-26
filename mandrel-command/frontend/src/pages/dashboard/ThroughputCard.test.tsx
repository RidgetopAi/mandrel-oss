/**
 * ThroughputCard render + wiring tests. Mounts the Dashboard throughput card into
 * jsdom (createRoot + async act — the repo pattern) behind a QueryClientProvider,
 * with the UNIFIED `api` client MOCKED (the client, never the ThroughputChart —
 * no lying mocks). Proves the three required states — data / empty / loading — plus the
 * load-bearing wiring: which PROJECT the card asks about.
 *
 * ── THE ASSERTION THAT WAS INVERTED ──────────────────────────────────
 * This file used to assert `api.tasks.throughput` was called "MANDREL-WIDE — configured
 * range, NO project_id", and called that its mutation anchor: "point the hook at a project
 * and it goes RED." It did exactly that, which made it a guard holding the DEFECT in place.
 *
 * `/api/tasks/throughput` resolves a `ProjectListScope` on the backend, so a call naming no
 * project is not workspace-wide — it is scoped by the ambient `X-Project-ID` header, i.e.
 * to the user's default project, invisibly. The card rendered one project's series under a
 * "Mandrel-wide" caption. The old assertion was true about the CODE and false about the
 * SYSTEM, and it would have made the fix look like the regression.
 *
 * Inverted, not deleted: the shape is the same (exact-match on the call), only the correct
 * answer changed. It now asserts the card names the project it was GIVEN — in the query
 * param AND in the `X-Project-ID` the page's `scope()` pinned.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('../../api', () => ({
  api: {
    tasks: { throughput: vi.fn() },
  },
}));

import { ThroughputCard } from './ThroughputCard';
import { api } from '../../api';
import { DASHBOARD_CONFIG, THROUGHPUT_RANGE_LABEL } from './config';

/** The project the page hands down, and one it must never substitute for it. */
const PAGE_PROJECT = 'aaaaaaaa-1111-4111-8111-111111111111';
const OTHER_PROJECT = 'bbbbbbbb-2222-4222-8222-222222222222';

/**
 * A stand-in for `usePageProject().scope`, with the same contract that matters here: it
 * pins the header to the page's project. Real enough to assert on, and it THROWS on an
 * absent project exactly as the shared primitive does, so a card that called it without a
 * scope would fail loudly instead of quietly widening.
 */
const scopeFor =
  (projectId: string | undefined) =>
  (base?: Record<string, unknown>) => {
    if (!projectId) throw new Error('Refusing to send an unscoped request');
    return { ...base, headers: { 'X-Project-ID': projectId } };
  };

const mockApi = api as unknown as {
  tasks: { throughput: ReturnType<typeof vi.fn> };
};

const HAPPY_SERIES = [
  { day: '2026-07-14', completed: 3, created: 5 },
  { day: '2026-07-15', completed: 7, created: 2 },
];

let container: HTMLDivElement;
let root: Root;

function makeClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
}

/**
 * `projectId` is REQUIRED, deliberately. It was a defaulted parameter, and a JS default
 * fires on an explicitly-passed `undefined` — so `mount(undefined)`, the whole point of the
 * empty-population case, silently mounted with the default project and the test asserted
 * nothing. The absent value must not be spellable the same way as "I didn't say".
 */
async function mountWith(projectId: string | undefined) {
  container = document.createElement('div');
  document.body.appendChild(container);
  const client = makeClient();
  await act(async () => {
    root = createRoot(container);
    root.render(
      <QueryClientProvider client={client}>
        <ThroughputCard
          projectId={projectId}
          scope={scopeFor(projectId) as never}
        />
      </QueryClientProvider>,
    );
  });
}

/** The ordinary case: the page handed this card a project. */
const mount = () => mountWith(PAGE_PROJECT);

async function settle() {
  for (let i = 0; i < 4; i++) {
    // eslint-disable-next-line no-await-in-loop
    await act(async () => {
      await Promise.resolve();
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
});

describe('ThroughputCard — data state', () => {
  it('renders the section head and the throughput chart from real series', async () => {
    mockApi.tasks.throughput.mockResolvedValue(HAPPY_SERIES);
    await mount();
    await settle();
    const text = container.textContent ?? '';
    expect(text).toContain('Task throughput'); // the SectionHead
    expect(text).toContain('Throughput vs created'); // the reused chart title
    expect(text).toContain(`tasks / day · ${THROUGHPUT_RANGE_LABEL}`); // config-driven caption
  });

  it('NAMES the page project — in the query param AND in the pinned header', async () => {
    // Mutation anchor: drop either spelling of the project, or change the range away from
    // config, and this exact-match assertion goes RED. Both spellings are asserted because
    // they fail differently: without the query param the ambient header decides the read,
    // and without the header a write from this scope would land in the default project.
    mockApi.tasks.throughput.mockResolvedValue(HAPPY_SERIES);
    await mount();
    await settle();
    expect(mockApi.tasks.throughput).toHaveBeenCalledWith(
      { range: DASHBOARD_CONFIG.throughputRange, project_id: PAGE_PROJECT },
      { headers: { 'X-Project-ID': PAGE_PROJECT } },
    );
  });

  it('follows the project it is GIVEN — it holds no scope of its own', async () => {
    mockApi.tasks.throughput.mockResolvedValue(HAPPY_SERIES);
    await mountWith(OTHER_PROJECT);
    await settle();
    const [params, config] = mockApi.tasks.throughput.mock.calls[0];
    expect(params.project_id).toBe(OTHER_PROJECT);
    expect(config.headers['X-Project-ID']).toBe(OTHER_PROJECT);
  });

  it('THE EMPTY POPULATION — with no project it asks NOTHING, rather than asking for everything', async () => {
    mockApi.tasks.throughput.mockResolvedValue(HAPPY_SERIES);
    await mountWith(undefined);
    await settle();
    // An unscoped call here is not "no data" — for an admin the backend reads it as every
    // project. The card's query must stay gated off until the page knows its scope.
    expect(mockApi.tasks.throughput).not.toHaveBeenCalled();
  });
});

describe('ThroughputCard — empty state', () => {
  it('shows the honest empty state when the series is empty (no fabricated trend)', async () => {
    mockApi.tasks.throughput.mockResolvedValue([]);
    await mount();
    await settle();
    expect(container.textContent ?? '').toContain('No activity in this window');
  });
});

describe('ThroughputCard — loading state', () => {
  it('shows a spinner while the throughput query is in flight', async () => {
    mockApi.tasks.throughput.mockImplementation(() => new Promise(() => {}));
    await mount();
    expect(container.querySelector('[role="status"]')).not.toBeNull();
  });
});

describe('ThroughputCard — error state', () => {
  it('surfaces an Alert when the throughput query fails', async () => {
    mockApi.tasks.throughput.mockImplementation(() => Promise.reject(new Error('backend down')));
    await mount();
    await settle();
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
  });
});
