/**
 * ProjectSwitch — THE project switch in the topbar.
 *
 * ── OPERATOR'S DONE-WHEN, AS ASSERTIONS ─────────────────────────────────────────────────
 *   "All pages are controlled by single project switch from top menu bar. Once selected
 *    it stays showing that project's data until logged back in where it goes back to
 *    'Default' project from Settings or user re-selects."
 *
 *   • the switch opens on the Settings default, and says so (the "default" marker);
 *   • picking a project in the switch moves EVERY page's scope — two pages are mounted
 *     beside the switch and both follow — AND the ambient `X-Project-ID` the interceptor
 *     would send (the REAL resolver, not the context agreeing with itself);
 *   • the pick survives a remount (navigation / reload) AND A NEW TAB — a second store
 *     instance rehydrating from the same localStorage (the project-switch walkthrough F1);
 *   • `resetProjectSelection()` — what logout AND a fresh login call — puts it back on
 *     the default, and a pick made under another username is never inherited;
 *   • a `?project=` deep link SETS the switch;
 *   • the switch NEVER offers "All projects" (the project-switch walkthrough F2).
 *
 * Real ProjectProvider + real store + real resolver; only the network and auth are
 * stubbed (the ProjectContext.test harness). Raw react-dom + React.act.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Project } from '../../types/project';

const ALPHA: Project = {
  id: 'aaaaaaaa-1111-4111-8111-111111111111',
  name: 'Alpha',
  status: 'active',
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
  last_activity: '2026-06-01T00:00:00.000Z',
};
/** THE SETTINGS DEFAULT. */
const BETA: Project = {
  id: 'bbbbbbbb-2222-4222-8222-222222222222',
  name: 'Beta (default)',
  status: 'active',
  created_at: '2026-01-02T00:00:00.000Z',
  updated_at: '2026-01-02T00:00:00.000Z',
  last_activity: '2026-06-02T00:00:00.000Z',
};

const settings = vi.hoisted(() => ({ defaultProjectId: undefined as string | undefined }));
const projectList = vi.hoisted(() => ({ value: [] as unknown[] }));

vi.mock('../../contexts/AuthContext', () => ({
  useAuthContext: () => ({ isAuthenticated: true, isLoading: false }),
}));
vi.mock('../../hooks/useProjects', () => ({
  useProjects: () => ({
    data: { projects: projectList.value },
    isLoading: false,
    error: null,
    refetch: vi.fn().mockResolvedValue({ data: { projects: projectList.value } }),
  }),
  useAllSessions: () => ({ data: { data: { sessions: [] } }, isLoading: false, error: null }),
}));
vi.mock('../../hooks/useSettings', () => ({
  useSettings: () => ({ defaultProjectId: settings.defaultProjectId }),
}));
vi.mock('../../hooks/useErrorHandler', () => ({
  useErrorHandler: () => ({
    error: null,
    clearError: vi.fn(),
    hasError: false,
    withErrorHandling: (fn: (...a: unknown[]) => unknown) => fn,
  }),
}));

import { ProjectProvider } from '../../contexts/ProjectContext';
import { ProjectSwitch } from './ProjectSwitch';
import { usePageProject, type UsePageProject } from '../../hooks/usePageProject';
import { resolveProjectHeader, __resetRememberedAmbientProject } from '../../api/http/projectHeaders';
import {
  resetProjectSelection,
  createProjectSelectionStore,
  currentSelection,
  PROJECT_SELECTION_STORAGE_KEY,
} from '../../stores/projectSelectionStore';
import { apiConfig } from '../../config/apiConfig';

/** Two "pages" beside the switch (e.g. Contexts and Calendar): both read the ONE switch. */
let scoped: UsePageProject;
let wide: UsePageProject;
const ScopedPage: React.FC = () => {
  scoped = usePageProject();
  return null;
};
const WidePage: React.FC = () => {
  wide = usePageProject();
  return null;
};

let container: HTMLDivElement;
let root: Root;

async function mount(url = '/tasks') {
  container = document.createElement('div');
  document.body.appendChild(container);
  await act(async () => {
    root = createRoot(container);
    root.render(
      <MemoryRouter initialEntries={[url]}>
        <ProjectProvider>
          <ProjectSwitch />
          <ScopedPage />
          <WidePage />
        </ProjectProvider>
      </MemoryRouter>,
    );
  });
  await settle();
}

async function settle() {
  for (let i = 0; i < 6; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await act(async () => {
      await Promise.resolve();
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

const trigger = (): HTMLElement => container.querySelector('[aria-label="Project"]') as HTMLElement;
const marker = (): Element | null =>
  container.querySelector('[data-testid="project-switch-default-marker"]');

async function pick(label: string) {
  const t = trigger();
  expect(t, 'the switch trigger should exist').toBeTruthy();
  await act(async () => t.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  const option = Array.from(container.querySelectorAll('[role="option"]')).find(
    (o) => (o.textContent ?? '').trim() === label,
  );
  expect(option, `option "${label}" should be offered`).toBeTruthy();
  await act(async () => option!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  await settle();
}

function unmount() {
  act(() => root?.unmount());
  container?.remove();
}

beforeEach(() => {
  settings.defaultProjectId = BETA.id;
  projectList.value = [ALPHA, BETA];
  localStorage.clear();
  localStorage.setItem('aidis_user', JSON.stringify({ id: 'u-alice', username: 'alice' }));
  resetProjectSelection();
  __resetRememberedAmbientProject();
});

const optionLabels = async (): Promise<string[]> => {
  await act(async () => trigger().dispatchEvent(new MouseEvent('click', { bubbles: true })));
  const labels = Array.from(container.querySelectorAll('[role="option"]')).map((o) =>
    (o.textContent ?? '').trim(),
  );
  await act(async () => trigger().dispatchEvent(new MouseEvent('click', { bubbles: true })));
  return labels;
};

afterEach(() => {
  unmount();
  localStorage.clear();
});

describe('ProjectSwitch — opens on the Settings default', () => {
  it('shows the default project and marks it as the default', async () => {
    await mount();
    expect(trigger().textContent).toContain(BETA.name);
    expect(marker()).not.toBeNull();
    expect(scoped.projectId).toBe(BETA.id);
    expect(wide.projectId).toBe(BETA.id);
    expect(resolveProjectHeader()).toBe(BETA.id);
  });

  it('renders exactly ONE project control in the shell — the switch', async () => {
    await mount();
    expect(container.querySelectorAll('[aria-label="Project"]').length).toBe(1);
  });
});

describe('ProjectSwitch — one switch moves every page AND the wire', () => {
  it('picking Alpha re-scopes both pages, their scope() header, and the ambient header', async () => {
    await mount();
    await pick(ALPHA.name);

    expect(trigger().textContent).toContain(ALPHA.name);
    expect(marker(), 'Alpha is not the default, so no marker').toBeNull();
    expect(scoped.projectId).toBe(ALPHA.id);
    expect(wide.projectId).toBe(ALPHA.id);
    // The page's per-request pin (what every api.* call carries)…
    expect((scoped.scope().headers as Record<string, string>)[apiConfig.projectHeader]).toBe(ALPHA.id);
    // …and the ambient header the interceptor would send for anything unscoped.
    expect(resolveProjectHeader()).toBe(ALPHA.id);
  });

  it('the pick SURVIVES a remount (navigation / reload)', async () => {
    await mount();
    await pick(ALPHA.name);
    expect(localStorage.getItem(PROJECT_SELECTION_STORAGE_KEY) ?? '').toContain(ALPHA.id);
    unmount();

    await mount('/contexts');
    expect(trigger().textContent).toContain(ALPHA.name);
    expect(scoped.projectId).toBe(ALPHA.id);
    expect(wide.projectId).toBe(ALPHA.id);
  });

  it('the pick SURVIVES a NEW TAB — a fresh store instance over the same localStorage (F1)', async () => {
    await mount();
    await pick(ALPHA.name);
    unmount();
    // A new tab is a new module instance rehydrating from localStorage. The singleton is
    // this tab; a second instance is the other one.
    const otherTab = createProjectSelectionStore();
    expect(currentSelection(otherTab.getState())).toBe(ALPHA.id);
    // …and the switch in that tab renders it (the singleton re-reads the same storage).
    await mount('/decisions');
    expect(trigger().textContent).toContain(ALPHA.name);
    expect(scoped.projectId).toBe(ALPHA.id);
  });

  it("a pick made under ANOTHER username is never inherited — it reads as this user's default (F1)", async () => {
    await mount();
    await pick(ALPHA.name); // alice picks Alpha
    unmount();
    localStorage.setItem('aidis_user', JSON.stringify({ id: 'u-bob', username: 'bob' }));
    // Login calls resetProjectSelection; but even a tab that MISSED it must not inherit.
    const bobTab = createProjectSelectionStore();
    expect(bobTab.getState().selectedProjectId).toBe(ALPHA.id); // the raw storage still holds it…
    expect(currentSelection(bobTab.getState())).toBeUndefined(); // …but it is not bob's scope
    await mount();
    expect(trigger().textContent).toContain(BETA.name);
    expect(marker()).not.toBeNull();
    expect(scoped.projectId).toBe(BETA.id);
    expect(resolveProjectHeader()).toBe(BETA.id);
  });

  it('a fresh login (resetProjectSelection) puts it back on the Settings default', async () => {
    await mount();
    await pick(ALPHA.name);
    expect(scoped.projectId).toBe(ALPHA.id);
    unmount();

    resetProjectSelection(); // what resetAuthState (logout) and useLogin.onSuccess call
    expect(localStorage.getItem(PROJECT_SELECTION_STORAGE_KEY) ?? '').not.toContain(ALPHA.id);

    await mount();
    expect(trigger().textContent).toContain(BETA.name);
    expect(marker()).not.toBeNull();
    expect(scoped.projectId).toBe(BETA.id);
    expect(resolveProjectHeader()).toBe(BETA.id);
  });

  it('NEVER offers "All projects" — the switch is one project at a time (F2)', async () => {
    await mount();
    const labels = await optionLabels();
    expect(labels).toEqual([BETA.name, ALPHA.name]); // the central order, nothing pinned ahead
    expect(labels.join('|')).not.toContain('All projects');
    expect(labels).not.toContain('all');
  });
});

describe('ProjectSwitch — a ?project= deep link SETS the switch', () => {
  it('opening /tasks?project=<alpha> shows Alpha in the switch, not the default', async () => {
    await mount(`/tasks?project=${ALPHA.id}`);
    expect(trigger().textContent).toContain(ALPHA.name);
    expect(marker()).toBeNull();
    expect(scoped.projectId).toBe(ALPHA.id);
    expect(localStorage.getItem(PROJECT_SELECTION_STORAGE_KEY) ?? '').toContain(ALPHA.id);
  });

  it('an unselectable ?project= leaves the switch on the default', async () => {
    await mount('/tasks?project=cccccccc-3333-4333-8333-333333333333');
    expect(trigger().textContent).toContain(BETA.name);
    expect(scoped.projectId).toBe(BETA.id);
  });
});
