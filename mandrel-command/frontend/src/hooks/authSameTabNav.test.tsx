/**
 * Same-tab login navigation regression (BUG 1).
 *
 * THE BUG: a same-tab login writes the bearer token, but the browser's native
 * `storage` event fires ONLY in OTHER tabs — so a `useAuthCheck` that re-derives
 * auth on `storage`/`focus`/`visibilitychange` never learns the token appeared.
 * `hasValidToken` stays false and `Login.tsx`'s reactive `isAuthenticated`
 * redirect never fires → the user is stuck on /login until a manual refresh
 * remounts the hook and re-reads the token.
 *
 * THE FIX: every token WRITER dispatches a same-tab `aidis-token-changed` event
 * and `useAuthCheck` listens for it — completing the set (cross-tab=`storage`,
 * return-to-tab=`focus`/`visibilitychange`, same-tab=this event).
 *
 * These exercise the REAL writers and the REAL hook effect (rendered in jsdom) —
 * not stubs. Test 1 FAILS without the listener wiring: with no 'storage' event
 * fired, nothing else can flip `hasValidToken`.
 */
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useAuthCheck, setStoredToken } from './useAuth';
import { useAuthStore } from '../stores/authStore';
import { AUTH_TOKEN_CHANGED_EVENT } from '../utils/authToken';
import { User } from '../api/generated/models/User';

// Keep the profile query off the network — when hasValidToken flips true the
// query enables; we resolve it deterministically so nothing hits a real fetch.
// useAuth now rides the unified client's auth domain (api.auth.profile), which
// returns the User directly (already unwrapped from the profile envelope).
vi.mock('../api/domains/auth', () => ({
  authApi: {
    profile: jest.fn().mockResolvedValue({ id: 'u1', username: 'operator' }),
    login: jest.fn(),
    logout: jest.fn(),
  },
}));

// Tell React 18 we're inside an act() environment (there's no @testing-library
// in this project to set it for us) — makes act() flush effects and silences the
// "environment is not configured to support act(...)" warning.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const base64url = (obj: object): string =>
  Buffer.from(JSON.stringify(obj))
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
const makeJwt = (payload: object): string =>
  `${base64url({ alg: 'HS256', typ: 'JWT' })}.${base64url(payload)}.testsig`;
const validToken = (): string => makeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 });
const asUser = (u: { id: string; username?: string }): User => u as unknown as User;

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

// ---- render harness (no @testing-library in this project) --------------------
let container: HTMLDivElement | null = null;
let root: Root | null = null;
let qc: QueryClient;
let latest: ReturnType<typeof useAuthCheck>;

const Probe: React.FC = () => {
  latest = useAuthCheck();
  return null;
};

const mount = async () => {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <QueryClientProvider client={qc}>
        <Probe />
      </QueryClientProvider>
    );
  });
};

beforeEach(() => {
  localStorage.clear();
  root = null;
  container = null;
  useAuthStore.setState({
    isAuthenticated: false,
    user: null,
    token: null,
    isLoading: false,
    error: null,
  });
});

afterEach(async () => {
  if (root) {
    await act(async () => {
      root!.unmount();
    });
  }
  container?.remove();
  jest.clearAllMocks();
});

describe('same-tab token WRITERS dispatch aidis-token-changed (whole class)', () => {
  test('setStoredToken(token) dispatches the event (set branch)', () => {
    const spy = jest.spyOn(window, 'dispatchEvent');
    setStoredToken(validToken());
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ type: AUTH_TOKEN_CHANGED_EVENT })
    );
    spy.mockRestore();
  });

  test('setStoredToken(null) dispatches the event (remove branch)', () => {
    const spy = jest.spyOn(window, 'dispatchEvent');
    setStoredToken(null);
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ type: AUTH_TOKEN_CHANGED_EVENT })
    );
    spy.mockRestore();
  });

  test('authStore.setUser dispatches the event (login path that bypasses setStoredToken)', () => {
    const spy = jest.spyOn(window, 'dispatchEvent');
    useAuthStore.getState().setUser(asUser({ id: 'u1', username: 'operator' }), validToken());
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ type: AUTH_TOKEN_CHANGED_EVENT })
    );
    spy.mockRestore();
  });

  test('authStore.logout dispatches the event (logout path that bypasses setStoredToken)', () => {
    const spy = jest.spyOn(window, 'dispatchEvent');
    useAuthStore.getState().logout();
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ type: AUTH_TOKEN_CHANGED_EVENT })
    );
    spy.mockRestore();
  });
});

describe('useAuthCheck reacts to a same-tab login WITHOUT a storage event', () => {
  test('hasValidToken flips true on same-tab login (the redirect trigger)', async () => {
    await mount();
    expect(latest.hasValidToken).toBe(false);

    const token = validToken();
    await act(async () => {
      // The REAL login writer: writes localStorage AND fires aidis-token-changed.
      // We deliberately do NOT fire a 'storage' event (the browser never fires it
      // in the writing tab) — so ONLY the new listener can flip hasValidToken.
      // Before the fix this stayed false until a manual refresh remounted the hook.
      setStoredToken(token);
    });

    expect(latest.hasValidToken).toBe(true);

    // Let the now-enabled profile query settle so no state update escapes act.
    await act(async () => {
      await flush();
    });
  });

  test('isAuthenticated flips true on same-tab login (Login.tsx redirect would fire)', async () => {
    await mount();
    // Seed a fresh profile so, once the token gate opens, isAuthenticated derives
    // true immediately (staleTime keeps it fresh → no refetch needed).
    qc.setQueryData(['auth', 'profile'], asUser({ id: 'u1', username: 'operator' }));
    expect(latest.isAuthenticated).toBe(false);

    await act(async () => {
      setStoredToken(validToken());
    });

    expect(latest.hasValidToken).toBe(true);
    expect(latest.isAuthenticated).toBe(true);
  });

  test('mirror: same-tab logout flips hasValidToken false', async () => {
    localStorage.setItem('aidis_token', validToken());
    await mount();
    expect(latest.hasValidToken).toBe(true);

    await act(async () => {
      // Real logout writer removes the token and fires the same-tab event.
      useAuthStore.getState().logout();
    });

    expect(latest.hasValidToken).toBe(false);
  });
});
