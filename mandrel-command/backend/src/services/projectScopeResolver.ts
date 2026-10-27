/**
 * projectScopeResolver — the ONE place a request's project scope is RESOLVED, and the
 * ONE place that resolution is AUTHORIZED.
 *
 * =============================================================================
 * THE DEFECT THIS CLOSES
 * =============================================================================
 * The F-04 closure authorized ONE door: the `X-Project-ID` header, in
 * middleware/project.ts. The check was keyed on that header being PRESENT, so the two
 * other doors that reach the same project scope were never checked at all:
 *
 *   WRITE  services/requestProjectScope.ts:65   `req.projectId ?? req.body?.projectId`
 *          → a non-admin with ZERO grants who omits the header and puts `projectId` in
 *            the body wrote into any project they named.
 *   READ   ~20 controller sites                 `req.projectId || req.query.project_id`
 *          (and `req.query.project`, and `req.query.projectId` on the SSE path)
 *          → the same bypass on every list endpoint.
 *
 * The fix is not "check those too" — that is a list, and the 21st call site reopens it.
 * The fix is to move the authorization from THE HEADER to THE RESOLUTION: gather every
 * candidate this request could possibly be scoped by, authorize EVERY ONE of them with
 * the SAME ProjectAccessService the header door already uses, and hand controllers a
 * single resolved value they cannot obtain any other way.
 *
 * =============================================================================
 * WHY EVERY CANDIDATE, NOT JUST THE WINNER
 * =============================================================================
 * A resolver that authorizes only the winning source is the same bug one layer in: the
 * caller controls which source wins (it supplies all of them), so "authorize the winner"
 * degrades to "authorize whichever door the attacker did not use". Every candidate is
 * authorized; one denial denies the request. This costs at most a handful of extra
 * indexed lookups, and in practice a request names a project through exactly one source.
 *
 * =============================================================================
 * PRECEDENCE — a real decision, written down once, here
 * =============================================================================
 * PROJECT_SCOPE_SOURCES below is in precedence order, FIRST WINS:
 *
 *   1. query `project_id`     2. query `project`     3. query `projectId`
 *   4. header `X-Project-ID`  5. body  `projectId`   6. body `project_id`
 *
 * QUERY BEATS HEADER because the live frontend depends on it and documents it as
 * load-bearing: `frontend/src/api/domains/daySummary.ts` and `momentumSeries.ts` state
 * that the explicit `project` query param is AUTHORITATIVE over the globally-selected
 * project that the axios layer attaches as `X-Project-ID` — that is how the Calendar's
 * own filter wins over the global selector, and how `project=all` can mean "unscoped"
 * while a project is header-selected. Inverting this would silently re-scope those
 * screens. controllers/daySummary.ts and controllers/momentumSeries.ts already
 * implemented exactly this order by hand; this generalises their rule rather than
 * inventing a competing one.
 *
 * HEADER BEATS BODY, preserving services/requestProjectScope.ts's original
 * `req.projectId ?? req.body?.projectId`.
 *
 * =============================================================================
 * THE `all` SENTINEL
 * =============================================================================
 * A query source may carry the literal `all` (case-insensitive), which means EXPLICITLY
 * UNSCOPED — distinct from "absent". It wins by precedence like any other value, so
 * `?project=all` with an `X-Project-ID` header resolves to unscoped, which is precisely
 * the daySummary/momentumSeries contract. It is NOT accepted from the header or the body,
 * neither of which ever meant it. An `all` that wins does not remove the obligation to
 * authorize the OTHER candidates on the request — a caller must not be able to launder an
 * un-granted project id past the check by also sending `project=all`.
 *
 * =============================================================================
 * FAIL CLOSED, EVERY BRANCH (C1: an instrument has three states)
 * =============================================================================
 *   malformed value (not a uuid, not `all`)   → 400
 *   non-string shape (`?project_id[x]=y`)      → 400
 *   repeated param with DISAGREEING values     → 400 (never "pick one")
 *   any candidate present, no verifiable caller→ 401
 *   caller lacks access to any candidate       → 403, nothing attached
 *   the access check THROWS (DB down)          → 500, never allow, never deny-silently
 *   no candidate at all                        → unscoped, pass through (pre-existing
 *                                                contract: controllers decide what an
 *                                                unscoped read means)
 */

import { ProjectAccessService } from './projectAccess';
import { isValidUuid } from '../utils/uuid';

/** The literal that means "explicitly unscoped" on a query source. */
export const UNSCOPED_SENTINEL = 'all';

export type ProjectSourceLocation = 'query' | 'header' | 'body';

export interface ProjectSourceSpec {
  /** Stable identifier; tests derive their population from these. */
  readonly key: string;
  readonly location: ProjectSourceLocation;
  /** The actual query-param name / header name / body field name. */
  readonly name: string;
  /** May this source carry the `all` (explicitly-unscoped) sentinel? */
  readonly acceptsUnscopedSentinel: boolean;
}

/**
 * ── THE POPULATION ───────────────────────────────────────────────────────────────────
 * Every way an HTTP request to this backend can name a project, IN PRECEDENCE ORDER.
 * This array is the single source of truth: the middleware iterates it, and
 * `__tests__/projectScopeEnforcement.test.ts` DERIVES its per-source denial cases from
 * it, so adding a source here without also making it enforceable fails the suite.
 *
 * GUARD SCOPE (C3 — state it, next to the enumeration): this covers project references
 * that arrive as a top-level query param, a request header, or a top-level body field on
 * an Express request handled by mandrel-command/backend. It does NOT cover: nested body
 * references (`body.arguments.projectId` on the /api/mcp passthrough — authorized
 * separately at routes/mcp.ts:258-290 against this same service), project references by
 * NAME rather than uuid (only the /api/mcp passthrough accepts those), PATH PARAMS, or the
 * mcp-server's own surface (a different process with its own project-scope guard).
 *
 * WHY PATH PARAMS CANNOT BE DONE HERE: Express populates `req.params` during ROUTING, and
 * this resolver runs in an app-level middleware BEFORE any router matches — `req.params`
 * is empty at that point. The routers that take a project path param are authorized at
 * their own choke point instead, with `router.param()` + {@link authorizeProjectPathParam}
 * below, which calls the SAME ProjectAccessService. (This paragraph said "no route takes a
 * project as one" until an adversarial sweep found `/api/surveyor/projects/:projectId/*` —
 * five live routes, authenticateToken + a uuid SHAPE check and no authorization. The
 * claim was wrong, which is worse than the hole: it told the next reader not to look.)
 *
 * `body.project_id` (SNAKE case) is in the list above because the same sweep found it is
 * the scope field for `POST /api/tasks` (controllers/task.ts:124), the task bulk update
 * (task.ts:632), context/session updates and `POST /api/git/push-stats` — and
 * validation/schemas.ts declares it on seven request bodies. The list originally carried
 * only the camelCase `projectId` because that is the spelling the ONE known defect used.
 * Measured, not remembered: a live probe writing `{"project_id": "<ungranted>"}` reached
 * the controller instead of a 403.
 */
export const PROJECT_SCOPE_SOURCES: readonly ProjectSourceSpec[] = [
  { key: 'query.project_id', location: 'query', name: 'project_id', acceptsUnscopedSentinel: true },
  { key: 'query.project', location: 'query', name: 'project', acceptsUnscopedSentinel: true },
  { key: 'query.projectId', location: 'query', name: 'projectId', acceptsUnscopedSentinel: true },
  { key: 'header.x-project-id', location: 'header', name: 'x-project-id', acceptsUnscopedSentinel: false },
  { key: 'body.projectId', location: 'body', name: 'projectId', acceptsUnscopedSentinel: false },
  { key: 'body.project_id', location: 'body', name: 'project_id', acceptsUnscopedSentinel: false },
];

/** A single project reference found on the request. */
export interface ProjectCandidate {
  readonly sourceKey: string;
  readonly raw: string;
  /** `'project'` → a uuid to authorize. `'unscoped'` → the `all` sentinel. */
  readonly kind: 'project' | 'unscoped';
  /** Normalized (lower-cased) uuid; present only when kind === 'project'. */
  readonly value?: string;
}

/** The resolved, AUTHORIZED scope attached to the request. */
export interface ResolvedProjectScope {
  /** The winning project uuid, or undefined when the request is unscoped. */
  readonly projectId?: string;
  /** True when a source explicitly said `all` (as opposed to naming nothing). */
  readonly explicitlyUnscoped: boolean;
  /** Which source won; undefined when nothing named a project. */
  readonly sourceKey?: string;
  /** Every distinct project uuid on the request — all of them passed authorization. */
  readonly authorizedProjectIds: readonly string[];
}

/** A request carrying a resolved scope. */
export interface ProjectScopedRequestLike {
  projectId?: string;
  projectScope?: ResolvedProjectScope;
}

export interface ScopeFailure {
  readonly status: 400 | 401 | 403 | 500;
  readonly error: string;
  readonly message: string;
  /** Populated for 403/401 logging. */
  readonly sourceKey?: string;
  readonly projectId?: string;
}

export type ExtractResult =
  | { ok: true; candidates: ProjectCandidate[] }
  | { ok: false; failure: ScopeFailure };

/** Minimal shape the extractor needs — deliberately not tied to Express's Request type. */
export interface RequestLike {
  headers?: Record<string, unknown>;
  query?: unknown;
  body?: unknown;
}

function readRawSource(req: RequestLike, spec: ProjectSourceSpec): unknown {
  switch (spec.location) {
    case 'header':
      return req.headers?.[spec.name];
    case 'query': {
      const q = req.query;
      if (!q || typeof q !== 'object' || Array.isArray(q)) return undefined;
      return (q as Record<string, unknown>)[spec.name];
    }
    case 'body': {
      const b = req.body;
      // A body that is not a plain object (array, string, Buffer, null) carries no
      // top-level project field. `Array.isArray` matters: `body[0]` is not `body.projectId`,
      // but a JSON array body would still answer `.projectId` as undefined — cheap to be
      // explicit rather than rely on that.
      if (!b || typeof b !== 'object' || Array.isArray(b)) return undefined;
      return (b as Record<string, unknown>)[spec.name];
    }
  }
}

/**
 * Gather every project reference on the request, in precedence order.
 *
 * SHAPES HANDLED EXPLICITLY (the "what does my check not match?" list):
 *   - `undefined` / `null` / `''` / whitespace-only  → not a candidate (absent, not a deny)
 *   - a repeated param (`?project_id=a&project_id=b`) — Express gives an ARRAY. Every
 *     element is normalized; identical values collapse to one candidate; DISAGREEING
 *     values are a 400, never a silent "first one wins".
 *   - a bracketed param (`?project_id[x]=y`) — Express gives an OBJECT → 400.
 *   - a non-string body value (number, object, array) → 400.
 *   - mixed-case uuids → accepted (Postgres's `uuid` is case-insensitive and so is
 *     utils/uuid.isValidUuid) and lower-cased before authorization, so `AAAA…` and
 *     `aaaa…` cannot be two different grants.
 *   - mixed-case `ALL` / `All` → the sentinel.
 */
export function extractProjectCandidates(req: RequestLike): ExtractResult {
  const candidates: ProjectCandidate[] = [];

  for (const spec of PROJECT_SCOPE_SOURCES) {
    const raw = readRawSource(req, spec);
    if (raw === undefined || raw === null) continue;

    let values: unknown[];
    if (Array.isArray(raw)) {
      values = raw;
    } else {
      values = [raw];
    }

    const normalized: ProjectCandidate[] = [];
    for (const v of values) {
      if (v === undefined || v === null) continue;
      if (typeof v !== 'string') {
        return {
          ok: false,
          failure: {
            status: 400,
            error: 'Invalid project scope',
            message: `'${spec.name}' must be a string project id${
              spec.acceptsUnscopedSentinel ? ` or '${UNSCOPED_SENTINEL}'` : ''
            }`,
            sourceKey: spec.key,
          },
        };
      }
      const trimmed = v.trim();
      if (trimmed === '') continue; // empty is absent, not malformed

      if (spec.acceptsUnscopedSentinel && trimmed.toLowerCase() === UNSCOPED_SENTINEL) {
        normalized.push({ sourceKey: spec.key, raw: trimmed, kind: 'unscoped' });
        continue;
      }

      if (!isValidUuid(trimmed)) {
        return {
          ok: false,
          failure: {
            status: 400,
            error: 'Invalid project ID format',
            message: `'${spec.name}' must be a valid project UUID${
              spec.acceptsUnscopedSentinel ? ` or '${UNSCOPED_SENTINEL}'` : ''
            }`,
            sourceKey: spec.key,
          },
        };
      }
      normalized.push({
        sourceKey: spec.key,
        raw: trimmed,
        kind: 'project',
        value: trimmed.toLowerCase(),
      });
    }

    if (normalized.length === 0) continue;

    // Repeated param: identical values are harmless; disagreeing values are ambiguous
    // and must not resolve to a silent pick.
    const distinct = new Set(
      normalized.map((c) => (c.kind === 'unscoped' ? UNSCOPED_SENTINEL : c.value ?? c.raw))
    );
    if (distinct.size > 1) {
      return {
        ok: false,
        failure: {
          status: 400,
          error: 'Ambiguous project scope',
          message: `'${spec.name}' was supplied more than once with different values`,
          sourceKey: spec.key,
        },
      };
    }
    candidates.push(normalized[0]);
  }

  return { ok: true, candidates };
}

export type ResolveResult =
  | { ok: true; scope: ResolvedProjectScope }
  | { ok: false; failure: ScopeFailure };

/** The caller shape ProjectAccessService authorizes against. */
export interface ScopingCaller {
  id: string;
  role?: string | null;
}

/**
 * Resolve + AUTHORIZE. `resolveCaller` is invoked lazily — only when the request actually
 * names a project — so unscoped requests keep costing zero JWT verifications, which is the
 * pre-existing behaviour of middleware/project.ts.
 *
 * NOTE the authorization is delegated to ProjectAccessService.userHasProjectAccess, the
 * SAME function the header door and the /api/mcp passthrough already call. Two
 * authorization implementations that can disagree is the defect being fixed here; there
 * is deliberately no second copy of the admin/grant/deny logic in this file.
 */
export async function resolveAndAuthorizeProjectScope(
  req: RequestLike,
  resolveCaller: () => Promise<ScopingCaller | null>
): Promise<ResolveResult> {
  const extracted = extractProjectCandidates(req);
  if (!extracted.ok) return { ok: false, failure: extracted.failure };

  const { candidates } = extracted;
  if (candidates.length === 0) {
    return { ok: true, scope: { explicitlyUnscoped: false, authorizedProjectIds: [] } };
  }

  const toAuthorize = Array.from(
    new Set(candidates.flatMap((c) => (c.kind === 'project' && c.value ? [c.value] : [])))
  );

  if (toAuthorize.length > 0) {
    const caller = await resolveCaller();
    if (!caller) {
      return {
        ok: false,
        failure: {
          status: 401,
          error: 'Authentication required',
          message: 'A project-scoped request requires a valid Authorization token',
        },
      };
    }

    for (const projectId of toAuthorize) {
      let allowed: boolean;
      try {
        allowed = await ProjectAccessService.userHasProjectAccess(caller, projectId);
      } catch {
        // C1: "could not measure" gets its own branch and never shares a value with
        // "no" — and most importantly never with "yes".
        return {
          ok: false,
          failure: {
            status: 500,
            error: 'Project access check failed',
            message: 'Internal server error during project authorization',
            projectId,
          },
        };
      }
      if (!allowed) {
        return {
          ok: false,
          failure: {
            status: 403,
            error: 'Project access denied',
            message: 'You do not have access to the requested project',
            projectId,
            sourceKey: candidates.find((c) => c.value === projectId)?.sourceKey,
          },
        };
      }
    }
  }

  const winner = candidates[0];
  return {
    ok: true,
    scope: {
      projectId: winner.kind === 'project' ? winner.value : undefined,
      explicitlyUnscoped: winner.kind === 'unscoped',
      sourceKey: winner.sourceKey,
      authorizedProjectIds: toAuthorize,
    },
  };
}

/**
 * Thrown when a handler asks for the project scope on a request that never passed
 * through projectContextMiddleware. FAIL LOUD (500), never "undefined, carry on":
 * an unresolved scope silently read as "no project" is exactly the ambient-write bug
 * this whole module exists to prevent.
 */
export class ProjectScopeNotResolvedError extends Error {
  constructor() {
    super(
      'Project scope was never resolved for this request. projectContextMiddleware must ' +
        'run before any handler that reads a project scope — mount it, do not read ' +
        'req.query/req.body directly.'
    );
    this.name = 'ProjectScopeNotResolvedError';
  }
}

/**
 * ── THE ONLY SUPPORTED WAY A HANDLER LEARNS ITS PROJECT ───────────────────────────────
 * Returns the AUTHORIZED project uuid, or undefined when the request is unscoped.
 * Controllers must call this instead of reading req.query / req.body / the header; the
 * raw reads are removed and the eslint `no-restricted-syntax` rule in `.eslintrc.js`
 * (ERROR-gated by the CI gate STAGE L) fails the build if one comes back. What that
 * rule does and does not catch is asserted, not described — see the generated fixture
 * grid in `__tests__/projectScopeLintRule.test.ts`.
 */
export function getRequestProjectId(req: ProjectScopedRequestLike): string | undefined {
  const scope = req.projectScope;
  if (!scope) throw new ProjectScopeNotResolvedError();
  return scope.projectId;
}

/** Full resolved scope (needed where `explicitlyUnscoped` vs "absent" matters). */
export function getRequestProjectScope(req: ProjectScopedRequestLike): ResolvedProjectScope {
  const scope = req.projectScope;
  if (!scope) throw new ProjectScopeNotResolvedError();
  return scope;
}

/**
 * Authorize a project id that arrives as a ROUTE PATH PARAM.
 *
 * Use as `router.param('projectId', authorizeProjectPathParam)` on any router whose paths
 * carry a project. It must be registered on a router that has ALREADY authenticated the
 * caller (`router.use(authenticateToken)`), because it authorizes `req.user` — it does not
 * re-implement authentication, and it does not re-implement authorization either: the
 * decision is ProjectAccessService.userHasProjectAccess, the same one the header/query/body
 * doors use.
 *
 * FAIL CLOSED, mirroring the middleware exactly:
 *   malformed uuid → 400 · no caller → 401 · no access → 403 · check THROWS → 500.
 */
export async function authorizeProjectPathParam(
  req: { user?: { id: string; role?: string | null } },
  res: {
    status: (c: number) => { json: (b: unknown) => unknown };
  },
  next: (err?: unknown) => void,
  value: string
): Promise<void> {
  const deny = (status: number, error: string, message: string) => {
    res.status(status).json({ success: false, error, message });
  };

  if (typeof value !== 'string' || !isValidUuid(value.trim())) {
    deny(400, 'Invalid project ID format', 'Project ID must be a valid UUID');
    return;
  }
  const user = req.user;
  if (!user) {
    deny(401, 'Authentication required', 'A project-scoped request requires a valid token');
    return;
  }
  try {
    const allowed = await ProjectAccessService.userHasProjectAccess(
      { id: user.id, role: user.role },
      value.trim().toLowerCase()
    );
    if (!allowed) {
      deny(403, 'Project access denied', 'You do not have access to the requested project');
      return;
    }
  } catch {
    // C1: could-not-measure gets its own branch and never becomes an allow.
    deny(500, 'Project access check failed', 'Internal server error during project authorization');
    return;
  }
  next();
}
