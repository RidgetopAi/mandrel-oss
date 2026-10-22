/**
 * authToken — THE single source of truth for "is the client holding a usable
 * bearer token right now?" (fix-auth-split-state).
 *
 * Background: the Command UI historically had THREE independent notions of
 * "logged in" that could silently disagree — the raw `aidis_token` in
 * localStorage, the persisted zustand `isAuthenticated` boolean, and the cached
 * `/auth/profile` react-query result. When the token vanished mid-session but a
 * cached profile lingered, the app rendered an authed shell while every API call
 * 401'd — a silent lockout.
 *
 * The fix collapses that to ONE derivation used by everyone: "authenticated" is
 * derived from a PRESENT, UNEXPIRED token. The persisted boolean and the cached
 * profile may still inform UX, but they can never assert authed without a valid
 * token, because everyone gates on `getValidToken()` / `isAuthedByToken()`.
 *
 * The server stays the real authority — this is a client-side "don't render
 * authed / don't fire authed calls with a known-dead token" gate, not a
 * replacement for server verification.
 */
import jwtDecode from 'jwt-decode';
import { authConfig } from '../config/authConfig';
import { logger } from './logger';

const TOKEN_KEY = 'aidis_token';
const USER_KEY = 'aidis_user';

/**
 * Same-tab token-change signal. The browser's native `storage` event fires ONLY
 * in OTHER tabs, never in the tab that wrote the change — so a same-tab login /
 * logout leaves any `storage`-listening auth check unaware the token flipped
 * (the "login accepts but doesn't navigate until refresh" bug). Every writer of
 * the bearer token dispatches this event so same-tab readers (`useAuthCheck`)
 * can re-derive auth immediately, completing the listener set:
 * cross-tab → `storage`, return-to-tab → `focus`/`visibilitychange`,
 * same-tab → this event.
 */
export const AUTH_TOKEN_CHANGED_EVENT = 'aidis-token-changed';

/** Notify same-tab auth readers that the stored bearer token changed. */
export const notifyAuthTokenChanged = (): void => {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event(AUTH_TOKEN_CHANGED_EVENT));
  }
};

interface JwtExpPayload {
  /** Standard JWT expiry, seconds since epoch (RFC 7519). */
  exp?: number;
}

/**
 * Remove the stored bearer token + cached user. Used whenever we detect a dead
 * token so a subsequent load starts clean (no manual site-data clearing).
 */
export const purgeStoredAuthToken = (): void => {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
};

/**
 * Is this JWT expired? Applies the configured clock-skew leeway (token stays
 * valid until `exp + leeway`). A token with no `exp` claim is treated as
 * non-expiring here (the server remains the authority); an undecodable token is
 * treated as expired/invalid.
 */
export const isTokenExpired = (token: string, nowMs: number = Date.now()): boolean => {
  try {
    const { exp } = jwtDecode<JwtExpPayload>(token);
    if (typeof exp !== 'number') {
      // No exp claim — we can't prove expiry client-side; defer to the server.
      return false;
    }
    const expiryMs = exp * 1000 + authConfig.clockSkewLeewayMs;
    return nowMs >= expiryMs;
  } catch (error) {
    // Malformed / non-JWT token string — cannot be trusted.
    logger.warn('authToken: failed to decode token, treating as invalid', error);
    return true;
  }
};

/**
 * Return the stored bearer token ONLY if it is present and unexpired; otherwise
 * return null AND purge the dead token/user from storage so nothing downstream
 * can ride a corpse. This is the ONE function every "am I authed?" reader uses.
 */
export const getValidToken = (): string | null => {
  const token = localStorage.getItem(TOKEN_KEY);
  if (!token) {
    return null;
  }
  if (isTokenExpired(token)) {
    purgeStoredAuthToken();
    return null;
  }
  return token;
};

/** Convenience boolean form of {@link getValidToken}. */
export const isAuthedByToken = (): boolean => getValidToken() !== null;
