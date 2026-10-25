/**
 * THE FIFTH LADDER PATH — logout must not carry user A's project into user B's session.
 *
 * ════════════════════════════════════════════════════════════════════════════════════
 *  THE DEFECT THIS EXISTS TO CATCH (Reviewer B3, reject round 1 of the page-scope epic)
 * ════════════════════════════════════════════════════════════════════════════════════
 * `ProjectContext` asserted, in a comment, that a user switch needed no handling because
 * "the 401 path navigates to /login and a real page load drops module memory outright."
 * That is true of the 401 SELF-HEAL (`services/api.ts` sets `window.location.href`). It
 * is FALSE of the Logout button: `AuthContext.logout` calls
 * `navigate('/login', { replace: true })` — a react-router navigation with NO reload.
 *
 * `useLogout.onSettled`, `authStore.logout()` and `resetAuthState()` cleared
 * `aidis_token` / `aidis_user` / `aidis-auth` and the query cache. NONE of them cleared
 * `aidis_selected_project`, `aidis_current_project`, `aidis_user_settings.defaultProjectId`,
 * or the in-memory rung. So after logout `resolveProjectHeader()` still answered A — and
 * because rung 4 lives in module memory, it re-seated A even after a full
 * `localStorage.clear()`. The foundation commit did not create the localStorage half; it
 * added two more leaking rungs AND a mechanism that survives a storage wipe, which made
 * the stale value STICKIER than before.
 *
 * Consequence, per rung: for a non-admin B every ambient call 403s under F-04 with no
 * recovery path (this work deleted the global switcher, the only control that could
 * unwedge it). For an admin B, reads and unscoped writes land in A's project.
 *
 * ── WHY THE ASSERTION IS `resolveProjectHeader()` AND NOT "the keys are gone" ─────────
 * Asserting on the storage keys would pass while rung 4 quietly re-seated them — which
 * is the actual defect. So the anchor is the value the WIRE would carry: the resolver's
 * return, read after logout, and read AGAIN after `localStorage.clear()` to prove no
 * rung is holding a copy out of reach of a storage wipe.
 *
 * ── THE POPULATION ───────────────────────────────────────────────────────────────────
 * All four rungs, seeded individually AND together, through BOTH logout paths that exist
 * (`resetAuthState` directly, and `useLogout.onSettled` which must delegate to it).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import {
  resolveProjectHeader,
  rememberAmbientProject,
  __resetRememberedAmbientProject,
} from '../api/http/projectHeaders';
import { resetAuthState } from './useAuth';
import { useEmbeddingStore } from '../stores/embeddingStore';
import {
  useProjectSelectionStore,
  PROJECT_SELECTION_STORAGE_KEY,
} from '../stores/projectSelectionStore';

/** User A's project — the value that must NOT survive into user B's session. */
const PROJECT_A = 'aaaaaaaa-1111-4111-8111-111111111111';

const STORED_PROJECT_KEY = 'aidis_selected_project';
const LEGACY_PROJECT_KEY = 'aidis_current_project';
const SETTINGS_STORAGE_KEY = 'aidis_user_settings';

/** Put user A's project on EVERY rung of the resolver ladder. */
const seedAllRungs = () => {
  const payload = JSON.stringify({ id: PROJECT_A });
  localStorage.setItem(STORED_PROJECT_KEY, payload); // rung 1
  localStorage.setItem(LEGACY_PROJECT_KEY, payload); // rung 2
  localStorage.setItem(
    SETTINGS_STORAGE_KEY,
    JSON.stringify({ theme: 'dark', defaultProjectId: PROJECT_A }), // rung 3
  );
  rememberAmbientProject(PROJECT_A); // rung 4
  useProjectSelectionStore.getState().select(PROJECT_A); // the topbar switch (upstream)
};

let queryClient: QueryClient;

beforeEach(() => {
  localStorage.clear();
  __resetRememberedAmbientProject();
  queryClient = new QueryClient();
  // The logged-in state resetAuthState is asked to tear down.
  localStorage.setItem('aidis_token', 'a.token.value');
  localStorage.setItem('aidis_user', JSON.stringify({ id: 'user-a' }));
});

afterEach(() => {
  localStorage.clear();
  __resetRememberedAmbientProject();
  vi.restoreAllMocks();
});

describe('resetAuthState clears the topbar project selection', () => {
  it('the fixture is real: BEFORE logout the switch holds A, in memory and in localStorage', () => {
    seedAllRungs();
    expect(useProjectSelectionStore.getState().selectedProjectId).toBe(PROJECT_A);
    expect(localStorage.getItem(PROJECT_SELECTION_STORAGE_KEY) ?? '').toContain(PROJECT_A);
  });

  it('after logout the switch holds NOTHING — the next login opens on the Settings default', () => {
    seedAllRungs();
    resetAuthState(queryClient);
    expect(useProjectSelectionStore.getState().selectedProjectId).toBeUndefined();
    expect(localStorage.getItem(PROJECT_SELECTION_STORAGE_KEY) ?? '').not.toContain(PROJECT_A);
  });
});

describe('resetAuthState clears the ambient project scope (Reviewer B3)', () => {
  it('the fixture is real: BEFORE logout the resolver answers A', () => {
    seedAllRungs();
    expect(resolveProjectHeader()).toBe(PROJECT_A);
  });

  it('after logout the resolver answers NOTHING — not A', () => {
    seedAllRungs();
    resetAuthState(queryClient);
    expect(resolveProjectHeader()).toBeUndefined();
  });

  it('after logout AND a full localStorage.clear(), the in-memory rung does not re-seat A', () => {
    // THE EXACT PROBE Reviewer ran. Rung 4 survives a storage wipe by design; if logout
    // does not reset it, `localStorage.clear()` makes the app RESTORE A rather than lose it.
    seedAllRungs();
    resetAuthState(queryClient);
    localStorage.clear();
    expect(resolveProjectHeader()).toBeUndefined();
    // …and it did not helpfully write A back into storage on the way out.
    expect(localStorage.getItem(STORED_PROJECT_KEY)).toBeNull();
    expect(localStorage.getItem(LEGACY_PROJECT_KEY)).toBeNull();
  });

  it.each([
    ['rung 1 — aidis_selected_project', () => localStorage.setItem(STORED_PROJECT_KEY, JSON.stringify({ id: PROJECT_A }))],
    ['rung 2 — aidis_current_project', () => localStorage.setItem(LEGACY_PROJECT_KEY, JSON.stringify({ id: PROJECT_A }))],
    ['rung 3 — aidis_user_settings.defaultProjectId', () => localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ defaultProjectId: PROJECT_A }))],
    ['rung 4 — the in-memory mirror', () => rememberAmbientProject(PROJECT_A)],
  ])('%s alone does not survive logout', (_label, seed) => {
    seed();
    expect(resolveProjectHeader()).toBe(PROJECT_A); // the rung really is load-bearing
    resetAuthState(queryClient);
    expect(resolveProjectHeader()).toBeUndefined();
  });

  it('keeps the non-identity settings (theme) — it clears a scope, not a preference', () => {
    seedAllRungs();
    resetAuthState(queryClient);
    const stored = JSON.parse(localStorage.getItem(SETTINGS_STORAGE_KEY) ?? '{}');
    expect(stored.theme).toBe('dark');
    expect(stored.defaultProjectId).toBeUndefined();
  });

  it('an unparseable settings cache is removed rather than left holding an unknown value', () => {
    seedAllRungs();
    localStorage.setItem(SETTINGS_STORAGE_KEY, '{not json');
    resetAuthState(queryClient);
    expect(localStorage.getItem(SETTINGS_STORAGE_KEY)).toBeNull();
    expect(resolveProjectHeader()).toBeUndefined();
  });

  it('is idempotent and safe on the EMPTY population (logout with nothing stored)', () => {
    localStorage.clear();
    expect(() => resetAuthState(queryClient)).not.toThrow();
    expect(() => resetAuthState(queryClient)).not.toThrow();
    expect(resolveProjectHeader()).toBeUndefined();
  });

  it('still clears the auth keys it always cleared (no regression in the original job)', () => {
    seedAllRungs();
    resetAuthState(queryClient);
    expect(localStorage.getItem('aidis_token')).toBeNull();
    expect(localStorage.getItem('aidis_user')).toBeNull();
  });

  // The embedding store was the one member of resetAuthState's five-item population with
  // no assertion behind it, so `resetEmbeddingStore()` could be deleted in total silence
  // (measured: removing that line left the whole 1690-test suite green). Its contents are
  // view state rather than identity, so this is not a leak guard — it is what keeps the
  // rule's population WHOLE. The rule above is "everything that survives a route change,
  // no exceptions list"; an unasserted member is how an exceptions list grows back.
  it('resets the embedding store — the member with no other test', () => {
    useEmbeddingStore.setState({
      selectedDatasetId: 'dataset-from-the-previous-user',
      activeTab: 'projection',
      heatmapSize: { rows: 7, cols: 7 },
    });

    resetAuthState(queryClient);

    const after = useEmbeddingStore.getState();
    expect(after.selectedDatasetId).toBeNull();
    expect(after.activeTab).toBe('heatmap');
    expect(after.heatmapSize).toEqual({ rows: 50, cols: 50 });
  });
});

/**
 * THE SECOND LOGOUT PATH — the Logout BUTTON, driven for real.
 *
 * `useLogout.onSettled` used to re-implement three of `resetAuthState`'s four steps
 * inline, which is exactly why it was missing the fourth. Asserting on `resetAuthState`
 * alone would therefore have passed on the broken commit: the self-heal path was fine
 * and the button was not. So this mounts the real hook, runs the real mutation (its one
 * network call stubbed, since the server response is explicitly irrelevant —
 * `onSettled` fires either way), and reads the resolver afterwards.
 */
describe('useLogout — the Logout button clears the scope too', () => {
  it('after the real logout mutation settles, the resolver no longer answers A', async () => {
    vi.doMock('../api/domains/auth', () => ({
      authApi: { logout: vi.fn(async () => undefined) },
    }));
    vi.resetModules();

    const React = (await import('react')).default;
    const { act } = await import('react');
    const { createRoot } = await import('react-dom/client');
    const { QueryClient: QC, QueryClientProvider } = await import('@tanstack/react-query');
    const { useLogout } = await import('./useAuth');
    const headers = await import('../api/http/projectHeaders');

    // Re-seed on the FRESHLY IMPORTED module instances — `vi.resetModules()` gave this
    // block its own copy of projectHeaders, so rung 4 must be written through that copy
    // or the probe would be reading a different module's memory.
    const payload = JSON.stringify({ id: PROJECT_A });
    localStorage.setItem(STORED_PROJECT_KEY, payload);
    localStorage.setItem(LEGACY_PROJECT_KEY, payload);
    localStorage.setItem(
      SETTINGS_STORAGE_KEY,
      JSON.stringify({ theme: 'dark', defaultProjectId: PROJECT_A }),
    );
    headers.rememberAmbientProject(PROJECT_A);
    expect(headers.resolveProjectHeader()).toBe(PROJECT_A);

    let logout: { mutateAsync: () => Promise<unknown> } | undefined;
    const Probe: React.FC = () => {
      logout = useLogout() as unknown as { mutateAsync: () => Promise<unknown> };
      return null;
    };

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const client = new QC({ defaultOptions: { queries: { retry: false } } });

    await act(async () => {
      root.render(React.createElement(QueryClientProvider, { client }, React.createElement(Probe)));
    });
    await act(async () => {
      await logout!.mutateAsync();
    });

    expect(headers.resolveProjectHeader()).toBeUndefined();
    // And the storage-wipe probe on this path too — rung 4 must be gone, not merely quiet.
    localStorage.clear();
    expect(headers.resolveProjectHeader()).toBeUndefined();

    await act(async () => root.unmount());
    container.remove();
    vi.doUnmock('../api/domains/auth');
  });
});
