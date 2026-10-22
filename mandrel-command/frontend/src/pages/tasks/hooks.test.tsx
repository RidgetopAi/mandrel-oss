/**
 * Tasks analytics-hooks wiring (extended by epic 41293984) — proves the
 * RANGE-AWARE reads call the right unified-client endpoint with the right params AND with
 * the page's own request scope:
 *   - useTaskThroughput → api.tasks.throughput({ range, project_id? }, scope)
 *   - useTaskCompletedByActor → api.tasks.completedByActor({ range, project_id? }, scope)
 *   - useTaskLeadTime → api.tasks.leadTime({ range, project_id? }, scope)
 *   - a `range` change refetches (it's in the query key)
 *   - 'all' scope omits project_id; a real project id includes it
 *   - disabled (non-analytics view) never fires
 *
 * ── WHY THE SECOND ARGUMENT IS ASSERTED, NOT JUST THE PARAMS ────────────────────────
 * The params alone were sufficient while the ambient X-Project-ID always equalled what the
 * page displayed. Epic 41293984 breaks that equality by design: the ambient header is
 * pinned to the user's DEFAULT project while each page selects its own. A read that names
 * the project ONLY in the query param is still correct today (query beats header in the
 * backend resolver) — but these hooks are also the shape the write surfaces copy, and a
 * scope silently dropped here is invisible. So every case asserts the SECOND argument is
 * the config `usePageProject().scope()` produced, keyed on the REAL header name from
 * apiConfig rather than a hardcoded string (C4 — never hardcode a config-derived value in
 * a test; derive it from the same source the product reads).
 *
 * These assertions are about the ARGUMENT the hook passed. The end-to-end proof that the
 * header actually scopes the response — a row planted in a second project, asserted absent
 * — lives in backend/src/__tests__/pageScopedProjectScope.db.test.ts, against real Postgres.
 *
 * Same harness as the rest of the suite (raw react-dom + React.act + QueryClientProvider;
 * this repo has NO @testing-library).
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../api', () => ({
  api: {
    tasks: {
      leadTime: vi.fn(),
      throughput: vi.fn(),
      completedByActor: vi.fn(),
    },
  },
}));

import { api } from '../../api';
import { useTaskLeadTime, useTaskThroughput, useTaskCompletedByActor } from './hooks';
import { scopedRequestConfig } from '../../api/http/projectScope';
import { apiConfig } from '../../config/apiConfig';

/** A real uuid — `scopedRequestConfig` rejects anything that is not one. */
const PROJ_1 = '11111111-1111-4111-8111-111111111111';
const PROJ_9 = '99999999-9999-4999-8999-999999999999';

/**
 * The page's scope function, exactly as `usePageProject().scope` is handed to these hooks.
 * Built from the PRODUCT's own primitive, so if `scopedRequestConfig` changes shape this
 * test follows it instead of pinning a stale copy.
 */
const scopeFor = (projectId: string) => () => scopedRequestConfig(projectId);

/** What that scope should have put on the wire, for the expectation side. */
const expectedScope = (projectId: string) => ({
  headers: { [apiConfig.projectHeader]: projectId },
});

const mockApi = api as unknown as {
  tasks: {
    leadTime: ReturnType<typeof vi.fn>;
    throughput: ReturnType<typeof vi.fn>;
    completedByActor: ReturnType<typeof vi.fn>;
  };
};

const Probe: React.FC<{ run: () => unknown }> = ({ run }) => {
  run();
  return null;
};

let container: HTMLDivElement;
let root: Root;
let client: QueryClient;

async function mount(run: () => unknown) {
  container = document.createElement('div');
  document.body.appendChild(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  await act(async () => {
    root = createRoot(container);
    root.render(
      <QueryClientProvider client={client}>
        <Probe run={run} />
      </QueryClientProvider>,
    );
  });
  await settle();
}

async function rerender(run: () => unknown) {
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <Probe run={run} />
      </QueryClientProvider>,
    );
  });
  await settle();
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

beforeEach(() => {
  vi.clearAllMocks();
  mockApi.tasks.leadTime.mockResolvedValue({
    distribution: [],
    stats: { totalTasks: 0, averageLeadTime: 0, medianLeadTime: 0, p90LeadTime: 0 },
  });
  mockApi.tasks.throughput.mockResolvedValue([]);
  mockApi.tasks.completedByActor.mockResolvedValue([]);
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
});

describe('useTaskThroughput — GET /api/tasks/throughput, range + project scoped', () => {
  it('scopes to a project id and passes the range', async () => {
    await mount(() => useTaskThroughput(PROJ_1, scopeFor(PROJ_1), '7d', true));
    expect(mockApi.tasks.throughput).toHaveBeenCalledWith(
      { range: '7d', project_id: PROJ_1 },
      expectedScope(PROJ_1),
    );
  });

  it('omits project_id for the "all" scope (range still passed)', async () => {
    await mount(() => useTaskThroughput('all', scopeFor('all'), '30d', true));
    // 'all' is a CHOSEN widening: the header is explicitly blanked rather than left to the
    // interceptor, or the ambient default would narrow an all-projects view back to one.
    expect(mockApi.tasks.throughput).toHaveBeenCalledWith(
      { range: '30d' },
      { headers: { [apiConfig.projectHeader]: undefined } },
    );
  });

  it('does not fire when disabled (non-analytics view)', async () => {
    await mount(() => useTaskThroughput(PROJ_1, scopeFor(PROJ_1), '7d', false));
    expect(mockApi.tasks.throughput).not.toHaveBeenCalled();
  });

  it('MUTATION — a scope that cannot name a project THROWS rather than sending unscoped', async () => {
    // The §A2 state: no default, no selection. `scope()` must not degrade to "send
    // nothing" — several backend controllers read a missing project as EVERY project.
    expect(() => scopedRequestConfig(undefined)).toThrow(/unscoped request/i);
  });
});

describe('useTaskCompletedByActor — GET /api/tasks/completed-by-actor, range + project scoped', () => {
  it('scopes to a project id and passes the range', async () => {
    await mount(() => useTaskCompletedByActor(PROJ_9, scopeFor(PROJ_9), '90d', true));
    expect(mockApi.tasks.completedByActor).toHaveBeenCalledWith(
      { range: '90d', project_id: PROJ_9 },
      expectedScope(PROJ_9),
    );
  });

  it('omits project_id for the "all" scope', async () => {
    await mount(() => useTaskCompletedByActor('all', scopeFor('all'), 'all', true));
    expect(mockApi.tasks.completedByActor).toHaveBeenCalledWith(
      { range: 'all' },
      { headers: { [apiConfig.projectHeader]: undefined } },
    );
  });
});

describe('useTaskLeadTime — now RANGE-AWARE (threads range through)', () => {
  it('passes the range param alongside the project scope', async () => {
    await mount(() => useTaskLeadTime(PROJ_1, scopeFor(PROJ_1), '7d', true));
    expect(mockApi.tasks.leadTime).toHaveBeenCalledWith(
      { range: '7d', project_id: PROJ_1 },
      expectedScope(PROJ_1),
    );
  });

  it('refetches with the new range when the range changes (range is in the query key)', async () => {
    await mount(() => useTaskLeadTime(PROJ_1, scopeFor(PROJ_1), '7d', true));
    expect(mockApi.tasks.leadTime).toHaveBeenCalledWith(
      { range: '7d', project_id: PROJ_1 },
      expectedScope(PROJ_1),
    );
    await rerender(() => useTaskLeadTime(PROJ_1, scopeFor(PROJ_1), '30d', true));
    expect(mockApi.tasks.leadTime).toHaveBeenCalledWith(
      { range: '30d', project_id: PROJ_1 },
      expectedScope(PROJ_1),
    );
  });

  it('a project SWITCH re-reads with the new project in BOTH the param and the scope', async () => {
    await mount(() => useTaskLeadTime(PROJ_1, scopeFor(PROJ_1), '7d', true));
    await rerender(() => useTaskLeadTime(PROJ_9, scopeFor(PROJ_9), '7d', true));
    // The project is in the query key, so this is a genuinely new read — not the previous
    // project's cached rows relabelled.
    expect(mockApi.tasks.leadTime).toHaveBeenCalledWith(
      { range: '7d', project_id: PROJ_9 },
      expectedScope(PROJ_9),
    );
  });
});
