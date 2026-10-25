/**
 * Split-state regression.
 *
 * Reproduces the exact silent-lockout bug and proves the fix. Before the fix the
 * router consumed `isAuthenticated = !!profile && !error` from a CACHED profile
 * with no token gate — so a lingering cached profile after a token loss rendered
 * an authed shell while every API call 401'd. After the fix, "authenticated" is
 * derived from a valid token in ONE place (`deriveIsAuthenticated`), so the three
 * sources (localStorage token / zustand flag / cached profile) can no longer
 * diverge into "authed shell, no token."
 *
 * These exercise the REAL exported derivation, the REAL token gate, and the REAL
 * store reconcile/reset — not stubs (a test that lies is worse than no test).
 */
import { deriveIsAuthenticated, resetAuthState } from './useAuth';
import { isAuthedByToken } from '../utils/authToken';
import { reconcileAuthStateToToken, useAuthStore } from '../stores/authStore';
import { User } from '../api/generated/models/User';

const base64url = (obj: object): string =>
  Buffer.from(JSON.stringify(obj))
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

const makeJwt = (payload: object): string =>
  `${base64url({ alg: 'HS256', typ: 'JWT' })}.${base64url(payload)}.testsig`;

const nowSec = () => Math.floor(Date.now() / 1000);
const validToken = () => makeJwt({ exp: nowSec() + 3600 });
const expiredToken = () => makeJwt({ exp: nowSec() - 3600 });

const asUser = (u: { id: string; username?: string }): User => u as unknown as User;
const cachedProfile = asUser({ id: 'u1', username: 'operator' });

/**
 * The PRE-FIX derivation the router used — kept here only to DOCUMENT the bug in
 * the same run (no token gate → authed on a stale cached profile alone).
 */
const buggyLegacyDerivation = (profile: unknown, error: unknown): boolean =>
  !!profile && !error;

beforeEach(() => {
  localStorage.clear();
  useAuthStore.setState({
    isAuthenticated: false,
    user: null,
    token: null,
    isLoading: false,
    error: null,
  });
});

describe('split-state: cached profile + no token', () => {
  test('THE BUG (reproduction): the legacy rule reports AUTHED with no token', () => {
    // No token in storage, but a profile is still cached (staleTime 5min,
    // no refetch on focus) — the exact stranded state.
    expect(isAuthedByToken()).toBe(false);
    expect(buggyLegacyDerivation(cachedProfile, null)).toBe(true); // <- the lockout
  });

  test('THE FIX: derived isAuthenticated is FALSE (routes to /login, no shell)', () => {
    expect(isAuthedByToken()).toBe(false);
    expect(deriveIsAuthenticated(isAuthedByToken(), cachedProfile, null)).toBe(false);
  });

  test('expired token + cached profile → not authed (token gate wins)', () => {
    localStorage.setItem('aidis_token', expiredToken());
    expect(deriveIsAuthenticated(isAuthedByToken(), cachedProfile, null)).toBe(false);
  });
});

describe('normal paths still work (no false negatives)', () => {
  test('valid token + cached profile → authed', () => {
    localStorage.setItem('aidis_token', validToken());
    expect(deriveIsAuthenticated(isAuthedByToken(), cachedProfile, null)).toBe(true);
  });

  test('valid token but profile error → not authed', () => {
    localStorage.setItem('aidis_token', validToken());
    expect(
      deriveIsAuthenticated(isAuthedByToken(), cachedProfile, new Error('boom'))
    ).toBe(false);
  });
});

describe('reconcile-on-rehydrate (R2)', () => {
  test('persisted isAuthenticated:true + no valid token → reconciled to false/null', () => {
    const rehydrated = {
      isAuthenticated: true,
      token: 'stale-persisted-token',
      user: asUser({ id: 'u1' }),
    };
    reconcileAuthStateToToken(rehydrated);
    expect(rehydrated.isAuthenticated).toBe(false);
    expect(rehydrated.token).toBeNull();
    expect(rehydrated.user).toBeNull();
  });

  test('persisted authed + a valid token present → left intact', () => {
    localStorage.setItem('aidis_token', validToken());
    const rehydrated = {
      isAuthenticated: true,
      token: 'live',
      user: asUser({ id: 'u1' }),
    };
    reconcileAuthStateToToken(rehydrated);
    expect(rehydrated.isAuthenticated).toBe(true);
    expect(rehydrated.user).not.toBeNull();
  });
});

describe('login + logout regression guards', () => {
  test('login write-path: setUser stores the token and derives authed', () => {
    const token = validToken();
    useAuthStore.getState().setUser(asUser({ id: 'u1', username: 'operator' }), token);

    expect(localStorage.getItem('aidis_token')).toBe(token);
    expect(isAuthedByToken()).toBe(true);
    expect(
      deriveIsAuthenticated(isAuthedByToken(), useAuthStore.getState().user, null)
    ).toBe(true);
  });

  test('resetAuthState fully clears ALL three sources + the query cache', () => {
    localStorage.setItem('aidis_token', validToken());
    localStorage.setItem('aidis_user', JSON.stringify({ id: 'u1' }));
    localStorage.setItem('aidis-auth', JSON.stringify({ state: { user: {} } }));
    useAuthStore.setState({
      isAuthenticated: true,
      token: 'x',
      user: asUser({ id: 'u1' }),
    });

    const clear = jest.fn();
    resetAuthState({ clear } as unknown as Parameters<typeof resetAuthState>[0]);

    expect(localStorage.getItem('aidis_token')).toBeNull();
    expect(localStorage.getItem('aidis_user')).toBeNull();
    // zustand-persist re-writes aidis-auth right after logout()'s set(), so the
    // key is present but must carry NO authed residue (clean user/token/flag).
    const persisted = JSON.parse(localStorage.getItem('aidis-auth') ?? '{}');
    expect(persisted.state?.user ?? null).toBeNull();
    expect(persisted.state?.token ?? null).toBeNull();
    expect(persisted.state?.isAuthenticated ?? false).toBe(false);
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
    expect(useAuthStore.getState().token).toBeNull();
    expect(clear).toHaveBeenCalledTimes(1);
  });
});
