/**
 * THE LEXICAL RETRIEVAL CHANNEL (SEARCH P2b — BUILD 1).
 *
 * P2a (migration 091) put two tsvectors on each of contexts /
 * technical_decisions / tasks: `search_tsv` (prose, english-stemmed) and `search_idents`
 * (identifier tokens injected VERBATIM). This service is the retrieval half — it turns a
 * caller's query into ranked candidate lists from those columns.
 *
 * ⚠️ THE TWO MECHANICS P2a MEASURED AND THIS FILE MUST NOT UNDO. Both look like style and
 * both fail SILENTLY:
 *   * The identifier tsquery is built by CASTING A QUOTED LITERAL (`quote_literal(t)::tsquery`),
 *     never `to_tsquery()`/`plainto_tsquery()`. Those re-parse, and the parser treats `_` as
 *     blank, so `MANDREL_SEARCH_MIN_SIMILARITY` would be re-shredded into four common words
 *     and stop matching the document that contains it whole.
 *   * The PROSE tsquery is built from lexemes that came out of `to_tsvector` — i.e. ALREADY
 *     STEMMED — so it is assembled with `quote_literal` + `::tsquery` too. Handing a stemmed
 *     lexeme back to a `*_tsquery` function stems it AGAIN ('databas' → 'databa'), which
 *     matches nothing. That is the double-stemming trap from an earlier context, and it is the
 *     same trap in the retrieval path that services/absentTerms.ts closes in the probe path.
 *
 * ═══ VISIBILITY IS THE SEMANTIC PATH'S, EXACTLY ═══
 * Every row this service can return is filtered by `project_id = $1 AND archived_at IS NULL`,
 * which is what contextHandler.searchContext, decisionsHandler.searchDecisions and
 * tasksHandler.searchTasks each apply by default (soft delete) and what
 * smart_search inherits by never passing `includeArchived`. A channel that could surface a
 * row the other channel cannot is a LEAK, not a feature — so the scope columns are read from
 * the LEXICAL_TABLES registry that migration 091 and absent-term detection also read, rather
 * than written out here where they could drift from it.
 */

import { db } from '../config/database.js';
import { LEXICAL_TABLES, LEXICAL_SEARCH_CONFIG } from '../config/lexicalSearchConfig.js';
import { HYBRID_SEARCH_CONFIG } from '../config/hybridSearchConfig.js';
import { deriveTypedRecordHeadline } from '../config/recordHeadlineConfig.js';
import { extractIdentifiers } from '../utils/lexicalTokens.js';
import { logger } from '../utils/logger.js';

/** Which record kind a lexical row came from. Matches SmartSearchResult['type']. */
export type LexicalKind = 'context' | 'decision' | 'task';

export interface LexicalRow {
  readonly kind: LexicalKind;
  readonly id: string;
  readonly createdAt: Date | string | null;
  /** ts_rank over the PROSE vector. 0 when the row matched on identifiers only. */
  readonly proseRank: number;
  /** How many DISTINCT query identifier literals this row's `search_idents` contains. */
  readonly identHits: number;
  /** Did the prose vector match the query at all? */
  readonly proseHit: boolean;
  /** Display fields, per kind — enough to build a SmartSearchResult without a second fetch. */
  readonly title: string;
  readonly summary: string;
  readonly meta: Record<string, unknown>;
}

export interface LexicalSearchResult {
  /** Rows that matched ≥1 identifier literal, best first. May be empty. */
  readonly identRanked: readonly LexicalRow[];
  /** Rows that matched the prose vector, best first. May be empty. */
  readonly proseRanked: readonly LexicalRow[];
  /** The identifier literals extracted from the query (lowercased, de-duplicated). */
  readonly identifiers: readonly string[];
  /**
   * Set when the query exceeded HYBRID_SEARCH_CONFIG.lexicalQueryMaxChars and the lexical
   * channel was SKIPPED rather than run on a truncated query. See runLexicalSearch().
   */
  readonly skipped: { readonly reason: 'query_too_long'; readonly length: number; readonly cap: number } | null;
}

const NO_ROWS: readonly LexicalRow[] = Object.freeze([]);
const NO_IDENTIFIERS: readonly string[] = Object.freeze([]);

/**
 * PER-KIND PROJECTION — the display columns each table contributes, and the timestamp that
 * feeds the deterministic tie-break.
 *
 * `timeColumn` is deliberately the SAME field the corresponding semantic adapter reports as
 * `createdAt` in handlers/smartSearch.ts (contexts.created_at, technical_decisions.decision_date,
 * tasks.created_at). The final tie-break is "score, then created_at, then id"; if the two
 * channels fed it different timestamps for the same record, one record could occupy two
 * positions in one total order.
 */
interface KindProjection {
  readonly kind: LexicalKind;
  readonly table: string;
  readonly timeColumn: string;
  /**
   * SQL producing the row title, or `null` when the title is DERIVED IN TYPESCRIPT from
   * `summary` by `deriveTypedRecordHeadline` (config/recordHeadlineConfig.ts).
   *
   * Contexts have no title column, so their headline is a CLIP of the body — and a clip is
   * an ALGORITHM, not a literal. This projection used to render that algorithm in SQL
   * (a `left(x.content, …)` truncation), which made it the copy of the rule nothing in TypeScript
   * could read, let alone compare: it was the one most likely to drift silently, and it was
   * also the shortest of the five clips the codebase carried. Deleting the copy is a
   * stronger guarantee than reconciling it, and it costs nothing — `summaryExpr` already
   * selects the full `x.content` this row needs.
   */
  readonly titleExpr: string | null;
  /** SQL producing the row summary/body. */
  readonly summaryExpr: string;
  /** SQL producing a jsonb metadata blob. */
  readonly metaExpr: string;
}

const KIND_PROJECTIONS: readonly KindProjection[] = Object.freeze([
  Object.freeze({
    kind: 'context' as const,
    table: 'contexts',
    timeColumn: 'created_at',
    titleExpr: null, // derived in TS — see KindProjection.titleExpr
    summaryExpr: `x.content`,
    metaExpr: `jsonb_build_object('tags', to_jsonb(x.tags), 'type', x.context_type, 'createdAt', x.created_at)`,
  }),
  Object.freeze({
    kind: 'decision' as const,
    table: 'technical_decisions',
    timeColumn: 'decision_date',
    titleExpr: `'DECISION: ' || x.title`,
    summaryExpr: `coalesce(x.description, '')`,
    metaExpr: `jsonb_build_object('decisionType', x.decision_type, 'impactLevel', x.impact_level, 'tags', to_jsonb(x.tags))`,
  }),
  Object.freeze({
    kind: 'task' as const,
    table: 'tasks',
    timeColumn: 'created_at',
    titleExpr: `'TASK: ' || x.title`,
    summaryExpr: `coalesce(x.description, x.title)`,
    metaExpr: `jsonb_build_object('taskType', x.type, 'status', x.status, 'priority', x.priority, 'tags', to_jsonb(x.tags))`,
  }),
]);

/**
 * THE REGISTRY IS THE POPULATION (C3 — name the population your guard enumerates).
 *
 * KIND_PROJECTIONS above says how to DISPLAY each table's rows; LEXICAL_TABLES (migration
 * 091's registry) says which tables have lexical columns and what their scope columns are.
 * Those two lists must name the same tables, and this function is where that is asserted at
 * module scope rather than discovered by a query returning nothing. A fourth lexical table
 * added to the registry without a projection here fails LOUDLY at first search, not silently
 * by contributing no candidates — which is the third-state failure this repo keeps paying for.
 */
function projectionFor(table: string): KindProjection {
  const p = KIND_PROJECTIONS.find((k) => k.table === table);
  if (!p) {
    throw new Error(
      `[lexicalSearch] table '${table}' is in LEXICAL_TABLES but has no display projection. ` +
        `Refusing to silently omit it from the lexical channel — a source that contributes no ` +
        `candidates is indistinguishable from a source where nothing matched.`,
    );
  }
  return p;
}

/**
 * Build the one statement.
 *
 * Params: $1 projectId · $2 tsConfig · $3 raw query · $4 identifier literals (text[]) ·
 *         $5 per-table candidate limit.
 *
 * SHAPE. One CTE derives the two tsqueries from the query text INSIDE the database — the
 * prose one from `to_tsvector`'s own lexemes (so the stemmer that indexed the documents is
 * the stemmer that reads them), the identifier one from the array the caller extracted. Then
 * one CTE per table produces every matching row with its two ranking facts, and two more
 * take the top-N of each ranking. The per-table LIMITs are what keep this bounded; the
 * fusion only needs enough depth for a row to HAVE a rank.
 *
 * WHY THE PROSE LEXEMES EXCLUDE THE IDENTIFIER LITERALS. The default parser also emits
 * `anchorgate.ts:122` as a prose lexeme, so without the exclusion the same string would be
 * searched under both channels and an identifier hit would be double-counted into the prose
 * rank it is supposed to be independent of. Same rule, same reason, as the de-duplication in
 * services/absentTerms.ts.
 */
/**
 * THE SOFT-DELETE COLUMN this channel filters on, written out in CODE rather than only
 * reached through `t.archivedColumn`.
 *
 * Two reasons, and the second is the one that matters. First, a reader (and
 * src/tests/archivedPredicateSweep.contract.test.ts, which cannot see through the
 * interpolation) can see the predicate exists at all. Second, it is ASSERTED against the
 * registry rather than substituted for it: LEXICAL_TABLES stays the single source of the
 * name, and a registry entry that ever declares a DIFFERENT soft-delete column fails loudly
 * here instead of quietly producing a scoping arm nobody reviewed. That is the failure this
 * whole file's visibility section exists to prevent — a channel that can surface a row the
 * semantic path cannot.
 */
const EXPECTED_SOFT_DELETE_COLUMN = 'archived_at';

function buildSql(): string {
  const mode = HYBRID_SEARCH_CONFIG.proseMatchMode;
  // 'off' builds a prose tsquery of NULL, which every predicate below already handles as
  // "no prose match" — so the ablation runs the same statement rather than a second one.
  const joiner = mode === 'all' ? "' & '" : "' | '";
  // ⚠️ THE 'off' FORM STILL REFERENCES $2 AND $3, AND THAT IS NOT DECORATION. A bare
  // `NULL::tsquery` leaves those two parameters unreferenced by the statement, and Postgres
  // then cannot infer their types and REFUSES to prepare it — so the whole lexical query
  // throws, is caught as a degraded source, and the ablation silently measures "lexical
  // channel off" instead of "prose channel off". MEASURED: that is exactly what happened on
  // the first run of this ablation, and it reported a clean 4/17 that looked like a finding.
  const proseQuery = mode === 'off'
    ? '(SELECT NULL::tsquery WHERE $2::regconfig IS NOT NULL AND $3::text IS NOT NULL)'
    : `(SELECT string_agg(quote_literal(l), ${joiner})
         FROM unnest(tsvector_to_array(to_tsvector($2::regconfig, $3::text))) AS l
        WHERE l <> ALL($4::text[]))::tsquery`;

  const parts: string[] = [];
  const tails: string[] = [];
  for (const t of LEXICAL_TABLES) {
    const p = projectionFor(t.table);
    if (t.archivedColumn !== EXPECTED_SOFT_DELETE_COLUMN) {
      throw new Error(
        `[lexicalSearch] table '${t.table}' declares soft-delete column ` +
          `'${t.archivedColumn}', not '${EXPECTED_SOFT_DELETE_COLUMN}'. Refusing to build the ` +
          `lexical query until this file states how that table is scoped — an unreviewed ` +
          `visibility arm is a leak, not a feature.`,
      );
    }
    const base = `lx_${p.kind}`;
    // SOFT-DELETE-VIA: EXPECTED_SOFT_DELETE_COLUMN — every arm emitted below carries
    // `AND x.<archived column> IS NULL`, but both the table and the column arrive through
    // interpolation, so the archived-predicate sweep cannot read the FROM target and correctly
    // refuses to guess. The column is pinned in CODE by the constant of that name (and the
    // loop above REFUSES to build the query for a registry entry that declares a different
    // one), the clause is asserted per registry entry in hybridSearch.contract.test.ts, and
    // the same file probes an archived row behaviourally by a marker only it contains.
    parts.push(`
    ${base} AS (
      SELECT '${p.kind}'::text AS kind,
             x.id::text        AS id,
             x.${p.timeColumn} AS created_at,
             CASE WHEN q.pq IS NULL THEN 0::float4
                  ELSE ts_rank(x.${t.tsvColumn}, q.pq) END           AS prose_rank,
             (SELECT count(*) FROM unnest($4::text[]) AS lit
               WHERE x.${t.identsColumn} @@ quote_literal(lit)::tsquery) AS ident_hits,
             (q.pq IS NOT NULL AND x.${t.tsvColumn} @@ q.pq)         AS prose_hit,
             ${p.titleExpr ?? 'NULL::text'}   AS title,
             ${p.summaryExpr} AS summary,
             ${p.metaExpr}    AS meta
        FROM ${p.table} x CROSS JOIN q
       WHERE x.${t.projectColumn} = $1
         AND x.${t.archivedColumn} IS NULL
         AND ( (q.pq IS NOT NULL AND x.${t.tsvColumn} @@ q.pq)
            OR (q.iq IS NOT NULL AND x.${t.identsColumn} @@ q.iq) )
    ),
    ${base}_i AS (
      SELECT *, 'ident'::text AS channel FROM ${base} WHERE ident_hits > 0
       ORDER BY ident_hits DESC, prose_rank DESC, created_at DESC NULLS LAST, id ASC LIMIT $5
    ),
    ${base}_p AS (
      SELECT *, 'prose'::text AS channel FROM ${base} WHERE prose_hit
       ORDER BY prose_rank DESC, created_at DESC NULLS LAST, id ASC LIMIT $5
    )`);
    tails.push(`SELECT * FROM ${base}_i`, `SELECT * FROM ${base}_p`);
  }

  return `
  WITH q AS (
    SELECT
      ${proseQuery} AS pq,
      (SELECT string_agg(quote_literal(l), ' | ')
         FROM unnest($4::text[]) AS l)::tsquery AS iq
  ),
  ${parts.join(',\n')}
  ${tails.join('\n  UNION ALL\n  ')}
  `;
}

/** Exposed so a guard can assert the statement's shape without re-deriving it. */
export const LEXICAL_SEARCH_SQL = buildSql();

/**
 * Retrieve lexical candidates for `query` in `projectId`.
 *
 * ═══ THE QUERY LENGTH BOUND, AND WHY IT SKIPS RATHER THAN TRUNCATES ═══
 * utils/lexicalTokens.extractIdentifiers() is quadratic in a contiguous run of word
 * characters (measured: 64 KB → 5.03 s of CPU; see HYBRID_SEARCH_CONFIG.lexicalQueryMaxChars).
 * Before P2b nothing put a caller-supplied string into it. Now every smart_search does.
 *
 * TRUNCATING was the obvious bound and it is the WRONG one here, for a reason that is about
 * correctness rather than cost. The absent-term veto (BUILD 4) returns EMPTY when a term is
 * absent from the corpus. Identifier extraction over a truncated query would miss a literal
 * that appears past the cut, that literal would then be checked as PROSE instead — where it
 * tokenises differently and reads as absent — and a query would be answered "we have no
 * record of X" about a record we do have. A bound whose failure mode is a confident wrong
 * empty is not a bound worth having.
 *
 * So an over-long query SKIPS the lexical layer entirely and falls back to exactly today's
 * semantic-only behaviour, with the reason reported. That is bounded CPU, no false absence,
 * no regression, and one branch a mutation probe can land on.
 */
export async function runLexicalSearch(
  projectId: string,
  query: string,
  perTableLimit: number = HYBRID_SEARCH_CONFIG.lexicalCandidatesPerTable,
): Promise<LexicalSearchResult> {
  const cap = HYBRID_SEARCH_CONFIG.lexicalQueryMaxChars;
  if (query.length > cap) {
    logger.warn(
      `⚠️ lexical channel SKIPPED: query is ${query.length} chars, cap ${cap} ` +
        `(MANDREL_SEARCH_LEXICAL_QUERY_MAX_CHARS). Semantic-only result.`,
    );
    return {
      identRanked: NO_ROWS,
      proseRanked: NO_ROWS,
      identifiers: NO_IDENTIFIERS,
      skipped: { reason: 'query_too_long', length: query.length, cap },
    };
  }

  const identifiers = extractIdentifiers(query);
  const res = await db.query(LEXICAL_SEARCH_SQL, [
    projectId,
    LEXICAL_SEARCH_CONFIG.tsConfig,
    query,
    identifiers,
    perTableLimit,
  ]);

  const identRanked: LexicalRow[] = [];
  const proseRanked: LexicalRow[] = [];
  for (const r of res.rows) {
    const row: LexicalRow = {
      kind: r.kind as LexicalKind,
      id: r.id,
      createdAt: r.created_at ?? null,
      proseRank: Number(r.prose_rank) || 0,
      identHits: Number(r.ident_hits) || 0,
      proseHit: r.prose_hit === true,
      // A NULL title means this kind's headline is derived here, not in SQL (contexts).
      // `deriveTypedRecordHeadline` returns null for a body with no non-empty line, which
      // collapses to the same empty string the SQL path produced for an empty content.
      title:
        r.title ??
        deriveTypedRecordHeadline(
          ((r.meta ?? {}) as Record<string, unknown>).type as string | undefined,
          r.summary,
        ) ??
        '',
      summary: r.summary ?? '',
      meta: (r.meta ?? {}) as Record<string, unknown>,
    };
    if (r.channel === 'ident') identRanked.push(row);
    else proseRanked.push(row);
  }

  // The SQL emits one top-N per TABLE per channel; the channel's rank is GLOBAL across
  // tables, so the three per-table lists are merged here under the same ordering the SQL
  // used. Sorting in JS rather than in SQL keeps the per-table LIMITs (which is what bounds
  // the work) while still producing one ranked list per channel.
  identRanked.sort(
    (a, b) =>
      b.identHits - a.identHits ||
      b.proseRank - a.proseRank ||
      timeOf(b) - timeOf(a) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  proseRanked.sort(
    (a, b) =>
      b.proseRank - a.proseRank ||
      timeOf(b) - timeOf(a) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );

  return { identRanked, proseRanked, identifiers, skipped: null };
}

function timeOf(r: LexicalRow): number {
  if (!r.createdAt) return 0;
  const t = r.createdAt instanceof Date ? r.createdAt.getTime() : new Date(r.createdAt).getTime();
  return Number.isFinite(t) ? t : 0;
}
