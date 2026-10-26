/**
 * auth.ts — the in-process OAuth 2.1 authorization-server (better-auth) instance.
 *
 * BA-1: stand up better-auth as an
 * IN-PROCESS OAuth 2.1 authorization-server / provider on the mcp-server so Claude.ai's
 * web custom connector can connect via the standard browser OAuth flow, WITHOUT breaking
 * the existing static-bearer clients. Identities + tokens live in OUR OWN Postgres
 * (no hosted IdP).
 *
 * Plugins:
 *   - jwt()            → JWT access tokens, verifiable IN-PROCESS via the JWKS endpoint
 *                        (no DB round-trip on the hot `/mcp` path). REQUIRED by the recipe.
 *   - oauthProvider()  → the OAuth 2.1 AS itself: authorize/token/register/consent,
 *                        dynamic client registration (DCR), RFC 8707 audience binding via
 *                        validAudiences=[resource]. We use @better-auth/oauth-provider
 *                        (>=1.6.11, NOT the deprecated `mcp`/`oidc-provider` plugins which
 *                        were removed in 1.7 for a security advisory).
 *
 * Config is 100% named (betterAuthConfig.ts) — issuer/resource/secret/basePath all from env.
 *
 * The instance is built LAZILY (getAuth()) and only when OAuth is enabled, so a default
 * static-bearer-only deployment pays nothing and the test suite controls construction.
 */

import { Pool } from 'pg';
import { betterAuth } from 'better-auth';
import type { Auth } from 'better-auth';
import { jwt } from 'better-auth/plugins';
import { oauthProvider } from '@better-auth/oauth-provider';
import { logger } from '../utils/logger.js';
import { guardPool } from '../utils/datastoreError.js';
import {
  BETTER_AUTH_CONFIG,
  OAUTH_SUPPORTED_SCOPES,
  OAUTH_LOGIN_PAGE,
  OAUTH_CONSENT_PAGE,
  type BetterAuthConfig,
} from '../config/betterAuthConfig.js';
import { OAUTH_CLIENT_CONFIG } from '../config/oauthClientConfig.js';

/** A pg Pool dedicated to better-auth, built from the same DATABASE_* env as the app. */
function buildAuthPool(): Pool {
  // DATASTORE ERROR BOUNDARY — the THIRD and last pg Pool constructed in
  // src/ (excluding scripts/). better-auth's own errors surface on the OAuth HTTP routes
  // rather than the MCP tool surface, but the boundary is applied at every construction
  // site on purpose: "every Pool in src/ is guarded" is a property a guard can ASSERT,
  // whereas "every Pool that a caller can reach" is a judgement that rots the first time
  // a route is re-mounted. See utils/datastoreError.ts.
  return guardPool(new Pool({
    user: process.env.DATABASE_USER || 'mandrel',
    host: process.env.DATABASE_HOST || 'localhost',
    database: process.env.DATABASE_NAME || 'mandrel',
    password: process.env.DATABASE_PASSWORD || '',
    port: parseInt(process.env.DATABASE_PORT || '5432', 10),
    ssl: ((process.env.DATABASE_SSL ?? process.env.DB_SSL ?? '').toLowerCase() === 'true')
      ? { rejectUnauthorized: false }
      : false,
    // better-auth issues short bursts of small queries; a tiny dedicated pool keeps it
    // isolated from the main app pool without contending for its connection budget.
    max: 5,
  }));
}

/**
 * Fail-closed secret guard: in a production-like env we REFUSE to build a real
 * authorization server with the dev default secret (it would sign forgeable tokens).
 * Mirrors the spirit of requireRemoteMcpEnv: a security feature must not
 * boot half-configured.
 */
function assertSecretSafe(cfg: BetterAuthConfig): void {
  const isProd = (process.env.NODE_ENV ?? '').trim().toLowerCase() === 'production';
  const isDefault = cfg.secret === 'dev-only-insecure-better-auth-secret-change-me';
  if (isProd && isDefault) {
    throw new Error(
      '❌ FATAL: OAuth (better-auth) is enabled in production but MANDREL_OAUTH_SECRET ' +
      '(or BETTER_AUTH_SECRET) is unset — refusing to sign tokens with the insecure dev ' +
      'default. Mint one: openssl rand -hex 32, then set MANDREL_OAUTH_SECRET.'
    );
  }
}

// The widened, non-specialized better-auth type. betterAuth() infers a type specialized
// to the exact literal config we pass, which is structurally incompatible with helpers
// (oauthProviderAuthServerMetadata, toNodeHandler) that accept the general `Auth`. We
// widen to `Auth` so the instance flows cleanly into those helpers (the runtime object
// is identical; only the static type is generalized).
export type AuthInstance = Auth;

let cachedAuth: AuthInstance | null = null;
let cachedPool: Pool | null = null;

/**
 * Build a better-auth instance for the given config. Exported (not just the singleton)
 * so tests can construct an isolated instance against a scratch DB/issuer without env
 * coupling. Callers that want the process-wide singleton use `getAuth()`.
 */
export function createAuth(cfg: BetterAuthConfig = BETTER_AUTH_CONFIG, pool?: Pool): AuthInstance {
  assertSecretSafe(cfg);
  const db = pool ?? buildAuthPool();

  return betterAuth({
    baseURL: cfg.issuer,
    basePath: cfg.basePath,
    secret: cfg.secret,
    database: db,
    trustedOrigins: cfg.trustedClientOrigins,
    // Rate limiting: better-auth defaults the limiter to `enabled ?? isProduction`, i.e. OFF in
    // dev/test — which would silently disable the DCR register rate-limit off-prod. Force it ON
    // (config-driven) so the security control below is REAL in every environment. Storage is the
    // in-memory default (correct for our single-process per-tenant container).
    rateLimit: {
      enabled: OAUTH_CLIENT_CONFIG.rateLimitEnabled,
    },
    // Client IP for rate-limit keys: the edge nginx sets X-Real-IP $remote_addr; Traefik now
    // forwards it. Without this better-auth reads x-forwarded-for, which any client can
    // prepend to, and the per-IP limits would key on a forgeable value.
    advanced: {
      ipAddress: {
        ipAddressHeaders: ['x-real-ip'],
      },
    },
    // Email+password is the minimal credential a user needs to exist for the consent
    // flow to complete. The sign-in/consent PAGES (oauthRoutes.ts) drive these endpoints.
    emailAndPassword: {
      enabled: true,
      // No email-verification gate: this is the authorization-server account, created
      // for the OAuth browser flow; verification is out of scope for BA-1.
      requireEmailVerification: false,
      // BA-3 ARMING: close OPEN self-registration by default. In the per-tenant
      // OAuth-dashboard model accounts are PROVISIONED, not self-served — otherwise anyone
      // reaching <handle>.mandrel.example.com could register into that tenant. Config-driven
      // (MANDREL_OAUTH_ALLOW_SIGNUP, default false → disableSignUp true). SIGN-IN + the consent
      // flow are unaffected; only the sign-up endpoint is closed.
      disableSignUp: !cfg.allowSignUp,
      // Sign-up S5: spending a one-time set-password link (POST
      // <basePath>/reset-password) ends every other session of that user. Supported by the
      // installed better-auth 1.6.20: option declared at @better-auth/core
      // dist/types/init-options.d.mts:652, honoured at better-auth dist/api/routes/password.mjs:163
      // (deleteUserSessions after the password update).
      revokeSessionsOnPasswordReset: true,
    },
    plugins: [
      // JWT access tokens, verified in-process via JWKS (no DB hit on the /mcp hot path).
      jwt(),
      oauthProvider({
        loginPage: OAUTH_LOGIN_PAGE,
        consentPage: OAUTH_CONSENT_PAGE,
        // Dynamic client registration — Claude.ai's connector self-registers.
        allowDynamicClientRegistration: true,
        // Allow the connector to register WITHOUT first authenticating (public DCR).
        // REQUIRED for Claude.ai self-registration — deliberately kept ON. The abuse surface it
        // opens is bounded elsewhere: a rate-limit (below), a per-tenant cap middleware
        // (oauthRoutes → oauthClientGuard), and a TTL-sweep of abandoned clients
        // (oauthClientSweeper). See config/oauthClientConfig.ts.
        allowUnauthenticatedClientRegistration: true,
        // BA-3 ARMING: rate-limit the DCR register endpoint. All thresholds are
        // NAMED CONFIG (oauthClientConfig). `enabled:false` on this rule would be a no-op, so we
        // always pass the window/max (the master switch is rateLimit.enabled above).
        rateLimit: {
          register: {
            window: OAUTH_CLIENT_CONFIG.registerRateWindowSec,
            max: OAUTH_CLIENT_CONFIG.registerRateMax,
          },
        },
        // RFC 8707 audience binding: tokens are minted bound to the exact /mcp resource,
        // and the /mcp guard verifies audience === resource.
        validAudiences: [cfg.resource],
        scopes: [...OAUTH_SUPPORTED_SCOPES],
      }),
    ],
  }) as unknown as AuthInstance;
}

/** Process-wide singleton (built on first use). Only call when OAuth is enabled. */
export function getAuth(): AuthInstance {
  if (!cachedAuth) {
    if (!BETTER_AUTH_CONFIG.enabled) {
      logger.warn('getAuth() called while OAuth is disabled — building anyway on demand.');
    }
    cachedPool = buildAuthPool();
    cachedAuth = createAuth(BETTER_AUTH_CONFIG, cachedPool);
    logger.info(
      `🔐 OAuth authorization-server (better-auth) initialized ` +
      `(issuer=${BETTER_AUTH_CONFIG.issuer}, basePath=${BETTER_AUTH_CONFIG.basePath}, ` +
      `resource=${BETTER_AUTH_CONFIG.resource}).`
    );
  }
  return cachedAuth;
}

/** Tear down the singleton's pool (graceful shutdown / test cleanup). */
export async function closeAuth(): Promise<void> {
  if (cachedPool) {
    await cachedPool.end().catch(() => { /* already closed */ });
    cachedPool = null;
  }
  cachedAuth = null;
}
