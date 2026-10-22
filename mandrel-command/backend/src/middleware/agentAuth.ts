/**
 * agentAuth.ts — the inbound MACHINE credential.
 *
 * ## Why this exists
 *
 * `POST /api/git/push-stats` was the only STATE-CHANGING route on the whole served
 * surface reachable with no credential at all. Anyone on the internet could write git
 * statistics into a customer's Mandrel instance. It was honestly declared
 * (`declareIntentionallyUnauthenticated('... id-possession is not authentication')`), so
 * this is a scoping decision being closed, not a discovery.
 *
 * ## Why a static service token rather than a JWT
 *
 * The consumer is `mandrel-watcher`, a long-lived local daemon. `authenticateToken`
 * accepts only user JWTs and `config.auth.jwtExpiresIn` is `24h`, so the only way to
 * credential a daemon with the existing mechanism is to widen token lifetime for every
 * human user. That is the wrong trade and an earlier task rules it out by name. mTLS was
 * considered and rejected for this batch: it moves the enforcement point into Traefik and
 * the deploy scripts, which are outside this change's blast radius, for the same security
 * property on ONE route.
 *
 * ## Fail-CLOSED, in the direction that matters
 *
 * `config.agent.pushToken` empty (nobody configured a credential) does NOT mean "let
 * everyone in". It means the AGENT path is unavailable and the request falls through to
 * ordinary user authentication, which will 401 an anonymous caller. There is no
 * environment, flag, or missing variable in which this middleware calls `next()` for a
 * request that presented no credential. That is the one property worth asserting, and
 * `routeAuthzCoverage.test.ts` asserts it by DRIVING this handler, not by reading it.
 */

import { Response, NextFunction } from 'express';
import { createHash, timingSafeEqual } from 'crypto';
import { AuthenticatedRequest } from '../types/auth';
import { authenticateToken } from './auth';
import { markAuthenticator } from './authz';
import { logger } from '../config/logger';
import config from '../config/environment';

/**
 * Constant-time compare of two secrets, safe on unequal lengths.
 *
 * `timingSafeEqual` THROWS when the buffers differ in length, which would turn a
 * wrong-length token into a 500 and leak length by status code. Both sides are hashed to a
 * fixed width first so the comparison is always same-length.
 */
function secretsMatch(presented: string, expected: string): boolean {
  if (expected.length === 0 || presented.length === 0) return false;
  const a = createHash('sha256').update(presented, 'utf8').digest();
  const b = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(a, b);
}

const bearerToken = (req: AuthenticatedRequest): string => {
  const header = req.headers.authorization;
  return typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : '';
};

const authenticateAgentOrUserImpl = async function authenticateAgentOrUser(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  // CORS pre-flight carries no credential by definition; authenticateToken lets it through
  // for the same reason. Kept identical so the two middlewares cannot disagree.
  if (req.method === 'OPTIONS') {
    return next();
  }

  const presented = bearerToken(req);
  if (presented && secretsMatch(presented, config.agent.pushToken)) {
    // A machine, not a person. `req.user` is deliberately NOT populated: nothing
    // downstream should be able to mistake the watcher for a logged-in human, and anything
    // that needs a user must fail rather than silently inherit one. `agentAuthenticated` is
    // the explicit signal for a downstream check (e.g. a project-ownership authorizer) that
    // needs to know a trusted machine, not an unauthenticated caller, is behind `!req.user`.
    req.agentAuthenticated = true;
    logger.debug('Agent credential accepted', { path: req.path, method: req.method });
    return next();
  }

  // NOT a fallback to "open" — a fallback to the STRICTER check. An anonymous caller gets
  // 401 from here.
  return authenticateToken(req, res, next);
};

/**
 * Accept EITHER the static agent service token OR an ordinary user JWT.
 *
 * Marked as an authenticator, so the coverage guard counts the route it guards as
 * credential-requiring — and so the behavioural probe drives it with no credential and
 * requires a 401.
 */
export const authenticateAgentOrUser = markAuthenticator(
  authenticateAgentOrUserImpl,
  'accepts the MANDREL_AGENT_TOKEN service credential (headless mandrel-watcher) or a user JWT; responds 401 when neither is presented'
);
