/**
 * usePageProject — WHAT A SCOPED PAGE SCOPES TO WHEN THE SERVER CANNOT BE REACHED.
 *
 * ════════════════════════════════════════════════════════════════════════════════════
 *  THE DEFECT THIS GUARD EXISTS TO CATCH
 * ════════════════════════════════════════════════════════════════════════════════════
 * A page's project comes from two network reads: the project LIST (ProjectContext) and
 * the user's DEFAULT (SettingsContext). When both fail, `loading` settles to false and
 * the list settles to empty — the same two values a user with genuinely zero projects
 * produces. A consumer that branches only on those cannot tell the two apart, and the
 * one it picks is the wrong one: on a page that offers "All projects", the selector
 * stays live with that as its ONLY choice, and choosing it writes `?project=all` into
 * the URL, where it survives the outage and every reload after it.
 *
 * So the assertion is not "the hook returns undefined". It is:
 *
 *     A SCOPE THE USER NEVER CHOSE MUST NOT BE REACHABLE, PRESENTABLE, OR PERSISTENT
 *     WHILE THE LIST CANNOT BE READ.
 *
 * ── WHY THE REAL PROVIDERS AND NOT MOCKED VALUES ─────────────────────────────────────
 * The defect lives in the COMPOSITION — which of ProjectContext's and SettingsContext's
 * settled values reach the hook's fallback, and in what order. Feeding the hook a
 * hand-written `{ allProjects: [], loading: false }` asserts the shape this test was
 * written to expect. These cases mount the real SettingsProvider and ProjectProvider and
 * fail the NETWORK, which is the thing that actually happened.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const HOME = {
  id: 'aaaaaaaa-1111-4111-8111-111111111111',
  name: 'Home project',
  status: 'active',
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
  last_activity: '2026-06-01T00:00:00.000Z',
};
const OTHER = {
  id: 'bbbbbbbb-2222-4222-8222-222222222222',
  name: 'Other project',
  status: 'active',
  created_at: '2026-01-02T00:00:00.000Z',
  updated_at: '2026-01-02T00:00:00.000Z',
  // More recently active than HOME, so `projects[0]` is OTHER: a test that passes
  // because the default and the first entry are the same project proves nothing.
  last_activity: '2026-06-09T00:00:00.000Z',
};

/**
 * Flipped per case. `null` = the request REJECTS (unreachable). A read that succeeds and
 * answers "none" is spelled differently — `defaultProjectId: undefined` — because those
 * are the two states this whole file is about telling apart, and a stub that spells them
 * the same way cannot test the distinction.
 */
const server = vi.hoisted(() => ({
  projects: null as null | Array<Record<string, unknown>>,
  defaultProjectId: null as null | undefined | string,
}));

const answer = <T,>(value: T | null, name: string): Promise<T> =>
  value === null ? Promise.reject(new Error(`Network Error (${name})`)) : Promise.resolve(value);

vi.mock('../contexts/AuthContext', () => ({
  useAuthContext: () => ({ isAuthenticated: true, isLoading: false }),
}));

vi.mock('../api/generated', () => ({
  ProjectsService: {
    getProjects: () => answer(server.projects, 'projects').then((projects) => ({ projects })),
    getProjectsSessionsAll: () => Promise.resolve({ data: { sessions: [], total: 0 } }),
  },
  SessionsService: {},
}));

vi.mock('../api', () => ({
  api: {
    projects: { list: () => answer(server.projects, 'projects') },
    users: {
      getPreferences: () =>
        answer(server.defaultProjectId, 'preferences').then((defaultProjectId) => ({
          defaultProjectId,
        })),
      updatePreferences: () => Promise.reject(new Error('not used')),
    },
  },
}));

vi.mock('./useErrorHandler', () => ({
  useErrorHandler: () => ({
    error: null,
    clearError: vi.fn(),
    hasError: false,
    withErrorHandling: (fn: (...a: unknown[]) => unknown) => fn,
  }),
}));

import { SettingsProvider } from '../contexts/SettingsContext';
import { ProjectProvider } from '../contexts/ProjectContext';
import { useProjectSelectionStore, resetProjectSelection } from '../stores/projectSelectionStore';
import { usePageProject, PROJECT_URL_PARAM, type UsePageProject } from './usePageProject';
import { ALL_PROJECTS_VALUE } from '../components/ui/ProjectSelect';
import { UnscopedRequestError } from '../api/http/projectScope';
import { apiConfig } from '../config/apiConfig';

const SETTINGS_CACHE_KEY = 'aidis_user_settings';

let hook: UsePageProject;
const Probe: React.FC = () => {
  hook = usePageProject();
  return null;
};

let root: Root | undefined;
let container: HTMLDivElement | undefined;
let queryClient: QueryClient | undefined;

async function mount(url: string) {
  container = document.createElement('div');
  document.body.appendChild(container);
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root = createRoot(container!);
    root.render(
      <QueryClientProvider client={queryClient}>
        <SettingsProvider>
          <ProjectProvider>
            <MemoryRouter initialEntries={[url]}>
              <Probe />
            </MemoryRouter>
          </ProjectProvider>
        </SettingsProvider>
      </QueryClientProvider>,
    );
  });
  // Let the two provider fetches settle (or reject) before asserting.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

/** The `X-Project-ID` the shared axios interceptor would actually put on the wire. */
async function headerOnTheWire(config: Record<string, unknown>): Promise<unknown> {
  const { apiClient } = await import('../services/api');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const instance = (apiClient as any).instance ?? (apiClient as any)._instance;
  let cfg: Record<string, unknown> = {
    ...config,
    headers: { ...((config.headers as object) ?? {}) },
    url: '/x',
    method: 'get',
  };
  for (const h of instance.interceptors.request.handlers.filter(Boolean)) {
    // eslint-disable-next-line no-await-in-loop
    cfg = await h.fulfilled(cfg);
  }
  return (cfg.headers as Record<string, unknown>)[apiConfig.projectHeader];
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('aidis_user', JSON.stringify({ id: 'u-alice', username: 'alice' }));
  resetProjectSelection();
  server.projects = [HOME, OTHER];
  server.defaultProjectId = HOME.id;
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
  localStorage.clear();
});

describe('usePageProject — the HAPPY path still opens on the user default', () => {
  it('opens on the default project, not the most-recently-active one', async () => {
    await mount('/sessions');
    expect(hook.unavailable).toBe(false);
    expect(hook.projectId).toBe(HOME.id);
    expect(hook.projectName).toBe(HOME.name);
    // OTHER sorts first by activity, so this distinguishes "read the default" from
    // "fell through to projects[0]".
    expect(hook.projectId).not.toBe(OTHER.id);
    expect(await headerOnTheWire(hook.scope())).toBe(HOME.id);
  });

  it("never opens on 'all' — the switch has no such entry (F2)", async () => {
    await mount('/sessions');
    expect(hook.projectId).not.toBe(ALL_PROJECTS_VALUE);
    expect(hook.unavailable).toBe(false);
  });
});

describe('usePageProject — the server is unreachable', () => {
  beforeEach(() => {
    server.projects = null;
    server.defaultProjectId = null;
  });

  it('does not resolve a scope, and says which of the two states it is in', async () => {
    await mount('/sessions');
    expect(hook.unavailable).toBe(true);
    expect(hook.loading).toBe(false);
    expect(hook.projectId).toBeUndefined();
    expect(hook.ready).toBe(false);
    expect(() => hook.scope()).toThrow(UnscopedRequestError);
  });

  it('presents no scope at all — not even a project list', async () => {
    await mount('/sessions');
    expect(hook.unavailable).toBe(true);
    expect(hook.projects).toEqual([]);
    expect(hook.projectId).toBeUndefined();
  });

  it('does not present a `?project=all` written during an earlier outage as resolved', async () => {
    await mount(`/sessions?${PROJECT_URL_PARAM}=${ALL_PROJECTS_VALUE}`);
    expect(hook.projectId).toBeUndefined();
    expect(hook.projectName).toBeUndefined();
    expect(hook.ready).toBe(false);
  });

  it("does not present an 'all' SELECTION in the switch during an outage as resolved either", async () => {
    // The store survives a reload in the same tab; an outage must not turn it into a scope.
    useProjectSelectionStore.getState().select(ALL_PROJECTS_VALUE);
    await mount('/sessions');
    expect(hook.unavailable).toBe(true);
    expect(hook.projectId).toBeUndefined();
    expect(hook.ready).toBe(false);
  });

  it('does not present an unvalidatable `?project=<uuid>` as resolved either', async () => {
    await mount(`/sessions?${PROJECT_URL_PARAM}=${OTHER.id}`);
    expect(hook.projectId).toBeUndefined();
    expect(hook.ready).toBe(false);
  });

  it('is not rescued by the localStorage settings cache', async () => {
    // The cache survives the outage and SettingsContext keeps it (a failed preference
    // read is not "the user cleared their default"). It still cannot resolve, because
    // the list it must be matched against is what failed. Asserted so the next reader
    // does not have to re-derive whether the cache covers this.
    localStorage.setItem(SETTINGS_CACHE_KEY, JSON.stringify({ defaultProjectId: HOME.id }));
    await mount('/sessions');
    expect(hook.unavailable).toBe(true);
    expect(hook.projectId).toBeUndefined();
  });

  it('behaves the same on another page — this is the hook, not Sessions', async () => {
    await mount('/tasks');
    expect(hook.unavailable).toBe(true);
    expect(hook.projectId).toBeUndefined();
    expect(hook.ready).toBe(false);
    expect(hook.projects).toEqual([]);
  });
});

describe('usePageProject — a FAILED REFETCH over a good list is not "unreadable"', () => {
  it('keeps the page on its project and the selector live when a later read fails', async () => {
    // The reconnect/refocus cell: an error is present AND a previously-loaded list is
    // still in cache. Treating that as unreadable would blank a working selector every
    // time the network hiccuped — so `projectsUnavailable` is narrowed on the list being
    // EMPTY, and this is the case that holds the narrowing in place.
    await mount('/sessions');
    expect(hook.projectId).toBe(HOME.id);

    server.projects = null; // the server goes away…
    await act(async () => {
      await queryClient!.refetchQueries({ queryKey: ['projects'] });
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    // …the refetch failed, so an error IS present. The cached list is still good.
    expect(queryClient!.getQueryState(['projects', 'list', {}])?.error).toBeTruthy();
    expect(hook.unavailable).toBe(false);
    expect(hook.projectId).toBe(HOME.id);
    expect(hook.ready).toBe(true);
    expect(hook.projects.map((p) => p.id)).toContain(OTHER.id);
  });
});

describe('usePageProject — an empty list is NOT the same as an unreadable one', () => {
  it('a user with genuinely zero projects is not reported as unavailable', async () => {
    server.projects = [];
    server.defaultProjectId = undefined;
    await mount('/sessions');
    // Both states leave `projectId` undefined; only `unavailable` tells them apart, and
    // a page renders a different thing for each.
    expect(hook.projectId).toBeUndefined();
    expect(hook.unavailable).toBe(false);
  });

  it('an empty list with a ?project=all deep link still resolves NOTHING (F2: all is not a scope)', async () => {
    server.projects = [];
    server.defaultProjectId = undefined;
    await mount(`/sessions?${PROJECT_URL_PARAM}=${ALL_PROJECTS_VALUE}`);
    expect(hook.projectId).toBeUndefined();
    expect(hook.ready).toBe(false);
  });
});

describe('usePageProject — THE BOUNDARY: the SETTINGS read is still collapsed', () => {
  /**
   * These pin what the hook does today, NOT what it should do. The list read now has
   * three states; the DEFAULT-PROJECT read still has two. `useSettings` reports the same
   * `defaultProjectId: undefined` whether the user has no default or the preference
   * endpoint could not be reached, so the fallback below cannot tell them apart and
   * silently pins the most-recently-active project in both.
   *
   * Left open deliberately: closing it means deciding whether a page should stop dead
   * when only `/api/users/preferences` is down, which is an availability trade this
   * change is not the place to make. These two cases exist so the boundary is a red
   * test away from moving rather than a paragraph, and so nobody reads the guard above
   * as covering the whole function.
   */
  it('no default SET → pins the first project (correct)', async () => {
    server.defaultProjectId = undefined;
    await mount('/sessions');
    expect(hook.projectId).toBe(OTHER.id); // most recently active
    expect(hook.unavailable).toBe(false);
  });

  it('default UNREADABLE with no cache → pins the same project, indistinguishably', async () => {
    server.defaultProjectId = null; // the read rejects
    localStorage.clear(); // and nothing cached covers for it
    await mount('/sessions');
    expect(hook.projectId).toBe(OTHER.id);
    // Identical to the case above in every observable the hook exposes. That identity IS
    // the open gap; when the settings read grows a third state, this assertion is what
    // will fail and point here.
    expect(hook.unavailable).toBe(false);
    expect(hook.ready).toBe(true);
  });
});
