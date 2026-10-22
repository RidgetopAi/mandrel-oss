/**
 * useBeforeThumbnails (lane B bulk read) — ONE request per board regardless of card
 * count, only punch cards asked, first `before` per task picked, legacy cards skipped.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../api', () => ({
  api: { tasks: { update: vi.fn() }, attachments: { listForTasks: vi.fn(), list: vi.fn() } },
}));

import { api } from '../../api';
import { useBeforeThumbnails, pickFirstBefore } from './hooks';
import type { Task } from '../../types/task';
import type { TaskAttachment } from '../../types/attachment';

const mockApi = api as unknown as { attachments: { listForTasks: ReturnType<typeof vi.fn> } };
const att = (id: string, taskId: string, kind: 'before' | 'evidence', mime = 'image/jpeg'): TaskAttachment =>
  ({ id, taskId, kind, filename: `${id}.jpg`, mime, byteSize: 1, createdAt: '2026-09-10T00:00:00Z', url: `/api/attachments/${id}` });
const punch = (id: string): Task => ({ id, status: 'todo', stage: 'ready', metadata: { punch: { proofKind: 'browser' } } }) as unknown as Task;
const legacy = (id: string): Task => ({ id, status: 'todo', stage: null, metadata: null }) as unknown as Task;

describe('pickFirstBefore', () => {
  it('first before per task, evidence ignored, absent when none', () => {
    expect(
      pickFirstBefore([att('e1', 't1', 'evidence'), att('b1', 't1', 'before'), att('b2', 't1', 'before'), att('e2', 't2', 'evidence')]),
    ).toEqual({ t1: 'b1' });
    expect(pickFirstBefore([])).toEqual({});
    // a text-only `before` is not a thumbnail; the first IMAGE before wins even if later
    expect(pickFirstBefore([att('n1', 't1', 'before', 'text/plain'), att('b1', 't1', 'before')])).toEqual({ t1: 'b1' });
    expect(pickFirstBefore([att('n1', 't1', 'before', 'text/plain')])).toEqual({});
  });
});

let container: HTMLDivElement;
let root: Root;
let latest: Record<string, string> = {};
const Harness: React.FC<{ tasks: Task[] }> = ({ tasks }) => {
  latest = useBeforeThumbnails(tasks);
  return null;
};
function mount(tasks: Task[]) {
  container = document.createElement('div');
  document.body.appendChild(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() => {
    root = createRoot(container);
    root.render(
      <QueryClientProvider client={client}>
        <Harness tasks={tasks} />
      </QueryClientProvider>,
    );
  });
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
});
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
});

describe('useBeforeThumbnails', () => {
  it('ONE bulk request for the whole board, punch cards only, first before per task', async () => {
    mockApi.attachments.listForTasks.mockResolvedValue([att('b1', 'p1', 'before'), att('b9', 'p1', 'before'), att('e1', 'p2', 'evidence')]);
    mount([punch('p1'), legacy('l1'), punch('p2'), punch('p3')]);
    await settle();
    expect(mockApi.attachments.listForTasks).toHaveBeenCalledTimes(1);
    expect(mockApi.attachments.listForTasks.mock.calls[0][0]).toEqual(['p1', 'p2', 'p3']);
    expect(latest).toEqual({ p1: 'b1' });
  });
  it('a board with no punch cards makes NO request', async () => {
    mount([legacy('l1'), legacy('l2')]);
    await settle();
    expect(mockApi.attachments.listForTasks).not.toHaveBeenCalled();
    expect(latest).toEqual({});
  });
});
