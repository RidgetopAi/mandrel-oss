import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { User } from '../api/generated/models/User';
import { logger } from '../utils/logger';
import { getValidToken, notifyAuthTokenChanged } from '../utils/authToken';

interface AuthState {
  // State
  isAuthenticated: boolean;
  user: User | null;
  token: string | null;
  isLoading: boolean;
  error: string | null;

  // Actions
  setUser: (user: User, token: string) => void;
  logout: () => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
  clearError: () => void;
}

/**
 * The auth-identity slice that must always agree with the token (single source
 * of truth). Reconcile it whenever the store loads from persistence.
 */
type AuthIdentitySlice = Pick<AuthState, 'isAuthenticated' | 'user' | 'token'>;

/**
 * R2 — reconcile a (possibly rehydrated) auth slice to the ONE source of truth,
 * the token. If there is no valid (present, unexpired) token, force a fully
 * logged-out identity so a persisted `user`/`token` can NEVER assert authed
 * without a live token. Mutates in place (persist's onRehydrateStorage hands us
 * the merged state to fix up) and also returns it for pure unit testing.
 */
export const reconcileAuthStateToToken = <T extends AuthIdentitySlice>(state: T): T => {
  if (!getValidToken()) {
    state.isAuthenticated = false;
    state.token = null;
    state.user = null;
  }
  return state;
};

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      // Initial state
      isAuthenticated: false,
      user: null,
      token: null,
      isLoading: false,
      error: null,

      // Actions
      setUser: (user: User, token: string) => {
        localStorage.setItem('aidis_token', token);
        localStorage.setItem('aidis_user', JSON.stringify(user));
        set({
          user,
          token,
          isAuthenticated: true,
          error: null,
        });
        // This path writes the token WITHOUT going through setStoredToken, so it
        // must fire the same-tab signal too (fix the whole class).
        notifyAuthTokenChanged();
      },

      logout: () => {
        // Clear localStorage first
        localStorage.removeItem('aidis_token');
        localStorage.removeItem('aidis_user');
        
        // Force clear the Zustand persistence cache to prevent corruption
        try {
          localStorage.removeItem('aidis-auth');
        } catch (e) {
          logger.warn('Failed to clear Zustand cache:', e);
        }
        
        // Update state
        set({
          user: null,
          token: null,
          isAuthenticated: false,
          error: null,
        });
        // Same-tab logout also removes the token directly here — signal readers
        // so a same-tab logout reflects immediately (whole class).
        notifyAuthTokenChanged();
      },

      setLoading: (loading: boolean) => {
        set({ isLoading: loading });
      },

      setError: (error: string | null) => {
        set({ error });
      },

      clearError: () => {
        set({ error: null });
      },
    }),
    {
      name: 'aidis-auth',
      // R2: deliberately do NOT persist `isAuthenticated`. It is a DERIVED value
      // (from a valid token) and must never be a standalone persisted claim that
      // could survive a token loss and assert an authed shell. It starts false
      // on every load and is only set true by setUser/login when a real token
      // exists. `user`/`token` are persisted for UX rehydrate, then reconciled
      // to the token below so they can't ride without a valid token either.
      partialize: (state) => ({
        user: state.user,
        token: state.token,
      }),
      // R2: on every rehydrate, reconcile the loaded identity to the token. If
      // the token is missing/expired, the persisted user/token are dropped and
      // isAuthenticated stays false — closing the "stale persisted authed" path.
      onRehydrateStorage: () => (state) => {
        if (state) {
          reconcileAuthStateToToken(state);
        }
      },
    }
  )
);

// Helper hook for auth operations
export const useAuth = () => {
  const store = useAuthStore();

  const initialize = (() => {
    let isInitializing = false;

    return () => {
      // Prevent re-entrancy during initialization
      if (isInitializing) {
        return;
      }

      isInitializing = true;

      try {
        // Reconcile the store to the ONE source of truth: a valid (present,
        // unexpired) token. getValidToken() purges a dead token as a side effect.
        const token = getValidToken();
        const userStr = localStorage.getItem('aidis_user');

        if (token && userStr) {
          try {
            const user = JSON.parse(userStr);
            store.setUser(user, token);
          } catch (error) {
            logger.error('Failed to parse stored user:', error);
            // Corrupt user blob but no usable identity — fully reset the store.
            store.logout();
          }
        } else if (store.isAuthenticated || store.token || store.user) {
          // No valid token but the store still carries authed residue. Fully
          // reset it (idempotent). The redirect to /login is owned by the
          // AuthContext self-heal / ProtectedRoute — NOT here — so there is no
          // clear-but-don't-redirect dead-end and no init-time redirect loop.
          logger.warn('No valid token on init — clearing stale auth state');
          store.logout();
        }
      } finally {
        isInitializing = false;
      }
    };
  })();

  return {
    ...store,
    initialize,
  };
};
