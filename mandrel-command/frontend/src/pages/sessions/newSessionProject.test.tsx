/**
 * NewSessionModal — the Project field.
 *
 * ════════════════════════════════════════════════════════════════════════════════════
 *  THE DEFECT THIS GUARD EXISTS TO CATCH
 * ════════════════════════════════════════════════════════════════════════════════════
 * The field is the ONLY thing that decides the new session's project: the value travels
 * in the request BODY, and nothing downstream re-checks that it names a project that
 * exists. So a value the field can hold but the project list does not contain becomes a
 * session filed against a project that is not there.
 *
 * The form's state outlives the list that seeded it — it is seeded from the Sessions
 * page, whose selection is held provisionally while the list is unresolved — so "the
 * options are correct" is not the property. The property is:
 *
 *     WHAT THE SUBMITTED BODY NAMES IS A PROJECT IN THE LIST, OR NOTHING AT ALL.
 *
 * Every assertion below therefore reads the mutation's ARGUMENTS, not the component's
 * state, and the negative cases assert that no mutation was fired at all.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AxiosRequestConfig } from 'axios';

const HOME = { id: 'aaaaaaaa-1111-4111-8111-111111111111', name: 'Home project' };
const OTHER = { id: 'bbbbbbbb-2222-4222-8222-222222222222', name: 'Other project' };
/** A project id that is NOT in the list — deleted, revoked, or hand-typed into the URL. */
const GHOST_ID = 'cccccccc-3333-4333-8333-333333333333';

const projectCtx = vi.hoisted(() => ({
  allProjects: [] as Array<Record<string, unknown>>,
  loading: false,
  projectsUnavailable: false,
}));
const started = vi.hoisted(() => ({
  calls: [] as Array<{ input?: { projectId?: string; title?: string }; scope: unknown }>,
}));

vi.mock('../../contexts/ProjectContext', () => ({
  useProjectContext: () => ({ setSelectedProjectId: () => undefined, ...projectCtx }),
}));

vi.mock('./hooks', () => ({
  useStartSession: () => ({
    mutate: (vars: { input?: { projectId?: string }; scope: unknown }) => started.calls.push(vars),
    reset: () => undefined,
    isPending: false,
    isError: false,
    error: null,
  }),
}));

import { NewSessionModal } from './NewSessionModal';
import { UNASSIGNED_PROJECT_LABEL, SEARCHABLE_THRESHOLD } from '../../components/ui';

let root: Root | undefined;
let container: HTMLDivElement | undefined;

/** A page scope that resolves — the ordinary case, so scope is never why a case fails. */
const workingPageScope = (): AxiosRequestConfig => ({ headers: { 'X-Project-ID': HOME.id } });

async function mount(defaultProjectId: string | undefined, pageScope = workingPageScope) {
  container = document.createElement('div');
  document.body.appendChild(container);
  await act(async () => {
    root = createRoot(container!);
    root.render(
      <NewSessionModal
        open
        onClose={() => undefined}
        defaultProjectId={defaultProjectId}
        pageScope={pageScope}
      />,
    );
  });
}

const projectTrigger = () =>
  document.querySelector<HTMLButtonElement>('button[aria-label="Session project"]')!;
const startButton = () =>
  Array.from(document.querySelectorAll('button')).find(
    (b) => b.textContent?.trim() === 'Start session',
  )!;

async function openProjectList() {
  await act(async () => {
    projectTrigger().click();
  });
  return Array.from(document.querySelectorAll('[role="option"]')).map((li) =>
    (li.textContent ?? '').trim(),
  );
}

async function chooseProject(label: string) {
  await act(async () => {
    projectTrigger().click();
  });
  const option = Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).find((li) =>
    (li.textContent ?? '').trim().includes(label),
  );
  if (!option) throw new Error(`no option labelled ${label}`);
  await act(async () => {
    option.click();
  });
}

async function submitForm() {
  const form = document.querySelector<HTMLFormElement>('#new-session-form')!;
  await act(async () => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
}

beforeEach(() => {
  projectCtx.allProjects = [HOME, OTHER];
  projectCtx.loading = false;
  projectCtx.projectsUnavailable = false;
  started.calls = [];
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
});

describe('NewSessionModal — the Project field offers the real projects', () => {
  it('lists every project the user has, plus the explicit unassigned entry', async () => {
    await mount(undefined);
    const labels = await openProjectList();
    expect(labels).toContain(HOME.name);
    expect(labels).toContain(OTHER.name);
    expect(labels).toContain(UNASSIGNED_PROJECT_LABEL);
    // The whole option set, so a future addition has to be asserted rather than assumed.
    expect(labels).toHaveLength(projectCtx.allProjects.length + 1);
  });

  it('submits the project that was chosen, in the request body', async () => {
    await mount(undefined);
    await chooseProject(OTHER.name);
    await submitForm();
    expect(started.calls).toHaveLength(1);
    expect(started.calls[0].input?.projectId).toBe(OTHER.id);
  });

  it('submits no project when left on unassigned, rather than guessing one', async () => {
    await mount(undefined);
    await submitForm();
    expect(started.calls).toHaveLength(1);
    expect(started.calls[0].input?.projectId).toBeUndefined();
  });
});

describe('NewSessionModal — a value outside the list cannot be submitted', () => {
  it('a seeded project that is not in the list disables Start and submits nothing', async () => {
    // How this arises: `usePageProject` holds a `?project=<uuid>` provisionally while the
    // list is unresolved, and the modal seeds from that value.
    await mount(GHOST_ID);
    expect(startButton().disabled).toBe(true);
    await submitForm();
    expect(started.calls).toEqual([]);
  });

  it('a project that disappears from the list while the form is open blocks submission', async () => {
    await mount(undefined);
    await chooseProject(OTHER.name);
    await act(async () => {
      projectCtx.allProjects = [HOME];
      // Re-render with the narrower list; the choice is now outside it.
      root!.render(
        <NewSessionModal
          open
          onClose={() => undefined}
          defaultProjectId={undefined}
          pageScope={workingPageScope}
        />,
      );
    });
    expect(startButton().disabled).toBe(true);
    await submitForm();
    expect(started.calls).toEqual([]);
  });

  it('typing into the search box cannot produce a value — the control commits options only', async () => {
    // The search box only exists once the list is long enough to warrant it, so the list
    // is built to cross that threshold — the assertion that it rendered is what stops
    // this case passing vacuously on a short list.
    projectCtx.allProjects = Array.from({ length: SEARCHABLE_THRESHOLD + 1 }, (_, i) => ({
      id: `dddddddd-4444-4444-8444-00000000000${i}`,
      name: `Project ${i}`,
    }));
    await mount(undefined);
    await act(async () => {
      projectTrigger().click();
    });

    const search = document.querySelector<HTMLInputElement>('input[role="combobox"]');
    expect(search).not.toBeNull();
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )!.set!;
      setter.call(search!, 'a project that does not exist');
      search!.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(document.querySelectorAll('[role="option"]')).toHaveLength(0);

    await submitForm();
    expect(started.calls).toHaveLength(1);
    expect(started.calls[0].input?.projectId).toBeUndefined();
  });
});

describe('NewSessionModal — the project list could not be read', () => {
  beforeEach(() => {
    projectCtx.allProjects = [];
    projectCtx.projectsUnavailable = true;
  });

  it('offers nothing at all, rather than a live control with one leftover choice', async () => {
    await mount(undefined);
    expect(projectTrigger().disabled).toBe(true);
    expect(projectTrigger().textContent).toContain('Projects unavailable');
  });

  it('refuses to start when no scope can be produced', async () => {
    await mount(undefined, () => {
      throw new Error('unscoped');
    });
    expect(startButton().disabled).toBe(true);
    await submitForm();
    expect(started.calls).toEqual([]);
  });
});
