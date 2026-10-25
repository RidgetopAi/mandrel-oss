/**
 * TaskDrawer tests — the task CRUD drawer, exercised end-to-end against a
 * MOCKED unified api client so the assertions are on the exact create/update/delete payloads
 * (mutation-sensitive: break the payload mapping and a test goes red). Same harness as the
 * rest of the suite (raw react-dom + React.act + QueryClientProvider [the mutations use
 * react-query] + MemoryRouter [BuildStory renders <Link>s]; this repo has NO
 * @testing-library). ProjectContext is stubbed (allProjects + effective project id) so no
 * real provider/auth/react-query project machinery is pulled in.
 *
 * Coverage: create flow (payload incl. project_id → onCreated), edit flow (only the CHANGED
 * field is sent → clean after save), delete flow (confirm → remove → onDeleted), validation
 * (empty title blocks Save), open/mode rendering (edit vs create; closed → nothing), and the
 * create target (page project → the no-project-must-pick case).
 *
 * ════════════════════════════════════════════════════════════════════════════════════
 *  THE CREATE TARGET CHANGED (page-scope epic §A1)
 * ════════════════════════════════════════════════════════════════════════════════════
 * Create mode used to seed its project from `useEffectiveProjectId()` — the AMBIENT
 * project. With a per-page selector that is a DIFFERENT value by design: the ambient one
 * is pinned to the user's default while the page shows whatever the user selected. A
 * "+ New Task" pressed on a page showing B would have defaulted to filing into A.
 *
 * So the drawer now takes `pageProjectId`, and — the half that has no visible symptom —
 * it SCOPES the create request to the project the FORM is showing. The backend's resolver
 * authorizes EVERY project a request names, so a body naming B under an ambient header
 * naming A is a request naming two projects. The assertions below are on BOTH arguments:
 * the payload's `project_id` and the request scope's `X-Project-ID`. They must agree.
 *
 * Project ids here are REAL UUIDs, not `proj-1` labels: `scopedRequestConfig` validates
 * the shape and refuses to send anything else, which is the behaviour under test.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Vitest allows factory refs to top-level vars prefixed `mock*`. These let each test set the
// project list the drawer offers and the ambient fallback it uses when given no page project.
let mockAllProjects: Array<{ id: string; name: string }> = [];
let mockEffectiveId: string | undefined;

/** REAL uuids — `scopedRequestConfig` rejects anything that is not one. */
const P_RIVERBEND = 'aaaa1111-1111-4111-8111-aaaa11111111';
const P_DAISY = 'bbbb2222-2222-4222-8222-bbbb22222222';

vi.mock('../../contexts/ProjectContext', () => ({
  useProjectContext: () => ({ setSelectedProjectId: () => undefined, allProjects: mockAllProjects }),
  useEffectiveProjectId: () => mockEffectiveId,
}));

vi.mock('../../api', () => ({
  api: {
    tasks: {
      create: vi.fn(),
      update: vi.fn(),
      remove: vi.fn(),
      restore: vi.fn(),
      links: vi.fn(),
    },
  },
}));

import { api } from '../../api';
import { TaskDrawer } from './TaskDrawer';
import { STATUS_LABEL, priorityLabel } from './config';
import type { Task } from '../../types/task';

const mockApi = api as unknown as {
  tasks: {
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    remove: ReturnType<typeof vi.fn>;
    restore: ReturnType<typeof vi.fn>;
    links: ReturnType<typeof vi.fn>;
  };
};

const NOW = new Date().toISOString();
const makeTask = (over: Partial<Task> = {}): Task =>
  ({
    id: 'aaaaaaaa-0000-0000-0000-000000000001',
    project_id: P_RIVERBEND,
    title: 'Wire the drawer',
    description: 'existing description',
    type: 'feature',
    status: 'in_progress',
    priority: 'medium',
    assigned_to: 'coordinator',
    tags: ['ui'],
    created_at: NOW,
    updated_at: NOW,
    ...over,
  }) as unknown as Task;

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
function typeInto(el: HTMLInputElement | HTMLTextAreaElement, text: string) {
  const proto =
    el instanceof HTMLTextAreaElement
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')!.set!;
  act(() => {
    setter.call(el, text);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

// The Drawer + Modal render through a portal to document.body (NOT inside `container`),
// so every query is document-scoped.
const input = (label: string) =>
  document.querySelector(`[aria-label="${label}"]`) as HTMLInputElement | null;

const buttonByText = (scope: ParentNode, text: string) =>
  (Array.from(scope.querySelectorAll('button')).find(
    (b) => (b.textContent ?? '').trim() === text,
  ) ?? null) as HTMLButtonElement | null;

/** Open a Select (by trigger aria-label) and click the option with the given label. */
function chooseOption(selectAriaLabel: string, optionLabel: string) {
  const trigger = document.querySelector(
    `button[aria-label="${selectAriaLabel}"]`,
  ) as HTMLButtonElement | null;
  click(trigger);
  const opt = Array.from(document.querySelectorAll('[role="option"]')).find(
    (o) => (o.textContent ?? '').trim() === optionLabel,
  );
  click(opt);
}

/** The drawer dialog (the one titled New/Edit/plain Task), as opposed to the confirm Modal. */
const drawerDialog = () =>
  (Array.from(document.querySelectorAll('[role="dialog"]')).find((d) =>
    /^(New task|Edit task|Task)$/.test((d.querySelector('h2')?.textContent ?? '').trim()),
  ) ?? null) as HTMLElement | null;

const confirmDialog = () =>
  (Array.from(document.querySelectorAll('[role="dialog"]')).find(
    (d) => (d.querySelector('h2')?.textContent ?? '') === 'Delete task?',
  ) ?? null) as HTMLElement | null;

beforeEach(() => {
  vi.clearAllMocks();
  mockAllProjects = [
    { id: P_RIVERBEND, name: 'riverbend' },
    { id: P_DAISY, name: 'daisy' },
  ];
  mockEffectiveId = P_RIVERBEND;
  mockApi.tasks.create.mockResolvedValue({ id: 'new-task-9' });
  mockApi.tasks.update.mockResolvedValue({});
  mockApi.tasks.remove.mockResolvedValue(undefined);
  mockApi.tasks.restore.mockResolvedValue({ id: 'aaaaaaaa-0000-0000-0000-000000000001' });
  mockApi.tasks.links.mockResolvedValue([]);
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
});

const noop = () => {};

describe('TaskDrawer — open / mode rendering', () => {
  it('renders nothing when closed', () => {
    mount(<TaskDrawer open={false} mode="edit" task={makeTask()} onClose={noop} onCreated={noop} onDeleted={noop} />);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it('opens in EDIT mode for the selected task (title "Edit task", no project field)', () => {
    mount(<TaskDrawer open mode="edit" task={makeTask()} onClose={noop} onCreated={noop} onDeleted={noop} />);
    expect(drawerDialog()).not.toBeNull();
    expect(drawerDialog()!.querySelector('h2')!.textContent).toBe('Edit task');
    expect(input('Task title')!.value).toBe('Wire the drawer');
    // Edit mode has a status field + build story; no project picker.
    expect(document.querySelector('button[aria-label="Task status"]')).not.toBeNull();
    expect(document.querySelector('button[aria-label="Task project"]')).toBeNull();
    expect(drawerDialog()!.textContent).toContain('Build story');
  });

  it('opens in CREATE mode empty, with a project field and NO build story', () => {
    mount(<TaskDrawer open mode="create" onClose={noop} onCreated={noop} onDeleted={noop} />);
    expect(drawerDialog()!.querySelector('h2')!.textContent).toBe('New task');
    expect(input('Task title')!.value).toBe('');
    expect(document.querySelector('button[aria-label="Task project"]')).not.toBeNull();
    // No build-story + no status field in create mode.
    expect(drawerDialog()!.textContent).not.toContain('Build story');
    expect(document.querySelector('button[aria-label="Task status"]')).toBeNull();
  });
});

/**
 * VIEW MODE — clicking a task used to land straight in the edit form.
 *
 * The assertions that matter are the NEGATIVE ones: view mode must contain no control that
 * can write. A "read-only" panel that still renders the Save button, or still renders the
 * inputs, is the bug wearing a different heading, and it would pass any test that only
 * checked the task's text was on screen.
 */
describe('TaskDrawer — view mode is read-only', () => {
  const openView = (over: Partial<Task> = {}, onEdit = noop) =>
    mount(
      <TaskDrawer
        open
        mode="view"
        task={makeTask(over)}
        links={[]}
        onEdit={onEdit}
        onClose={noop}
        onCreated={noop}
        onDeleted={noop}
      />,
    );

  it('shows the task without any editable control', () => {
    openView();
    const dialog = drawerDialog()!;
    expect(dialog.querySelector('h2')!.textContent).toBe('Task');
    expect(dialog.textContent).toContain('Wire the drawer');

    // NOT ONE writable control: no form inputs, and none of the edit form's Selects.
    expect(dialog.querySelectorAll('input, textarea').length).toBe(0);
    expect(document.querySelector('[aria-label="Task title"]')).toBeNull();
    expect(document.querySelector('[aria-label="Task description"]')).toBeNull();
    expect(document.querySelector('button[aria-label="Task status"]')).toBeNull();
    expect(document.querySelector('button[aria-label="Task priority"]')).toBeNull();
    expect(document.querySelector('button[aria-label="Task type"]')).toBeNull();
    expect(document.querySelector('[aria-label="Task assignee"]')).toBeNull();

    // …and no control that commits or destroys.
    expect(buttonByText(dialog, 'Save')).toBeNull();
    expect(buttonByText(dialog, 'Delete')).toBeNull();
  });

  it('shows the SAME information the edit form does', () => {
    // The point of the read-only stop is that you do not have to enter edit mode to read
    // the record — so every field the form exposes has to be legible here.
    openView({ assigned_to: 'builder', tags: ['ui', 'kanban'], description: 'the body text' });
    const text = drawerDialog()!.textContent ?? '';
    expect(text).toContain('Wire the drawer'); // title
    expect(text).toContain('the body text'); // description
    expect(text).toContain('builder'); // assignee
    expect(text).toContain('feature'); // type
    expect(text).toContain('ui'); // tags
    expect(text).toContain('kanban');
    // Status and priority are rendered through config's own label maps, so they are
    // derived here from that same source rather than restated — a test that hardcoded
    // 'medium' would fail against the real label ('med') while the product was correct.
    expect(text).toContain(STATUS_LABEL.in_progress);
    expect(text).toContain(priorityLabel('medium'));
  });

  it('keeps the BuildStory typed-edge block visible (it is read-only content already)', () => {
    openView();
    expect(drawerDialog()!.textContent).toContain('Build story');
  });

  it('renders an honest empty for each unset field rather than a blank gap', () => {
    openView({ description: '', assigned_to: '', tags: [] });
    const text = drawerDialog()!.textContent ?? '';
    expect(text).toContain('No description');
    expect(text).toContain('unassigned');
    expect(text).toContain('No tags');
  });

  it('the Edit button is the one door into the form, and it reports back to the page', () => {
    const onEdit = vi.fn();
    openView({}, onEdit);
    const editBtn = buttonByText(drawerDialog()!, 'Edit')!;
    expect(editBtn).not.toBeNull();
    click(editBtn);
    // The drawer does not switch modes by itself — the PAGE owns the mode, which is what
    // makes a new selection reset to view.
    expect(onEdit).toHaveBeenCalledTimes(1);
  });

  it('an ARCHIVED task still says so in view mode', () => {
    openView({ archived_at: NOW });
    expect(drawerDialog()!.textContent).toContain('This task is deleted (archived)');
    // Restore is a write — it belongs to edit mode, not the read-only stop.
    expect(buttonByText(drawerDialog()!, 'Restore')).toBeNull();
  });

  it('MUTATION — view mode never sends a write, whatever is clicked', async () => {
    // Proof this block can see the defect: click every button the panel offers and assert
    // no task mutation left the drawer.
    openView();
    for (const b of Array.from(drawerDialog()!.querySelectorAll('button'))) {
      // eslint-disable-next-line no-await-in-loop
      await click(b);
    }
    await settle();
    expect(mockApi.tasks.update).not.toHaveBeenCalled();
    expect(mockApi.tasks.create).not.toHaveBeenCalled();
    expect(mockApi.tasks.remove).not.toHaveBeenCalled();
    expect(mockApi.tasks.restore).not.toHaveBeenCalled();
  });
});

describe('TaskDrawer — create flow', () => {
  it('creates with the mapped payload incl. project_id, then selects the new task', async () => {
    const onCreated = vi.fn();
    mount(<TaskDrawer open mode="create" onClose={noop} onCreated={onCreated} onDeleted={noop} />);
    await settle();

    typeInto(input('Task title')!, 'Ship the drawer');
    typeInto(input('Task assignee')!, 'builder');
    chooseOption('Task priority', 'high');
    chooseOption('Task type', 'docs');

    click(buttonByText(drawerDialog()!, 'Create task'));
    await settle();

    expect(mockApi.tasks.create).toHaveBeenCalledTimes(1);
    expect(mockApi.tasks.create).toHaveBeenCalledWith(
      {
        title: 'Ship the drawer',
        priority: 'high',
        project_id: P_RIVERBEND,
        type: 'docs',
        assigned_to: 'builder',
      },
      // …and the request is SCOPED to the same project the payload names.
      { headers: { 'X-Project-ID': P_RIVERBEND } },
    );
    // onSuccess ran → the new task id is selected (parent reopens it in edit mode).
    expect(onCreated).toHaveBeenCalledWith('new-task-9');
  });

  it('seeds create mode from the PAGE project, not the ambient default', async () => {
    // THE BUG THIS PINS: the page is showing daisy; the ambient default is riverbend.
    // Before the page-scope epic the drawer read the ambient one and a task created from the
    // daisy board was filed in riverbend — where the user was not looking.
    mockEffectiveId = P_RIVERBEND;
    mount(
      <TaskDrawer
        open
        mode="create"
        pageProjectId={P_DAISY}
        onClose={noop}
        onCreated={noop}
        onDeleted={noop}
      />,
    );
    await settle();
    typeInto(input('Task title')!, 'Lands where the page is');
    click(buttonByText(drawerDialog()!, 'Create task'));
    await settle();

    const [payload, config] = mockApi.tasks.create.mock.calls[0];
    expect(payload).toMatchObject({ project_id: P_DAISY });
    expect(payload.project_id).not.toBe(P_RIVERBEND);
    // Present-and-correct on the scope too: naming the page project in the body while the
    // header still said the ambient default is a request naming TWO projects.
    expect(config).toEqual({ headers: { 'X-Project-ID': P_DAISY } });
  });

  it('falls back to the ambient project only when given no page project', async () => {
    // A caller with no selector of its own (there is none on this page today, but the prop
    // is optional) still gets a working create target rather than a blocked form.
    mockEffectiveId = P_DAISY;
    mount(<TaskDrawer open mode="create" onClose={noop} onCreated={noop} onDeleted={noop} />);
    await settle();
    typeInto(input('Task title')!, 'Lands in the ambient');
    click(buttonByText(drawerDialog()!, 'Create task'));
    await settle();
    expect(mockApi.tasks.create).toHaveBeenCalledWith(
      expect.objectContaining({ project_id: P_DAISY }),
      { headers: { 'X-Project-ID': P_DAISY } },
    );
  });

  it('with NO project resolvable at all, Save is disabled until one is picked', async () => {
    mockEffectiveId = undefined; // no page project, no ambient → must pick
    mount(<TaskDrawer open mode="create" onClose={noop} onCreated={noop} onDeleted={noop} />);
    await settle();
    typeInto(input('Task title')!, 'Needs a project');
    // Title valid but no project → Save blocked. This is the guard that keeps
    // `scopedRequestConfig` from ever being asked to scope nothing.
    expect(buttonByText(drawerDialog()!, 'Create task')!.disabled).toBe(true);
    chooseOption('Task project', 'daisy');
    await settle();
    expect(buttonByText(drawerDialog()!, 'Create task')!.disabled).toBe(false);
    click(buttonByText(drawerDialog()!, 'Create task'));
    await settle();
    expect(mockApi.tasks.create).toHaveBeenCalledWith(
      expect.objectContaining({ project_id: P_DAISY }),
      { headers: { 'X-Project-ID': P_DAISY } },
    );
  });

  it('MUTATION — the create is never sent unscoped: no project → no request at all', async () => {
    // Proof this suite can see the defect. With no project anywhere, pressing Save must
    // produce NOTHING — not an unscoped create that the backend files into whatever the
    // ambient slot points at.
    mockEffectiveId = undefined;
    mount(<TaskDrawer open mode="create" onClose={noop} onCreated={noop} onDeleted={noop} />);
    await settle();
    typeInto(input('Task title')!, 'Must not be sent');
    click(buttonByText(drawerDialog()!, 'Create task'));
    await settle();
    expect(mockApi.tasks.create).not.toHaveBeenCalled();
  });
});

describe('TaskDrawer — edit flow (diff save)', () => {
  it('sends ONLY the changed field (priority) and clears dirty on success', async () => {
    const task = makeTask({ priority: 'medium' });
    mount(<TaskDrawer open mode="edit" task={task} links={[]} onClose={noop} onCreated={noop} onDeleted={noop} />);
    await settle();

    // Save starts disabled (nothing changed).
    expect(buttonByText(drawerDialog()!, 'Save')!.disabled).toBe(true);

    chooseOption('Task priority', 'high');
    await settle();
    expect(buttonByText(drawerDialog()!, 'Save')!.disabled).toBe(false);

    click(buttonByText(drawerDialog()!, 'Save'));
    await settle();

    // Mutation-check: exactly the diff, keyed by id — not the whole record.
    expect(mockApi.tasks.update).toHaveBeenCalledTimes(1);
    expect(mockApi.tasks.update).toHaveBeenCalledWith(task.id, { priority: 'high' });
    // onSuccess reset the baseline → the form is clean again (Save disabled).
    expect(buttonByText(drawerDialog()!, 'Save')!.disabled).toBe(true);
  });

  it('edits title + description together and sends both in one diff', async () => {
    const task = makeTask();
    mount(<TaskDrawer open mode="edit" task={task} links={[]} onClose={noop} onCreated={noop} onDeleted={noop} />);
    await settle();
    typeInto(input('Task title')!, 'Renamed task');
    typeInto(input('Task description')!, 'new body');
    click(buttonByText(drawerDialog()!, 'Save'));
    await settle();
    expect(mockApi.tasks.update).toHaveBeenCalledWith(task.id, {
      title: 'Renamed task',
      description: 'new body',
    });
  });
});

describe('TaskDrawer — delete flow', () => {
  it('confirms then removes the task and calls onDeleted', async () => {
    const onDeleted = vi.fn();
    const task = makeTask();
    mount(<TaskDrawer open mode="edit" task={task} links={[]} onClose={noop} onCreated={noop} onDeleted={onDeleted} />);
    await settle();

    // No confirm dialog yet.
    expect(confirmDialog()).toBeNull();
    click(buttonByText(drawerDialog()!, 'Delete'));
    expect(confirmDialog()).not.toBeNull();

    // The confirm modal's own Delete button drives the mutation.
    click(buttonByText(confirmDialog()!, 'Delete'));
    await settle();

    expect(mockApi.tasks.remove).toHaveBeenCalledWith(task.id);
    expect(onDeleted).toHaveBeenCalledTimes(1);
  });
});

describe('TaskDrawer — validation', () => {
  it('blocks Save when the title is empty (create + edit)', async () => {
    // Create: empty title → disabled.
    mount(<TaskDrawer open mode="create" onClose={noop} onCreated={noop} onDeleted={noop} />);
    await settle();
    expect(buttonByText(drawerDialog()!, 'Create task')!.disabled).toBe(true);
    typeInto(input('Task title')!, 'Now valid');
    expect(buttonByText(drawerDialog()!, 'Create task')!.disabled).toBe(false);
    act(() => root.unmount());
    container.remove();

    // Edit: clearing the title disables Save and surfaces the required error.
    const task = makeTask();
    mount(<TaskDrawer open mode="edit" task={task} links={[]} onClose={noop} onCreated={noop} onDeleted={noop} />);
    await settle();
    typeInto(input('Task title')!, '');
    expect(buttonByText(drawerDialog()!, 'Save')!.disabled).toBe(true);
    expect(drawerDialog()!.textContent).toContain('Title is required');
  });
});

/**
 * SOFT-DELETE + RESTORE. Delete no longer destroys the row — it sets
 * `archived_at` — so the drawer has to (a) tell the truth in the confirm copy and (b) offer
 * the undo. The footer control is chosen from the RECORD's `archived_at`, not from which
 * list the user came through, which is what these assert.
 */
describe('TaskDrawer — soft delete + restore', () => {
  it('a LIVE task shows Delete and no Restore (the control)', () => {
    mount(
      <TaskDrawer open mode="edit" task={makeTask()} onClose={noop} onCreated={noop} onDeleted={noop} />,
    );
    const dialog = drawerDialog()!;
    expect(buttonByText(dialog, 'Delete')).not.toBeNull();
    expect(buttonByText(dialog, 'Restore')).toBeNull();
  });

  it('an ARCHIVED task shows Restore instead of Delete, and says it is deleted', () => {
    mount(
      <TaskDrawer
        open
        mode="edit"
        task={makeTask({ archived_at: NOW })}
        onClose={noop}
        onCreated={noop}
        onDeleted={noop}
      />,
    );
    const dialog = drawerDialog()!;
    expect(buttonByText(dialog, 'Restore')).not.toBeNull();
    // The destructive control must be GONE — offering Delete on an already-deleted task is
    // exactly the confusion the two-semantics bug created.
    expect(buttonByText(dialog, 'Delete')).toBeNull();
    expect(dialog.textContent).toContain('This task is deleted (archived)');
  });

  it('clicking Restore calls api.tasks.restore with the id and reports back to the caller', async () => {
    const onDeleted = vi.fn();
    mount(
      <TaskDrawer
        open
        mode="edit"
        task={makeTask({ archived_at: NOW })}
        onClose={noop}
        onCreated={noop}
        onDeleted={onDeleted}
      />,
    );
    await click(buttonByText(drawerDialog()!, 'Restore'));
    await settle();

    expect(mockApi.tasks.restore).toHaveBeenCalledWith('aaaaaaaa-0000-0000-0000-000000000001');
    // No hard-delete call may sneak out of the restore path.
    expect(mockApi.tasks.remove).not.toHaveBeenCalled();
    expect(onDeleted).toHaveBeenCalled();
  });

  it('a failing Restore surfaces the real server message instead of looking like a no-op', async () => {
    mockApi.tasks.restore.mockRejectedValue(new Error('archive is on fire'));
    mount(
      <TaskDrawer
        open
        mode="edit"
        task={makeTask({ archived_at: NOW })}
        onClose={noop}
        onCreated={noop}
        onDeleted={noop}
      />,
    );
    await click(buttonByText(drawerDialog()!, 'Restore'));
    await settle();

    const dialog = drawerDialog()!;
    expect(dialog.textContent).toContain("Couldn't restore the task");
    expect(dialog.textContent).toContain('archive is on fire');
  });

  it('the delete confirm tells the truth: archived, not destroyed, and restorable', async () => {
    mount(
      <TaskDrawer open mode="edit" task={makeTask()} onClose={noop} onCreated={noop} onDeleted={noop} />,
    );
    await click(buttonByText(drawerDialog()!, 'Delete'));
    await settle();

    const confirm = confirmDialog()!;
    expect(confirm.textContent).toContain('ARCHIVED, not destroyed');
    // The old copy claimed the opposite; it must not survive anywhere in the modal.
    expect(confirm.textContent).not.toContain("can't be undone");
  });
});
