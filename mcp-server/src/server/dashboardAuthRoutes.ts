/**
 * dashboardAuthRoutes — the internal seam that lets the Command dashboard sign a person in
 * with their better-auth email + password (option A: ONE login).
 *
 *   POST <DASHBOARD_AUTH_CONFIG.signInPath>   body {email, password, clientIp?}
 *     guard   bearerAuth() with no options = the static MCP_AUTH_TOKEN ONLY (the Command
 *             backend's service credential). An `mdl_` API token or an OAuth JWT is 401.
 *     200 {result:'ok', user:{id,email}, session:{id,expiresAt}}
 *             better-auth's own signInEmail accepted the password and opened a session. The
 *             Command backend binds its dashboard session to `session.id`, so when better-auth
 *             ends that session (a set-password link is spent → revokeSessionsOnPasswordReset)
 *             the dashboard session ends with it (auth_tokens.auth_session_id ON DELETE CASCADE).
 *             The session TOKEN never leaves this process — the dashboard does not need it.
 *     200 {result:'no-match'}
 *             wrong password, unknown email, no credential account: better-auth said no. 200
 *             with a verdict rather than 401, so the caller can tell "the person is wrong"
 *             from "MY service credential is wrong" (which IS a 401, from the guard).
 *     429 {result:'rate-limited'}   too many FAILED attempts for this (email, client) (dashboardAuthConfig).
 *     400 {result:'bad-request'}    body is not {email:string, password:string}.
 *     503 {result:'unavailable'}    could not check (database down, better-auth threw a
 *             non-API error). THREE STATES, NOT TWO (CLASSES C1): never reported as no-match.
 *
 * Mounted from mountOAuthRoutes when OAuth is enabled. When it is NOT, HealthServer mounts
 * mountDashboardAuthDisabled instead: the same path and guard, answering 200
 * {result:'not-enabled'} — there is no better-auth login on this instance. So the route
 * ALWAYS exists, and a 404 at the caller can only mean a wrong path or a version skew between
 * the two services: "could not check", never "wrong password".
 *
 * NEVER LOGGED: the password. Nothing here logs the email either.
 */

import express from 'express';
import type { Application, NextFunction, Request, Response } from 'express';
import { isAPIError } from 'better-auth/api';
import type { AuthInstance } from './auth.js';
import { bearerAuth } from '../middleware/bearerAuth.js';
import { DASHBOARD_AUTH_CONFIG, type DashboardAuthConfig } from '../config/dashboardAuthConfig.js';
import { logger } from '../utils/logger.js';

export type DashboardSignInVerdict =
  | { result: 'ok'; user: { id: string; email: string }; session: { id: string; expiresAt: string } }
  | { result: 'no-match' }
  | { result: 'not-enabled' }
  | { result: 'rate-limited' }
  | { result: 'unavailable' };

/**
 * Run better-auth's own email+password sign-in. Exported so the integration test drives the
 * SHIPPED function; the route below is a thin HTTP wrapper over it.
 */
export async function signInForDashboard(
  auth: AuthInstance,
  email: string,
  password: string,
): Promise<DashboardSignInVerdict> {
  let token: string;
  try {
    const res = (await auth.api.signInEmail({ body: { email, password } })) as { token?: unknown };
    if (typeof res?.token !== 'string' || res.token === '') {
      logger.error('dashboard sign-in: better-auth accepted the password but returned no session token');
      return { result: 'unavailable' };
    }
    token = res.token;
  } catch (err) {
    if (isAPIError(err)) {
      if (err.statusCode === 429) return { result: 'rate-limited' };
      // better-auth's verdicts about the PERSON (wrong password, unknown/invalid email, no
      // credential account, unverified) are all 4xx APIErrors. One answer for all of them,
      // so the response never says which.
      if (err.statusCode >= 400 && err.statusCode < 500) return { result: 'no-match' };
    }
    logger.error(`dashboard sign-in: could not check the credential: ${(err as Error).message}`);
    return { result: 'unavailable' };
  }

  try {
    const ctx = await auth.$context;
    const found = await ctx.internalAdapter.findSession(token);
    if (!found) {
      logger.error('dashboard sign-in: the session better-auth just opened could not be read back');
      return { result: 'unavailable' };
    }
    return {
      result: 'ok',
      user: { id: found.user.id, email: found.user.email },
      session: { id: found.session.id, expiresAt: new Date(found.session.expiresAt).toISOString() },
    };
  } catch (err) {
    logger.error(`dashboard sign-in: session read-back failed: ${(err as Error).message}`);
    return { result: 'unavailable' };
  }
}

/**
 * Fixed-window limiter on FAILED sign-ins, keyed per (email, client address). In-memory, per
 * process (one mcp-server per tenant); expired buckets are swept on use.
 *
 * Only FAILURES count, and the key includes the client address the Command backend reports
 * (Reviewer N1): with successes counted, or with the key on the email alone, anyone
 * could lock an owner out of their own dashboard just by failing at their address. A guesser
 * exhausts only their OWN bucket — IF the backend reports real client addresses. On the hosted
 * fleet it does not yet (one proxy address per tenant), so there the key is
 * effectively per-email (Reviewer).
 */
export function failedSignInLimiter(cfg: DashboardAuthConfig = DASHBOARD_AUTH_CONFIG, now: () => number = Date.now) {
  const buckets = new Map<string, { count: number; resetAt: number }>();
  const keyOf = (email: string, client: string) => `${email.trim().toLowerCase()}|${client}`;
  const live = (key: string) => {
    const t = now();
    if (buckets.size > 1000) for (const [k, b] of buckets) if (b.resetAt <= t) buckets.delete(k);
    const b = buckets.get(key);
    return b && b.resetAt > t ? b : undefined;
  };
  return {
    /** True when this (email, client) has used up its failures for the window. */
    blocked(email: string, client: string): boolean {
      const b = live(keyOf(email, client));
      return !!b && b.count >= cfg.rateMax;
    },
    /** Count one FAILED attempt. Successful sign-ins are never counted. */
    recordFailure(email: string, client: string): void {
      const key = keyOf(email, client);
      const b = live(key) ?? { count: 0, resetAt: now() + cfg.rateWindowMs };
      b.count += 1;
      buckets.set(key, b);
    },
  };
}

/** Mount the internal sign-in route. Called from mountOAuthRoutes (OAuth enabled only). */
export function mountDashboardAuthRoutes(app: Application, auth: AuthInstance): void {
  const limiter = failedSignInLimiter();
  app.post(
    DASHBOARD_AUTH_CONFIG.signInPath,
    // Static service token ONLY: bearerAuth() without `apiTokens` never consults api_tokens,
    // and it does not accept OAuth JWTs.
    bearerAuth(),
    // Route-scoped body parser: mountOAuthRoutes runs BEFORE the app's global express.json().
    express.json({ limit: '4kb' }),
    async (req: Request, res: Response, _next: NextFunction) => {
      res.setHeader('Cache-Control', 'no-store');
      const email = req.body?.email;
      const password = req.body?.password;
      if (typeof email !== 'string' || typeof password !== 'string' || email.trim() === '' || password === '') {
        res.status(400).json({ result: 'bad-request' });
        return;
      }
      // The END user's address, as the Command backend saw it (its own trust-proxy rule). This
      // route is static-token-only, so the value comes from our own backend, not the client.
      const rawClient = req.body?.clientIp;
      const client = typeof rawClient === 'string' && rawClient.trim() !== '' ? rawClient.trim().slice(0, 64) : 'unknown';
      if (limiter.blocked(email, client)) {
        res.status(429).json({ result: 'rate-limited' });
        return;
      }
      const verdict = await signInForDashboard(auth, email.trim(), password);
      if (verdict.result === 'no-match') limiter.recordFailure(email, client);
      const status = verdict.result === 'rate-limited' ? 429 : verdict.result === 'unavailable' ? 503 : 200;
      res.status(status).json(verdict);
    },
  );
}

/**
 * The OAuth-disabled twin: same path, same static-token-only guard, one honest answer —
 * this instance has no better-auth sign-in. Called from HealthServer when mountOAuthRoutes
 * mounted nothing.
 */
export function mountDashboardAuthDisabled(app: Application): void {
  app.post(DASHBOARD_AUTH_CONFIG.signInPath, bearerAuth(), (_req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({ result: 'not-enabled' });
  });
}
