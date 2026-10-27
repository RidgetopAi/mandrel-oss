/**
 * dashboardAuthConfig — ONE LOGIN: the Command dashboard signs people in through better-auth
 * (option A).
 *
 * The Command backend owns the dashboard session (its own JWT + auth_tokens row) and the
 * AUTHORIZATION record (admin_users: role, is_active, grants, API tokens). better-auth owns the
 * CREDENTIAL. This file configures the one seam between them: an INTERNAL endpoint on the
 * mcp-server that runs better-auth's own email+password sign-in and tells the Command backend
 * who that is. The Command backend never sees a better-auth hash and never re-implements the
 * hasher (a second copy of that rule would drift on the next better-auth upgrade).
 *
 * WHY AN INTERNAL ENDPOINT AND NOT better-auth's public `<basePath>/sign-in/email`:
 *   - the public route's rate limiter keys on the client IP, and every Command → mcp-server
 *     call comes from ONE address (the backend container), so all customers would share one
 *     bucket of 3 sign-ins per 10 s;
 *   - the Command backend would have to learn the per-tenant basePath (it is not in its env)
 *     and parse a session cookie to find out which session it got;
 *   - this endpoint answers the only question the dashboard asks — "is this email+password
 *     right, and which better-auth user + session is it?" — and nothing else.
 *
 * WHO MAY CALL IT: ONLY the static MCP_AUTH_TOKEN (the Command backend's service credential;
 * it already holds it to proxy tool calls). A customer's `mdl_` API token or an OAuth access
 * token is refused — a password check is not something a customer credential gets to run.
 * It is mounted only when OAuth is enabled (there is no better-auth login to check otherwise),
 * and its path is outside every prefix the tenant Traefik router publishes
 * (Path(/mcp), PathPrefix(/healthz), the OAuth prefixes), so on a tenant it is reachable only
 * on the compose network.
 *
 * configs-not-hardcoded: every tunable is here, env-overridable.
 */

/** Read a positive integer env var, falling back on missing/invalid. */
function envPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name]; // env-read: via-callers
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw.trim());
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export interface DashboardAuthConfig {
  /**
   * The internal sign-in path. Mirrors DASHBOARD_AUTH_CONFIG.signInPath in the Command backend
   * (mandrel-command/backend/src/config/dashboardAuth.ts). The two services share no package.
   */
  signInPath: string;
  /**
   * FAILED-attempt limit on the internal sign-in: at most `rateMax` failures per `rateWindowMs`
   * for one (email, client address) pair. Successes never count. The client part only
   * separates guessers when the backend sees real client IPs; on the hosted fleet today it
   * sees one proxy address (TRUST_PROXY unset), so this is per-email there and
   * repeated failures CAN lock the owner out for one window (Reviewer).
   * The Command backend separately limits every client address (routes/auth.ts authLimiter).
   * Over the limit → 429, and the dashboard says "try again later".
   */
  rateMax: number;
  rateWindowMs: number;
  /**
   * The admin_users.role a dashboard row CREATED for a provisioned better-auth user receives.
   * Per-instance, the hosted customer IS the instance's owner (the operator, 2026-10-22), and API
   * tokens are admin-only (apiTokenConfig.requiredOwnerRole). This role is per INSTANCE: the
   * dashboard has no surface that reaches another tenant or the host.
   */
  ownerRole: string;
  /**
   * SESSION SWEEP (N3, Reviewer): every dashboard sign-in leaves a 7-day better-auth
   * "session" row that nothing else deletes once it expires. The sweep deletes rows whose
   * "expiresAt" has passed (auth_tokens.auth_session_id cascades; oauth tokens' sessionId is
   * set null). `sessionSweepEnabled` env: MANDREL_DASHBOARD_SESSION_SWEEP_ENABLED (default
   * true); `sessionSweepIntervalMinutes` env: MANDREL_DASHBOARD_SESSION_SWEEP_INTERVAL_MINUTES
   * (default 60).
   */
  sessionSweepEnabled: boolean;
  sessionSweepIntervalMinutes: number;
}

export const DASHBOARD_AUTH_CONFIG: DashboardAuthConfig = {
  signInPath: '/internal/dashboard-auth/sign-in',
  rateMax: envPositiveInt('MANDREL_DASHBOARD_SIGNIN_RATE_MAX', 10),
  rateWindowMs: envPositiveInt('MANDREL_DASHBOARD_SIGNIN_RATE_WINDOW_MS', 15 * 60_000),
  ownerRole: 'admin',
  sessionSweepEnabled: !['0', 'false', 'no', 'off'].includes(
    (process.env.MANDREL_DASHBOARD_SESSION_SWEEP_ENABLED ?? '').trim().toLowerCase(), // env-read: via-callers
  ),
  sessionSweepIntervalMinutes: envPositiveInt('MANDREL_DASHBOARD_SESSION_SWEEP_INTERVAL_MINUTES', 60),
};
