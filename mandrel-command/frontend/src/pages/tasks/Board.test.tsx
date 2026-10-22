/**
 * Board drag-to-change-status.
 *
 * Two things are worth pinning here, and a third deliberately is NOT.
 *
 *  1. WHICH DROPS ARE A WRITE — `statusChangeFromDrop` is the whole decision, as a pure
 *     function, so the no-op cases can be asserted without a drag. The no-ops matter more
 *     than the happy path: a drop back onto the same column that fired a request would
 *     write to the server every time a user picked a card up and changed their mind.
 *
 *  2. OPTIMISM AND ROLLBACK — the card must move before the request resolves, and must go
 *     back if the request fails. A board left showing a status the server rejected is the
 *     specific failure this is here to catch, so the failing path is asserted on the cache
 *     the board actually renders from.
 *
 * NOT pinned here: that a real mouse drag does not also fire the card's click. That is a
 * browser behaviour (rbd binds its sensors at the window and drives real pointer events);
 * jsdom would only be asserting my own mock of it. It was verified in a browser instead —
 * see the task's proof.
 *
 * Harness matches the rest of the suite: raw react-dom + React.act, no @testing-library.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { DropResult } from 'react-beautiful-dnd';

vi.mock('../../api', () => ({
  api: {
    tasks: {
      update: vi.fn(),
      links: vi.fn(),
    },
  },
}));

import { api } from '../../api';
import { statusChangeFromDrop } from './Board';
import { useBoardStatusDrag } from './boardDrag';
import type { Task } from '../../types/task';

const mockApi = api as unknown as { tasks: { update: ReturnType<typeof vi.fn> } };

const TASK_ID = 'aaaaaaaa-0000-0000-0000-000000000001';

/** A DropResult with only the fields the decision reads; the rest is rbd bookkeeping. */
const drop = (over: {
  draggableId?: string;
  from: string;
  to: string | null;
}): DropResult =>
  ({
    draggableId: over.draggableId ?? TASK_ID,
    source: { droppableId: over.from, index: 0 },
    destination: over.to === null ? null : { droppableId: over.to, index: 0 },
    reason: 'DROP',
    mode: 'FLUID',
    type: 'DEFAULT',
    combine: null,
  }) as unknown as DropResult;

describe('statusChangeFromDrop — which drops are a status write', () => {
  it('a drop on a DIFFERENT column is a status change to that column', () => {
    expect(statusChangeFromDrop(drop({ from: 'todo', to: 'in_progress' }))).toEqual({
      id: TASK_ID,
      status: 'in_progress',
    });
  });

  it('every board column is a valid target', () => {
    for (const status of ['todo', 'in_progress', 'blocked', 'completed']) {
      // Start somewhere else so the same-column no-op is not what is being observed.
      const from = status === 'todo' ? 'blocked' : 'todo';
      expect(statusChangeFromDrop(drop({ from, to: status }))?.status).toBe(status);
    }
  });

  it('a drop back on the SAME column is a no-op (picking a card up must not write)', () => {
    expect(statusChangeFromDrop(drop({ from: 'todo', to: 'todo' }))).toBeNull();
  });

  it('a drag cancelled in mid-air (no destination) is a no-op', () => {
    expect(statusChangeFromDrop(drop({ from: 'todo', to: null }))).toBeNull();
  });

  it('a drop on something that is not a board column is a no-op', () => {
    // `cancelled` is a real TaskStatus but has NO column, so nothing can drop onto it —
    // and an unknown droppable id must never be written through as a status.
    expect(statusChangeFromDrop(drop({ from: 'todo', to: 'cancelled' }))).toBeNull();
    expect(statusChangeFromDrop(drop({ from: 'todo', to: 'not-a-column' }))).toBeNull();
    expect(statusChangeFromDrop(drop({ from: 'todo', to: '' }))).toBeNull();
  });

  it('the moved task is the DRAGGED one, not whatever was selected', () => {
    const other = 'bbbbbbbb-0000-0000-0000-000000000002';
    expect(statusChangeFromDrop(drop({ draggableId: other, from: 'todo', to: 'blocked' }))?.id).toBe(
      other,
    );
  });
});

// ── Optimism + rollback ────────────────────────────────────────────────────────────────

const LIST_KEY = ['tasks', 'list', 'proj-1', null, null];

const makeTask = (over: Partial<Task> = {}): Task =>
  ({
    id: TASK_ID,
    project_id: 'proj-1',
    title: 'Drag me',
    type: 'feature',
    status: 'todo',
    priority: 'medium',
    tags: [],
    created_at: '2026-08-09T00:00:00.000Z',
    updated_at: '2026-08-09T00:00:00.000Z',
    ...over,
  }) as unknown as Task;

let container: HTMLDivElement;
let root: Root;
let client: QueryClient;
let move: (id: string, status: Task['status']) => void;

/** Renders nothing — it exists to hand the hook's `moveStatus` out to the test. */
const Harness: React.FC = () => {
  const drag = useBoardStatusDrag();
  move = drag.moveStatus;
  return null;
};

function mount(seed: Task[]) {
  container = document.createElement('div');
  document.body.appendChild(container);
  client = new QueryClient({
    // gcTime must NOT be 0 here. These cache entries are seeded directly and have no
    // observer, so a zero gcTime collects them the moment the mutation settles and every
    // post-settle assertion reads `undefined` instead of the row it is about to check.
    // On the real page `useTaskList` observes this key, so keeping it is the faithful
    // harness, not a workaround.
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity },
      mutations: { retry: false },
    },
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

const cachedStatus = () => client.getQueryData<Task[]>(LIST_KEY)?.[0]?.status;

beforeEach(() => {
  vi.clearAllMocks();
  mockApi.tasks.update.mockResolvedValue({});
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
});

describe('useBoardStatusDrag — optimistic move, rolled back on failure', () => {
  it('moves the card in the cache BEFORE the request resolves', async () => {
    // The request never settles, so anything observed is purely the optimistic write.
    mockApi.tasks.update.mockReturnValue(new Promise(() => {}));
    mount([makeTask({ status: 'todo' })]);

    expect(cachedStatus()).toBe('todo');
    act(() => move(TASK_ID, 'in_progress'));
    expect(cachedStatus()).toBe('in_progress');
  });

  it('persists the new status through PUT /tasks/:id, sending only the status', async () => {
    mount([makeTask({ status: 'todo' })]);
    act(() => move(TASK_ID, 'completed'));
    await settle();

    expect(mockApi.tasks.update).toHaveBeenCalledTimes(1);
    expect(mockApi.tasks.update).toHaveBeenCalledWith(TASK_ID, { status: 'completed' });
  });

  it('ROLLS BACK to the original status when the request fails', async () => {
    mockApi.tasks.update.mockRejectedValue(new Error('nope'));
    mount([makeTask({ status: 'todo' })]);

    act(() => move(TASK_ID, 'completed'));
    expect(cachedStatus()).toBe('completed'); // optimistic
    await settle();
    expect(cachedStatus()).toBe('todo'); // rolled back — the board must not lie
  });

  it('a rollback restores the OTHER cards untouched', async () => {
    const other = 'bbbbbbbb-0000-0000-0000-000000000002';
    mockApi.tasks.update.mockRejectedValue(new Error('nope'));
    mount([makeTask({ status: 'todo' }), makeTask({ id: other, status: 'blocked' })]);

    act(() => move(TASK_ID, 'completed'));
    await settle();

    const rows = client.getQueryData<Task[]>(LIST_KEY)!;
    expect(rows.map((t) => t.status)).toEqual(['todo', 'blocked']);
  });

  it('rewrites EVERY cached list, not just the board its own key', async () => {
    // The same task sits in several cached lists (the key carries project + status filter
    // + archived flag). Leaving the others behind shows two statuses for one task.
    const filteredKey = ['tasks', 'list', 'proj-1', 'todo', null];
    mockApi.tasks.update.mockReturnValue(new Promise(() => {}));
    mount([makeTask({ status: 'todo' })]);
    client.setQueryData(filteredKey, [makeTask({ status: 'todo' })]);

    act(() => move(TASK_ID, 'blocked'));

    expect(cachedStatus()).toBe('blocked');
    expect(client.getQueryData<Task[]>(filteredKey)?.[0]?.status).toBe('blocked');
  });

  it('an empty list cache is not a crash and not a fabricated row', async () => {
    mount([]);
    act(() => move(TASK_ID, 'blocked'));
    await settle();
    expect(client.getQueryData<Task[]>(LIST_KEY)).toEqual([]);
    // The write still goes out — the row may be off this page but the drag was real.
    expect(mockApi.tasks.update).toHaveBeenCalledWith(TASK_ID, { status: 'blocked' });
  });
});
