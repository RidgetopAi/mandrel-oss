/**
 * ════════════════════════════════════════════════════════════════════════════════════
 *  THE OTHER FOUR EXIT PATHS — the ones `resetAuthState` is not called from directly
 * ════════════════════════════════════════════════════════════════════════════════════
 * `utils/lastVisitedPath.test.ts` pins the LOGOUT BUTTON: it calls `resetAuthState`
 * directly, so the teardown is a straight-line call and asserting it is easy.
 *
 * There are four other ways a session ends, and NONE of them calls `resetAuthState`:
 *   1. token expiry            — hooks/useAuth.ts:212-214 (profile 401 → token+store dropped)
 *   2. 401 force-logout        — services/api.ts:145-148 (removes the keys, sets location)
 *   3. revoke-all-sessions     — pages/settings/AccountSection.tsx:126-128 (removes the key)
 *   4. another tab logs out    — the token simply vanishes from localStorage
 *
 * Every one of them is correct TODAY for exactly one reason: the AuthProvider self-heal
 * (contexts/AuthContext.tsx:65-84) notices "no valid token but authed residue present"
 * and calls the SAME `resetAuthState` — which now clears the visited path. That rescue
 * is load-bearing and completely unasserted: narrow the `hasResidue` predicate later and
 * B1 silently reopens on expiry, on 401 and cross-tab, while every existing test stays
 * green. This file is the assertion that the rescue actually happens.
 *
 * ── WHY THE REAL AuthProvider, AND NOT A MODEL OF IT ─────────────────────────────────
 * A first attempt at this class of proof drove the four exit paths in isolation and
 * reported ALL FOUR leaking. That was a model of the app, not the app: in the real tree
 * the provider is mounted and the self-heal fires. So this renders the REAL AuthProvider,
 * the REAL store, the REAL `resetAuthState` and the REAL lastVisitedPath module. The only
 * stub is the network (`api/domains/auth`) — there is no server in jsdom, and stubbing it
 * changes nothing about the teardown being measured.
 *
 * ── THE ANCHOR ───────────────────────────────────────────────────────────────────────
 * `getLastVisitedPath()` — the value the Feedback form would actually read — not "the
 * storage key is gone". Asserting the key would pass while the in-memory copy answered.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// The ONLY stub: the network. Everything else in the teardown path is real.
//
// `profile` RESOLVES by default, and that matters. A first version of this file had it
// reject 401, which made every mount an unhealthy session: useAuthCheck's 401 branch
// (useAuth.ts:212-214) dropped the token, the self-heal fired, and the path was cleared
// before the test had even reached its own precondition. The tests "passed" for the wrong
// reason and the healthy-session control failed. The session must be genuinely healthy
// until the test itself ends it.
vi.mock('../api/domains/auth', () => ({
  authApi: {
    profile: vi.fn().mockResolvedValue({ id: 'u-a', username: 'user-a' }),
    login: vi.fn(),
    logout: vi.fn().mockResolvedValue(undefined),
    refresh: vi.fn(),
  },
}));

import { AuthProvider } from './AuthContext';
import { useAuthStore } from '../stores/authStore';
import { AUTH_TOKEN_CHANGED_EVENT } from '../utils/authToken';
import {
  LAST_VISITED_PATH_KEY,
  clearLastVisitedPath,
  getLastVisitedPath,
  recordVisitedPath,
  __resetInMemoryPathForTest,
} from '../utils/lastVisitedPath';

/** An id-bearing route of user A's — exactly what must not reach user B. */
const PATH_A = '/contexts/aaaaaaaa-1111-4111-8111-111111111111';

const b64url = (o: object) =>
  Buffer.from(JSON.stringify(o)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const jwt = (expOffsetSec: number) =>
  `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url({ exp: Math.floor(Date.now() / 1000) + expOffsetSec })}.sig`;

let container: HTMLDivElement;
let root: Root;

/** Mount the REAL provider tree. */
async function mountApp() {
  container = document.createElement('div');
  document.body.appendChild(container);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  await act(async () => {
    root = createRoot(container);
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={['/dashboard']}>
          <AuthProvider>
            <div data-testid="app" />
          </AuthProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
}

/** Put the app in a genuinely logged-in state: valid token + the residue keys. */
function seedLoggedIn() {
  localStorage.setItem('aidis_token', jwt(3600));
  localStorage.setItem('aidis_user', JSON.stringify({ id: 'u-a', username: 'user-a' }));
  localStorage.setItem('aidis-auth', JSON.stringify({ state: { isAuthenticated: true } }));
  useAuthStore.setState({ isAuthenticated: true, user: { id: 'u-a' } as never, token: 'x' });
}

/** The same-tab signal every real token writer sends (utils/authToken). */
async function tokenChanged() {
  await act(async () => {
    window.dispatchEvent(new Event(AUTH_TOKEN_CHANGED_EVENT));
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  sessionStorage.clear();
  clearLastVisitedPath();
  useAuthStore.setState({ isAuthenticated: false, user: null, token: null });
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  localStorage.clear();
  sessionStorage.clear();
  clearLastVisitedPath();
});

describe("the AuthProvider self-heal clears user A's path on every non-button exit path", () => {
  it('EXPIRY / another tab: the token vanishes and the path goes with it', async () => {
    seedLoggedIn();
    recordVisitedPath(PATH_A);
    await mountApp();
    expect(getLastVisitedPath()).toBe(PATH_A); // still logged in — path is legitimately held

    // The token disappears (24h expiry purge, or another tab logging out). The other
    // residue keys remain — that is precisely what makes `hasResidue` true.
    localStorage.removeItem('aidis_token');
    await tokenChanged();

    expect(getLastVisitedPath()).toBeNull();
    expect(sessionStorage.getItem(LAST_VISITED_PATH_KEY)).toBeNull();
  });

  it('EXPIRED (not removed) token: an unexpired-token check that now fails clears it too', async () => {
    seedLoggedIn();
    recordVisitedPath(PATH_A);
    await mountApp();

    // The token is still PRESENT but no longer valid — the real 24h-expiry shape.
    localStorage.setItem('aidis_token', jwt(-3600));
    await tokenChanged();

    expect(getLastVisitedPath()).toBeNull();
  });

  it('401 FORCE-LOGOUT + RELOAD: the sessionStorage mirror survives the reload, the self-heal kills it', async () => {
    // services/api.ts removes aidis_token + aidis_user and sets window.location.href.
    // A REAL page load follows, so module memory is gone — but sessionStorage is NOT,
    // and it still holds A's path. `aidis-auth` (the persisted store) is the residue
    // that makes the self-heal fire on the fresh page. This is the case where the
    // rescue is genuinely doing work rather than being redundant.
    seedLoggedIn();
    recordVisitedPath(PATH_A);

    localStorage.removeItem('aidis_token'); // what the interceptor removes
    localStorage.removeItem('aidis_user');
    __resetInMemoryPathForTest(); // the reload: module memory is fresh
    useAuthStore.setState({ isAuthenticated: false, user: null, token: null });

    // Precondition — the leak really is present at this instant, in the mirror.
    expect(sessionStorage.getItem(LAST_VISITED_PATH_KEY)).toBe(PATH_A);
    expect(getLastVisitedPath()).toBe(PATH_A);

    await mountApp(); // the fresh page mounts the provider

    expect(getLastVisitedPath()).toBeNull();
    expect(sessionStorage.getItem(LAST_VISITED_PATH_KEY)).toBeNull();
  });

  it('REVOKE ALL SESSIONS: removing the token alone is enough to clear the path', async () => {
    // AccountSection removes aidis_token then sets window.location.href='/login'.
    seedLoggedIn();
    recordVisitedPath(PATH_A);
    await mountApp();

    localStorage.removeItem('aidis_token');
    await tokenChanged();

    expect(getLastVisitedPath()).toBeNull();
  });

  it('does NOT clear the path while the session is healthy (no false teardown)', async () => {
    // The control leg: the self-heal must not fire for a logged-in user, or this whole
    // feature would be broken in the ordinary case and the tests above would be vacuous.
    seedLoggedIn();
    recordVisitedPath(PATH_A);
    await mountApp();
    await tokenChanged();
    expect(getLastVisitedPath()).toBe(PATH_A);
  });
});
