/**
 * projectListScope — the ONE place a MULTI-ROW read learns which projects it may return
 * (item 7 — the whole-class closure).
 *
 * =============================================================================
 * THE DEFECT THIS CLOSES
 * =============================================================================
 * services/projectScopeResolver.ts answers "which project did this request NAME, and may
 * the caller have it?". It deliberately lets a request name NOTHING — `getRequestProjectId`
 * returns `undefined` and the controller decides what unscoped means. Every list controller
 * decided the same thing, in the same shape:
 *
 *     const projectId = getRequestProjectId(req);
 *     if (projectId) filter.project_id = projectId;     // no project -> NO FILTER
 *
 * so an authenticated non-admin who simply omitted the project got EVERY project's rows.
 * Measured at the real surface against a migrated disposable DB with a zero-grant
 * non-admin (`__tests__/unscopedListProjectScope.db.test.ts` is the surviving form of that
 * probe): `GET /api/tasks`, `/api/contexts`, `/api/sessions`, `/api/dashboard/stats` and
 * fifteen more returned a row or a count belonging to a project the caller held no grant on.
 *
 * =============================================================================
 * WHY A TYPE AND NOT A RULE
 * =============================================================================
 * The rule "unscoped means the caller's authorized projects" applied by hand at N call
 * sites is wrong at site N+1. This module makes the dangerous state UNREACHABLE BY
 * OMISSION instead (the J3 shape this branch already used for
 * `getAvailableDatasets(…, allowedProjectIds)`):
 *
 *   - Every scoped read takes a `ProjectListScope`. It is a REQUIRED parameter with NO
 *     default, so forgetting it is a COMPILE error, not a silent every-project read.
 *   - "Every project" is the literal word {@link ALL_PROJECTS} at the call site, where a
 *     reviewer sees it. It cannot be spelled `undefined`, `null`, `''` or `[]`.
 *   - The EMPTY population is a first-class value: `{ mode: 'projects', projectIds: [] }`
 *     is a caller with zero grants and it returns NOTHING. `= ANY('{}'::uuid[])` is
 *     legitimately empty, so this needs no special case — but it must never be written as
 *     `if (projectIds.length)`, which is exactly how an empty set becomes "no filter".
 *
 * A new endpoint inherits the behaviour: it cannot call one of these services without
 * producing a scope, and the only supported way to produce one from a request is
 * {@link resolveListScope}, which consults ProjectAccessService.
 */

import { ProjectAccessService } from './projectAccess';
import { getRequestProjectId, type ProjectScopedRequestLike } from './projectScopeResolver';

/**
 * The explicit sentinel for "every project on the box". A WORD, not `undefined`/`null`,
 * so the unrestricted mode is legible at the call site and unreachable by omission.
 */
export const ALL_PROJECTS = 'ALL_PROJECTS' as const;

/**
 * The projects a multi-row read may return rows from.
 *
 *  - `{ mode: 'projects', projectIds }` — exactly these. An EMPTY array means NOTHING,
 *    and that is the correct answer for a caller with zero grants.
 *  - `{ mode: ALL_PROJECTS }` — unrestricted. Only an admin, and only via
 *    {@link resolveListScope} or an explicitly-justified call site.
 */
export type ProjectListScope =
  | { readonly mode: 'projects'; readonly projectIds: readonly string[] }
  | { readonly mode: typeof ALL_PROJECTS };

/** Unrestricted. Spelled out on purpose — see the module doc. */
export const allProjects: ProjectListScope = { mode: ALL_PROJECTS };

/** Restrict to exactly these project ids (an empty list returns no rows). */
export function projectsScope(projectIds: readonly string[]): ProjectListScope {
  return { mode: 'projects', projectIds: [...projectIds] };
}

/** The caller shape this module authorizes against — the same one ProjectAccessService takes. */
export interface ListScopeCaller {
  id: string;
  role?: string | null;
}

/**
 * Thrown when a scoped read runs on a request with no authenticated caller. FAIL LOUD,
 * mirroring `ProjectScopeNotResolvedError`: answering "unscoped" for a request whose user
 * could not be resolved is precisely how an every-project read happens silently.
 */
export class ListScopeCallerMissingError extends Error {
  constructor() {
    super(
      'A project-scoped list read requires an authenticated caller. authenticateToken must ' +
        'run before any handler that resolves a list scope.'
    );
    this.name = 'ListScopeCallerMissingError';
  }
}

/**
 * ── THE ONLY SUPPORTED WAY A LIST HANDLER LEARNS ITS SCOPE ────────────────────────────
 *
 *   a project was named  → exactly that project. It was already AUTHORIZED by
 *                          projectContextMiddleware, which 403s an ungranted id before any
 *                          handler runs — so this branch adds no second authorization
 *                          decision (two implementations that can disagree is the defect
 *                          projectScopeResolver.ts exists to prevent).
 *   no project + admin   → ALL_PROJECTS.
 *   no project + other   → the caller's grants, which may be the EMPTY set.
 *
 * `explicitlyUnscoped` (`?project=all`) is deliberately NOT a third answer: "show me
 * everything" from a non-admin still means "everything I am allowed to see". The sentinel
 * controls the PROJECT FILTER, never the AUTHORIZATION.
 *
 * @throws ProjectScopeNotResolvedError when projectContextMiddleware never ran
 * @throws ListScopeCallerMissingError  when there is no authenticated caller
 */
export async function resolveListScope(
  req: ProjectScopedRequestLike & { user?: ListScopeCaller }
): Promise<ProjectListScope> {
  const projectId = getRequestProjectId(req);
  if (projectId) return projectsScope([projectId]);
  return resolveCallerScope(req);
}

/**
 * The caller's GRANTS, ignoring whatever project the request NAMED.
 *
 * For a by-id WRITE whose named project is a DESTINATION, not a filter — `POST
 * /tasks/bulk/move` sends `body.project_id` as where the rows should GO. `body.project_id`
 * is a PROJECT_SCOPE_SOURCE, so with no header it is the resolved project, and
 * {@link resolveListScope} would hand back the destination as the scope: a move
 * "constrained" to rows already in its destination, with the SOURCE rows — the ones the
 * write actually re-homes — unconstrained. This is the scope for those: the rows a caller
 * may touch are exactly the projects they hold, and the destination has already been
 * authorized by projectContextMiddleware as a candidate.
 *
 * Same three answers as the unnamed branch of resolveListScope; that branch delegates here
 * so the two cannot drift.
 */
export async function resolveCallerScope(
  req: { user?: ListScopeCaller }
): Promise<ProjectListScope> {
  const user = req.user;
  if (!user?.id) throw new ListScopeCallerMissingError();
  if (user.role === 'admin') return allProjects;

  return projectsScope(await ProjectAccessService.listAccessibleProjectIds(user.id));
}

/**
 * The ONE translation of a scope into SQL. Appends to `params` and returns the predicate
 * to concatenate onto a WHERE clause (`''` for ALL_PROJECTS).
 *
 * @param column the fully-qualified column, e.g. `'c.project_id'` — the caller's, because
 *               these queries alias differently; it is never caller INPUT, always a literal.
 */
export function scopePredicate(
  scope: ProjectListScope,
  column: string,
  params: unknown[]
): string {
  if (scope.mode === ALL_PROJECTS) return '';
  params.push([...scope.projectIds]);
  return ` AND ${column} = ANY($${params.length}::uuid[])`;
}

/**
 * The same predicate for a query that has no preceding condition (no leading ` AND `).
 * Returns `''` for ALL_PROJECTS so the caller can build `WHERE 1=1${…}` or branch.
 */
export function scopeWhere(
  scope: ProjectListScope,
  column: string,
  params: unknown[]
): string {
  const p = scopePredicate(scope, column, params);
  return p === '' ? '' : ` WHERE ${p.slice(' AND '.length)}`;
}

/**
 * The scope as a SQL comparison RIGHT-HAND SIDE — `ANY($n::uuid[])` — or `undefined` for
 * ALL_PROJECTS. Appends the array to `params`.
 *
 * This exists for the queries in services/sessionCounts.ts's helpers, which splice a
 * caller-supplied param reference into `c.project_id = ${projectParam}` to implement RULE 2
 * (a project-filtered LIST filters its derived child counts to the same projects). Those
 * helpers took a bare `'$1'`; `ANY($1::uuid[])` slots into the same position, so RULE 2
 * keeps working unchanged with a SET instead of a single project.
 */
export function scopeParamRef(
  scope: ProjectListScope,
  params: unknown[]
): string | undefined {
  if (scope.mode === ALL_PROJECTS) return undefined;
  params.push([...scope.projectIds]);
  return `ANY($${params.length}::uuid[])`;
}

/**
 * True when the scope can return no rows at all (a caller with zero grants). Surfaces on
 * the read paths this backend PROXIES rather than queries (the MCP tool surface takes one
 * `projectId` and cannot express a set), so they can answer an honest empty instead of
 * falling through to the proxy's ambient project.
 */
export function scopeIsEmpty(scope: ProjectListScope): boolean {
  return scope.mode !== ALL_PROJECTS && scope.projectIds.length === 0;
}

/** Does this scope permit rows from `projectId`? Used to post-filter a proxied response. */
export function scopeAllows(scope: ProjectListScope, projectId: string | undefined): boolean {
  if (scope.mode === ALL_PROJECTS) return true;
  if (!projectId) return false;
  const want = projectId.toLowerCase();
  return scope.projectIds.some((p) => p.toLowerCase() === want);
}
