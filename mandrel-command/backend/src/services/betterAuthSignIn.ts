/**
 * betterAuthSignIn — ask better-auth (in the mcp-server) whether an email + password is right
 * (ONE login). The Command backend's half of the internal seam; the other half
 * is mcp-server/src/server/dashboardAuthRoutes.ts.
 *
 * FOUR STATES, and the ones that are not "no" stay distinct (CLASSES C1 — "could not
 * measure" never lands on "wrong password"):
 *   ok            better-auth accepted the password; here is who, and the better-auth session
 *                 the dashboard session will be bound to.
 *   no-match      better-auth said no — OR the mcp-server says this instance has no
 *                 better-auth sign-in at all (`not-enabled`, OAuth off), which for the person
 *                 signing in is a no.
 *   rate-limited  too many attempts for this email.
 *   unavailable   could not check: the mcp-server is unreachable, timed out, answered 5xx,
 *                 refused OUR service credential (401/503 from its static-token guard), or
 *                 has no such route at all (404 — the route exists whether OAuth is on or off,
 *                 so a 404 is a wrong path or a version skew between the two services). All
 *                 deployment faults: logged loudly, never blamed on the person.
 *
 * NEVER LOGGED: the password, or the email.
 */

import { McpService } from './mcp';
import { DASHBOARD_AUTH_CONFIG } from '../config/dashboardAuth';
import { logger } from '../config/logger';

export type BetterAuthSignInResult =
  | { kind: 'ok'; authUserId: string; email: string; authSessionId: string }
  | { kind: 'no-match' }
  | { kind: 'rate-limited' }
  | { kind: 'unavailable' };

/**
 * @param clientIp the END user's address as this backend sees it (req.ip, under its trust-proxy
 *   rule). The mcp-server keys its failed-attempt limit on (email, clientIp), so one guesser
 *   cannot lock the owner out.
 */
export type BetterAuthSignIn = (email: string, password: string, clientIp?: string) => Promise<BetterAuthSignInResult>;

interface Verdict {
  result?: unknown;
  user?: { id?: unknown; email?: unknown };
  session?: { id?: unknown };
}

export const signInThroughBetterAuth: BetterAuthSignIn = async (email, password, clientIp) => {
  const auth = McpService.authHeader();
  if (!auth.Authorization) {
    // No service credential configured: the internal route cannot be called at all.
    logger.error('[dashboard sign-in] MCP_AUTH_TOKEN is not set — cannot reach better-auth sign-in');
    return { kind: 'unavailable' };
  }
  const { hostname, port } = McpService.resolveMcpTarget();
  const url = `http://${hostname}:${port}${DASHBOARD_AUTH_CONFIG.signInPath}`;

  let status: number;
  let body: Verdict;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...auth },
      body: JSON.stringify({ email, password, ...(clientIp ? { clientIp } : {}) }),
      signal: AbortSignal.timeout(DASHBOARD_AUTH_CONFIG.timeoutMs),
    });
    status = res.status;
    body = (await res.json().catch(() => ({}))) as Verdict;
  } catch (err) {
    logger.error('[dashboard sign-in] could not reach the mcp-server', {
      error: err instanceof Error ? err.message : String(err),
    });
    return { kind: 'unavailable' };
  }

  if (status === 429) return { kind: 'rate-limited' };
  if (status === 200 && (body.result === 'no-match' || body.result === 'not-enabled')) return { kind: 'no-match' };
  if (
    status === 200 &&
    body.result === 'ok' &&
    typeof body.user?.id === 'string' &&
    typeof body.user?.email === 'string' &&
    typeof body.session?.id === 'string'
  ) {
    return { kind: 'ok', authUserId: body.user.id, email: body.user.email, authSessionId: body.session.id };
  }
  if (status === 401 || status === 403) {
    logger.error('[dashboard sign-in] the mcp-server refused this backend\'s service credential (MCP_AUTH_TOKEN mismatch?)', { status });
  } else if (status === 404) {
    logger.error('[dashboard sign-in] the mcp-server has no internal sign-in route (path drift or a version skew between the services?)', { status });
  } else {
    logger.error('[dashboard sign-in] unexpected answer from the mcp-server', { status });
  }
  return { kind: 'unavailable' };
};
