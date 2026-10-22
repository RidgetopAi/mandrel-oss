/**
 * PunchDetail — arriving with `missing` (a rejected drag or a draft
 * submit) must open the EDITOR with those fields flagged, not the read-only view; and the
 * Evidence section renders even when empty. Attachments + task update are mocked at the
 * unified client. Raw react-dom harness like the rest of the suite.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../api', () => ({
  api: {
    tasks: { update: vi.fn() },
    attachments: { list: vi.fn(), blob: vi.fn(), remove: vi.fn() },
  },
}));

import { api } from '../../api';
import { PunchDetail } from './PunchDetail';
import type { Task } from '../../types/task';

const mockApi = api as unknown as {
  tasks: { update: ReturnType<typeof vi.fn> };
  attachments: { list: ReturnType<typeof vi.fn> };
};

const task = (over: Partial<Task> = {}): Task =>
  ({
    id: 'aaaaaaaa-0000-0000-0000-000000000001',
    project_id: 'p1',
    title: 'Save button dead',
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

function mount(ui: React.ReactElement) {
  container = document.createElement('div');
  document.body.appendChild(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  act(() => {
    root = createRoot(container);
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter>{ui}</MemoryRouter>
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
  mockApi.attachments.list.mockResolvedValue([]);
  mockApi.tasks.update.mockResolvedValue({});
});
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
});

describe('PunchDetail', () => {
  it('opens READ-ONLY by default: no editor, an Edit button, and both gallery sections', async () => {
    mount(<PunchDetail task={task()} taskLoading={false} onClose={() => {}} />);
    await settle();
    expect(container.querySelector('textarea[aria-label="Done when"]')).toBeNull();
    expect(Array.from(container.querySelectorAll('button')).some((b) => b.textContent === 'Edit')).toBe(true);
    expect(container.querySelector('section[data-kind="evidence"]')?.textContent).toContain('no evidence yet');
    expect(container.textContent).toContain('not set'); // done-when honestly unset
  });

  it('arriving with `missing` opens the EDITOR with those fields flagged', async () => {
    mount(<PunchDetail task={task()} taskLoading={false} missing={['doneWhen']} onClose={() => {}} />);
    await settle();
    expect(container.querySelector('textarea[aria-label="Done when"]')).not.toBeNull();
    const alerts = Array.from(container.querySelectorAll('[role="alert"]')).map((a) => a.textContent ?? '');
    expect(alerts.some((t) => t.includes('doneWhen'))).toBe(true);
    expect(alerts.some((t) => t.includes('Required before Ready'))).toBe(true);
  });

  it('the stage timeline marks the current stage (legacy null derives from status)', async () => {
    mount(<PunchDetail task={task({ stage: null, status: 'in_progress' })} taskLoading={false} onClose={() => {}} />);
    await settle();
    const now = container.querySelector('[data-state="now"]');
    expect(now?.textContent).toContain('Claimed');
    expect(container.querySelectorAll('[data-state="past"]')).toHaveLength(2); // draft, ready
  });

  it('links to the full task view', async () => {
    mount(<PunchDetail task={task()} taskLoading={false} onClose={() => {}} />);
    await settle();
    const link = container.querySelector('a[href="/tasks/aaaaaaaa-0000-0000-0000-000000000001"]');
    expect(link).not.toBeNull();
  });
});
