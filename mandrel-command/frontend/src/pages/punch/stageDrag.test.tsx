/**
 * useStageDrag — optimistic stage move, rolled back on failure, and the PUNCH_INCOMPLETE
 * hand-off that opens the card with its missing fields. Same harness
 * as Board.test.tsx (raw react-dom + React.act, no testing-library).
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../api', () => ({
  api: { tasks: { update: vi.fn() }, attachments: { list: vi.fn(), listForTasks: vi.fn() } },
}));

import { api } from '../../api';
import { useStageDrag } from './hooks';
import type { TaskUpdateInput } from '../tasks/hooks';
import type { Task } from '../../types/task';

const mockApi = api as unknown as { tasks: { update: ReturnType<typeof vi.fn> } };
const TASK_ID = 'aaaaaaaa-0000-0000-0000-000000000001';
const LIST_KEY = ['tasks', 'list', 'proj-1', null, null];

const makeTask = (over: Partial<Task> = {}): Task =>
  ({
    id: TASK_ID,
    project_id: 'proj-1',
    title: 'Fix the thing',
    type: 'bug',
    status: 'todo',
    stage: 'draft',
    priority: 'medium',
    metadata: { punch: { proofKind: 'browser', source: 'form' } },
    created_at: '2026-09-10T00:00:00.000Z',
    updated_at: '2026-09-10T00:00:00.000Z',
    ...over,
  }) as unknown as Task;

let container: HTMLDivElement;
let root: Root;
let client: QueryClient;
let move: (id: string, updates: TaskUpdateInput) => void;
let onError: ReturnType<typeof vi.fn>;

const Harness: React.FC = () => {
  const d = useStageDrag(onError as unknown as (err: unknown, id: string, u: TaskUpdateInput) => void);
  move = d.move;
  return null;
};

function mount(seed: Task[]) {
  container = document.createElement('div');
  document.body.appendChild(container);
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } },
  });
  client.setQueryData(LIST_KEY, seed);
  act(() => {
    root = createRoot(container);
    root.render(
      <QueryClientProvider client={client}>
        <Harness />
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

const cached = () => client.getQueryData<Task[]>(LIST_KEY)?.[0];

beforeEach(() => {
  vi.clearAllMocks();
  onError = vi.fn();
  mockApi.tasks.update.mockResolvedValue({});
});
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
});

describe('useStageDrag', () => {
  it('moves the card to the new stage in the cache BEFORE the request resolves', () => {
    mockApi.tasks.update.mockReturnValue(new Promise(() => {}));
    mount([makeTask({ stage: 'draft' })]);
    act(() => move(TASK_ID, { stage: 'ready' }));
    expect(cached()?.stage).toBe('ready');
  });

  it('persists through PUT /tasks/:id sending exactly the drop updates', async () => {
    mount([makeTask({ stage: 'ready' })]);
    act(() => move(TASK_ID, { stage: 'claimed' }));
    await settle();
    expect(mockApi.tasks.update).toHaveBeenCalledTimes(1);
    expect(mockApi.tasks.update).toHaveBeenCalledWith(TASK_ID, { stage: 'claimed' });
  });

  it('SNAPS BACK on a 400 PUNCH_INCOMPLETE and hands the missing fields to onError', async () => {
    mockApi.tasks.update.mockRejectedValue({
      message: 'Punch incomplete',
      code: 'PUNCH_INCOMPLETE',
      status: 400,
      details: { code: 'PUNCH_INCOMPLETE', missing: ['doneWhen'] },
    });
    mount([makeTask({ stage: 'draft' })]);
    act(() => move(TASK_ID, { stage: 'ready' }));
    expect(cached()?.stage).toBe('ready'); // optimistic
    await settle();
    expect(cached()?.stage).toBe('draft'); // rolled back — the board must not lie
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0]).toMatchObject({ code: 'PUNCH_INCOMPLETE' });
    expect(onError.mock.calls[0][1]).toBe(TASK_ID);
  });

  it('a blocked-lane drop rewrites status optimistically and rolls that back too', async () => {
    mockApi.tasks.update.mockRejectedValue(new Error('nope'));
    mount([makeTask({ status: 'in_progress', stage: 'claimed' })]);
    act(() => move(TASK_ID, { status: 'blocked' }));
    expect(cached()?.status).toBe('blocked');
    await settle();
    expect(cached()?.status).toBe('in_progress');
    expect(cached()?.stage).toBe('claimed');
  });

  it('an empty cache is not a crash; the write still goes out', async () => {
    mount([]);
    act(() => move(TASK_ID, { stage: 'ready' }));
    await settle();
    expect(client.getQueryData<Task[]>(LIST_KEY)).toEqual([]);
    expect(mockApi.tasks.update).toHaveBeenCalledWith(TASK_ID, { stage: 'ready' });
  });
});
