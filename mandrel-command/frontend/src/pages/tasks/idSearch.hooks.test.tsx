/**
 * useResolveTaskSearch wiring — proves the SERVER-SIDE search-by-id fires
 * the RIGHT single-source resolver with the RIGHT (normalized) id, and ONLY for an
 * id-shaped query:
 *   - an id8 / UUID query → calls api.resolve.record(<normalized id>)  (the SAME
 *     `/api/resolve/:id` resolver `/r/<id8>` uses — no parallel task-by-id path)
 *   - a dashed id → resolves the dash-stripped canonical id
 *   - a prose query → NEVER calls the resolver (left to the client-side substring filter)
 *   - an empty box → NEVER calls the resolver
 * Same harness as hooks.test.tsx (raw react-dom + React.act + QueryClientProvider; this
 * repo has NO @testing-library). `../../api` is mocked so the assertion is on the exact
 * call — mutation-sensitive: drop the normalize or the enabled-gate → red.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../api', () => ({
  api: {
    resolve: {
      record: vi.fn(),
    },
  },
}));

import { api } from '../../api';
import { useResolveTaskSearch } from './hooks';

const mockApi = api as unknown as {
  resolve: { record: ReturnType<typeof vi.fn> };
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
  mockApi.resolve.record.mockResolvedValue({
    status: 'unique',
    record: { type: 'task', id: 'f2d3f00d-1929-45db-88a5-6bb927663ea1', title: 'X', url: '/tasks/f2d3f00d-1929-45db-88a5-6bb927663ea1' },
  });
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
});

describe('useResolveTaskSearch — server-side resolve for id-shaped queries', () => {
  it('resolves an id8 query via api.resolve.record', async () => {
    await mount(() => useResolveTaskSearch('5eadf00d'));
    expect(mockApi.resolve.record).toHaveBeenCalledWith('5eadf00d');
  });

  it('normalizes a dashed id (dashes stripped, lowercased) before resolving', async () => {
    await mount(() => useResolveTaskSearch('F2D3F00D-1929'));
    expect(mockApi.resolve.record).toHaveBeenCalledWith('f2d3f00d1929');
  });

  it('does NOT fire for a prose query (left to the client-side substring filter)', async () => {
    await mount(() => useResolveTaskSearch('bridge auth'));
    expect(mockApi.resolve.record).not.toHaveBeenCalled();
  });

  it('does NOT fire for a hex run shorter than the id8 floor', async () => {
    await mount(() => useResolveTaskSearch('5eadf00')); // 7 hex
    expect(mockApi.resolve.record).not.toHaveBeenCalled();
  });

  it('does NOT fire for an empty search box', async () => {
    await mount(() => useResolveTaskSearch(''));
    expect(mockApi.resolve.record).not.toHaveBeenCalled();
  });
});
