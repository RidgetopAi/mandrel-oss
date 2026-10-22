import React from 'react';
import { useMutation, useQuery, useQueryClient, QueryClient } from '@tanstack/react-query';
import { authApi } from '../api/domains/auth';
import { LoginRequest } from '../api/generated/models/LoginRequest';
import { User } from '../api/generated/models/User';
import { useAuthStore } from '../stores/authStore';
import { isAuthedByToken, notifyAuthTokenChanged, AUTH_TOKEN_CHANGED_EVENT } from '../utils/authToken';
import { clearAmbientProjectState } from '../api/http/projectHeaders';
import { clearLastVisitedPath } from '../utils/lastVisitedPath';
import { resetEmbeddingStore } from '../stores/embeddingStore';
import { resetProjectSelection } from '../stores/projectSelectionStore';
import { logger } from '../utils/logger';

// SINGLE SOURCE OF TRUTH for the auth token: localStorage 'aidis_token', read
// FRESH on every request by the function-based OpenAPI.TOKEN resolver installed
// in api/client.ts (imported at app startup in index.tsx). We deliberately do
// NOT also pin a STATIC token/headers onto the global OpenAPI config here.
//
// THE BUG THIS REMOVES (stale-token logout loop):
//   This module used to call setAuthToken() at module-load and on every login,
//   which set `OpenAPI.TOKEN = <captured string>` and
//   `OpenAPI.HEADERS = { Authorization: 'Bearer <captured string>' }`.
//   Those STATIC values raced with — and clobbered — client.ts's fresh
//   function resolver. After a stale token had been captured (e.g. an old
//   value left in localStorage, or login firing while module-load already
//   captured the previous token), some parallel authed calls would send the
//   STALE token (→ 401) while siblings sent the fresh one. A single such 401
//   then tripped the global axios interceptor's force-logout → logout loop.
//
// The fix: writing localStorage is the ONLY thing that updates the token; every
// reader (client.ts resolver, services/api.ts, sessionsClient, etc.) reads that
// same key fresh, so it is impossible for one call to carry a stale token while
// a sibling carries the fresh one.
// Exported so the regression test can exercise the REAL writer (both branches),
// not a stub. Every token write MUST notify same-tab readers (see below).
export const setStoredToken = (token: string | null) => {
  if (token) {
    localStorage.setItem('aidis_token', token);
  } else {
    localStorage.removeItem('aidis_token');
  }
  // Same-tab login/logout does NOT fire the native 'storage' event in this tab,
  // so without this signal a mounted useAuthCheck would keep the stale
  // hasValidToken until a remount/refresh (the "must refresh after login" bug).
  notifyAuthTokenChanged();
};

/**
 * R3 — the FULL logged-out reset (the same one manual Logout performs): drop the
 * bearer token + cached user, the persisted `aidis-auth` key, the zustand
 * identity, every cached query, AND the ambient project scope. Factored out so the
 * self-heal path and the explicit logout path can never drift into clearing different
 * subsets (which is how the split-state arose — only manual logout cleared all three).
 *
 * ── THE PROJECT SCOPE IS PART OF THE IDENTITY (epic 41293984, the reviewer B3) ──────────
 * The ambient `X-Project-ID` is derived from user A's default project and cached across
 * FOUR rungs (api/http/projectHeaders.ts). None of them was cleared here, and the Logout
 * button is a react-router `navigate()` with NO page reload — so user B inherited A's
 * project on every ambient call: a 403 wedge for a non-admin B, and A's data for an
 * admin B. `clearAmbientProjectState()` owns the rung list; this call site must not
 * enumerate it (a second copy is how rungs 3 and 4 came to leak in the first place).
 *
 * ── THE LAST-VISITED PATH IS ALSO PART OF THE IDENTITY (the reviewer B1) ─
 * Same class, third occurrence: `utils/lastVisitedPath` caches the route the user was on
 * (in module memory AND a sessionStorage mirror) so the Feedback form can report it. Our
 * routes are id-bearing, so after a react-router logout user B saw — and submitted —
 * user A's path. `clearLastVisitedPath()` owns its own copies for the same reason
 * `clearAmbientProjectState()` owns the rungs; do not enumerate them here.
 *
 * ⚠️ ANYTHING THAT SURVIVES A ROUTE CHANGE MUST BE TORN DOWN HERE — NO EXCEPTIONS LIST.
 * Module-level state does NOT die on logout, because logout is a react-router navigate
 * with no reload. If you add a module singleton or cache of ANY kind, export a
 * `clearX()`/`resetX()` NEXT TO IT and add the call below. The rule is deliberately not
 * "…if it is identity-bearing": that phrasing makes every new module a judgement call,
 * and re-deriving that judgement is precisely what failed three times (the ambient
 * project rungs, then the visited path). Clearing something harmless costs one line;
 * missing something that matters costs a cross-user leak.
 *
 * THE POPULATION, measured 2026-08-08 — every module singleton holding USER-SCOPED
 * MUTABLE state (many other singletons survive a logout; they hold config or are inert):
 *   • useAuthStore              (stores/authStore.ts)      → .logout() below
 *   • the ambient project rungs (api/http/projectHeaders)  → clearAmbientProjectState()
 *   • lastVisitedPath           (utils/lastVisitedPath)    → clearLastVisitedPath()
 *   • useEmbeddingStore         (stores/embeddingStore)    → resetEmbeddingStore()
 *   • the react-query cache                                → queryClient.clear()
 * Enumerated at AST level over the 445 product files given by
 *   find src -name '*.ts' -o -name '*.tsx' | grep -vE '\.(test|spec)\.|\.d\.ts$' | wc -l
 * An earlier revision of this comment said 349 and carried no command; that number did
 * not reproduce under ANY definition, which is exactly why the command is here now — a
 * too-small denominator reads as "I swept everything" while having swept less. The
 * finding held when re-derived over the wider population, but the number did not.
 * — module-scope `let`/`var` (2), static
 * mutable class properties (0), const-bound mutable containers (120), and const-bound
 * `create(...)`/`new X()` singletons (71) — then each candidate read for whether it holds
 * per-user state. `apiClient`, `mandrelApi` and `errorReporter` are config only (the
 * bearer token is read fresh from localStorage per request, never held on the instance).
 * NOT enumerated by grepping for a shape: the `^let` sweep that preceded this found the
 * two `let`s and missed every singleton — right answer, wrong instrument, and the same
 * class of error as a count without its population.
 *
 * Enforced today only by the per-module teardown tests — hooks/logoutClearsProjectScope
 * (which now also covers useEmbeddingStore, the one member that had no assertion behind
 * it: measured, deleting its call left the entire 1690-test suite green), utils/
 * lastVisitedPath, and contexts/logoutExitPathsClearLastVisitedPath (which covers the
 * four exit paths reaching this function via the AuthProvider self-heal rather than by
 * calling it directly). Every member of the list above now has a test that goes RED if
 * its call is removed — verified by mutation, one member at a time.
 *
 * There is still no mechanism that fails when a NEW singleton is added without a
 * teardown. That is the remaining gap and it is filed for the coordinator, not solved here — the
 * enumeration above is a snapshot, and a snapshot cannot notice a sixth member arriving.
 */
export const resetAuthState = (queryClient: QueryClient): void => {
  setStoredToken(null);
  // useAuthStore.logout() removes aidis_token + aidis_user + aidis-auth and
  // resets the in-memory identity.
  useAuthStore.getState().logout();
  clearAmbientProjectState();
  clearLastVisitedPath();
  resetEmbeddingStore();
  queryClient.clear();
};

export const useLogin = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (credentials: LoginRequest) => {
      // Unified client: POST /api/auth/login through the ONE shared axios instance.
      return authApi.login(credentials);
    },
    onSuccess: (data) => {
      // Store the fresh token in the single source of truth (localStorage).
      // The function-based OpenAPI.TOKEN resolver (api/client.ts) and every
      // other reader pick it up fresh on their next request — no static copy
      // is pinned onto the OpenAPI config, so no stale token can race.
      setStoredToken(data.token);

      // A FRESH LOGIN OPENS ON THE SETTINGS DEFAULT. Logout already
      // drops the topbar selection via resetAuthState, but the 401 self-heal path
      // (services/api.ts) reloads to /login WITHOUT it, and sessionStorage survives a
      // same-tab reload — so the pick is dropped here too, on the way in.
      resetProjectSelection();

      // Update auth store
      useAuthStore.getState().setUser(data.user as User, data.token);
      useAuthStore.setState({ isAuthenticated: true });

      // Invalidate and refetch user profile
      queryClient.invalidateQueries({ queryKey: ['auth', 'profile'] });
      queryClient.setQueryData(['auth', 'profile'], data.user);
    },
    onError: (error: any) => {
      logger.error('Login failed:', error);
      // The unified client maps errors to { message, code, status, details }, where
      // `message` already carries the server's message (or the axios message).
      useAuthStore.getState().setError(error?.message || error?.details?.message || 'Login failed');
    },
  });
};

export const useLogout = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async () => {
      try {
        await authApi.logout();
      } catch (error) {
        // Even if logout fails on server, clear local state
        logger.error('Logout error:', error);
      }
    },
    onSettled: () => {
      // Always clear local state regardless of server response — through the ONE reset,
      // never a hand-rolled subset. This used to re-implement three of resetAuthState's
      // four steps inline, which is precisely how it came to be missing the fourth (the
      // ambient project scope) while the self-heal path was fixed. One function, one
      // definition of "logged out".
      resetAuthState(queryClient);
    },
  });
};

/**
 * R2 — the ONE derivation the router/ProtectedRoute consumes. "Authenticated" is
 * true only when there is a valid (present, unexpired) token AND a successful
 * profile with no error. Crucially it is FALSE whenever `hasValidToken` is false,
 * regardless of any lingering cached profile — so the split-state (authed shell,
 * no token) can no longer occur. This is exported as a pure function so the
 * regression test exercises the REAL derivation the hook uses (not a stub).
 */
export const deriveIsAuthenticated = (
  hasValidToken: boolean,
  profile: unknown,
  error: unknown
): boolean => hasValidToken && !!profile && !error;

// Hook to check and verify authentication on app start
export const useAuthCheck = () => {
  const queryClient = useQueryClient();

  // Reactive mirror of "do we hold a VALID (present + unexpired) token?" — the
  // single source of truth. isAuthedByToken() also purges a dead token as a
  // side effect, so an expired token flips this to false on the next check.
  const [hasValidToken, setHasValidToken] = React.useState(() => isAuthedByToken());

  React.useEffect(() => {
    const recheck = () => {
      const valid = isAuthedByToken();
      setHasValidToken((prev) => (prev !== valid ? valid : prev));
    };

    // Check on mount, on cross-tab storage changes, and — critically for a
    // same-tab mid-session expiry / token loss — when the tab regains focus or
    // becomes visible (the storage event does NOT fire in the tab that changed
    // it). This is what heals the "token expired while I was away" case.
    recheck();
    window.addEventListener('storage', recheck);
    window.addEventListener('focus', recheck);
    document.addEventListener('visibilitychange', recheck);
    // Same-tab token writes (login/logout in THIS tab) — the 'storage' event does
    // not fire for them, so this custom event is what makes a same-tab login
    // navigate immediately instead of only after a manual refresh.
    window.addEventListener(AUTH_TOKEN_CHANGED_EVENT, recheck);
    return () => {
      window.removeEventListener('storage', recheck);
      window.removeEventListener('focus', recheck);
      document.removeEventListener('visibilitychange', recheck);
      window.removeEventListener(AUTH_TOKEN_CHANGED_EVENT, recheck);
    };
  }, []);

  // R4: the moment we no longer hold a valid token, drop the cached profile so
  // `isAuthenticated` can never ride a stale success from before the token died.
  React.useEffect(() => {
    if (!hasValidToken) {
      queryClient.removeQueries({ queryKey: ['auth', 'profile'] });
    }
  }, [hasValidToken, queryClient]);

  const isEnabled = hasValidToken;

  const { data: profile, isLoading, error } = useQuery({
    queryKey: ['auth', 'profile'],
    queryFn: async () => {
      try {
        // Unified client: GET /api/auth/profile, already unwrapped to the User.
        return await authApi.profile();
      } catch (error: any) {
        // The profile check IS an auth-critical call: a 401 here means the
        // stored token is genuinely dead, so clearing auth state is correct.
        // (Contrast with non-critical widget calls — those must NOT force a
        // logout; see services/api.ts response interceptor.) The unified client's
        // mapped ApiError carries `.status`, so this branch still fires on 401.
        if (error.status === 401) {
          setStoredToken(null);
          useAuthStore.getState().logout();
        }
        throw error;
      }
    },
    enabled: isEnabled,
    retry: (failureCount, error: any) => {
      // Don't retry on 401 errors
      if (error.status === 401) {
        return false;
      }
      return failureCount < 2;
    },
    staleTime: 5 * 60 * 1000, // 5 minutes
    refetchOnWindowFocus: false, // Prevent unnecessary refetches
    refetchOnReconnect: false,
  });

  return {
    // Never surface a cached profile as the current user once the token is gone.
    user: hasValidToken ? profile : undefined,
    // R2: derived from a valid token — a lingering cached profile alone can no
    // longer report authed.
    isAuthenticated: deriveIsAuthenticated(hasValidToken, profile, error),
    isLoading,
    error,
    // Exposed so AuthContext's self-heal can act on token validity directly.
    hasValidToken,
  };
};