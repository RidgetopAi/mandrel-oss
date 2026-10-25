/**
 * ProjectContext — the PINNED ambient scope (page-scope epic §C, amended §A2).
 *
 * ── WHAT THIS GUARD IS FOR ───────────────────────────────────────────────────────────
 * ONE invariant, stated as the thing that must never happen:
 *
 *     WHILE ANY REAL PROJECT EXISTS, `resolveProjectHeader()` MUST NOT RETURN undefined.
 *
 * That is not a style preference. Several backend controllers read a MISSING project as
 * "every project", so an undefined header does not fail — it silently widens every
 * unscoped read to the whole instance, with no error anywhere. The deleted "All Projects"
 * sentinel did exactly this on purpose (by REMOVING the localStorage keys), and the three
 * accidental routes to the same state are what §A2 enumerates.
 *
 * ── WHY THE ASSERTIONS READ localStorage AND THE RESOLVER, NOT THE CONTEXT ───────────
 * The context's own `currentProject` is the app agreeing with itself. The value that
 * actually decides scope is what `resolveProjectHeader()` — a synchronous function
 * running BELOW React inside the axios interceptor — returns for the next request. Every
 * scoping assertion below is anchored there, on the real implementation, not on a mock.
 *
 * ── THE POPULATION THIS GUARD ENUMERATES ─────────────────────────────────────────────
 * Every route to "no ambient project" that §A2 names, plus the empty/absent members:
 *   default set · default absent · default unresolvable (deleted / access revoked) ·
 *   storage keys purged mid-session · corrupt stored id · legitimately zero projects.
 *
 * Raw react-dom + React.act harness (this repo has no @testing-library).
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Project } from '../types/project';

const ALPHA: Project = {
  id: 'aaaaaaaa-1111-4111-8111-111111111111',
  name: 'Alpha',
  status: 'active',
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
  last_activity: '2026-06-01T00:00:00.000Z',
};
const BETA: Project = {
  id: 'bbbbbbbb-2222-4222-8222-222222222222',
  name: 'Beta',
  status: 'active',
  created_at: '2026-01-02T00:00:00.000Z',
  updated_at: '2026-01-02T00:00:00.000Z',
  last_activity: '2026-06-02T00:00:00.000Z',
};
/** A default that names a project the user cannot see — deleted, or access revoked. */
const GHOST_ID = 'cccccccc-3333-4333-8333-333333333333';

const settings = vi.hoisted(() => ({ defaultProjectId: undefined as string | undefined }));
const projectList = vi.hoisted(() => ({ value: [] as unknown[] }));

vi.mock('./AuthContext', () => ({
  useAuthContext: () => ({ isAuthenticated: true, isLoading: false }),
}));

vi.mock('../hooks/useProjects', () => ({
  useProjects: () => ({
    data: { projects: projectList.value },
    isLoading: false,
    error: null,
    refetch: vi.fn().mockResolvedValue({ data: { projects: projectList.value } }),
  }),
  useAllSessions: () => ({ data: { data: { sessions: [] } }, isLoading: false, error: null }),
}));

vi.mock('../hooks/useSettings', () => ({
  useSettings: () => ({ defaultProjectId: settings.defaultProjectId }),
}));

vi.mock('../hooks/useErrorHandler', () => ({
  useErrorHandler: () => ({
    error: null,
    clearError: vi.fn(),
    hasError: false,
    withErrorHandling: (fn: (...a: unknown[]) => unknown) => fn,
  }),
}));

import { ProjectProvider, useProjectContext, useEffectiveProjectId } from './ProjectContext';
import { useProjectSelectionStore, resetProjectSelection } from '../stores/projectSelectionStore';
// The REAL resolver — the thing the axios interceptor calls. Not a mock.
import {
  resolveProjectHeader,
  __resetRememberedAmbientProject,
} from '../api/http/projectHeaders';

let probe: {
  currentId: string | undefined;
  effectiveId: string | undefined;
  projectNames: string[];
} = { currentId: undefined, effectiveId: undefined, projectNames: [] };

const Probe: React.FC = () => {
  const { currentProject, allProjects } = useProjectContext();
  probe = {
    currentId: currentProject?.id,
    effectiveId: useEffectiveProjectId(),
    projectNames: allProjects.map((p) => p.name),
  };
  return null;
};

let container: HTMLDivElement;
let root: Root;

async function mount() {
  container = document.createElement('div');
  document.body.appendChild(container);
  await act(async () => {
    root = createRoot(container);
    root.render(
      <ProjectProvider>
        <Probe />
      </ProjectProvider>,
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

beforeEach(() => {
  settings.defaultProjectId = BETA.id;
  projectList.value = [ALPHA, BETA];
  localStorage.clear();
  localStorage.setItem('aidis_user', JSON.stringify({ id: 'u-alice', username: 'alice' }));
  resetProjectSelection();
  // The resolver's in-memory rung is module state and WOULD leak between tests,
  // making a later case pass on a value an earlier one left behind.
  __resetRememberedAmbientProject();
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  localStorage.clear();
});

describe('ProjectContext — rung 0: the topbar selection', () => {
  it("a selected project becomes the ambient project AND the next request's header", async () => {
    useProjectSelectionStore.getState().select(ALPHA.id);
    await mount();
    expect(probe.currentId).toBe(ALPHA.id);
    expect(probe.effectiveId).toBe(ALPHA.id);
    expect(resolveProjectHeader()).toBe(ALPHA.id);
  });

  it('switching at runtime re-derives the header — no reload needed', async () => {
    await mount();
    expect(resolveProjectHeader()).toBe(BETA.id);
    await act(async () => useProjectSelectionStore.getState().select(ALPHA.id));
    await settle();
    expect(probe.currentId).toBe(ALPHA.id);
    expect(resolveProjectHeader()).toBe(ALPHA.id);
  });

  it("a leftover 'all' NEVER widens the header — it stays pinned to the default (F2)", async () => {
    useProjectSelectionStore.getState().select('all');
    await mount();
    expect(probe.currentId).toBe(BETA.id);
    expect(resolveProjectHeader()).toBe(BETA.id);
  });

  it('a selection the user can no longer see falls through to the default, never unscoped', async () => {
    useProjectSelectionStore.getState().select(GHOST_ID);
    await mount();
    expect(probe.currentId).toBe(BETA.id);
    expect(resolveProjectHeader()).toBe(BETA.id);
  });

  it("a pick made under ANOTHER login is not this user's scope (F1 owner check)", async () => {
    localStorage.setItem('aidis_user', JSON.stringify({ id: 'u-bob', username: 'bob' }));
    useProjectSelectionStore.getState().select(ALPHA.id); // bob picks Alpha…
    localStorage.setItem('aidis_user', JSON.stringify({ id: 'u-alice', username: 'alice' }));
    await mount(); // …alice's session reads the same localStorage
    expect(probe.currentId).toBe(BETA.id);
    expect(resolveProjectHeader()).toBe(BETA.id);
  });

  it('the selection is dropped by resetProjectSelection (what logout and login call)', async () => {
    useProjectSelectionStore.getState().select(ALPHA.id);
    await mount();
    expect(probe.currentId).toBe(ALPHA.id);
    await act(async () => resetProjectSelection());
    await settle();
    expect(probe.currentId).toBe(BETA.id);
    expect(resolveProjectHeader()).toBe(BETA.id);
  });
});

describe('ProjectContext — pinned to the user default', () => {
  it('pins the ambient project to the user default, BY ID', async () => {
    await mount();
    expect(probe.currentId).toBe(BETA.id);
    expect(probe.effectiveId).toBe(BETA.id);
    // The assertion that matters: the next request carries Beta.
    expect(resolveProjectHeader()).toBe(BETA.id);
  });

  it('follows a RENAMED project, because the preference is an id (the rename bug)', async () => {
    // Same id, different name — the exact mutation the old name-keyed preference broke on.
    projectList.value = [ALPHA, { ...BETA, name: 'Beta (renamed)' }];
    await mount();
    expect(probe.currentId).toBe(BETA.id);
    expect(resolveProjectHeader()).toBe(BETA.id);
  });

  it('exposes allProjects most-recently-active first (the ONE central sort)', async () => {
    await mount();
    // Source order is [Alpha, Beta]; Beta.last_activity (06-02) > Alpha (06-01).
    expect(probe.projectNames).toEqual(['Beta', 'Alpha']);
  });

  // ── THE INVARIANT, ACROSS THE WHOLE §A2 POPULATION ────────────────────────────────
  describe('the ambient header never resolves to undefined while a project exists', () => {
    it('…with NO default set (a brand-new user)', async () => {
      settings.defaultProjectId = undefined;
      await mount();
      const header = resolveProjectHeader();
      expect(header).toBeDefined();
      // Falls back to a REAL project from the list, never a sentinel.
      expect([ALPHA.id, BETA.id]).toContain(header);
      expect(probe.currentId).toBe(header);
    });

    it('…with a default that no longer resolves (project deleted / access revoked)', async () => {
      // This is the DESIGNED outcome of deleting the default project: the migration's
      // ON DELETE SET NULL nulls the preference, and an id can also survive in the cache
      // pointing at a project the user can no longer see.
      settings.defaultProjectId = GHOST_ID;
      await mount();
      const header = resolveProjectHeader();
      expect(header).toBeDefined();
      expect(header).not.toBe(GHOST_ID);
      expect([ALPHA.id, BETA.id]).toContain(header);
    });

    it('…after localStorage is CLEARED mid-session (§A2 mutation)', async () => {
      await mount();
      expect(resolveProjectHeader()).toBe(BETA.id);

      // THE MUTATION: wipe the enforcement point out from under React. React cannot see
      // this — the provider's persist effect is dependency-gated on values that did not
      // change, so nothing re-runs. Against a storage-only ladder the app sat unscoped
      // from here on; that is what rung 4 exists for.
      localStorage.clear();

      // The invariant: the VERY NEXT request still names the project. Not "eventually",
      // not "after a re-render" — the next one, because that is when the damage happens.
      expect(resolveProjectHeader()).toBe(BETA.id);

      // …and it HEALED rather than limping on memory: the storage rungs are seated again
      // for every other reader (SSE, embeddingsClient).
      expect(JSON.parse(localStorage.getItem('aidis_selected_project')!).id).toBe(BETA.id);
      expect(JSON.parse(localStorage.getItem('aidis_current_project')!).id).toBe(BETA.id);
    });

    it('…and the in-memory rung is dropped when the user genuinely has no projects', async () => {
      await mount();
      expect(resolveProjectHeader()).toBe(BETA.id);

      // Positively-measured empty list: rung 4 must NOT helpfully re-seat an id this
      // user can no longer see (the backend 403s it under F-04).
      projectList.value = [];
      settings.defaultProjectId = undefined;
      await act(async () => {
        root.render(
          <ProjectProvider>
            <Probe />
          </ProjectProvider>,
        );
      });
      await settle();

      expect(resolveProjectHeader()).toBeUndefined();
      expect(localStorage.getItem('aidis_selected_project')).toBeNull();
    });

    it('…when only the SETTINGS CACHE survives (rung 3 of the ladder)', async () => {
      await mount();
      // Simulate the corrupt-purge / project-deleted path clearing BOTH project keys,
      // which is what used to leave the app unscoped.
      localStorage.removeItem('aidis_selected_project');
      localStorage.removeItem('aidis_current_project');
      localStorage.setItem(
        'aidis_user_settings',
        JSON.stringify({ defaultProjectId: BETA.id }),
      );

      expect(resolveProjectHeader()).toBe(BETA.id);
    });

    it('…when the stored id is CORRUPT and the legacy mirror is healthy (rung 2)', async () => {
      localStorage.setItem(
        'aidis_selected_project',
        JSON.stringify({ id: 'session_voiceitt-bridge', name: 'corrupt' }),
      );
      localStorage.setItem('aidis_current_project', JSON.stringify({ id: ALPHA.id }));

      expect(resolveProjectHeader()).toBe(ALPHA.id);
      // …and the corrupt value is healed away rather than re-sent next time.
      expect(JSON.parse(localStorage.getItem('aidis_selected_project')!).id).toBe(ALPHA.id);
    });
  });

  it('clears the cached project ONLY when the list positively loads empty', async () => {
    localStorage.setItem('aidis_selected_project', JSON.stringify({ id: ALPHA.id }));
    projectList.value = [];
    settings.defaultProjectId = undefined;
    await mount();

    // Positively measured "this user has no projects" — a stale id here would name a
    // project the backend now 403s (F-04).
    expect(localStorage.getItem('aidis_selected_project')).toBeNull();
    expect(probe.currentId).toBeUndefined();
  });

  it('does NOT expose a setter, a sentinel, or a name-based selector', async () => {
    await mount();
    const ctxKeys = Object.keys(probe);
    expect(ctxKeys).not.toContain('setCurrentProject');
    // The deleted global-sentinel surface must not come back: importing it should fail.
    const mod = await import('./ProjectContext');
    expect('ALL_PROJECTS' in mod).toBe(false);
    expect('ALL_PROJECTS_ID' in mod).toBe(false);
    expect('setCurrentProject' in mod).toBe(false);
  });
});
