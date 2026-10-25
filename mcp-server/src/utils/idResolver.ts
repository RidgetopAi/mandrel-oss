/**
 * SHORT-ID RESOLUTION.
 *
 * THE CLASS THIS FIXES: every tool's output DISPLAYS the full UUID, but agents and
 * humans routinely reference a record by its leading 8-hex-char prefix (the "short id"
 * — the form Mandrel task/decision references use, e.g. `2b3c4d5e`). The id-taking
 * mutate/detail tools (task_update, task_details, decision_update, decision_get) used
 * to require a full UUID and reject that prefix, so a tool-only agent literally could
 * not resolve a short id → full UUID through the public tool surface. This module
 * resolves a short id to its full UUID SERVER-SIDE, scoped to the current project where
 * the table is project-scoped (so a prefix is far less likely to collide and we never
 * resolve across tenants/projects).
 *
 * SECURITY (non-negotiable): the user input is NEVER string-concatenated into SQL. The
 * prefix match binds the input as a PARAMETER (`WHERE id::text LIKE $1 || '%'` with $1
 * bound) and the input is shape-validated (hex/uuid only) at the zod layer before it
 * ever reaches here. The actionable errors below never leak SQL, paths, or secrets —
 * only the field/id and (for ambiguity) the candidate full ids + a human-pickable label.
 *
 * THREE-CASE CONTRACT (see resolveShortId):
 *   exactly 1 match → return the full id.
 *   0 matches       → throw IdNotFoundError (actionable not-found).
 *   >1 match        → throw AmbiguousIdError listing the candidate full ids (NEVER pick).
 *
 * Full UUIDs short-circuit: a syntactically full UUID is returned as-is (back-compat,
 * canonical form) WITHOUT a DB round-trip — existence is enforced downstream exactly as
 * it was before this change.
 */

import type { Pool } from 'pg';
import { db } from '../config/database.js';
import {
  SEARCH_ID_PREFIX_MIN_LENGTH,
  SEARCH_ID_MAX_CANDIDATES,
  SEARCH_ID_MAX_QUERY_TOKENS,
  RESERVED_QUERY_PREFIXES_EFFECTIVE,
  type ReservedPrefixRemedy,
} from '../config/searchConfig.js';

/**
 * Minimum length of a short id we will resolve. A UUID's leading hex is highly
 * collision-resistant at 8 chars (32 bits of prefix entropy) AND scoping to a single
 * project shrinks the candidate set to that project's rows — together this makes an
 * accidental collision vanishingly unlikely while still accepting the 8-char form every
 * tool reference uses. Shorter prefixes (which WOULD collide) are rejected at the zod
 * layer, never reaching the resolver.
 */
export const MIN_SHORT_ID_LENGTH = 8;

/** Full canonical UUID (8-4-4-4-12 hex). */
const FULL_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True when the value is a syntactically complete canonical UUID. */
export function isFullUuid(value: string): boolean {
  return FULL_UUID_RE.test(value);
}

/**
 * True when the value is acceptable as an id field: a full UUID OR an 8+-hex short id
 * (hyphens allowed, mirroring a copied UUID prefix). Non-hex garbage is false. This is
 * the predicate the zod refinement uses so the SHAPE is validated even though the field
 * is no longer full-uuid-only.
 */
export function isUuidOrShortId(value: string): boolean {
  if (typeof value !== 'string') return false;
  if (isFullUuid(value)) return true;
  // Strip hyphens for the length/hex check so `2b3c4d5e` and `13-1e-f0-54...` both pass,
  // but reject anything containing a non-hex char.
  const hexOnly = value.replace(/-/g, '');
  return hexOnly.length >= MIN_SHORT_ID_LENGTH && /^[0-9a-f]+$/i.test(hexOnly);
}

/**
 * Normalize a short id for the prefix match: lower-case, strip hyphens.
 *
 * EXPORTED so the SEARCH id-prefix predicate reuses the SAME
 * normalization the resolver uses (no second, drifting copy). A user
 * pasting a dashed partial (`0f39f00d-db79`) and a bare hex prefix (`0f39f00ddb79`)
 * must normalize identically on BOTH the resolve path and the search path.
 */
export function normalizeShortId(value: string): string {
  return value.replace(/-/g, '').toLowerCase();
}

/** A candidate row surfaced when a short-id prefix is ambiguous. */
export interface IdCandidate {
  id: string;
  /** A human-pickable label (task title / decision title+type) so the caller can choose. */
  label: string;
}

/** Thrown when a short-id prefix matches MORE THAN ONE row (do NOT silently pick). */
export class AmbiguousIdError extends Error {
  readonly candidates: IdCandidate[];
  readonly shortId: string;
  constructor(shortId: string, candidates: IdCandidate[]) {
    super(`Short id "${shortId}" is ambiguous (${candidates.length} matches)`);
    this.name = 'AmbiguousIdError';
    this.shortId = shortId;
    this.candidates = candidates;
  }
}

/**
 * Thrown when a short-id prefix matches NO row — OR when it is not a well-formed short id at
 * all (too short / non-hex). `reason` distinguishes the two: "matched no record" and "isn't a
 * usable id" are different problems and deserve different remedies in the surfaced message.
 */
export class IdNotFoundError extends Error {
  readonly shortId: string;
  /** Present when the id was REJECTED ON SHAPE rather than simply not found. */
  readonly reason?: string;
  constructor(shortId: string, reason?: string) {
    super(reason ? `Invalid id "${shortId}": ${reason}` : `Short id "${shortId}" matched no record`);
    this.name = 'IdNotFoundError';
    this.shortId = shortId;
    this.reason = reason;
  }
}

/** What kind of record we're resolving — selects the table + label columns. */
export type ResolvableEntity = 'task' | 'decision' | 'context' | 'session';

interface EntityConfig {
  table: string;
  /** Build the human label for an ambiguity candidate row. */
  label: (row: any) => string;
  /** Extra SELECT columns needed to build the label. */
  labelColumns: string[];
}

const ENTITY_CONFIG: Record<ResolvableEntity, EntityConfig> = {
  task: {
    table: 'tasks',
    labelColumns: ['title', 'status', 'type'],
    label: (r) => `"${r.title}" (${r.type}/${r.status})`,
  },
  decision: {
    table: 'technical_decisions',
    labelColumns: ['title', 'decision_type'],
    label: (r) => `"${r.title}" (${r.decision_type})`,
  },
  // SESSION IDENTITY (Amp-orb eval W3): sessions are referenced by their
  // 8-hex short form everywhere Mandrel ids appear, so session_get accepts one — resolved by
  // the SAME parameterized, project-scoped, ambiguity-refusing resolver every other entity
  // uses. A second short-id implementation for sessions is exactly the drift this module
  // exists to prevent.
  session: {
    table: 'sessions',
    labelColumns: ['actor', 'started_at'],
    label: (r) => `actor ${r.actor ?? 'NOT RECORDED'} · started ${r.started_at}`,
  },
  context: {
    table: 'contexts',
    // Contexts have no title — use the context_type + a short content snippet so an
    // ambiguity candidate is still human-pickable.
    labelColumns: ['context_type', 'content'],
    label: (r) =>
      `${r.context_type}: "${String(r.content ?? '').replace(/\s+/g, ' ').slice(0, 60)}…"`,
  },
};

/**
 * Resolve an id field to a full UUID.
 *
 *  - Full UUID input → returned unchanged (no DB round-trip; existence enforced
 *    downstream exactly as before).
 *  - Short id input  → parameterized prefix match (`id::text LIKE $1 || '%'`), scoped to
 *    `projectId` when provided (project-scoped tables), yielding the three-case contract.
 *
 * @param entity     which table to resolve against
 * @param rawId      the user-provided id (already zod shape-validated)
 * @param projectId  scope the prefix match to this project (recommended for project-
 *                   scoped tables); omit to resolve across all rows (e.g. decision_get,
 *                   which is intentionally cross-project)
 * @param pool       pg pool (defaults to the shared db; injectable for tests)
 */
export async function resolveEntityId(
  entity: ResolvableEntity,
  rawId: string,
  projectId?: string,
  pool: Pool = db,
): Promise<string> {
  // Full UUID: canonical form, pass straight through (back-compat).
  if (isFullUuid(rawId)) return rawId;

  // ── SHAPE FLOOR AT THE CHOKE POINT (the reviewer follow-up) ──────────────
  // This check used to live ONLY in the zod layer (isUuidOrShortId), so every ROUTE argument
  // was validated but this resolver — which EVERY path funnels through — enforced nothing.
  // The tag path never touches zod: autoMintFromTags reads raw strings out of `tags` and
  // hands the part after `task:` straight here. Two things got through:
  //
  //   * TOO SHORT — `task:a` resolves by prefix; in a small project a 1-char prefix matches
  //     exactly one row and mints a REAL edge to an essentially arbitrary record.
  //   * LIKE WILDCARDS — the prefix is a BOUND parameter (never concatenated, so no SQL
  //     injection) but `_` and `%` are LIKE metacharacters. `task:________` clears any length
  //     floor and matches ANY row. A length-only fix leaves this open, which is exactly the
  //     partial-fix shape we keep getting bitten by — hence the SHAPE check, not a length one.
  //
  // REUSES isUuidOrShortId — the SAME predicate the zod layer applies — rather than
  // re-deriving the rule here (one definition; two copies drift). Enforcing it at
  // the choke point means every caller inherits it and no future call site can forget it.
  if (!isUuidOrShortId(rawId)) {
    throw new IdNotFoundError(
      rawId,
      `a short id must be at least ${MIN_SHORT_ID_LENGTH} hexadecimal characters ` +
        '(0-9 a-f, hyphens allowed) — this is not a usable id, so nothing was resolved',
    );
  }

  const cfg = ENTITY_CONFIG[entity];
  const shortId = normalizeShortId(rawId);

  // Parameterized prefix match. $1 is BOUND (never concatenated). LIKE '<prefix>%' on the
  // text form of the uuid. Scope to project when given. Cap the result set so an absurd
  // prefix can't pull unbounded rows; >1 already means ambiguous.
  const params: any[] = [shortId];
  let sql =
    `SELECT id::text AS id, ${cfg.labelColumns.join(', ')} ` +
    `FROM ${cfg.table} WHERE id::text LIKE $1 || '%'`;
  if (projectId) {
    params.push(projectId);
    sql += ` AND project_id = $${params.length}`;
  }
  sql += ` LIMIT 25`;

  const result = await pool.query(sql, params);

  if (result.rows.length === 0) {
    throw new IdNotFoundError(rawId);
  }
  if (result.rows.length === 1) {
    return result.rows[0].id;
  }
  // >1 → ambiguous. Surface the candidate FULL ids + labels; never pick one.
  const candidates: IdCandidate[] = result.rows.map((r) => ({
    id: r.id,
    label: cfg.label(r),
  }));
  throw new AmbiguousIdError(rawId, candidates);
}

/**
 * STRICT endpoint resolution for a path that is about to MINT A GRAPH EDGE.
 *
 * THE CLASS THIS CLOSES. {@link resolveEntityId} short-circuits a syntactically valid full
 * UUID straight through with NO existence check and NO project check — "existence enforced
 * downstream". For the id-taking MUTATE tools that is true (the UPDATE simply matches no
 * row). For the EDGE-MINTING paths it is NOT: `links` has no FK backstop (its endpoints
 * span three tables), so an unchecked id is written verbatim as an edge endpoint. The
 * resolver therefore VALIDATES THE FORMAT YOU'RE LIKELY TO TYPE (an id8 — existence- and
 * project-checked) and WAVES THROUGH THE FORMAT YOU'D PASTE (a full UUID), producing:
 *
 *   (a) DANGLING EDGES — a typo'd/pasted UUID mints an edge to a nonexistent node. getLinks
 *       hydrates it with a null title instead of failing, so it stays invisible.
 *   (b) CROSS-PROJECT EDGES — a full UUID from another project mints an edge that bypasses
 *       the project scoping every short id is subject to.
 *
 * This function is the ONE definition both formats now pass through (centralize,
 * don't grow N drifting copies). A full UUID gets an indexed primary-key existence check,
 * project-scoped when `projectId` is supplied; a short id delegates to resolveEntityId,
 * which already enforces both. Failure is the SAME {@link IdNotFoundError} the short-id path
 * throws, so every caller's existing error handling (idErrorResponse) works unchanged.
 *
 * DELIBERATELY NOT APPLIED to the READ/REPAIR path (LinksRoutes.resolveAnyEndpoint, used by
 * `unlink` and `get_links`). Those mint nothing, and guarding them would make every
 * already-dangling edge permanently UNREMOVABLE — walling off the one sanctioned remedy for
 * exactly the rows this guard exists to stop creating. See mintEndpointGuard.contract.test.ts,
 * which pins that decision.
 *
 * @param entity     which table the endpoint must exist in
 * @param rawId      full UUID or id8 short id (already zod shape-validated)
 * @param projectId  scope the check to this project (STRONGLY recommended on mint paths)
 * @param pool       pg pool (defaults to the shared db; injectable for tests)
 * @throws IdNotFoundError   the id matches no row (or no row in this project)
 * @throws AmbiguousIdError  a short-id prefix matched more than one row
 */
export async function resolveMintEndpoint(
  entity: ResolvableEntity,
  rawId: string,
  projectId?: string,
  pool: Pool = db,
): Promise<string> {
  if (!isFullUuid(rawId)) {
    // Short id: resolveEntityId already does existence + project scoping + the
    // three-case contract. Nothing to add — delegate rather than duplicate.
    return resolveEntityId(entity, rawId, projectId, pool);
  }

  // Full UUID: the case that used to pass through unchecked. Indexed PK lookup, scoped to
  // the project when one is supplied. $1/$2 are BOUND (never concatenated); `entity` selects
  // a fixed table name from ENTITY_CONFIG and is never user input.
  const cfg = ENTITY_CONFIG[entity];
  const params: any[] = [rawId];
  let sql = `SELECT id::text AS id FROM ${cfg.table} WHERE id = $1`;
  if (projectId) {
    params.push(projectId);
    sql += ` AND project_id = $${params.length}`;
  }
  const result = await pool.query(sql, params);

  if (result.rows.length === 0) {
    // Same error the short-id miss throws — a caller cannot tell (or need to tell) which
    // FORM of id missed, only that it resolves to nothing mintable here.
    throw new IdNotFoundError(rawId);
  }
  return result.rows[0].id;
}

/** One row a referent matched OUTSIDE the caller's project scope. */
export interface CrossProjectHit {
  /** The full uuid of the matched record. */
  id: string;
  /** The project the record actually lives in. */
  projectId: string;
  /** That project's name (for the human message); null if the row is unreadable. */
  projectName: string | null;
}

/**
 * PROBE for a referent OUTSIDE the caller's project scope — DIAGNOSIS ONLY for a short id,
 * and the resolution step for a full UUID (see resolveRefSafe in services/links.ts).
 *
 * WHY THIS EXISTS. A tag like `task:<id8>` naming a record in a SIBLING project resolves to
 * nothing and mints no edge. That is CORRECT — an 8-char prefix is not unique across
 * projects, and resolving it cross-project would mint an edge to whichever row happened to
 * match, which is the exact wrong-edge failure the mint guard exists to stop. But the
 * message the writer got — "not found in this project" — sent them hunting for a record that
 * exists and is fine, and never mentioned the one thing that would work. This probe supplies
 * the missing half of the sentence: WHERE it actually lives, and what to pass instead.
 *
 * It NEVER resolves a short id cross-project. It returns hits; the caller decides, and the
 * caller only accepts a hit when the referent was a full UUID (unambiguous by construction).
 *
 * Best-effort by contract: any failure returns [] rather than throwing, because its only job
 * is to enrich a message on a path that must never break the user's write.
 */
export async function probeCrossProject(
  entity: ResolvableEntity,
  rawId: string,
  pool: Pool = db,
): Promise<CrossProjectHit[]> {
  try {
    if (!isFullUuid(rawId) && !isUuidOrShortId(rawId)) return [];
    const cfg = ENTITY_CONFIG[entity];
    // `entity` selects a fixed table name from ENTITY_CONFIG and is never user input; $1 is
    // BOUND. LEFT JOIN so a row whose project is missing still reports its id.
    const where = isFullUuid(rawId) ? `e.id = $1` : `e.id::text LIKE $1 || '%'`;
    const param = isFullUuid(rawId) ? rawId.toLowerCase() : normalizeShortId(rawId);
    const result = await pool.query(
      `SELECT e.id::text AS id, e.project_id::text AS project_id, p.name AS project_name
         FROM ${cfg.table} e LEFT JOIN projects p ON p.id = e.project_id
        WHERE ${where} LIMIT 25`,
      [param],
    );
    return result.rows.map((r) => ({
      id: r.id,
      projectId: r.project_id,
      projectName: r.project_name ?? null,
    }));
  } catch {
    return [];
  }
}

/**
 * Render an AmbiguousIdError into an actionable, user-facing message: the candidate FULL
 * ids + labels, and an instruction to re-call with the full id. Safe (no SQL/paths).
 */
export function ambiguousIdMessage(err: AmbiguousIdError, toolName: string): string {
  const list = err.candidates
    .map((c, i) => `   ${i + 1}. ${c.id}  — ${c.label}`)
    .join('\n');
  return (
    `❌ Ambiguous short id: "${err.shortId}" matches ${err.candidates.length} records.\n\n` +
    `${list}\n\n` +
    `💡 Re-run ${toolName} with the FULL id of the one you mean (copy it from the list above).`
  );
}

/**
 * CENTRALIZED short-id error → McpResponse. The delete/restore routes
 * all need the SAME two branches the existing mutate routes hand-roll (Ambiguous → list
 * candidates, no mutation; NotFound → actionable not-found pointing at the find tool).
 * Factoring it here means the soft-delete tools can't drift from the established
 * actionable-error contract (one definition, not N copies). Returns an
 * McpResponse to return, or `null` if `err` is neither id-error (caller rethrows).
 *
 * @param err       the thrown error
 * @param toolName  the tool name (for the ambiguous-message re-run hint)
 * @param entity    human label for the not-found message ('task'|'decision'|'context')
 * @param rawId     the user-supplied id (echoed in not-found)
 * @param findTool  the tool that lists ids (pointed at in not-found, e.g. 'task_list')
 */
export function idErrorResponse(
  err: unknown,
  toolName: string,
  entity: string,
  rawId: string,
  findTool: string,
): any | null {
  if (err instanceof AmbiguousIdError) {
    return {
      content: [{ type: 'text', text: ambiguousIdMessage(err, toolName) }],
      isError: true,
      structuredContent: { ok: false, ambiguous: true, candidates: err.candidates.map((c) => c.id) },
    };
  }
  if (err instanceof IdNotFoundError) {
    const cap = entity.charAt(0).toUpperCase() + entity.slice(1);
    // A SHAPE rejection is a different problem from a miss: the id was never usable, so
    // "the id may be wrong, go look it up" is the wrong advice. Say which it was.
    const text = err.reason
      ? `❌ Invalid ${entity} id: ${rawId}\n\n` +
        `   ${err.reason}\n\n` +
        `💡 Use ${findTool} to find the ${entity} and copy its full 🆔 ID.`
      : `❌ ${cap} not found: ${rawId}\n\n` +
        `💡 The id may be wrong. Use ${findTool} to find the ${entity} and copy its 🆔 ID.`;
    return {
      content: [{ type: 'text', text }],
      isError: true,
      structuredContent: { ok: false, found: false, ...(err.reason ? { invalidId: true } : {}) },
    };
  }
  return null;
}

/**
 * SEARCH id-prefix + partial-tag matching (an earlier task — the part-2 class-fix).
 *
 * THE CLASS THIS FIXES: a search box (the Command UI Decisions view → decision_search,
 * and the MCP tool itself) sends the typed text as the free-text `query`. Before this,
 * a query that is a bare id (full UUID or hex prefix) matched nothing — search only
 * looked at prose — and a partial tag like `ref:` missed because tag filtering used an
 * EXACT `tags && [..]` / `= ANY` match. This helper builds the additive predicate that
 * makes a bare-id query reach the EXACT record and a partial tag match by substring.
 *
 * It is the SEARCH sibling of resolveEntityId: same id contract (full UUID short-circuit;
 * else a PARAMETERIZED prefix match against the dash-stripped `id::text`), same
 * normalization (normalizeShortId, reused — not re-implemented), same floor/cap config
 * (config/searchConfig). The difference: search ADMITS many matches and returns a result
 * set; the resolver demands exactly one. There is no second id-resolver here — this reuses
 * the in-package primitives (centralize, don't drift N copies).
 *
 * SECURITY: every value is a BOUND parameter. The id prefix and the tag substring are
 * pushed as params ($n); nothing is concatenated into SQL. LIKE metacharacters can't be
 * injected via the id path (the prefix is normalized to hex only); the tag substring is a
 * plain ILIKE pattern with its own bound value.
 */

/** A hex id-prefix the user typed: hex + optional dashes (a pasted partial UUID). */
const HEX_PREFIX_RE = /^[0-9a-f-]+$/i;

/**
 * Does this query look like an id-prefix lookup (full UUID, or a long-enough hex prefix)?
 * Length is measured on the DASH-STRIPPED hex so a dashed partial is judged by its real
 * hex length against SEARCH_ID_PREFIX_MIN_LENGTH.
 */
export function queryLooksLikeId(query: string): boolean {
  const q = query.trim();
  if (isFullUuid(q)) return true;
  if (!HEX_PREFIX_RE.test(q)) return false;
  return normalizeShortId(q).length >= SEARCH_ID_PREFIX_MIN_LENGTH;
}

/**
 * EXTRACT the id-shaped TOKENS from a free-text query.
 *
 * THE CLASS THIS FIXES. {@link queryLooksLikeId} judges the WHOLE query, so the id-lookup arm
 * fired only when the caller typed an identifier AND NOTHING ELSE. Measured on live prod
 * 2026-08-22 (retrieval baseline, arm `prod-http`, limit 5): the bare id8 came back at rank 1
 * with score 1.2699, and the SAME id inside the sentence a person actually types — "what is
 * decision <id8> about" — did not appear in the top five at all. One surrounding word
 * discarded an exact identifier the caller obviously meant.
 *
 * So the id path is not made cleverer; it is simply asked of each TOKEN instead of the whole
 * string. There is no sentence parsing and no special case for the question form — a token
 * either is an id or it is not, judged by the SAME predicate the whole-query gate used
 * (isFullUuid / the SEARCH_ID_PREFIX_MIN_LENGTH floor over the dash-stripped hex).
 *
 * TOKENIZATION: maximal runs of [0-9a-f-]. Everything that can separate an id from
 * surrounding text — a space, a colon, a comma, a bracket, a full stop — is a non-hex
 * character, so `task:<id8>`, `(<id8>)` and `<id8>,` all yield the bare id. A pasted UUID
 * survives whole because `-` is inside the run.
 *
 * WHAT THIS DELIBERATELY DOES NOT PROMISE: that only "real" ids are extracted. An 8-digit
 * number and a date (`2026-08-27` → `20260827`) are id-shaped, and always were — the
 * whole-query gate accepted them too (see the "ID-SHAPED IS WIDER THAN IT SOUNDS" note in
 * handlers/context.ts). That is bounded rather than narrow: the arm is ADDITIVE — it can only
 * admit and boost rows whose id actually starts with the token — so a token that matches
 * nothing changes no result.
 *
 * Deduplicated (a repeated id must not emit two identical predicates) and capped at
 * SEARCH_ID_MAX_QUERY_TOKENS, which is the bound that replaces the one-per-query bound the
 * whole-query gate provided for free. Order is first-seen, so the cap keeps the tokens the
 * caller typed first.
 */
export function extractIdTokens(query: string | undefined): string[] {
  const q = (query ?? '').trim();
  if (!q || q === '*') return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of q.match(/[0-9a-f-]+/gi) ?? []) {
    const token = raw.toLowerCase();
    // The SAME judgement the whole-query gate makes — a full uuid, or a long-enough
    // dash-stripped hex prefix. Reused, not re-derived.
    if (!queryLooksLikeId(token)) continue;
    const key = normalizeShortId(token);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(token);
    if (out.length >= SEARCH_ID_MAX_QUERY_TOKENS) break;
  }
  return out;
}

/**
 * RESERVED ARG-NAME PREFIX in a free-text query — the fail-loud guard.
 *
 * `query: 'id:<uuid>'` is the single most damaging way to call search: `queryLooksLikeId`
 * rejects it (the `:` is not in HEX_PREFIX_RE), so the id-prefix arm never fires and the
 * caller silently gets semantic noise ranked as if it were an answer. These names are real
 * PARAMETERS of the search tools, so a `name:value` query is unambiguously a mistake.
 *
 * TOOL-SCOPED ON PURPOSE — the reserved set AND the remedy differ per tool (context_search
 * has an `id` parameter; decision_search and smart_search do not, and want the bare token
 * instead). `toolName` is REQUIRED, with no default: a default would silently apply one
 * tool's rules — and one tool's possibly-WRONG remedy — to a new call site. An unknown tool
 * is simply unguarded (returns null), never guessed at.
 *
 * MATCHING IS DELIBERATELY NARROW — anchored at the start AND requiring the remainder to be
 * a single whitespace-free token. That is what keeps ordinary prose out of the guard: a
 * genuine search for `type: what does this field mean` has spaces in the value and is NOT
 * caught, while the actual misuse shape (`id:3c4d5e6f`, `tags:["ref:x"]`) always is. A false
 * positive here would block a legitimate search, so the guard errs toward silence.
 *
 * Tag-grammar prefixes (`ref:`, `task:`, `decision:`, …) are NOT reservable on ANY tool —
 * they resolve real tags via the partial-tag substring arm and must keep working (see
 * config/searchConfig.SEARCH_PROTECTED_TAG_GRAMMAR_PREFIXES).
 *
 * @returns the reserved arg name AS CONFIGURED if the query is that misuse, else null.
 */
export function reservedArgPrefixInQuery(
  query: string | undefined,
  toolName: string,
): string | null {
  if (!query) return null;
  const table = RESERVED_QUERY_PREFIXES_EFFECTIVE[toolName];
  if (!table) return null; // tool not guarded — never guess another tool's rules
  const q = query.trim();
  for (const name of Object.keys(table)) {
    if (matchesReservedPrefix(q, name)) return name;
  }
  return null;
}

/**
 * Does `q` have the shape `<name>:<single whitespace-free token>`? Case-insensitive on the
 * NAME, which is compared LITERALLY.
 *
 * NO REGEX IS BUILT FROM `name` (the reviewer REJECT). The previous version
 * interpolated the name into `new RegExp(...)` unescaped, so an env-supplied metacharacter
 * name (`'[a-z]+'`) matched as a PATTERN and reserved `ref:` — breaking the boot ritual the
 * literal-string protection was supposed to guarantee — while a malformed one (`'['`) threw
 * a SyntaxError per request. config/searchConfig.ts now validates the name SHAPE at module
 * load (the primary fix); this literal matcher is the second layer, so the guard is correct
 * even if a future caller feeds it an unvalidated name.
 *
 * EXPORTED so the contract test can pin that second layer directly — the config gate throws
 * before an invalid name could ever reach here through the public API, which would otherwise
 * make this layer untestable (and therefore unproven).
 */
export function matchesReservedPrefix(q: string, name: string): boolean {
  if (q.length <= name.length) return false;
  if (q.slice(0, name.length).toLowerCase() !== name.toLowerCase()) return false;
  const afterName = q.slice(name.length).trimStart();
  if (!afterName.startsWith(':')) return false;
  const value = afterName.slice(1).trimStart();
  // Non-empty AND a single token — prose like `type: what does this mean` is NOT the misuse
  // shape and must stay a search.
  return value.length > 0 && !/\s/.test(value);
}

/** Render one remedy as the concrete thing the caller should do instead. */
function remedyText(remedy: ReservedPrefixRemedy, name: string, value: string): string {
  switch (remedy.kind) {
    case 'parameter':
      // tags-shaped parameters take an array; the rest are scalars.
      return remedy.param === 'tags' || remedy.param === 'includeTypes'
        ? `Pass it as the \`${remedy.param}\` parameter instead (and leave \`query\` unset):\n` +
          `       ${remedy.param} = ["${value}"]`
        : `Pass it as the \`${remedy.param}\` parameter instead (and leave \`query\` unset):\n` +
          `       ${remedy.param} = "${value}"`;
    case 'bare-token':
      // This tool has no such parameter, but its query DOES match a bare token.
      return `This tool has no \`${name}\` parameter — but a BARE token in \`query\` is ` +
        `matched directly. Drop the prefix:\n       query = "${value}"`;
    case 'generic':
    default:
      return `Use this tool's \`${name}\` parameter rather than putting it in \`query\`.`;
  }
}

/**
 * The loud, actionable error for a reserved-prefix query. Names the CORRECT form for THAT
 * tool and states plainly that there is no query DSL, so the caller learns the real contract
 * instead of re-typing a variant of the same mistake.
 *
 * Phrasing is deliberately SURFACE-NEUTRAL (it names the parameter, never a `tool arg:value`
 * string) so it reads correctly on BOTH the flat surface and the gateway — and so it can
 * never itself teach the misread it exists to catch.
 */
export function reservedArgPrefixMessage(
  name: string,
  query: string,
  toolName: string,
): string {
  const q = query.trim();
  const value = q.slice(q.indexOf(':') + 1).trim();
  const remedy = RESERVED_QUERY_PREFIXES_EFFECTIVE[toolName]?.[name] ?? { kind: 'generic' as const };
  const reserved = Object.keys(RESERVED_QUERY_PREFIXES_EFFECTIVE[toolName] ?? {});
  return (
    `❌ Invalid search query: "${q}"\n\n` +
    `\`${name}\` is a PARAMETER of this search tool — it is not query syntax. There is no ` +
    `key:value query language; \`query\` is matched as free text, so this would have searched ` +
    `for the literal string "${q}" and returned unrelated results.\n\n` +
    `💡 ${remedyText(remedy, name, value)}\n\n` +
    `Note: tag lookups like \`ref:resume\` or \`task:<id8>\` ARE valid free-text queries — ` +
    `only real parameter names (${reserved.join(', ')}) are rejected here.`
  );
}

/**
 * Is this query a bare hex PREFIX (not a full UUID) long enough to be an id-lookup? Such a
 * query is "ambiguous" by nature (it can match many ids) so callers cap its page at
 * SEARCH_ID_MAX_CANDIDATES via capSearchLimit.
 */
export function queryIsAmbiguousIdPrefix(query: string): boolean {
  const q = query.trim();
  return (
    !isFullUuid(q) &&
    HEX_PREFIX_RE.test(q) &&
    normalizeShortId(q).length >= SEARCH_ID_PREFIX_MIN_LENGTH
  );
}

/**
 * Cap the effective page limit for an ambiguous id-prefix query so an absurdly short
 * prefix can never pull unbounded rows. Non-id-prefix queries keep the requested limit.
 */
export function capSearchLimit(query: string | undefined, requestedLimit: number): number {
  if (query && queryIsAmbiguousIdPrefix(query)) {
    return Math.min(requestedLimit, SEARCH_ID_MAX_CANDIDATES);
  }
  return requestedLimit;
}

/** A built OR-predicate fragment + its bound params + the next free $n index. */
export interface SearchMatchClause {
  /** SQL fragment, parenthesized, WITHOUT a leading AND/OR — e.g. "(a OR b)". */
  sql: string;
  /** Parameters to push in order, matching the $n placeholders in `sql`. */
  params: any[];
  /** Next free $n parameter index after this clause's placeholders. */
  nextParamIndex: number;
}

export interface BuildSearchMatchOptions {
  /** The row id column expression (e.g. "id"). */
  idColumn: string;
  /** The text[] tags column expression (e.g. "tags"). */
  tagsColumn: string;
}

/**
 * Build the ADDITIVE id-prefix + partial-tag OR-predicate for a free-text `query`.
 *
 * Returns null when the query is empty / a wildcard (`*`) — the caller keeps its existing
 * behavior untouched (no regression). Otherwise returns an OR of:
 *   - id-lookup (ONLY when queryLooksLikeId): parameterized prefix match against the
 *     dash-stripped `id::text` — `REPLACE(<id>::text,'-','') LIKE $n || '%'`, $n bound to
 *     the normalized prefix. A full UUID is just the maximal prefix → exact match.
 *   - partial-tag: case-insensitive SUBSTRING against any element of the tags[] array.
 *
 * @param query       the raw user search string
 * @param startIndex  the next free $n parameter index in the caller's query
 * @param opts        column wiring
 */
export function buildSearchMatchPredicate(
  query: string | undefined,
  startIndex: number,
  opts: BuildSearchMatchOptions,
): SearchMatchClause | null {
  const q = (query ?? '').trim();
  if (!q || q === '*') return null;

  const ors: string[] = [];
  const params: any[] = [];
  let i = startIndex;

  // id-lookup — one parameterized prefix match per id-shaped TOKEN in the query. $n is
  // BOUND, never concatenated, exactly as in resolveEntityId.
  //
  // PER TOKEN, NOT PER QUERY. This used to be `if (queryLooksLikeId(q))`,
  // testing the WHOLE query — so `<id8>` fired the arm and `what is decision <id8> about`
  // did not, and an exact identifier the caller obviously meant was discarded by one
  // surrounding word (measured on prod 2026-08-22, rows X16/X17). extractIdTokens is the
  // same judgement asked of each token; for a query that IS a single id it yields exactly
  // that one token, so the emitted SQL is byte-identical to before and X16 cannot regress.
  for (const token of extractIdTokens(q)) {
    const idx = i++;
    ors.push(`REPLACE(${opts.idColumn}::text, '-', '') LIKE $${idx} || '%'`);
    params.push(normalizeShortId(token));
  }

  // partial-tag — case-insensitive substring against any tag element. Replaces the old
  // exact `tags && [..]` so a partial tag (`ref:`, `bucket`) matches a tag CONTAINING it.
  {
    const idx = i++;
    ors.push(
      `EXISTS (SELECT 1 FROM unnest(${opts.tagsColumn}) AS _tag WHERE _tag ILIKE $${idx})`,
    );
    params.push(`%${q}%`);
  }

  return { sql: `(${ors.join(' OR ')})`, params, nextParamIndex: i };
}
