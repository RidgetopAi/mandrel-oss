/**
 * usePageProject + scopedRequestConfig — a page's scope, read from THE ONE SWITCH
 * (an earlier punch over the page-scope epic §A1/§A4).
 *
 * ════════════════════════════════════════════════════════════════════════════════════
 *  THE DEFECT THIS GUARD EXISTS TO CATCH
 * ════════════════════════════════════════════════════════════════════════════════════
 * Page selector = project A. Ambient header = the user's default, project B. A write
 * from that page (`decision_record`, `decision_update`, `context_store` — the
 * `requireWriteProjectId` controllers) resolves scope as HEADER > body, so it lands in
 * **B**. It does not appear in the list on screen. Nothing errors: both projects
 * authorize, so the backend guard passes legitimately.
 *
 * That is a silent data-misplacement bug with no exception and no red anywhere, and it
 * is introduced BY DESIGN the moment the ambient header stops equalling what the page
 * shows. So the assertion below is not "the hook returns A" — it is:
 *
 *     THE OUTGOING REQUEST NAMES A. Not "no project". Not B. A.
 *
 * ── WHY THIS IS NOT AN msw ECHO ──────────────────────────────────────────────────────
 * A mock server replaying what the frontend sent is the app agreeing with itself. This
 * suite instead drives the REAL axios request interceptor (services/api.ts) and reads
 * the header off the config the interceptor produced — the actual bytes that would go on
 * the wire — with the ambient localStorage deliberately set to a DIFFERENT project so
 * that "no header" and "the wrong header" are both distinguishable failures.
 *
 * ── THE MUTATION THAT PROVES IT ──────────────────────────────────────────────────────
 * Null the default / clear the localStorage keys and assert the request STILL names A,
 * or FAILS. It must never succeed unscoped — see the last describe block.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Project } from '../types/project';

const PROJECT_A: Project = {
  id: 'aaaaaaaa-1111-4111-8111-111111111111',
  name: 'Project A',
  status: 'active',
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
  last_activity: '2026-06-02T00:00:00.000Z',
};
/** THE AMBIENT/DEFAULT PROJECT — the one a mis-scoped write would silently land in. */
const PROJECT_B: Project = {
  id: 'bbbbbbbb-2222-4222-8222-222222222222',
  name: 'Project B (the default)',
  status: 'active',
  created_at: '2026-01-02T00:00:00.000Z',
  updated_at: '2026-01-02T00:00:00.000Z',
  last_activity: '2026-06-01T00:00:00.000Z',
};

const settings = vi.hoisted(() => ({ defaultProjectId: undefined as string | undefined }));
const projectList = vi.hoisted(() => ({ value: [] as unknown[] }));
/** The topbar switch's store, as ProjectContext surfaces it. Survives a remount, like the real one. */
const selection = vi.hoisted(() => ({ value: undefined as string | undefined }));

vi.mock('../contexts/ProjectContext', () => ({
  useProjectContext: () => ({
    allProjects: projectList.value,
    loading: false,
    selectedProjectId: selection.value,
    setSelectedProjectId: (v: string) => {
      selection.value = v;
    },
  }),
}));
vi.mock('./useSettings', () => ({
  useSettings: () => ({ defaultProjectId: settings.defaultProjectId }),
}));

import { usePageProject, PROJECT_URL_PARAM, type UsePageProject } from './usePageProject';
import { UnscopedRequestError, scopedRequestConfig } from '../api/http/projectScope';
import { apiConfig } from '../config/apiConfig';

let hook: UsePageProject;
let search = '';

const Probe: React.FC = () => {
  hook = usePageProject();
  search = useLocation().search;
  return null;
};

let container: HTMLDivElement;
let root: Root;

async function mount(initialUrl = '/contexts') {
  container = document.createElement('div');
  document.body.appendChild(container);
  await act(async () => {
    root = createRoot(container);
    root.render(
      <MemoryRouter initialEntries={[initialUrl]}>
        <Probe />
      </MemoryRouter>,
    );
  });
}

/**
 * Run the config a page produced through the REAL axios request interceptor and return
 * the `X-Project-ID` it would actually send. This is the closest thing to the wire that
 * a unit test can read, and it is what makes "no header" a visible failure rather than a
 * silent pass.
 */
async function headerOnTheWire(config: Record<string, unknown>): Promise<unknown> {
  const { apiClient } = await import('../services/api');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const instance = (apiClient as any).instance ?? (apiClient as any)._instance;
  const handlers = instance.interceptors.request.handlers.filter(Boolean);
  let cfg = { ...config, headers: { ...((config.headers as object) ?? {}) }, url: '/x', method: 'post' };
  for (const h of handlers) {
    // eslint-disable-next-line no-await-in-loop
    cfg = await h.fulfilled(cfg);
  }
  return (cfg.headers as Record<string, unknown>)[apiConfig.projectHeader];
}

beforeEach(() => {
  localStorage.clear();
  selection.value = undefined;
  projectList.value = [PROJECT_A, PROJECT_B];
  settings.defaultProjectId = PROJECT_B.id;
  // THE AMBIENT SCOPE IS PROJECT B, DELIBERATELY. Every assertion below is meaningful
  // only because the ambient value is a project the page is NOT showing.
  localStorage.setItem('aidis_selected_project', JSON.stringify({ id: PROJECT_B.id }));
  localStorage.setItem('aidis_current_project', JSON.stringify({ id: PROJECT_B.id }));
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  localStorage.clear();
});

describe('usePageProject — THE SWITCH governs, the default is the floor', () => {
  it('opens at the user default when nothing is selected and no ?project= is present', async () => {
    await mount('/contexts');
    expect(hook.projectId).toBe(PROJECT_B.id);
    expect(hook.projectName).toBe(PROJECT_B.name);
  });

  it('opens at the topbar selection when one is set', async () => {
    selection.value = PROJECT_A.id;
    await mount('/contexts');
    expect(hook.projectId).toBe(PROJECT_A.id);
    expect(hook.projectName).toBe(PROJECT_A.name);
  });

  it('a STALE selection (a project this user can no longer see) falls back to the default', async () => {
    selection.value = 'cccccccc-3333-4333-8333-333333333333';
    await mount('/contexts');
    expect(hook.projectId).toBe(PROJECT_B.id);
  });

  it('setProjectId moves THE switch — so the next page (a remount) opens on it too', async () => {
    await mount('/contexts');
    await act(async () => hook.setProjectId(PROJECT_A.id));
    expect(selection.value).toBe(PROJECT_A.id);
    act(() => root.unmount());
    await mount('/tasks');
    expect(hook.projectId).toBe(PROJECT_A.id);
  });

  it("a leftover 'all' in the store is NOT a scope — the page shows the default (F2)", async () => {
    selection.value = 'all';
    await mount('/contexts');
    expect(hook.projectId).toBe(PROJECT_B.id);
    expect(hook.projectName).toBe(PROJECT_B.name);
    expect(hook.ready).toBe(true);
  });
});

describe('usePageProject — ?project= is a deep link that SETS the switch (§A4, amended)', () => {
  it('honours ?project= over the selection for that page load', async () => {
    selection.value = PROJECT_B.id;
    await mount(`/contexts?${PROJECT_URL_PARAM}=${PROJECT_A.id}`);
    expect(hook.projectId).toBe(PROJECT_A.id);
    expect(hook.projectName).toBe(PROJECT_A.name);
  });

  it('ADOPTS it into the switch, so the topbar never shows one project while the page renders another', async () => {
    selection.value = PROJECT_B.id;
    await mount(`/contexts?${PROJECT_URL_PARAM}=${PROJECT_A.id}`);
    expect(selection.value).toBe(PROJECT_A.id);
  });

  it('IGNORES a ?project= the user cannot select, rather than sending a 403 — and does not adopt it', async () => {
    await mount(`/contexts?${PROJECT_URL_PARAM}=cccccccc-3333-4333-8333-333333333333`);
    expect(hook.projectId).toBe(PROJECT_B.id);
    expect(selection.value).toBeUndefined();
  });

  it('?project=all is IGNORED like any other unselectable value, and not adopted (F2)', async () => {
    await mount(`/sessions?${PROJECT_URL_PARAM}=all`);
    expect(hook.projectId).toBe(PROJECT_B.id);
    expect(selection.value).toBeUndefined();
  });

  it('a later switch DROPS the ?project= override from the URL, so the two cannot disagree', async () => {
    await mount(`/contexts?${PROJECT_URL_PARAM}=${PROJECT_A.id}`);
    expect(search).toContain(`${PROJECT_URL_PARAM}=`);
    await act(async () => hook.setProjectId(PROJECT_B.id));
    expect(search).not.toContain(`${PROJECT_URL_PARAM}=`);
    expect(selection.value).toBe(PROJECT_B.id);
    expect(hook.projectId).toBe(PROJECT_B.id);
  });
});

describe('usePageProject — the outgoing request NAMES the page project (§A1)', () => {
  it('a page on A sends X-Project-ID: A, while the ambient default is B', async () => {
    await mount(`/decisions?${PROJECT_URL_PARAM}=${PROJECT_A.id}`);

    const sent = await headerOnTheWire(hook.scope());

    // The whole point, stated three ways so no failure mode reads as a pass:
    expect(sent).toBe(PROJECT_A.id); // it named A…
    expect(sent).not.toBe(PROJECT_B.id); // …not the ambient default…
    expect(sent).toBeDefined(); // …and not "no project", which the backend reads as ALL.
  });

  it('WITHOUT scope(), the same request silently carries the ambient B — the bug', async () => {
    await mount(`/decisions?${PROJECT_URL_PARAM}=${PROJECT_A.id}`);

    // This is what a page that forgets `scope()` produces. Asserted explicitly so the
    // guard documents the defect it protects against, and so a future change to the
    // interceptor that quietly alters this is visible here.
    const sent = await headerOnTheWire({});
    expect(sent).toBe(PROJECT_B.id);
    expect(sent).not.toBe(PROJECT_A.id);
  });

  it('scope() preserves the caller config and only pins the header', async () => {
    await mount(`/decisions?${PROJECT_URL_PARAM}=${PROJECT_A.id}`);
    const cfg = hook.scope({ params: { limit: 20 }, headers: { 'X-Custom': 'keep' } });
    expect(cfg.params).toEqual({ limit: 20 });
    expect((cfg.headers as Record<string, string>)['X-Custom']).toBe('keep');
    expect((cfg.headers as Record<string, string>)[apiConfig.projectHeader]).toBe(PROJECT_A.id);
  });

  it("scopedRequestConfig('all') still BLANKS the header — the primitive keeps its contract", async () => {
    // No page can reach 'all' from the switch any more (F2); the primitive that hooks
    // such as tasks/hooks still accept is unchanged, so this is asserted on it directly.
    const sent = await headerOnTheWire(scopedRequestConfig('all'));
    expect(sent).toBeUndefined();
  });
});

describe('usePageProject — fails LOUD, never silently unscoped (§A2 mutation)', () => {
  it('scope() THROWS when the page has no project, instead of falling back to ambient', async () => {
    projectList.value = [];
    settings.defaultProjectId = undefined;
    await mount('/contexts');

    expect(hook.projectId).toBeUndefined();
    expect(hook.ready).toBe(false);
    // The mutation: ambient B is still sitting in localStorage and would have been used
    // by a silent fallback. It must not be.
    expect(localStorage.getItem('aidis_selected_project')).not.toBeNull();
    expect(() => hook.scope()).toThrow(UnscopedRequestError);
  });

  it('`ready` is the non-throwing form of the same question', async () => {
    await mount(`/contexts?${PROJECT_URL_PARAM}=${PROJECT_A.id}`);
    expect(hook.ready).toBe(true);
    expect(() => hook.scope()).not.toThrow();
  });

  it('nulling the default does NOT make the page fall back to unscoped', async () => {
    settings.defaultProjectId = undefined;
    await mount('/contexts');
    // No default set, but projects exist → the page pins the first real one, and the
    // request names it. Never `undefined`, which the backend reads as every project.
    const sent = await headerOnTheWire(hook.scope());
    expect(sent).toBeDefined();
    expect([PROJECT_A.id, PROJECT_B.id]).toContain(sent);
  });
});
