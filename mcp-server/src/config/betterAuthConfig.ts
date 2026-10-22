/**
 * betterAuthConfig — the OAuth 2.1 authorization-server (better-auth) knobs (BA-1,
 * branch better-auth).
 *
 * STANDING PRINCIPLE (the operator, binds this + all future builds): NO HARDCODED VARIABLES.
 * Every better-auth tunable — issuer URL, the protected-resource (audience) URL, the
 * base path, the signing secret, the CORS allow-list, and the master enable flag —
 * lives HERE: a named value with a safe default, a one-line doc, and an env override.
 * Mirrors sessionConfig.ts / threadConfig.ts / trustConfig.ts: the config is the
 * contract, the code reads it. The PROVISIONER sets the per-tenant values later
 * (issuer/resource/secret/CORS) — this file documents exactly which names it sets.
 *
 * WHY this exists: BA-1 adds better-auth as an IN-PROCESS OAuth 2.1 authorization
 * server on the mcp-server so Claude.ai's web custom connector can connect via the
 * standard browser OAuth flow, WITHOUT breaking the existing static-bearer clients.
 * Identities/tokens live in our own Postgres (no hosted IdP).
 *
 * Env reads happen at module load with a safe fallback (bad/missing → the default),
 * matching recallConfig.envInt / sessionConfig.envInt.
 */

/** Read a string env var, trimming, falling back to `fallback` on missing/empty. */
function envStr(name: string, fallback: string): string {
  const raw = process.env[name]; // env-read: via-callers
  if (raw === undefined || raw.trim() === '') return fallback;
  return raw.trim();
}

/** Read a boolean-ish env flag (1/true/yes/on → true), else `fallback`. */
function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name]; // env-read: via-callers
  if (raw === undefined || raw.trim() === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

/** Read a comma-separated list, trimming + dropping empties; fallback when unset. */
function envList(name: string, fallback: string[]): string[] {
  const raw = process.env[name]; // env-read: via-callers
  if (raw === undefined || raw.trim() === '') return fallback;
  const parts = raw.split(',').map(s => s.trim()).filter(Boolean);
  return parts.length > 0 ? parts : fallback;
}

export interface BetterAuthConfig {
  /**
   * enabled — master switch for the OAuth authorization-server surface. When false,
   * NONE of the better-auth routes (`<basePath>/*`, the `.well-known` discovery docs,
   * the sign-in/consent pages) are mounted, and `/mcp` accepts ONLY the static bearer
   * token (exactly today's behavior). This keeps the static-bearer path the safe
   * default until a tenant is provisioned for OAuth.
   * Env: MANDREL_OAUTH_ENABLED. Default false (opt-in).
   */
  enabled: boolean;

  /**
   * issuer — the OAuth issuer / better-auth `baseURL` (origin, no trailing slash).
   * This is the public origin clients reach the AS at (token/authorize/JWKS live
   * under `<issuer><basePath>`). It is the `iss` of minted JWTs and the
   * `issuer` in the discovery docs. MUST be the externally-reachable HTTPS origin
   * in prod (e.g. https://<handle>.mandrel.example.com).
   * Env: MANDREL_OAUTH_ISSUER. Default http://localhost:8080 (dev/test).
   */
  issuer: string;

  /**
   * resource — the protected-resource identifier = the EXACT `/mcp` URL (RFC 8707
   * audience binding + RFC 9728 protected-resource metadata). Minted access tokens
   * carry this as their `aud`; the dual-path `/mcp` guard verifies `audience === resource`.
   * MUST be the exact public `/mcp` URL in prod (e.g. https://<handle>.mandrel.example.com/mcp).
   * Env: MANDREL_OAUTH_RESOURCE. Default http://localhost:8080/mcp (dev/test).
   */
  resource: string;

  /**
   * basePath — the path prefix better-auth mounts its API under (authorize, token,
   * register, JWKS, etc.). Discovery endpoints are derived from issuer + basePath.
   * Env: MANDREL_OAUTH_BASE_PATH. Default /api/oauth — deliberately NOT better-auth's
   * own default (/api/auth), which collides with the Command UI dashboard backend that
   * owns /api/auth/{login,logout,profile,refresh,register}; the OAuth Traefik router
   * would then steal the dashboard login → "Login failed: Not Found" (404). Overriding
   * the env still works and still wins — this is only the collision-safe fallback so a
   * NEW tenant is correct without needing the override.
   */
  basePath: string;

  /**
   * secret — the better-auth signing/encryption secret. REQUIRED when enabled in a
   * production-like env (the factory throws if enabled + missing + NODE_ENV=production,
   * fail-closed — never boot a real AS with a default secret). In dev/test a fixed
   * non-secret default is used so the suite is hermetic.
   * Env: MANDREL_OAUTH_SECRET (or better-auth's native BETTER_AUTH_SECRET). Mint:
   * openssl rand -hex 32.
   */
  secret: string;

  /**
   * corsOrigins — origins allowed to cross-origin fetch the auth + `.well-known`
   * routes from a browser. Claude.ai's web connector fetches discovery + token legs
   * cross-origin, so https://claude.ai must be allowed. The on-box bridge and `/mcp`
   * transport are NOT affected (the SDK transport does its own Origin/DNS-rebinding
   * protection). Safe default: just https://claude.ai.
   * Env: MANDREL_OAUTH_CORS_ORIGINS (comma-separated). Default ["https://claude.ai"].
   */
  corsOrigins: string[];

  /**
   * trustedClientOrigins — origins better-auth itself treats as trusted for its
   * cookie/CSRF + redirect handling (better-auth `trustedOrigins`). Includes the
   * issuer origin + the CORS origins by default so the browser flow completes.
   * Env: MANDREL_OAUTH_TRUSTED_ORIGINS (comma-separated). Default derives from
   * issuer + corsOrigins.
   */
  trustedClientOrigins: string[];

  /**
   * allowSignUp — whether the AS's email+password endpoint accepts OPEN, unauthenticated
   * self-registration (`<basePath>/sign-up/email`).
   *
   * SECURITY DEFAULT = FALSE (RESTRICTED). BA-3 arming (the operator
   * APPROVED 2026-07-03): each tenant is a per-tenant OAuth-dashboard instance reachable at
   * `<handle>.mandrel.example.com`; with open sign-up ANYONE reaching that subdomain can
   * self-register an account INTO that tenant. In this model accounts are PROVISIONED, not
   * self-served, so open sign-up is closed by default. When false, `createAuth` sets
   * better-auth's `emailAndPassword.disableSignUp = true` → the sign-up endpoint rejects with
   * BAD_REQUEST while SIGN-IN (for provisioned users) and the whole OAuth/consent flow stay
   * fully functional. Flip to true only for an instance that intentionally wants open
   * registration. Env: MANDREL_OAUTH_ALLOW_SIGNUP. Default false (safe/restricted).
   */
  allowSignUp: boolean;
}

const issuer = envStr('MANDREL_OAUTH_ISSUER', 'http://localhost:8080').replace(/\/+$/, '');
const corsOrigins = envList('MANDREL_OAUTH_CORS_ORIGINS', ['https://claude.ai']);

export const BETTER_AUTH_CONFIG: BetterAuthConfig = {
  enabled: envBool('MANDREL_OAUTH_ENABLED', false),
  issuer,
  resource: envStr('MANDREL_OAUTH_RESOURCE', `${issuer}/mcp`),
  basePath: envStr('MANDREL_OAUTH_BASE_PATH', '/api/oauth'),
  // BETTER_AUTH_SECRET is better-auth's native env name; honor it as a fallback so an
  // operator who set the native one still works. Dev/test default is non-secret on purpose.
  secret: envStr('MANDREL_OAUTH_SECRET', envStr('BETTER_AUTH_SECRET', 'dev-only-insecure-better-auth-secret-change-me')),
  corsOrigins,
  trustedClientOrigins: envList('MANDREL_OAUTH_TRUSTED_ORIGINS', [issuer, ...corsOrigins]),
  // SAFE DEFAULT: open self-registration is CLOSED unless an operator explicitly opts in.
  allowSignUp: envBool('MANDREL_OAUTH_ALLOW_SIGNUP', false),
};

/**
 * The OAuth scopes this AS supports (OIDC: must include "openid"). Kept as a named
 * constant (not buried in the plugin call) so it is the single source for both the
 * provider config and the discovery `scopes_supported`.
 */
export const OAUTH_SUPPORTED_SCOPES = ['openid', 'profile', 'email', 'offline_access'] as const;

/** Path (relative to root) of the minimal sign-in page the AS redirects to. */
export const OAUTH_LOGIN_PAGE = '/sign-in';
/** Path (relative to root) of the minimal consent page the AS redirects to. */
export const OAUTH_CONSENT_PAGE = '/consent';

/**
 * The OAuth ISSUER IDENTIFIER — the value better-auth actually advertises as `issuer`
 * in the discovery docs AND mints as the `iss` claim of access tokens. GROUND TRUTH
 * (verified against better-auth 1.6.20): the effective issuer is `baseURL + basePath`
 * (e.g. https://host/api/oauth), NOT the bare origin. So the `/mcp` guard must verify
 * tokens against THIS, and the WWW-Authenticate / protected-resource `authorization_servers`
 * must point HERE. Derived so it always tracks issuer(origin) + basePath.
 */
export function oauthIssuerIdentifier(cfg: BetterAuthConfig = BETTER_AUTH_CONFIG): string {
  return `${cfg.issuer}${cfg.basePath}`;
}

/**
 * JWKS URL used by the `/mcp` dual-path guard to verify OAuth access tokens locally
 * (the jwt() plugin exposes the key set under <issuerIdentifier>/jwks). Derived so it
 * always tracks issuer + basePath.
 */
export function oauthJwksUrl(cfg: BetterAuthConfig = BETTER_AUTH_CONFIG): string {
  return `${oauthIssuerIdentifier(cfg)}/jwks`;
}
