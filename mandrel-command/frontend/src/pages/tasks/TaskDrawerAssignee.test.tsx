/**
 * TaskDrawer — the ASSIGNEE COMBOBOX (Phase 2 item 3).
 *
 * THE DRIFT BEING FIXED, measured on prod 2026-08-09 (project riverbend): `builder` /
 * `Builder` / `builder (P3 Insight)` are one actor in three buckets, `coordinator` / `Coordinator`
 * likewise, and `'Operator + Coordinator'` / `'Coordinator + Operator'` are the same pair twice. That is what
 * makes the Completed-by-Actor chart wrong. The Assignee field was a plain `<Input>` —
 * inconsistent with Priority and Type, which are Selects.
 *
 * THE REQUIREMENT MOST LIKELY TO BE QUIETLY LOST IN A SELECT REFACTOR — and therefore the
 * first assertion here — is that FREE TEXT STILL SUBMITS. `tasks.assigned_to` is free-form
 * varchar with no FK and no enum; `'Operator + Coordinator'` must stay typeable and savable. The
 * suggestions only make the canonical spelling the path of least resistance.
 *
 * Same harness as TaskDrawer.test.tsx (raw react-dom + React.act; this repo has no
 * @testing-library), with `api.tasks.actorOptions` mocked so the suggestion list under test
 * is exactly the one asserted.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const P_RIVERBEND = 'aaaa1111-1111-4111-8111-aaaa11111111';

vi.mock('../../contexts/ProjectContext', () => ({
  useProjectContext: () => ({ setSelectedProjectId: () => undefined, allProjects: [{ id: P_RIVERBEND, name: 'riverbend' }] }),
  useEffectiveProjectId: () => P_RIVERBEND,
}));

vi.mock('../../api', () => ({
  api: {
    tasks: {
      create: vi.fn(),
      update: vi.fn(),
      remove: vi.fn(),
      restore: vi.fn(),
      links: vi.fn(),
      actorOptions: vi.fn(),
    },
  },
}));

import { api } from '../../api';
import { TaskDrawer } from './TaskDrawer';
import { ASSIGNEE_COMBOBOX_CONFIG } from './config';
import { TASKS_ASSIGNED_TO } from '../../config/fieldLimits';
import type { Task, ActorOption } from '../../types/task';

const mockApi = api as unknown as {
  tasks: Record<string, ReturnType<typeof vi.fn>>;
};

const NOW = new Date().toISOString();
const makeTask = (over: Partial<Task> = {}): Task =>
  ({
    id: 'aaaaaaaa-0000-0000-0000-000000000001',
    project_id: P_RIVERBEND,
    title: 'Wire the drawer',
    description: '',
    type: 'feature',
    status: 'in_progress',
    priority: 'medium',
    assigned_to: '',
    tags: [],
    created_at: NOW,
    updated_at: NOW,
    ...over,
  }) as unknown as Task;

const actor = (a: string, taskCount = 0): ActorOption => ({
  actor: a,
  kind: null,
  taskCount,
  sessionCount: 0,
  sources: ['tasks'],
  variants: [],
});

let container: HTMLDivElement;
let root: Root;
let client: QueryClient;

function mount(ui: React.ReactElement) {
  container = document.createElement('div');
  document.body.appendChild(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
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

const click = (el: Element | null | undefined) =>
  act(() => {
    el?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });

/** Set a controlled input the way React expects (native setter + input event). */
function typeInto(el: HTMLInputElement, text: string) {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    'value',
  )!.set!;
  act(() => {
    setter.call(el, text);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

/**
 * Focus the combobox the way React sees it. React 17+ delegates `onFocus` from the
 * bubbling `focusin` event at the root container, so dispatching a plain non-bubbling
 * `focus` here would leave the handler unrun and the popup shut — a green that proved
 * nothing about the product.
 */
const focusCombobox = (el: HTMLInputElement) =>
  act(() => {
    el.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
  });

const assigneeInput = () =>
  document.querySelector('[aria-label="Task assignee"]') as HTMLInputElement | null;

const options = () =>
  Array.from(document.querySelectorAll('[role="option"]')).map((o) =>
    (o.querySelector('span')?.textContent ?? o.textContent ?? '').trim(),
  );

const buttonByText = (scope: ParentNode, text: string) =>
  (Array.from(scope.querySelectorAll('button')).find(
    (b) => (b.textContent ?? '').trim() === text,
  ) ?? null) as HTMLButtonElement | null;

const drawerDialog = () =>
  (Array.from(document.querySelectorAll('[role="dialog"]')).find((d) =>
    /^(New task|Edit task|Task)$/.test((d.querySelector('h2')?.textContent ?? '').trim()),
  ) ?? null) as HTMLElement | null;

const noop = () => {};

beforeEach(() => {
  vi.clearAllMocks();
  mockApi.tasks.create.mockResolvedValue({ id: 'new-task-9' });
  mockApi.tasks.update.mockResolvedValue({});
  mockApi.tasks.links.mockResolvedValue([]);
  mockApi.tasks.actorOptions.mockResolvedValue([
    actor('builder', 274),
    actor('coordinator', 14),
    actor('operator', 8),
    actor('auditor', 5),
  ]);
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
});

describe('Assignee is a COMBOBOX, not a Select — free text still submits', () => {
  it('SAVES a value that is NOT in the options list', async () => {
    // THE load-bearing assertion. `'Operator + Coordinator'` is a real prod value and no roster will
    // ever contain it; a Select refactor would have silently made it unreachable.
    mount(<TaskDrawer open mode="edit" task={makeTask()} onClose={noop} onCreated={noop} onDeleted={noop} />);
    await settle();

    const el = assigneeInput()!;
    expect(el.getAttribute('role')).toBe('combobox');
    expect(options()).not.toContain('Operator + Coordinator'); // control: it really is unlisted

    typeInto(el, 'Operator + Coordinator');
    expect(el.value).toBe('Operator + Coordinator');

    click(buttonByText(drawerDialog()!, 'Save'));
    await settle();

    expect(mockApi.tasks.update).toHaveBeenCalledTimes(1);
    expect(mockApi.tasks.update.mock.calls[0][1]).toEqual({ assigned_to: 'Operator + Coordinator' });
  });

  it('CREATES with a free-text assignee that is not in the options list', async () => {
    mount(<TaskDrawer open mode="create" onClose={noop} onCreated={noop} onDeleted={noop} pageProjectId={P_RIVERBEND} />);
    await settle();

    typeInto(document.querySelector('[aria-label="Task title"]') as HTMLInputElement, 'New work');
    typeInto(assigneeInput()!, 'Coordinator + Operator');

    click(buttonByText(drawerDialog()!, 'Create task'));
    await settle();

    expect(mockApi.tasks.create).toHaveBeenCalledTimes(1);
    expect(mockApi.tasks.create.mock.calls[0][0].assigned_to).toBe('Coordinator + Operator');
  });
});

describe('the suggestions themselves', () => {
  it('offers the project\'s actual actors and filters them CASE-INSENSITIVELY', async () => {
    mount(<TaskDrawer open mode="edit" task={makeTask()} onClose={noop} onCreated={noop} onDeleted={noop} />);
    await settle();

    const el = assigneeInput()!;
    focusCombobox(el);
    expect(options()).toEqual(['builder', 'coordinator', 'operator', 'auditor']);

    // Upper-case query must still find the lower-case canonical spelling — this IS the
    // drift fix: typing `Builder` steers you to the one spelling that already exists.
    typeInto(el, 'BUIL');
    expect(options()).toEqual(['builder']);
  });

  it('picking a suggestion REPLACES the typed text with the canonical spelling', async () => {
    mount(<TaskDrawer open mode="edit" task={makeTask()} onClose={noop} onCreated={noop} onDeleted={noop} />);
    await settle();

    const el = assigneeInput()!;
    typeInto(el, 'Builder');
    expect(el.value).toBe('Builder'); // control: the typed casing, before picking

    click(document.querySelector('[role="option"]'));
    expect(assigneeInput()!.value).toBe('builder');

    click(buttonByText(drawerDialog()!, 'Save'));
    await settle();
    expect(mockApi.tasks.update.mock.calls[0][1]).toEqual({ assigned_to: 'builder' });
  });

  it('says so — without erroring — when nothing matches', async () => {
    mount(<TaskDrawer open mode="edit" task={makeTask()} onClose={noop} onCreated={noop} onDeleted={noop} />);
    await settle();

    typeInto(assigneeInput()!, 'zzz-nobody');
    expect(document.querySelectorAll('[role="option"]')).toHaveLength(0);
    expect(document.body.textContent).toContain(ASSIGNEE_COMBOBOX_CONFIG.emptyLabel);
    // Not an error state: free text is legal, so the control must not mark itself invalid.
    expect(assigneeInput()!.getAttribute('aria-invalid')).toBeNull();
  });

  it('caps how many suggestions are rendered (Reviewer N3 — the endpoint has no LIMIT)', async () => {
    const many = Array.from({ length: ASSIGNEE_COMBOBOX_CONFIG.maxVisible + 15 }, (_, i) =>
      actor(`actor-${String(i).padStart(3, '0')}`),
    );
    mockApi.tasks.actorOptions.mockResolvedValue(many);

    mount(<TaskDrawer open mode="edit" task={makeTask()} onClose={noop} onCreated={noop} onDeleted={noop} />);
    await settle();

    focusCombobox(assigneeInput()!);
    // Positive control: the server really did hand us more than the cap.
    expect(many.length).toBeGreaterThan(ASSIGNEE_COMBOBOX_CONFIG.maxVisible);
    expect(options()).toHaveLength(ASSIGNEE_COMBOBOX_CONFIG.maxVisible);

    // …and the cap does NOT hide a match: filtering happens first, so a value past the cap
    // is still reachable by typing.
    typeInto(assigneeInput()!, 'actor-030');
    expect(options()).toEqual(['actor-030']);
  });

  it('degrades to a plain free-text field when the suggestions read FAILS', async () => {
    // Losing suggestions must never block an edit.
    mockApi.tasks.actorOptions.mockRejectedValue(new Error('boom'));
    mount(<TaskDrawer open mode="edit" task={makeTask()} onClose={noop} onCreated={noop} onDeleted={noop} />);
    await settle();

    const el = assigneeInput()!;
    expect(el).not.toBeNull();
    typeInto(el, 'someone');
    click(buttonByText(drawerDialog()!, 'Save'));
    await settle();
    expect(mockApi.tasks.update.mock.calls[0][1]).toEqual({ assigned_to: 'someone' });
  });
});

describe('the cap the control enforces is the COLUMN\'s', () => {
  it('maxLength on the input is the column-derived cap, not a hand-typed number', async () => {
    mount(<TaskDrawer open mode="edit" task={makeTask()} onClose={noop} onCreated={noop} onDeleted={noop} />);
    await settle();
    expect(assigneeInput()!.getAttribute('maxlength')).toBe(String(TASKS_ASSIGNED_TO.max));
    // The value the OLD literal-100 client cap wrongly refused is inside this one.
    expect(TASKS_ASSIGNED_TO.max).toBeGreaterThan(100);
  });
});
