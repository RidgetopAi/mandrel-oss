import express, { Request, Response, NextFunction, RequestHandler } from 'express';
import config from '../config/environment';
import { authenticateAgentOrUser } from './agentAuth';

/**
 * Body parsing that happens only AFTER authentication.
 *
 * The previous app-wide `express.json({limit:'10mb'})` ran before every route's own auth
 * guard, so an unauthenticated 2 MiB body was buffered and parsed first (malformed JSON
 * answered 400, oversize 413) — the caller never reached the 401, and the server did
 * the work for an anonymous party.
 *
 * Routes here authenticate per-router, so a single app-level step does both: for a
 * body-bearing request it first runs the credential check (the superset authenticator —
 * user JWT, or the agent service token) and answers 401 itself on failure, WITHOUT
 * reading the body; only then does it parse. The route's own guard still runs afterwards
 * and remains the authority for role/ownership — this step only decides "may we spend
 * effort reading your body".
 *
 * Public routes that genuinely need a body (no credential exists yet) are listed in
 * PUBLIC_BODY_ROUTES and get their own SMALL parser (`bodyLimits.public`).
 */

/** Methods that can carry a body. Everything else is passed straight through. */
const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Routes reachable with NO credential that must read a body. `login` IS the credential
 * exchange. Matched on the request path as seen at the app (`req.path`, mounted at root).
 */
export const PUBLIC_BODY_ROUTES: ReadonlyArray<{ method: string; path: string }> = [
  { method: 'POST', path: '/api/auth/login' },
];

const publicJson = express.json({ limit: config.bodyLimits.public });

const authenticatedParsers: RequestHandler[] = [
  express.json({ limit: config.bodyLimits.authenticated }),
  express.urlencoded({ extended: true, limit: config.bodyLimits.authenticated }),
];

function runChain(handlers: RequestHandler[], req: Request, res: Response, next: NextFunction): void {
  let i = 0;
  const step = (err?: unknown): void => {
    if (err) return next(err);
    const h = handlers[i++];
    if (!h) return next();
    h(req, res, step);
  };
  step();
}

export function bodyParsingAfterAuth(req: Request, res: Response, next: NextFunction): void {
  if (!BODY_METHODS.has(req.method)) return next();

  const path = req.path.length > 1 ? req.path.replace(/\/+$/, '') : req.path;
  if (PUBLIC_BODY_ROUTES.some((r) => r.method === req.method && r.path === path)) {
    return publicJson(req, res, next);
  }

  // Authenticate first. On failure the authenticator has already written the 401 and does
  // not call next(), so the body is never read.
  authenticateAgentOrUser(req, res, (err?: unknown) => {
    if (err) return next(err);
    runChain(authenticatedParsers, req, res, next);
  });
}
