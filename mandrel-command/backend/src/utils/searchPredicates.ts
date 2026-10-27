/**
 * Shared search-predicate builder for the Command UI search box.
 *
 * WHY THIS EXISTS / SOURCE PATTERN:
 *   The canonical id-resolution contract lives in the Mandrel core at
 *   mcp-server/src/utils/idResolver.ts (`resolveEntityId`): a full UUID passes
 *   straight through; a short hex id becomes a PARAMETERIZED prefix match
 *   (`id::text LIKE $n || '%'`), project-scoped, with an ambiguity cap.
 *
 *   That module cannot be cleanly imported across the workspace boundary — it is
 *   a different tsconfig `rootDir` (the MCP server), pulls in core-only deps
 *   (zod error types, the core db pool), and the Command backend build (`tsc`
 *   with its own rootDir) would reject the out-of-tree import. So rather than
 *   copy-paste a second resolver, we factor ONE shared helper HERE that all
 *   direct-SQL Command search services (contexts, tasks, …) call, and we MIRROR
 *   the idResolver pattern deliberately. If the resolver's prefix-match contract
 *   changes, update this file to match (single shared helper on this side of the
 *   boundary; see a past incident — fix the class, don't drift N copies).
 *
 * WHAT IT ADDS to a search query, all OR'd together (additive — never replaces
 * the caller's existing content/title match):
 *   1. id-lookup  — full UUID OR hex id-prefix (>= searchConfig.idPrefixMinLength)
 *                   matches the exact record(s) whose id starts with it,
 *                   project-scoped, capped at searchConfig.idMaxCandidates.
 *   2. partial-tag — case-insensitive SUBSTRING match against any element of the
 *                    tags[] array (today's exact-ANY match fails partial tags like
 *                    `ref:` or `bucket`).
 *
 * SECURITY: every value is a BOUND parameter ($n). Nothing is concatenated into
 * SQL. The caller passes a starting param index and we return the next free one.
 */

import { searchConfig } from '../config/search';

/** A canonical v4-ish UUID (8-4-4-4-12 hex). Mirrors idResolver.isFullUuid. */
const FULL_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A hex id-prefix the user typed. Dashes are allowed (a user often pastes a
 * dashed partial like `0f39f00d-db79`); we normalize them away before matching,
 * exactly like idResolver.normalizeShortId. After stripping dashes it must be
 * pure hex.
 */
const HEX_PREFIX_RE = /^[0-9a-f-]+$/i;

/** Strip dashes — mirrors idResolver.normalizeShortId. */
export function normalizeShortId(value: string): string {
  return value.trim().replace(/-/g, '').toLowerCase();
}

export function isFullUuid(value: string): boolean {
  return FULL_UUID_RE.test(value.trim());
}

/**
 * Does this query look like an id (full UUID or a long-enough hex prefix)?
 * Used to decide whether to add the id-prefix clause at all. The length floor
 * (searchConfig.idPrefixMinLength) is measured on the DASH-STRIPPED hex so a
 * dashed partial is judged by its real hex length.
 */
export function looksLikeId(query: string): boolean {
  const q = query.trim();
  if (isFullUuid(q)) return true;
  if (!HEX_PREFIX_RE.test(q)) return false;
  return normalizeShortId(q).length >= searchConfig.idPrefixMinLength;
}

/**
 * Is this query a bare hex PREFIX (not a full UUID) long enough to be an id-lookup?
 * Such a query is "ambiguous" by nature — it can match many ids — so callers cap
 * its result page at searchConfig.idMaxCandidates (see capLimitForQuery).
 */
export function isAmbiguousIdPrefix(query: string): boolean {
  const q = query.trim();
  return (
    !isFullUuid(q) &&
    HEX_PREFIX_RE.test(q) &&
    normalizeShortId(q).length >= searchConfig.idPrefixMinLength
  );
}

/**
 * Cap the effective page limit for ambiguous id-prefix queries so an absurdly
 * short prefix can't pull unbounded rows (mirrors idResolver's LIMIT 25 guard).
 * Non-id-prefix queries keep the caller's requested limit unchanged.
 */
export function capLimitForQuery(query: string | undefined, requestedLimit: number): number {
  if (query && isAmbiguousIdPrefix(query)) {
    return Math.min(requestedLimit, searchConfig.idMaxCandidates);
  }
  return requestedLimit;
}

export interface SearchClause {
  /** SQL fragment WITHOUT a leading AND/OR — e.g. "(a OR b OR c)". */
  sql: string;
  /** Parameters to push, in order, matching the $n placeholders in `sql`. */
  params: any[];
  /** The next free parameter index after this clause's placeholders. */
  nextParamIndex: number;
}

export interface BuildSearchOptions {
  /** Column expression for the free-text body (e.g. "c.content" or
   *  "(t.title || ' ' || coalesce(t.description,''))"). */
  textColumns: string[];
  /** Column expression that holds the row id (e.g. "c.id" or "t.id"). */
  idColumn: string;
  /** text[] column holding tags (e.g. "c.tags" or "t.tags"). */
  tagsColumn: string;
  /** Optional extra equality clauses OR'd in (e.g. type/status exact match). Each
   *  entry is a pre-built fragment + its params; placeholders use the running
   *  index. Kept generic so callers preserve their existing matches. */
  extraOrClauses?: Array<{ template: (i: number) => { sql: string; consumed: number }; params: any[] }>;
}

/**
 * Build the full OR'd search predicate for a free-text `query`, adding id-prefix
 * and partial-tag matching to the caller's text/extra matches.
 *
 * @param query        the raw user search string
 * @param startIndex   the next free $n parameter index in the caller's query
 * @param opts         column wiring (see BuildSearchOptions)
 */
export function buildSearchPredicate(
  query: string,
  startIndex: number,
  opts: BuildSearchOptions,
): SearchClause {
  const q = query.trim();
  const ors: string[] = [];
  const params: any[] = [];
  let i = startIndex;

  // 1. Free-text: ILIKE %query% across each text column.
  if (opts.textColumns.length > 0) {
    const likeIdx = i++;
    const textOr = opts.textColumns.map((col) => `${col} ILIKE $${likeIdx}`).join(' OR ');
    ors.push(`(${textOr})`);
    params.push(`%${q}%`);
  }

  // 2. Caller-supplied extra OR clauses (e.g. exact type/status match) — preserves
  //    existing no-regression behavior.
  if (opts.extraOrClauses) {
    for (const extra of opts.extraOrClauses) {
      const built = extra.template(i);
      ors.push(built.sql);
      params.push(...extra.params);
      i += built.consumed;
    }
  }

  // 3. id-lookup: full UUID OR hex prefix. Parameterized prefix match against the
  //    DASH-STRIPPED text form of the id, exactly like idResolver
  //    (replace(id::text,'-','') LIKE $n || '%'). $n is always BOUND, never
  //    concatenated. We normalize both sides so a user can paste a dashed partial
  //    (`0f39f00d-db79`) or a bare hex prefix and get the same match. A full UUID
  //    is just the maximal prefix → same LIKE form. The query's own LIMIT (and
  //    searchConfig.idMaxCandidates on callers that cap by it) bound how many
  //    ambiguous-prefix rows surface.
  if (looksLikeId(q)) {
    const idx = i++;
    ors.push(`REPLACE(${opts.idColumn}::text, '-', '') LIKE $${idx} || '%'`);
    params.push(normalizeShortId(q));
  }

  // 4. partial-tag: case-insensitive substring against any tag element.
  {
    const idx = i++;
    ors.push(
      `EXISTS (SELECT 1 FROM unnest(${opts.tagsColumn}) AS _tag WHERE _tag ILIKE $${idx})`,
    );
    params.push(`%${q}%`);
  }

  return {
    sql: `(${ors.join(' OR ')})`,
    params,
    nextParamIndex: i,
  };
}
