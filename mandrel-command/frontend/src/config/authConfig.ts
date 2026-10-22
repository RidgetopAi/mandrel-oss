/**
 * Auth configuration — single, named home for auth tunables (configs-not-hardcoded).
 *
 * These are the only knobs that govern client-side token-validity decisions. They
 * live here (not as magic literals scattered through the auth code) and are
 * env-overridable so a deploy can tune them without a code change.
 */

/** Parse a non-negative integer from an env string, falling back on any bad value. */
const parseNonNegativeInt = (raw: string | undefined, fallback: number): number => {
  if (raw === undefined || raw === '') {
    return fallback;
  }
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
};

export const authConfig = {
  /**
   * Clock-skew leeway (ms) added PAST a JWT `exp` before the client treats the
   * token as expired. Direction is deliberately LENIENT: we keep a borderline
   * token for `clockSkewLeewayMs` past its stated expiry and let the server be
   * the final authority (an auth-critical 401 still force-logs-out). Being
   * lenient here avoids prematurely purging a still-server-valid token — which is
   * exactly the silent-lockout failure this fix exists to prevent. Override with
   * VITE_AUTH_CLOCK_SKEW_MS.
   */
  clockSkewLeewayMs: parseNonNegativeInt(import.meta.env.VITE_AUTH_CLOCK_SKEW_MS, 30_000),
} as const;

export type AuthConfig = typeof authConfig;
