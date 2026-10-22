/**
 * authz.ts — the authorization CLASSIFICATION channel.
 *
 * ## Why this exists
 *
 * `DELETE /api/projects/:id` shipped for the whole life of this repo gated by
 * `authenticateToken` ONLY, so any authenticated caller of any role could cascade-delete a
 * project across 24 project-owned tables. `requireAdmin` had existed the entire time in
 * `middleware/auth.ts` and was used on exactly ONE route repo-wide (`/auth/register`).
 *
 * Nobody "forgot" — there was no place where forgetting was visible. Adding `requireAdmin`
 * to the delete route fixes ONE route; it does nothing about the next destructive route
 * somebody writes. This module is the part that closes the class.
 *
 * ## The construction
 *
 * Every middleware that answers "who may call this" carries a machine-readable
 * classification on the function object itself. `requireAdmin` carries one because it
 * ENFORCES. The two `declare*` markers below carry one because somebody DECIDED, and the
 * decision plus its written reason live at the route, in the same argument list, one token
 * from the handler — not in a central list a reviewer has to remember to update
 * (an allow-list of routes we remembered is the shape that rots).
 *
 * `src/__tests__/mutatingRouteAuthzCoverage.test.ts` then walks the REAL mounted
 * `routes/index.ts` router and requires a classification on every route registered with a
 * state-changing verb. Its population is not a list anyone maintains — it is whatever
 * Express actually has in its stack. So a new `router.post(...)` with no classification is
 * a RED test the moment it is written, and the failure message names the exact
 * method + path. **Omission is loud, not documented.**
 *
 * ## What a marker is NOT
 *
 * `declareAnyAuthenticatedMayWrite` does not grant anything and does not weaken anything —
 * it is `next()`. It records that the open state is intentional. Deleting it does not open
 * a route; it turns the coverage guard RED. That asymmetry is deliberate: the marker can
 * only ever cost you a failing test, never a permission.
 */

import { Response, NextFunction, RequestHandler } from 'express';
import { AuthenticatedRequest } from '../types/auth';

/**
 * Registry key. `Symbol.for` (not a bare `Symbol`) so the guard still recognises a
 * classification when a module is loaded through two different realms/instances — a
 * duplicate-module situation would otherwise make the guard silently see NOTHING
 * classified and, if it were written the other way round, silently pass everything.
 */
export const AUTHZ_CLASSIFICATION: unique symbol = Symbol.for(
  'mandrel.authz.classification'
) as typeof AUTHZ_CLASSIFICATION;

export type AuthzKind =
  /** Enforced: `req.user.role` must be `admin` or the request is refused 403. */
  | 'admin'
  /**
   * Enforced: this middleware validates a credential and refuses the request (401) when
   * there is none. Attached with `markAuthenticator`. This is the kind that lets the
   * coverage guard answer "is this route reachable without a credential?" WITHOUT
   * matching middleware by NAME.
   *
   * Name-matching was the first thing tried and it is wrong: `routes/events.ts` is
   * guarded by `ensureAuthForSse`, not `authenticateToken`, so a name-keyed sweep
   * reports three authenticated routes as OPEN. A census that over-reports is annoying;
   * the same mechanism under-reports the moment somebody writes a fourth authenticator,
   * and then it is a hole. The classification travels ON the middleware object, so the
   * guard sees whatever the app actually mounted.
   */
  | 'authenticated'
  /** Declared: any successfully authenticated user may perform this write. */
  | 'any-authenticated'
  /** Declared: reachable with no credential at all. */
  | 'unauthenticated';

/**
 * Every kind, as a VALUE — so a test can enumerate the kinds instead of restating them.
 * A guard that hardcodes the list goes stale silently the next time one is added
 * (CLASSES.md C4: never hardcode a value the product derives from somewhere else).
 *
 * The `satisfies` plus the exhaustiveness line below make forgetting to add a new kind
 * here a COMPILE error, not a stale constant.
 */
export const ALL_AUTHZ_KINDS = [
  'admin',
  'authenticated',
  'any-authenticated',
  'unauthenticated',
] as const satisfies readonly AuthzKind[];

type MissingKinds = Exclude<AuthzKind, (typeof ALL_AUTHZ_KINDS)[number]>;
// If this line stops compiling, a member of AuthzKind is missing from ALL_AUTHZ_KINDS.
const _allKindsListed: MissingKinds extends never ? true : never = true;
void _allKindsListed;

/**
 * The kinds that ENFORCE — i.e. a request that reaches the handler through one of these
 * carried a credential. These are the only kinds that may be counted through an enclosing
 * `router.use(...)`, because `router.use(authenticateToken)` genuinely does protect every
 * route registered beneath it.
 *
 * The `declare*` kinds are NOT here on purpose: they grant nothing, so inheriting one is a
 * blanket mute (see the coverage guard).
 */
export const ENFORCING_AUTHZ_KINDS: ReadonlySet<AuthzKind> = new Set<AuthzKind>([
  'admin',
  'authenticated',
]);

export const isEnforcing = (c: AuthzClassification | undefined): boolean =>
  c !== undefined && ENFORCING_AUTHZ_KINDS.has(c.kind);

export interface AuthzClassification {
  kind: AuthzKind;
  /** Why. Free text, required, must be non-blank — see `classifyAuthz`. */
  reason: string;
}

export type ClassifiedHandler = RequestHandler & {
  [AUTHZ_CLASSIFICATION]: AuthzClassification;
};

/**
 * Attach a classification to a middleware.
 *
 * Throws at MODULE LOAD time (route files call these at import time, so this runs when the
 * router is built — before the process can serve a request) on a blank reason. An empty
 * reason is the value that would otherwise slip through and turn this channel into
 * decoration: `declareAnyAuthenticatedMayWrite('')` would satisfy a naive coverage check
 * while recording no decision at all. Blank is the population that gets probed in the
 * guard's own tests.
 */
export function classifyAuthz<T extends RequestHandler>(
  handler: T,
  classification: AuthzClassification
): T & ClassifiedHandler {
  const reason = typeof classification.reason === 'string' ? classification.reason.trim() : '';
  if (reason.length === 0) {
    throw new Error(
      `[AUTHZ] classifyAuthz('${classification.kind}') requires a non-blank reason. ` +
        'A classification with no reason records no decision.'
    );
  }
  return Object.defineProperty(handler, AUTHZ_CLASSIFICATION, {
    value: { kind: classification.kind, reason } as AuthzClassification,
    enumerable: false,
    writable: false,
    configurable: false,
  }) as T & ClassifiedHandler;
}

/** Read a classification off a middleware, or `undefined` if it carries none. */
export function readAuthzClassification(handler: unknown): AuthzClassification | undefined {
  if (typeof handler !== 'function') return undefined;
  return (handler as Partial<ClassifiedHandler>)[AUTHZ_CLASSIFICATION];
}

const passThrough = (_req: AuthenticatedRequest, _res: Response, next: NextFunction): void => next();

/**
 * "Any authenticated user may perform this write, and that is intended."
 *
 * Put it in the route's argument list next to `authenticateToken`. It grants nothing; it
 * asserts a human looked at this write and decided admin was not the right bar. Write the
 * reason for the next reader, not for the linter.
 *
 *   router.post('/', authenticateToken,
 *     declareAnyAuthenticatedMayWrite('creating a context is ordinary user work'),
 *     ContextController.createContext);
 */
export const declareAnyAuthenticatedMayWrite = (reason: string): ClassifiedHandler =>
  classifyAuthz(
    // A fresh function per call: the classification is a non-writable own property, so a
    // shared singleton could only ever carry ONE reason.
    (req: AuthenticatedRequest, res: Response, next: NextFunction) => passThrough(req, res, next),
    { kind: 'any-authenticated', reason }
  );

/**
 * "This route is reachable with no credential, and that is intended."
 *
 * Deliberately verbose. If you are typing this, say who calls it and what stops abuse.
 */
export const declareIntentionallyUnauthenticated = (reason: string): ClassifiedHandler =>
  classifyAuthz(
    (req: AuthenticatedRequest, res: Response, next: NextFunction) => passThrough(req, res, next),
    { kind: 'unauthenticated', reason }
  );

/**
 * "This middleware ENFORCES authentication: no valid credential, no handler."
 *
 * Put it on the middleware itself (in `middleware/`), not at a route. Every authenticator
 * the app mounts must carry this, or the coverage guard will report every route it guards
 * as unauthenticated — loud, and in the right direction.
 *
 * ⚠️ This is a DECLARATION, and a declaration can lie. `routeAuthzCoverage.test.ts`
 * therefore drives every handler carrying this mark with a credential-free request and
 * requires a 401. A passthrough that claimed to be an authenticator would be RED there.
 */
// Return type is the NAMED `ClassifiedHandler`, not an inferred `T & ClassifiedHandler`.
// The inferred form makes `tsc --noEmit` fail TS4023 at every call site ("cannot be named"
// — the intersection embeds the unique symbol structurally). `requireAdmin` already
// carries the same explicit annotation for the same reason.
export const markAuthenticator = (
  handler: RequestHandler,
  reason: string
): ClassifiedHandler => classifyAuthz(handler, { kind: 'authenticated', reason });
