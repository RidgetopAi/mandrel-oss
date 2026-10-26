/**
 * dashboardAuth — ONE LOGIN (option A): the dashboard signs
 * a person in with their better-auth email + password.
 *
 * better-auth (in the mcp-server) owns the CREDENTIAL. This backend owns the dashboard SESSION
 * and the AUTHORIZATION record (admin_users). It asks the mcp-server's internal sign-in
 * endpoint whether an email+password is right; it never reads or re-implements a better-auth
 * password hash. See mcp-server/src/server/dashboardAuthRoutes.ts for the other side.
 */

const intFromEnv = (name: string, fallback: number): number => {
  const raw = process.env[name]; // env-read: via-callers
  const n = raw === undefined ? NaN : Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

export const DASHBOARD_AUTH_CONFIG = {
  /**
   * The mcp-server's internal sign-in path. Mirrors DASHBOARD_AUTH_CONFIG.signInPath in
   * mcp-server/src/config/dashboardAuthConfig.ts — the two services share no package.
   */
  signInPath: '/internal/dashboard-auth/sign-in',
  /**
   * How long one sign-in check may take before it is reported as "could not check" (503 to
   * the browser), never as a wrong password. better-auth's scrypt verify is ~50-100 ms.
   */
  timeoutMs: intFromEnv('MANDREL_DASHBOARD_SIGNIN_TIMEOUT_MS', 10_000),
} as const;
