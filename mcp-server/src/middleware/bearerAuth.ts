/**
 * Bearer-token auth middleware for the remote Streamable HTTP MCP endpoint.
 *
 * Option B (the container IS the tenant): a single expected token is read from the
 * environment variable `MCP_AUTH_TOKEN`. There is intentionally NO multi-tenant JWT
 * logic here — one token per container = one tenant.
 *
 * Security posture:
 *   - FAIL CLOSED: if `MCP_AUTH_TOKEN` is unset/empty, every request to the guarded
 *     route is rejected with 503 and a clear server-side log. We NEVER default-open.
 *   - Constant-time comparison to avoid timing side-channels.
 *   - On missing/invalid credentials → 401 with a JSON-RPC-shaped error body, BEFORE
 *     the request ever reaches the transport / any tool.
 *
 * This middleware is applied ONLY to the new `/mcp` route(s). The pre-existing
 * localhost `/mcp/tools/*` bridge for on-box agents is intentionally left unguarded.
 */

import type { Request, Response, NextFunction } from 'express';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { logger } from '../utils/logger.js';
import { verifyAccessToken } from 'better-auth/oauth2';
import { BETTER_AUTH_CONFIG, oauthJwksUrl, oauthIssuerIdentifier } from '../config/betterAuthConfig.js';
import { bridgeAuthEnabled, commandJwtSecret } from '../config/bridgeAuthConfig.js';
import {
  defaultApiTokenVerifier,
  looksLikeApiToken,
  type ApiTokenPrincipal,
  type ApiTokenVerifier,
} from '../services/apiTokenAuth.js';

/** JSON-RPC error codes (subset). -32001 ≈ unauthorized in common MCP usage. */
const JSONRPC_AUTH_ERROR_CODE = -32001;

/**
 * Build a JSON-RPC 2.0 error envelope. `id` is null because auth rejection happens
 * before we can reliably parse the request id.
 */
function jsonRpcError(code: number, message: string) {
  return {
    jsonrpc: '2.0' as const,
    error: { code, message },
    id: null,
  };
}

/**
 * Constant-time string compare that does not early-return on length mismatch.
 * Hashes both inputs to fixed-length buffers so timingSafeEqual never throws on
 * differing lengths and length itself isn't leaked.
 */
function constantTimeEqual(a: string, b: string): boolean {
  // Use SHA-256 digests so both buffers are always 32 bytes regardless of input length.
  const ha = createHash('sha256').update(a, 'utf8').digest();
  const hb = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(ha, hb);
}

/** Extract the raw token from an `Authorization: Bearer <token>` header, or null. */
function extractBearer(req: Request): string | null {
  const header = req.header('authorization') || req.header('Authorization');
  if (!header || !header.startsWith('Bearer ')) return null;
  const presented = header.slice('Bearer '.length).trim();
  return presented || null;
}

/**
 * Does the presented token match the configured STATIC MCP_AUTH_TOKEN (constant-time)?
 * Returns 'ok' (matches), 'mismatch' (wrong token), or 'unconfigured' (server has no
 * token set — fail-closed). This is the EXACT static logic the original guard used,
 * factored out so both the static-only guard and the dual guard share ONE implementation
 * (no drifting copies).
 */
function checkStaticToken(presented: string): 'ok' | 'mismatch' | 'unconfigured' {
  const expected = process.env.MCP_AUTH_TOKEN;
  if (!expected || expected.trim() === '') return 'unconfigured';
  return constantTimeEqual(presented, expected) ? 'ok' : 'mismatch';
}

/**
 * Express middleware factory (STATIC-only). Reads the expected token from env at call
 * time so tests can set it per-process. Returns a guard suitable for `app.use('/mcp', ...)`.
 *
 * This is the pre-existing, backward-compatible behavior used whenever OAuth is disabled.
 * Its responses are UNCHANGED (503 unconfigured / 401 missing / 401 invalid).
 */
export function bearerAuth(deps?: {
  /**
   * OPT-IN: also accept a per-user API token (`mdl_…`). Passed ONLY by the
   * `/mcp` mount when OAuth is disabled. Every other mount (the Command backend's service
   * routes: /api/v2/sessions, /api/decisions, provenance, set-primary) calls bearerAuth()
   * with no argument and stays static-token-only, byte-for-byte — a customer's loop token
   * must never reach those cross-project service surfaces.
   */
  apiTokens?: ApiTokenVerifier;
}) {
  const verifyApiToken = deps?.apiTokens;
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const expected = process.env.MCP_AUTH_TOKEN;

    // FAIL CLOSED: never serve the guarded route without a configured token.
    if (!expected || expected.trim() === '') {
      logger.error(
        '🔒 MCP remote transport refused: MCP_AUTH_TOKEN is not set. ' +
        'Refusing to serve /mcp (fail-closed). Set MCP_AUTH_TOKEN to enable remote MCP.'
      );
      res.status(503).json(
        jsonRpcError(
          JSONRPC_AUTH_ERROR_CODE,
          'Remote MCP transport is not configured (server missing auth token).'
        )
      );
      return;
    }

    const presented = extractBearer(req);
    if (!presented) {
      logger.warn('🔒 MCP auth rejected: missing or malformed Authorization header');
      res.status(401).json(
        jsonRpcError(JSONRPC_AUTH_ERROR_CODE, 'Unauthorized: missing Bearer token.')
      );
      return;
    }

    if (!constantTimeEqual(presented, expected)) {
      if (verifyApiToken && looksLikeApiToken(presented)) {
        const outcome = await verifyApiToken(presented);
        if (outcome.kind === 'ok') {
          attachApiTokenPrincipal(req, outcome.principal);
          next();
          return;
        }
        if (outcome.kind === 'unavailable') {
          sendCredentialCheckUnavailable(res);
          return;
        }
      }
      logger.warn('🔒 MCP auth rejected: invalid Bearer token');
      res.status(401).json(
        jsonRpcError(JSONRPC_AUTH_ERROR_CODE, 'Unauthorized: invalid Bearer token.')
      );
      return;
    }

    next();
  };
}

/** Subject info attached to the request after a successful OAuth verification. */
export interface OAuthSubject {
  /** The `sub` claim (the authenticated user/principal id from the OAuth token). */
  sub?: string;
  /** Space-or-array scopes granted to the token, if present. */
  scope?: string;
  /** The full verified JWT payload (for downstream use). For an API token: its row ids. */
  claims: Record<string, unknown>;
  /**
   * Which credential produced this subject. Absent = an OAuth JWT (every pre-existing
   * producer). 'api_token' = a per-user API token, whose `sub` is the
   * owner's better-auth user id when their dashboard row is linked (an earlier task — the
   * same `sub` their OAuth tokens carry), else the owner's admin_users.username.
   */
  via?: 'oauth' | 'api_token';
}

/**
 * Attach an accepted API token's owner as the request's VERIFIED principal.
 *
 * WHY THROUGH `req.oauthSubject` and not a new field: every consumer that turns a verified
 * principal into an actor already reads `req.oauthSubject.sub` — healthServer#actorFor,
 * remoteMcpTransport#actorFor and #rehydratePrincipalKey, sessionAnalyticsController — and
 * hands it to deriveActor, which owns the one precedence rule (verified principal over a
 * declared X-Actor-ID; composite `<principal>/<handle>` when that flag is on). Using the
 * same channel means an API-token request is attributed EXACTLY as an OAuth request is,
 * with no second copy of the rule to drift. The project-scope guard keys on X-Connection-ID
 * / X-Mandrel-Project, which this does not touch.
 */
function attachApiTokenPrincipal(req: Request, principal: ApiTokenPrincipal): void {
  req.oauthSubject = {
    sub: principal.principal,
    via: 'api_token',
    claims: { api_token_id: principal.tokenId, user_id: principal.userId },
  };
  logger.debug(`🔓 authorized via API token ${principal.tokenId}`);
}

/**
 * The THIRD state of an API-token check: the server could not look the token up (database
 * error). 503, never 401 — a 401 would tell a customer their working token is wrong.
 */
function sendCredentialCheckUnavailable(res: Response): void {
  res.status(503).json(
    jsonRpcError(JSONRPC_AUTH_ERROR_CODE, 'Credential check unavailable; try again shortly.')
  );
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Set by dualBearerAuth() when the caller authenticated via an OAuth token. */
      oauthSubject?: OAuthSubject;
    }
  }
}

/**
 * Build the RFC 9728 `WWW-Authenticate` challenge value pointing the client at the
 * protected-resource metadata so a fresh (non-static) client can discover the AS and
 * start the OAuth flow. Named/derived from config — never hardcoded.
 */
function buildWwwAuthenticate(): string {
  const resourceMetadataUrl = `${BETTER_AUTH_CONFIG.issuer}/.well-known/oauth-protected-resource`;
  return `Bearer resource_metadata="${resourceMetadataUrl}", scope="openid profile email"`;
}

/**
 * DUAL-PATH guard for `/mcp` (BA-1). Accepts EITHER credential, in order:
 *   (a) the existing static MCP_AUTH_TOKEN (constant-time compare) → allow (UNCHANGED
 *       backward-compatible path; existing tenants are byte-for-byte unaffected); else
 *   (b) a better-auth OAuth JWT access token, verified IN-PROCESS via JWKS with RFC 8707
 *       audience binding (audience === resource, issuer === issuer) → allow + attach the
 *       subject to req.oauthSubject; else
 *   (c) 401 with a `WWW-Authenticate: Bearer resource_metadata=...` header so a browser
 *       OAuth client can discover the AS and begin the flow.
 *
 * Fail-closed semantics for the STATIC side are preserved: if MCP_AUTH_TOKEN is unset
 * the static path can never succeed (checkStaticToken → 'unconfigured'); the request can
 * then only pass via a valid OAuth token. (When OAuth is DISABLED entirely, the caller
 * mounts the plain `bearerAuth()` instead, which keeps the 503 fail-closed response.)
 *
 * NOTE (behavior change, documented): on a 401 this guard now emits a `WWW-Authenticate`
 * header that the plain static guard did not. The 401 JSON body is otherwise unchanged.
 * Existing non-OAuth clients that send a VALID static token never see a 401, so they are
 * unaffected; only an unauthenticated/invalid caller sees the new header (which is the
 * correct, spec-mandated hint for OAuth discovery).
 */
export function dualBearerAuth(deps?: {
  /** Override the verifier (tests). Default: better-auth verifyAccessToken against JWKS. */
  verifyOAuth?: (token: string) => Promise<OAuthSubject | null>;
  /** Override the API-token verifier (tests). Default: SHA-256 lookup in api_tokens. */
  verifyApiToken?: ApiTokenVerifier;
}) {
  const verifyOAuth = deps?.verifyOAuth ?? defaultVerifyOAuth;
  const verifyApiToken = deps?.verifyApiToken ?? defaultApiTokenVerifier;

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const presented = extractBearer(req);

    // (a) STATIC token path — try first so existing tenants take the identical fast path.
    if (presented) {
      const staticResult = checkStaticToken(presented);
      if (staticResult === 'ok') {
        next();
        return;
      }

      // (a2) per-user API token — only a bearer carrying the `mdl_` prefix
      // reaches the database; it is never a JWT, so it does not fall through to (b).
      if (looksLikeApiToken(presented)) {
        const outcome = await verifyApiToken(presented);
        if (outcome.kind === 'ok') {
          attachApiTokenPrincipal(req, outcome.principal);
          next();
          return;
        }
        if (outcome.kind === 'unavailable') {
          sendCredentialCheckUnavailable(res);
          return;
        }
      } else {
        // (b) OAuth JWT path — only attempt if the static token did not match. A token that
        // is not the static secret may be a valid OAuth access token.
        try {
          const subject = await verifyOAuth(presented);
          if (subject) {
            req.oauthSubject = subject;
            logger.debug(`🔓 /mcp authorized via OAuth token (sub=${subject.sub ?? 'unknown'})`);
            next();
            return;
          }
        } catch (err) {
          // Verification failure is an auth failure, not a server error — fall through to 401.
          logger.warn(`🔒 OAuth token verification failed: ${(err as Error).message}`);
        }
      }
    }

    // (c) Neither credential authorized → 401 with discovery hint.
    res.setHeader('WWW-Authenticate', buildWwwAuthenticate());
    logger.warn('🔒 MCP auth rejected (dual): no valid static or OAuth credential');
    res.status(401).json(
      jsonRpcError(
        JSONRPC_AUTH_ERROR_CODE,
        presented ? 'Unauthorized: invalid Bearer token.' : 'Unauthorized: missing Bearer token.'
      )
    );
  };
}

/**
 * Default OAuth verifier: verifies a JWT access token locally against the AS's JWKS,
 * enforcing issuer + audience (RFC 8707) from named config. Returns the subject on
 * success, or null if the token is not a valid OAuth access token for this resource.
 */
async function defaultVerifyOAuth(token: string): Promise<OAuthSubject | null> {
  const payload = await verifyAccessToken(token, {
    jwksUrl: oauthJwksUrl(),
    verifyOptions: {
      // GROUND TRUTH: better-auth mints iss = baseURL + basePath, not the bare origin.
      issuer: oauthIssuerIdentifier(),
      audience: BETTER_AUTH_CONFIG.resource,
    },
  });
  if (!payload) return null;
  return {
    sub: typeof payload.sub === 'string' ? payload.sub : undefined,
    scope: typeof (payload as Record<string, unknown>).scope === 'string'
      ? (payload as Record<string, unknown>).scope as string
      : undefined,
    claims: payload as Record<string, unknown>,
  };
}

/**
 * Verify a command-login JWT (HS256, signed by mandrel-command/backend AuthService with
 * MANDREL_JWT_SECRET) using only Node's built-in crypto — no new dependency, matching the
 * node:crypto style this file already uses (createHash/timingSafeEqual).
 *
 * SECURITY:
 *   - ALGORITHM ALLOWLIST: only `alg: "HS256"` is accepted. `alg: "none"` and any asymmetric
 *     alg (the RS / ES / PS families) are REJECTED outright — this is the standard defense against JWT
 *     algorithm-confusion / "none" bypass. We never let the token pick the verifier.
 *   - Signature is recomputed as HMAC-SHA256 over `<header>.<payload>` with the shared secret
 *     and compared in CONSTANT TIME (timingSafeEqual on equal-length 32-byte digests).
 *   - `exp` (required-if-present) and `nbf` are enforced against the current time.
 * Returns true ONLY for a structurally valid, correctly-signed, unexpired HS256 JWT.
 */
export function verifyCommandJwt(token: string, secret: string): boolean {
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  const [headerB64, payloadB64, signatureB64] = parts;
  if (!headerB64 || !payloadB64 || !signatureB64) return false;

  // Parse + allowlist the header algorithm BEFORE trusting anything else.
  let header: { alg?: unknown; typ?: unknown };
  try {
    header = JSON.parse(Buffer.from(headerB64, 'base64url').toString('utf8'));
  } catch {
    return false;
  }
  if (header.alg !== 'HS256') return false;
  if (header.typ !== undefined && header.typ !== 'JWT') return false;

  // Recompute the signature over the exact signing input and constant-time compare.
  const expectedSig = createHmac('sha256', secret)
    .update(`${headerB64}.${payloadB64}`)
    .digest();
  let presentedSig: Buffer;
  try {
    presentedSig = Buffer.from(signatureB64, 'base64url');
  } catch {
    return false;
  }
  // HS256 output is always 32 bytes; a wrong-length signature is trivially invalid. The
  // length check guards timingSafeEqual (which throws on unequal lengths) without leaking
  // anything meaningful (the digest length is fixed/public).
  if (presentedSig.length !== expectedSig.length) return false;
  if (!timingSafeEqual(presentedSig, expectedSig)) return false;

  // Signature is valid — now enforce temporal claims.
  let payload: { exp?: unknown; nbf?: unknown };
  try {
    payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  } catch {
    return false;
  }
  const nowSec = Math.floor(Date.now() / 1000);
  if (typeof payload.exp === 'number' && nowSec >= payload.exp) return false;
  if (typeof payload.nbf === 'number' && nowSec < payload.nbf) return false;

  return true;
}

/**
 * bridgeAuth — the flag-gated guard for the on-box MCP HTTP bridge routes
 *   GET  /mcp/tools/schemas
 *   GET  /mcp/tools
 *   POST /mcp/tools/:toolName
 * (SECURITY P0 interim shield, an earlier task PHASE 1; default flipped fail-CLOSED in PHASE 2).
 * This is the SAME single guard for all three routes — NO drifting second
 * validator. It reuses the exact primitives the /mcp guards use
 * (extractBearer / checkStaticToken / defaultVerifyOAuth).
 *
 * FAIL-CLOSED BY DEFAULT — behavior is chosen by MCP_BRIDGE_AUTH_ENABLED:
 *   - flag TRUE (the DEFAULT, including when UNSET): enforce. A request passes if it presents
 *     ANY ONE of:
 *       (1) the static MCP_AUTH_TOKEN (constant-time), OR
 *       (2) a valid command HS256 login JWT (MANDREL_JWT_SECRET), OR
 *       (3) a valid better-auth OAuth JWT (only when OAuth is enabled).
 *     No valid credential → 401. FAIL CLOSED: if enforcement is on but NO credential source is
 *     configured at all (no static token, no JWT secret, OAuth disabled) the guard cannot
 *     authenticate anyone, so it returns 503 and refuses — it NEVER falls open (mirrors the
 *     /mcp 503-when-unset posture).
 *   - flag EXPLICITLY falsey (`false`/`0`/`off`/`no`): pass-through. next() is called
 *     immediately with NO credential read and NO response mutation → the three routes are
 *     byte-identical to the pre-gate behavior. PHASE 1 shipped this gate DARK (default
 *     pass-through); PHASE 2 flips the default so this tool-exec surface is closed
 *     unless it is EXPLICITLY opted out.
 *
 * `deps.verifyOAuth` is injectable for tests (default: JWKS verification), same seam as
 * dualBearerAuth.
 */
export function bridgeAuth(deps?: {
  verifyOAuth?: (token: string) => Promise<OAuthSubject | null>;
  /** Override the API-token verifier (tests). Default: SHA-256 lookup in api_tokens. */
  verifyApiToken?: ApiTokenVerifier;
}) {
  const verifyOAuth = deps?.verifyOAuth ?? defaultVerifyOAuth;
  const verifyApiToken = deps?.verifyApiToken ?? defaultApiTokenVerifier;

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    // EXPLICITLY DISABLED (MCP_BRIDGE_AUTH_ENABLED falsey): pass-through, byte-identical to the
    // pre-gate behavior. Do NOT touch req/res. Enforcement is the DEFAULT, so
    // this branch is taken only when the flag is set to an explicit `false`/`0`/`off`/`no`.
    if (!bridgeAuthEnabled()) {
      next();
      return;
    }

    // ENFORCING (default): determine which credential paths are configured.
    const staticToken = process.env.MCP_AUTH_TOKEN;
    const staticConfigured = !!(staticToken && staticToken.trim() !== '');
    const jwtSecret = commandJwtSecret();
    const oauthConfigured = BETTER_AUTH_CONFIG.enabled;

    // FAIL CLOSED: enforcement is on but nothing can validate a caller → refuse, never open.
    if (!staticConfigured && !jwtSecret && !oauthConfigured) {
      logger.error(
        '🔒 MCP bridge auth is ENABLED but no credential source is configured ' +
        '(MCP_AUTH_TOKEN, MANDREL_JWT_SECRET, and OAuth all unset). Refusing /mcp/tools/* ' +
        '(fail-closed). Provision a credential before enabling MCP_BRIDGE_AUTH_ENABLED.'
      );
      res.status(503).json(
        jsonRpcError(
          JSONRPC_AUTH_ERROR_CODE,
          'MCP bridge auth is enabled but not configured (server missing credential).'
        )
      );
      return;
    }

    const presented = extractBearer(req);
    if (presented) {
      // (1) static bridge token — the fast path machine callers take.
      if (staticConfigured && checkStaticToken(presented) === 'ok') {
        next();
        return;
      }
      // (1b) per-user API token — the Punch List loop's MANDREL_TOKEN. The
      // loop talks to THIS surface (POST /mcp/tools/<tool>), so a token that only opened
      // /mcp would be useless to it.
      if (looksLikeApiToken(presented)) {
        const outcome = await verifyApiToken(presented);
        if (outcome.kind === 'ok') {
          attachApiTokenPrincipal(req, outcome.principal);
          next();
          return;
        }
        if (outcome.kind === 'unavailable') {
          sendCredentialCheckUnavailable(res);
          return;
        }
      }
      // (2) command HS256 login JWT — the browser (Command UI) path.
      if (jwtSecret && verifyCommandJwt(presented, jwtSecret)) {
        next();
        return;
      }
      // (3) OAuth JWT — only attempted when OAuth is enabled for this container.
      if (oauthConfigured) {
        try {
          const subject = await verifyOAuth(presented);
          if (subject) {
            req.oauthSubject = subject;
            next();
            return;
          }
        } catch (err) {
          logger.warn(`🔒 Bridge OAuth token verification failed: ${(err as Error).message}`);
        }
      }
    }

    logger.warn('🔒 MCP bridge auth rejected: no valid static/JWT/OAuth credential');
    res.status(401).json(
      jsonRpcError(
        JSONRPC_AUTH_ERROR_CODE,
        presented ? 'Unauthorized: invalid Bearer token.' : 'Unauthorized: missing Bearer token.'
      )
    );
  };
}
