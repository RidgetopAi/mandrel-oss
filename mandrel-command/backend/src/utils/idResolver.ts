/**
 * UNIFIED navigation id resolver (SPINE of branch:mandrel-navigation).
 *
 * THE PROBLEM THIS SOLVES: a human or agent has a bare id — a full UUID or the
 * 8-hex short-id form every Mandrel reference uses (e.g. `2b3c4d5e`) — and wants to
 * navigate to that record WITHOUT already knowing what KIND of record it is. This
 * resolver takes the bare id, discovers its TYPE by looking in every navigable table
 * at once, and returns the canonical record ({type, id, title, url}) so a route can
 * 302-redirect to the frontend detail page.
 *
 * THE TYPE LIST IS DATA, NOT PROSE. The resolver originally hardcoded
 * three types across a hand-written UNION, a hand-written `'a' | 'b' | 'c'` union type,
 * and two hand-written "No decision, task, or context matches" 404 strings in the two
 * routes — five places that had to be edited in lockstep to add a type, which is exactly
 * how the *next* type gets half-added. Sessions and projects are now resolvable and the
 * enumeration lives in ONE place: NAV_ENTITIES below. Everything else — the union type,
 * the SQL, the human "we searched N kinds" message, the tests' population — is derived
 * from it. Adding a sixth type is one entry, not five edits.
 *
 * SINGLE SOURCE OF RESOLUTION LOGIC (fix the class, don't drift N
 * copies): the id-shape primitives (isFullUuid / normalizeShortId) are REUSED from
 * utils/searchPredicates.ts — the backend-side mirror of the Mandrel-core resolver
 * (mcp-server/src/utils/idResolver.ts). We do NOT re-implement them here.
 *
 * WHY NOT PROXY / IMPORT THE MCP-CORE RESOLVER: the same reason searchPredicates.ts
 * documents — mcp-server/src/utils/idResolver.ts lives behind a
 * different tsconfig rootDir, pulls core-only deps (the core pg pool, zod error
 * types), and this backend's `tsc` build rejects the out-of-tree import. Nor is
 * there an MCP REST endpoint to proxy to: the core resolver is a library function
 * that resolves ONE type at a time (it takes the entity as an argument), so a
 * unified cross-type resolve would have to ADD a new endpoint to the mcp-server —
 * expanding the blast radius into another component. So, exactly as the codebase
 * already established for search, we add the ONE piece that is genuinely new — the
 * multi-type UNION resolution — on the backend side, reusing the shared id-shape
 * primitives so nothing drifts.
 *
 * SECURITY (non-negotiable): the user id is NEVER concatenated into SQL. It is
 * shape-validated (hex/uuid only, dash-stripped, length-floored) BEFORE the query
 * and bound as a parameter in a `REPLACE(id::text,'-','') LIKE $1 || '%'` prefix
 * match (identical to searchPredicates / the core resolver). Errors never leak SQL,
 * paths, or secrets — only the id and (for ambiguity) candidate full ids + labels.
 *
 * FOUR-CASE CONTRACT, FAIL-CLOSED (never guesses):
 *   invalid shape   → InvalidNavIdError (route → 400). A non-hex/too-short id is
 *                     rejected up front; it can never resolve to a record. Carries a
 *                     machine-readable `reason` so the user is told WHICH rule they
 *                     broke, not just "invalid".
 *   0 matches       → NavIdNotFoundError (route → 404). Carries the exact population
 *                     that was searched and whether a project scope narrowed it — a
 *                     bare 404 leaves the user unable to tell "no such record" from
 *                     "right record, wrong project".
 *   exactly 1 match → resolved record.
 *   >1 match        → AmbiguousNavIdError listing candidates (route → 409). We
 *                     NEVER pick one; the caller disambiguates with a full id. This
 *                     holds ACROSS types: a session and a task sharing an 8-hex
 *                     prefix is ambiguous, never a coin flip.
 */

import type { Pool } from 'pg';
import { db } from '../database/connection';
import { isFullUuid, normalizeShortId } from './searchPredicates';
import { resolveConfig } from '../config/resolve';
import { ALL_PROJECTS, type ProjectListScope } from '../services/projectListScope';

/**
 * THE SINGLE ENUMERATION of navigable record types. Order is the order candidates are
 * surfaced in an ambiguity list. Everything downstream derives from this array.
 */
export const RESOLVABLE_TYPES = [
  'context',
  'task',
  'decision',
  'session',
  'project',
] as const;

/** The record types the navigation spine resolves. Derived — never hand-written. */
export type ResolvableType = (typeof RESOLVABLE_TYPES)[number];

/**
 * How to find and label one record type. Adding a navigable type means adding ONE
 * entry here — the UNION, the not-found message and the type union all follow.
 */
interface NavEntityConfig {
  /** Physical table. A fixed literal from this map — NEVER user input, never bound. */
  table: string;
  /**
   * The column a `?project_id=` scope filters on.
   *
   * ⚠️ NOT always `project_id`. The `projects` table has NO `project_id` column — a
   * project IS the scope, so it scopes on its own `id`. Blindly appending
   * `AND project_id = $2` to every branch (what the three-table version did, because
   * all three of its tables happened to have that column) makes the projects branch
   * a hard SQL error the moment anyone passes ?project_id — a 500, not a miss.
   * Verified against the migrated schema, not assumed: `\d projects` has no
   * project_id; `\d sessions` has a NULLABLE one.
   */
  projectScopeColumn: string;
  /**
   * SQL expression producing the human-pickable label. `snippetLen` is a config-derived
   * integer (never user input) for the types that have no title of their own.
   */
  label: (snippetLen: number) => string;
  /**
   * SQL boolean expression selecting whether a matched row is a Punch List record
   *. Only `task` can ever be a punch — a task
   * carrying `metadata.punch` renders its evidence on /punch/:id, not /tasks/:id, so
   * urlForRecord needs this bit to route it correctly. Every other type is
   * definitionally never a punch, hence the `FALSE` default below rather than a
   * per-type literal repeated four times.
   */
  isPunchSql?: string;
}

const NAV_ENTITIES: Record<ResolvableType, NavEntityConfig> = {
  // Contexts have no title — label with the context_type + a whitespace-collapsed
  // snippet of the content.
  context: {
    table: 'contexts',
    projectScopeColumn: 'project_id',
    label: (n) => `context_type || ': ' || left(regexp_replace(content, '\\s+', ' ', 'g'), ${n})`,
  },
  // `metadata -> 'punch'` (jsonb, not `->>` text) is SQL NULL exactly when the key is
  // absent — punchMergeSql (mcp-server/src/utils/punchMerge.ts) always jsonb_sets an
  // OBJECT there (starting from '{}'), it never stores a bare JSON null at this key, so
  // presence of the key is an unambiguous "this task carries a punch contract".
  task: {
    table: 'tasks',
    projectScopeColumn: 'project_id',
    label: () => 'title',
    isPunchSql: `(metadata -> 'punch') IS NOT NULL`,
  },
  decision: {
    table: 'technical_decisions',
    projectScopeColumn: 'project_id',
    label: () => 'title',
  },
  // A session's `title` is NULLABLE; `display_id` is NOT NULL + UNIQUE, so it is the
  // guaranteed fallback label. An untitled session must still be pickable in an
  // ambiguity list — a blank label there is an unclickable choice.
  session: {
    table: 'sessions',
    projectScopeColumn: 'project_id',
    label: () => `COALESCE(NULLIF(title, ''), display_id)`,
  },
  // See projectScopeColumn note above: a project scopes on its own id.
  project: { table: 'projects', projectScopeColumn: 'id', label: () => 'name' },
};

/**
 * The searched population as an English list ("context, task, decision, session, or
 * project") for the not-found message. Derived from RESOLVABLE_TYPES so the message
 * can never claim a population the query did not actually search — the exact drift
 * that left two routes saying "No decision, task, or context matches" forever.
 */
export function describeResolvableTypes(
  types: readonly string[] = RESOLVABLE_TYPES,
): string {
  if (types.length === 0) return 'no record type';
  if (types.length === 1) return types[0];
  return `${types.slice(0, -1).join(', ')}, or ${types[types.length - 1]}`;
}

/** A fully-resolved navigation record. */
export interface ResolvedRecord {
  type: ResolvableType;
  /** The full canonical UUID (never a short prefix). */
  id: string;
  /** Human display label: task/decision title, or context_type + snippet. */
  title: string;
  /** The frontend detail-page path to redirect to (e.g. /decisions/<uuid>). */
  url: string;
}

/** A candidate surfaced when a prefix is ambiguous (do NOT silently pick). */
export interface NavIdCandidate {
  type: ResolvableType;
  id: string;
  title: string;
  url: string;
}

/**
 * WHY the id was rejected. A bare "invalid" tells a user nothing actionable; these
 * map to a sentence that names the rule they broke.
 *   empty     — nothing (or only whitespace/dashes) was supplied.
 *   not-hex   — contains characters an id cannot contain.
 *   too-short — valid hex, but below the short-id floor to prefix-match on.
 */
export type InvalidNavIdReason = 'empty' | 'not-hex' | 'too-short';

/** Thrown when the supplied id is malformed (non-hex, or shorter than the floor). */
export class InvalidNavIdError extends Error {
  readonly rawId: string;
  readonly reason: InvalidNavIdReason;
  /** A user-facing sentence explaining exactly what is wrong with this id. */
  readonly detail: string;
  constructor(rawId: string, reason: InvalidNavIdReason) {
    const floor = resolveConfig.shortIdMinLength;
    const detail =
      reason === 'empty'
        ? 'No id was supplied.'
        : reason === 'not-hex'
          ? 'A Mandrel id is hexadecimal (0-9, a-f) with optional dashes; this contains other characters.'
          : `A short id must be at least ${floor} hex characters (the id8 form every Mandrel reference uses); this one is shorter, and a shorter prefix could match many records.`;
    super(`Invalid id "${rawId}" (${reason}): ${detail}`);
    this.name = 'InvalidNavIdError';
    this.rawId = rawId;
    this.reason = reason;
    this.detail = detail;
  }
}

/**
 * Thrown when a well-formed id matches NO record in any navigable table.
 *
 * Carries the population it searched and whether a project scope was applied, so the
 * route can tell the user WHAT was looked for rather than emitting a bare 404. The
 * project-scope half matters: "no such record" and "that record exists, but not in
 * the project you scoped to" are different problems with different fixes, and a bare
 * 404 makes them indistinguishable.
 */
export class NavIdNotFoundError extends Error {
  readonly rawId: string;
  readonly searchedTypes: readonly ResolvableType[];
  readonly projectScoped: boolean;
  /** A user-facing sentence naming the population that was searched. */
  readonly detail: string;
  constructor(
    rawId: string,
    searchedTypes: readonly ResolvableType[] = RESOLVABLE_TYPES,
    projectScoped = false,
  ) {
    const scopeNote = projectScoped
      ? ' within the project you scoped to (the record may exist in another project — retry without ?project_id)'
      : ' in any project';
    const detail = `Searched every ${describeResolvableTypes(searchedTypes)}${scopeNote}. Nothing has an id starting with this.`;
    super(`No record found for id "${rawId}". ${detail}`);
    this.name = 'NavIdNotFoundError';
    this.rawId = rawId;
    this.searchedTypes = searchedTypes;
    this.projectScoped = projectScoped;
    this.detail = detail;
  }
}

/** Thrown when a short-id prefix matches MORE THAN ONE record (across any type). */
export class AmbiguousNavIdError extends Error {
  readonly rawId: string;
  readonly candidates: NavIdCandidate[];
  constructor(rawId: string, candidates: NavIdCandidate[]) {
    super(`Id "${rawId}" is ambiguous (${candidates.length} matches)`);
    this.name = 'AmbiguousNavIdError';
    this.rawId = rawId;
    this.candidates = candidates;
  }
}

/**
 * Build the frontend detail-page path for a resolved record. Matches the frontend
 * detail routes, which are uniformly `type + 's'`: /contexts/:id, /tasks/:id,
 * /decisions/:id, /sessions/:id, /projects/:id — all five verified present in
 * frontend/src/App.tsx, so the pluralization rule holds for the whole population
 * rather than for the three it was written against.
 * Centralized so the redirect target and the candidate urls can never drift.
 *
 * PUNCH ROUTING: a task carrying a punch contract
 * (`metadata.punch`) renders its evidence — the attachment gallery, before-thumbnails —
 * ONLY on the Punch page (frontend/src/pages/punch/PunchDetail.tsx); the Tasks page
 * renders none of it. Before this fix EVERY task, punch or not, resolved to /tasks/:id,
 * so a punch's canonical /r/ link landed on a page that hides the exact evidence it was
 * shared for. `isPunch` is ignored for every type but `task` — only a task can be a
 * punch — so a non-punch task (isPunch=false) is UNCHANGED: it still lands on /tasks/:id.
 */
export function urlForRecord(type: ResolvableType, id: string, isPunch = false): string {
  if (type === 'task' && isPunch) return `/punch/${id}`;
  return `/${type}s/${id}`;
}

/**
 * Classify the id's shape. Returns `null` when it is resolvable, or the REASON it is
 * not — so the caller can tell the user which rule they broke instead of a bare
 * "invalid". A full UUID, OR a pure-hex (dashes allowed, mirroring a pasted partial)
 * prefix of at least the configured floor once dashes are stripped, is resolvable.
 * Anything else is rejected before touching the DB.
 */
export function navIdRejectionReason(rawId: unknown): InvalidNavIdReason | null {
  if (typeof rawId !== 'string') return 'empty';
  const q = rawId.trim();
  if (q === '') return 'empty';
  if (isFullUuid(q)) return null;
  if (!/^[0-9a-f-]+$/i.test(q)) return 'not-hex';
  // Pure hex from here. An all-dashes / empty-after-normalize input is 'empty', not
  // 'too-short' — telling someone "----" is too short would send them hunting for
  // more characters of an id they never pasted.
  const normalized = normalizeShortId(q);
  if (normalized.length === 0) return 'empty';
  return normalized.length >= resolveConfig.shortIdMinLength ? null : 'too-short';
}

/**
 * Is this raw id a shape we will even attempt to resolve? Thin boolean over
 * navIdRejectionReason (ONE shape rule — the two can never disagree).
 */
export function isResolvableNavId(rawId: string): boolean {
  return navIdRejectionReason(rawId) === null;
}

interface ResolveOptions {
  /**
   * The projects this caller may resolve within — REQUIRED, no default.
   *
   * WAS `projectId?: string`, where OMITTING it resolved CROSS-PROJECT. The comment called
   * that "the default for navigation, matching the existing cross-project single-record
   * GET endpoints" — and those endpoints were the defect. Measured: a zero-grant non-admin
   * hitting `/api/resolve/<victim id>` got `200 {"type":"task","title":"task VICTIM…"}`,
   * and `/api/r/<id>` a 302 to `/tasks/<id>`, which discloses that the id exists and what
   * kind of record it is even without a body.
   *
   * Each type filters via its own scope column (see NavEntityConfig.projectScopeColumn:
   * `projects` scopes on its own id, and a session with a NULL project_id is correctly
   * invisible under a scope). ALL_PROJECTS is the explicit word for unrestricted.
   */
  scope: ProjectListScope;
  /** pg pool (defaults to the shared backend pool; injectable for tests). */
  pool?: Pool;
}

/**
 * Resolve a bare id to exactly one record, or throw one of the three fail-closed
 * errors above. NOTE: unlike the core single-type resolver, a full UUID is NOT
 * short-circuited — we must hit the DB even for a full UUID because the TYPE (which
 * detail page to redirect to) is only knowable by finding the row.
 */
/**
 * The row limit for the resolver's UNION query. FLOORED AT 2, independent of the
 * display cap (resolveConfig.maxCandidates): detecting ambiguity (>1 match) is a
 * CORRECTNESS property and must never be coupled to a display-tuning knob. If the
 * cap were ever set to 1, a `LIMIT 1` would return a single row for an ambiguous
 * prefix and silently resolve to a guess — a fail-open. Fetch at least 2 so ">1"
 * is always detectable; the cap only bounds how many candidates we surface beyond that.
 */
export function navQueryLimit(maxCandidates: number): number {
  return Math.max(2, maxCandidates);
}

/**
 * Build the cross-type UNION. Exported for test visibility: the ONLY way to prove the
 * query covers every type in RESOLVABLE_TYPES is to read the SQL it emits, and the
 * only way to prove a project scope is applied per-type-correctly (see the `projects`
 * note on NavEntityConfig.projectScopeColumn) is to read the emitted clauses.
 *
 * SECURITY: `projectScoped` only selects whether a clause referencing $2 is emitted;
 * table names and the scope column come from the fixed NAV_ENTITIES literal. The only
 * values that ever reach SQL are $1 (prefix) and $2 (project id), both BOUND by the
 * caller, plus two integers derived from config (never from a request).
 */
export function buildNavResolveSql(opts: {
  projectScoped: boolean;
  snippetLen: number;
  queryLimit: number;
}): string {
  const idMatch = `REPLACE(id::text, '-', '') LIKE $1 || '%'`;
  const branches = RESOLVABLE_TYPES.map((type) => {
    const cfg = NAV_ENTITIES[type];
    // `= ANY($2::uuid[])` rather than `= $2`: the scope is now a SET (the caller's grants),
    // and an EMPTY set is legitimately empty rather than unrestricted. `projectScoped`
    // false is the explicit ALL_PROJECTS mode, never "the caller passed nothing".
    const scope = opts.projectScoped ? ` AND ${cfg.projectScopeColumn} = ANY($2::uuid[])` : '';
    return `    SELECT id::text AS id, '${type}' AS type, ${cfg.label(opts.snippetLen)} AS title, ${cfg.isPunchSql ?? 'FALSE'} AS is_punch
      FROM ${cfg.table}
      WHERE ${idMatch}${scope}`;
  });
  return `\n${branches.join('\n    UNION ALL\n')}\n    LIMIT ${opts.queryLimit}\n  `;
}

export async function resolveNavId(
  rawId: string,
  opts: ResolveOptions,
): Promise<ResolvedRecord> {
  const rejection = navIdRejectionReason(rawId);
  if (rejection !== null) {
    throw new InvalidNavIdError(rawId, rejection);
  }

  const pool: Pool = opts.pool ?? db;
  const prefix = normalizeShortId(rawId);

  // Parameterized prefix match against the dash-stripped id text, UNION'd across
  // every navigable table so one round-trip tells us the type. $1 is the normalized
  // prefix (BOUND). $2 (optional) is the project scope. A full UUID is just the
  // maximal prefix → exact match.
  const projectScoped = opts.scope.mode !== ALL_PROJECTS;
  const params: unknown[] = [prefix];
  if (projectScoped && opts.scope.mode !== ALL_PROJECTS) params.push([...opts.scope.projectIds]);

  const sql = buildNavResolveSql({
    projectScoped,
    snippetLen: resolveConfig.contextLabelSnippetLength,
    queryLimit: navQueryLimit(resolveConfig.maxCandidates),
  });

  const result = await pool.query(sql, params);
  const rows = result.rows as Array<{
    id: string;
    type: ResolvableType;
    title: string;
    is_punch: boolean;
  }>;

  if (rows.length === 0) {
    throw new NavIdNotFoundError(rawId, RESOLVABLE_TYPES, projectScoped);
  }
  if (rows.length === 1) {
    const r = rows[0];
    return { type: r.type, id: r.id, title: r.title, url: urlForRecord(r.type, r.id, r.is_punch) };
  }

  // >1 → ambiguous. Surface every candidate (full id + label + url); NEVER pick one.
  const candidates: NavIdCandidate[] = rows.map((r) => ({
    type: r.type,
    id: r.id,
    title: r.title,
    url: urlForRecord(r.type, r.id, r.is_punch),
  }));
  throw new AmbiguousNavIdError(rawId, candidates);
}
