/**
 * oauthRoutes.ts — mounts the better-auth OAuth 2.1 authorization-server surface on the
 * existing Express app (HealthServer), BA-1.
 *
 * What it mounts (only when MANDREL_OAUTH_ENABLED=true):
 *   1. CORS for the auth + `.well-known` routes (claude.ai fetches discovery + token legs
 *      cross-origin from the browser) — config-driven allow-list (betterAuthConfig.corsOrigins).
 *   2. The better-auth handler at `<basePath>/*` via toNodeHandler — MOUNTED BEFORE
 *      express.json() (json-first hangs the handler; better-auth reads the raw body itself).
 *   3. Root discovery docs (clients look here, not under basePath):
 *        - GET /.well-known/oauth-authorization-server   (RFC 8414)
 *        - GET /.well-known/openid-configuration          (OIDC discovery)
 *        - GET /.well-known/oauth-protected-resource      (RFC 9728, audience=resource)
 *   4. Minimal, REAL sign-in + consent pages (/sign-in, /consent) so the morning browser
 *      flow (BA-2) can complete — a user can be created + sign in + consent. No stubs.
 *
 * It must NOT swallow `/mcp` or `/mcp/tools/*` (those are mounted separately and the auth
 * handler is scoped to `<basePath>` + the explicit `.well-known` + page routes only).
 *
 * Express 5 note: route wildcards are NAMED (`*splat`), not the bare `*` of Express 4.
 */

import type { Application, Request, Response, NextFunction } from 'express';
import { toNodeHandler } from 'better-auth/node';
import {
  oauthProviderAuthServerMetadata,
  oauthProviderOpenIdConfigMetadata,
} from '@better-auth/oauth-provider';
import { logger } from '../utils/logger.js';
import { getAuth, type AuthInstance } from './auth.js';
import { BETTER_AUTH_CONFIG, OAUTH_SUPPORTED_SCOPES, oauthIssuerIdentifier } from '../config/betterAuthConfig.js';
import { renderSignInPage, renderConsentPage } from './oauthPages.js';
import { dcrClientCapMiddleware } from '../services/oauthClientGuard.js';
import { mountSetPasswordRoutes } from './setPasswordPage.js';
import { mountDashboardAuthRoutes } from './dashboardAuthRoutes.js';

/**
 * Adapt a Web Fetch-API handler (request: Request) => Promise<Response> — which the
 * better-auth metadata helpers return — into an Express handler. Builds a Fetch Request
 * from the Express req (method/url/headers), runs the handler, and writes the Fetch
 * Response back (status, headers, body). Uses Node 18+ global Request/Response/Headers.
 */
function fetchToExpress(
  handler: (request: globalThis.Request) => Promise<globalThis.Response>
): (req: Request, res: Response) => Promise<void> {
  return async (req: Request, res: Response): Promise<void> => {
    const url = `${BETTER_AUTH_CONFIG.issuer}${req.originalUrl}`;
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (typeof v === 'string') headers.set(k, v);
      else if (Array.isArray(v)) headers.set(k, v.join(', '));
    }
    const fetchReq = new globalThis.Request(url, { method: req.method, headers });
    const fetchRes = await handler(fetchReq);
    res.status(fetchRes.status);
    fetchRes.headers.forEach((value, key) => res.setHeader(key, value));
    const body = await fetchRes.text();
    res.send(body);
  };
}

/**
 * CORS for the auth + discovery routes only. The on-box bridge and /mcp transport set
 * their own headers / Origin protection and are NOT touched here.
 */
function oauthCors(req: Request, res: Response, next: NextFunction): void {
  const origin = req.headers.origin;
  if (origin && BETTER_AUTH_CONFIG.corsOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  }
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  next();
}

/**
 * The RFC 9728 protected-resource metadata. The AS does not publish this itself; we
 * publish it for OUR resource (the exact /mcp URL) pointing back at our issuer. Built
 * directly from named config (resource + issuer) — small, well-defined, no guessing.
 */
function protectedResourceMetadata(): Record<string, unknown> {
  return {
    resource: BETTER_AUTH_CONFIG.resource,
    // The AS identifier is origin+basePath (ground truth), so clients fetch its discovery
    // doc from there. We host the AS discovery doc at the ORIGIN root too (clients commonly
    // look there), but authorization_servers must name the canonical issuer identifier.
    authorization_servers: [oauthIssuerIdentifier()],
    scopes_supported: [...OAUTH_SUPPORTED_SCOPES],
    bearer_methods_supported: ['header'],
    resource_documentation: `${BETTER_AUTH_CONFIG.issuer}/.well-known/oauth-authorization-server`,
  };
}

/**
 * Mount the OAuth surface. Returns the auth instance (for tests) or null when disabled.
 * Call this on the Express app BEFORE express.json() is applied (see HealthServer).
 */
export function mountOAuthRoutes(app: Application, authOverride?: AuthInstance): AuthInstance | null {
  if (!BETTER_AUTH_CONFIG.enabled && !authOverride) {
    logger.info('🔐 OAuth authorization-server DISABLED (MANDREL_OAUTH_ENABLED!=true) — static bearer only.');
    return null;
  }

  const auth = authOverride ?? getAuth();
  const basePath = BETTER_AUTH_CONFIG.basePath;

  // CORS first (applies to the auth + .well-known routes mounted below).
  app.use('/.well-known', oauthCors);
  app.use(basePath, oauthCors);

  // (3) Root discovery docs — mounted BEFORE the auth handler + BEFORE express.json().
  // The metadata factories require an auth whose `.api` statically advertises the
  // plugin-added config endpoints (getOAuthServerConfig / getOpenIdConfig). Those exist
  // at RUNTIME (added by oauthProvider()), but the widened `Auth` type doesn't list them,
  // so we cast to the precise structural shape each helper requires.
  const authForAsMeta = auth as unknown as Parameters<typeof oauthProviderAuthServerMetadata>[0];
  const authForOidcMeta = auth as unknown as Parameters<typeof oauthProviderOpenIdConfigMetadata>[0];
  app.get('/.well-known/oauth-authorization-server', fetchToExpress(oauthProviderAuthServerMetadata(authForAsMeta)));
  app.get('/.well-known/openid-configuration', fetchToExpress(oauthProviderOpenIdConfigMetadata(authForOidcMeta)));
  app.get('/.well-known/oauth-protected-resource', (_req: Request, res: Response) => {
    res.setHeader('Content-Type', 'application/json');
    res.status(200).json(protectedResourceMetadata());
  });

  // (4) Minimal, real sign-in + consent pages (server-rendered HTML; no stubs).
  app.get('/sign-in', (req: Request, res: Response) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.status(200).send(renderSignInPage(req.query as Record<string, string>));
  });
  app.get('/consent', (req: Request, res: Response) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.status(200).send(renderConsentPage(req.query as Record<string, string>));
  });
  // (4b) One-time set-password page for a provisioned login user (sign-up S5).
  mountSetPasswordRoutes(app, auth);
  // (4c) Internal dashboard sign-in (ONE login): the Command backend asks
  // better-auth "is this email+password right?" — static service token only, not published by
  // the tenant router. See server/dashboardAuthRoutes.ts.
  mountDashboardAuthRoutes(app, auth);

  // (2a) PER-TENANT DCR CAP: reject a dynamic client registration once this
  // instance already holds OAUTH_CLIENT_CONFIG.perTenantCap clients. Mounted on the exact
  // register route BEFORE the better-auth handler; it only COUNTs (no body read), so it is safe
  // ahead of express.json() / the raw-body handler. Under the cap it calls next() → the register
  // falls through to the better-auth node handler below. The native register RATE-LIMIT and the
  // TTL-SWEEP are the other two controls (auth.ts rateLimit + oauthClientSweeper).
  app.post(`${basePath}/oauth2/register`, dcrClientCapMiddleware());

  // (2b) The better-auth handler — Express 5 named wildcard, mounted LAST of the auth
  // routes and BEFORE express.json() so better-auth owns raw-body parsing for its endpoints.
  app.all(`${basePath}/*splat`, toNodeHandler(auth));

  logger.info(
    `🔐 OAuth authorization-server MOUNTED: ${basePath}/* + 3 discovery docs + /sign-in + /consent + /sign-in/set-password + internal dashboard sign-in ` +
    `(issuer=${BETTER_AUTH_CONFIG.issuer}, resource=${BETTER_AUTH_CONFIG.resource}).`
  );
  return auth;
}
