/**
 * entityProjectScope — the ONE place a read of a SINGLE RECORD BY ID is authorized
 * (the entity-detail half of item 7).
 *
 * =============================================================================
 * THE DEFECT THIS CLOSES
 * =============================================================================
 * The list half of this task made unscoped list reads mean "the caller's projects". The
 * detail reads beside them were untouched and took no authority at all:
 *
 *     controllers/task.ts:84     TaskService.getTaskById(id)        // no scope argument
 *     controllers/context.ts:183 ContextService.getContextById(id)  // no scope argument
 *
 * Measured at the real surface with a zero-grant non-admin and ids seeded into a project
 * it holds no grant on: `/api/tasks/:id`, `/api/contexts/:id`, `/api/sessions/:id`,
 * `/api/session-code/session/:sessionId`, `/api/treewalker/:anchorId/thread` and
 * `/api/resolve/:id` all returned 200 with the victim's rows.
 *
 * That left this branch in the state it exists to abolish, one family over:
 * `/api/projects/:id` and `/api/surveyor/projects/:projectId/*` were tight while their
 * immediate neighbours were open.
 *
 * =============================================================================
 * WHY A router.param CHOKE POINT AND NOT A SCOPE ARGUMENT
 * =============================================================================
 * The list fix threads a REQUIRED `ProjectListScope` through the service signature, so
 * forgetting it is a compile error. That works there because the service BUILDS the query
 * and the scope is an input to it.
 *
 * A detail read is different: the project is not known until AFTER the row is fetched, so
 * the check is "load, then decide", and a per-service scope argument would mean every
 * `getXById` re-implements load-then-decide — N copies of an authorization decision, which
 * is the defect projectScopeResolver.ts exists to prevent.
 *
 * `router.param` is the choke point that already works in this codebase for exactly this
 * shape (routes/surveyor.ts, and routes/projects.ts on this branch). It runs during
 * ROUTING, before any handler on that router, and — the property that matters — a NEW
 * `/:id` route added to one of these routers tomorrow INHERITS the check without anyone
 * remembering to add it. That is the difference between a construction and a list.
 *
 * =============================================================================
 * THE FAILURE MODE: 403 FOR BOTH, ON PURPOSE
 * =============================================================================
 * A 403 for "exists but you may not have it" and a 404 for "does not exist" is an
 * existence oracle: an unauthorized caller enumerates ids and learns which ones are real.
 * `authorizeProjectPathParam` already answers 403 to both (a non-existent project id has
 * no grant row, so it fails the same check), verified at the surface. This matches it:
 *
 *     malformed uuid                 -> 400   (a shape error discloses nothing)
 *     no authenticated caller        -> 401
 *     row does not exist             -> 403   <- deliberately NOT 404
 *     row exists, caller not granted -> 403
 *     row exists with NULL project   -> 403   (fail closed; sessions.project_id is NULLABLE)
 *     the access check THROWS        -> 500   (C1: could-not-measure gets its own branch)
 *
 * The cost is that a granted caller asking for an id that genuinely does not exist in
 * their own project also gets 403 rather than 404. That is the price of not running an
 * existence oracle, it is what the project family already does, and it is asserted rather
 * than described in __tests__/entityDetailProjectScope.db.test.ts.
 */

import { db as pool } from '../database/connection';
import { ProjectAccessService } from './projectAccess';
import { isValidUuid } from '../utils/uuid';

/**
 * ── THE POPULATION ───────────────────────────────────────────────────────────────────
 * Every record kind that can arrive as an id in a route PATH and whose visibility is
 * governed by a project.
 *
 * `table` is a FIXED LITERAL from this map and never request input — it is interpolated
 * into SQL, and that is only safe because nothing outside this file can choose it. The id
 * is always a bound parameter.
 *
 * GUARD SCOPE (C3 — stated next to the enumeration): this covers a project-owning record
 * identified by a full uuid in a path segment. It does NOT cover: ids in the QUERY or BODY
 * (those are project references, handled by services/projectScopeResolver.ts's
 * PROJECT_SCOPE_SOURCES), SHORT-PREFIX ids (the navigation spine resolves those across
 * several tables at once — scoped instead inside utils/idResolver.ts, which takes the
 * caller's ProjectListScope), or a path param that is itself a PROJECT id (that is
 * authorizeProjectPathParam — the project IS the scope, so there is no row to load first).
 *
 * `projects` is deliberately ABSENT: a project scopes on its own id and already has its
 * own handler. Adding it here would be a second authorization implementation for one
 * question.
 */
export const PROJECT_OWNED_ENTITIES = {
  task: { table: 'tasks' },
  context: { table: 'contexts' },
  decision: { table: 'technical_decisions' },
  session: { table: 'sessions' },
} as const;

export type ProjectOwnedEntity = keyof typeof PROJECT_OWNED_ENTITIES;

/** Every table a path-param entity id can live in. Used by the guard's own coverage test. */
export const PROJECT_OWNED_TABLES: readonly string[] = Object.values(PROJECT_OWNED_ENTITIES).map(
  (e) => e.table
);

/**
 * `ANY` — the record kind is not known from the route.
 *
 * `/api/treewalker/:anchorId/thread` takes an anchor that may be a context, a task or a
 * decision, and the route cannot say which. Rather than let that route opt out of the
 * check (the shape that produced every hole on this task), it resolves the id against
 * EVERY project-owned table and authorizes whatever it finds. An id matching nothing is a
 * 403 like any other, so this branch cannot be used as an existence oracle either.
 */
export const ANY_PROJECT_OWNED = 'any' as const;

export type EntityParamKind = ProjectOwnedEntity | typeof ANY_PROJECT_OWNED;

/** The minimal request shape this needs. Deliberately not tied to Express's Request. */
export interface EntityScopedRequestLike {
  user?: { id: string; role?: string | null };
}

export interface EntityDenyResponseLike {
  status: (code: number) => { json: (body: unknown) => unknown };
}

/**
 * Resolve the owning project of `id`, or `null` when no project-owned row has that id
 * (either it does not exist, or its `project_id` is NULL).
 *
 * Exported so the guard can assert the lookup covers every table in the population
 * instead of trusting that it does.
 */
export async function findOwningProjectId(
  id: string,
  kind: EntityParamKind
): Promise<string | null> {
  const tables =
    kind === ANY_PROJECT_OWNED ? PROJECT_OWNED_TABLES : [PROJECT_OWNED_ENTITIES[kind].table];

  // One round trip. Every branch selects the same two columns so the UNION is valid, and
  // `project_id IS NOT NULL` is in the WHERE rather than checked afterwards — a NULL owner
  // must behave exactly like "no row", never like "no restriction".
  const sql = tables
    .map((t) => `SELECT project_id::text AS project_id FROM ${t} WHERE id = $1 AND project_id IS NOT NULL`)
    .join(' UNION ALL ');

  const result = await pool.query(`${sql} LIMIT 1`, [id]);
  return result.rows.length > 0 ? (result.rows[0].project_id as string) : null;
}

/**
 * Build a `router.param` handler that authorizes an ENTITY id in the path.
 *
 * Use as `router.param('<paramName>', authorizeEntityPathParam('<kind>'))` on a router
 * that has ALREADY authenticated the caller (`router.use(authenticateToken)`), exactly
 * like authorizeProjectPathParam. It does not re-implement authentication, and it does not
 * re-implement authorization: the decision is
 * `ProjectAccessService.userHasProjectAccess`, the same function every other door calls.
 *
 * Typed structurally rather than as Express's `RequestParamHandler` so it is unit-testable
 * without an Express request; each router adapts it at the call site, where a signature
 * drift is the compiler's problem.
 */
export function authorizeEntityPathParam(kind: EntityParamKind) {
  return async function authorizeEntityParam(
    req: EntityScopedRequestLike,
    res: EntityDenyResponseLike,
    next: (err?: unknown) => void,
    value: string
  ): Promise<void> {
    const deny = (status: number, error: string, message: string) => {
      res.status(status).json({ success: false, error, message });
    };

    if (typeof value !== 'string' || !isValidUuid(value.trim())) {
      deny(400, 'Invalid ID format', 'The id must be a valid UUID');
      return;
    }
    const user = req.user;
    if (!user) {
      deny(401, 'Authentication required', 'This request requires a valid token');
      return;
    }

    // Admin holds every project by definition; skip the lookup entirely so an admin's
    // detail read costs exactly what it did before.
    if (user.role === 'admin') {
      next();
      return;
    }

    try {
      const owningProjectId = await findOwningProjectId(value.trim().toLowerCase(), kind);
      // NO ROW AND NO ACCESS ARE THE SAME ANSWER. See the failure-mode note in the module
      // doc: splitting them here is what turns this guard into an existence oracle.
      if (owningProjectId === null) {
        deny(403, 'Access denied', 'You do not have access to the requested record');
        return;
      }
      const allowed = await ProjectAccessService.userHasProjectAccess(
        { id: user.id, role: user.role },
        owningProjectId
      );
      if (!allowed) {
        deny(403, 'Access denied', 'You do not have access to the requested record');
        return;
      }
    } catch {
      // C1: "could not measure" gets its own branch and never becomes an allow.
      deny(500, 'Access check failed', 'Internal server error during authorization');
      return;
    }
    next();
  };
}
