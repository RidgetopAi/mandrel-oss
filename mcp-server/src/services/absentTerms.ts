/**
 * ABSENT-TERM DETECTION — which of a query's content terms occur in ZERO records of this
 * project (SEARCH P2a).
 *
 * The question it answers is the one a vector search structurally cannot: "is this word
 * anywhere in what we have?" Cosine similarity always returns SOMETHING, and its top hit for
 * a term the corpus has never contained looks exactly like its top hit for a term the corpus
 * is full of. A term that is lexically absent is a hard, checkable fact, and it is the raw
 * material P2b uses to say "we do not have that" instead of returning confident noise.
 *
 * ⚠️ THREE PROPERTIES OF THIS FUNCTION ARE REQUIREMENTS, NOT IMPLEMENTATION DETAIL:
 *
 *  1. SCOPED TO THE PROJECT. An absent-term claim is per project, never per database.
 *     "Kubernetes appears nowhere" is a statement about a corpus; making it about the wrong
 *     corpus is how you tell a customer their own record does not exist.
 *
 *  2. ONE ROUND TRIP for the whole query. The terms are carried into the database as arrays
 *     and joined against the corpus there — never a query per term, which turns a 12-word
 *     question into 12 network round trips and makes the cost of asking scale with how
 *     articulate the caller was.
 *
 *  3. LEXEMES ARE MATCHED EXACTLY — never through plainto_tsquery()/to_tsquery().
 *     THE TRAP, measured and paid for during the design spike: the prose
 *     terms come out of `to_tsvector` ALREADY STEMMED, and handing an already-stemmed lexeme
 *     back to a *_tsquery function stems it AGAIN. Measured:
 *         to_tsvector('english','database')      → 'databas'
 *         plainto_tsquery('english','databas')   → 'databa'
 *     'databa' matches nothing, so `database` reads as ABSENT from a corpus that is full of
 *     it — a false "we do not have that" about the most common word in the project. The
 *     correct form is the same one the identifier side uses: cast a QUOTED LITERAL,
 *     `quote_literal(lex)::tsquery`, which does no parsing and no stemming at all.
 *     src/tests/absentTerms.contract.test.ts asserts this trap stays closed.
 */

import { db } from '../config/database.js';
import { LEXICAL_TABLES, LEXICAL_SEARCH_CONFIG } from '../config/lexicalSearchConfig.js';
import { extractIdentifiers } from '../utils/lexicalTokens.js';
import { nearMissMaxDistance } from './absentTermVeto.js';

/**
 * THE WHOLE-PROJECT NEAR-MISS FALLBACK. The project's prose lexemes within
 * near-miss LENGTH range of any of `lexemes`, read from every lexical table. Called ONLY on the
 * would-empty path (see nearMissFallbackLexemes in services/absentTermVeto.ts): three per-table
 * word-list reads that unnest every live row's tsvector (~350 ms on contexts alone for a
 * 7.6k-context project), which is why it is not the default near-miss vocabulary. The length window is the only filter pushed into SQL;
 * the edit-distance rule itself stays in one place (absentTermVeto.findNearMiss).
 */
export async function fetchProjectNearMissVocabulary(
  projectId: string,
  lexemes: readonly string[],
): Promise<Set<string>> {
  const vocab = new Set<string>();
  if (lexemes.length === 0) return vocab;
  const minLen = Math.min(...lexemes.map((l) => l.length - nearMissMaxDistance(l)));
  const maxLen = Math.max(...lexemes.map((l) => l.length + nearMissMaxDistance(l)));
  // CONCURRENT, one read per table; Promise.all rejects if ANY table fails, so a partial
  // vocabulary is never returned — the caller's veto stands and the failure is named.
  const results = await Promise.all(LEXICAL_TABLES.map((t) => db.query(
    `SELECT DISTINCT w AS word
       FROM (SELECT unnest(tsvector_to_array(x.${t.tsvColumn})) AS w
               FROM ${t.table} x
              WHERE x.${t.projectColumn} = $1 AND x.${t.archivedColumn} IS NULL) v
      WHERE length(w) BETWEEN $2 AND $3`,
    [projectId, minLen, maxLen],
  )));
  for (const r of results) for (const row of r.rows) vocab.add(row.word as string);
  return vocab;
}

/** Which tsvector a term is checked against — the prose one or the verbatim-identifier one. */
export type TermKind = 'prose' | 'identifier';

export interface QueryTerm {
  /** The lexeme as it is stored in the corresponding tsvector (already stemmed, if prose). */
  readonly lexeme: string;
  readonly kind: TermKind;
  /**
   * THE WORDS THE CALLER ACTUALLY TYPED that produced this lexeme, lowercased by the parser
   * where it lowercases. Added by P2b and it is a CORRECTNESS requirement,
   * not a convenience.
   *
   * MEASURED, and it falsifies the obvious reading of BUILD 4 ("veto when an absent term is
   * not an English word"): `lexeme` is STEMMED, and English stems are mostly not English
   * words. Against the vendored SCOWL list —
   *     to_tsvector('english','database')  → 'databas'   in word list: NO
   *     to_tsvector('english','favourite') → 'favourit'  in word list: NO
   *     to_tsvector('english','anybody')   → 'anybodi'   in word list: NO
   * — so a veto applied to the LEXEME would fire on `database`, `favourite` and `anybody`,
   * which are the exact ordinary-English words the word list exists to protect. The design's
   * measured trade (12/17 negatives caught, 1/33 real answers lost) is only reproducible if
   * the Englishness question is asked of the SURFACE form. It is an array because one lexeme
   * can come from several surfaces in one query ('database' and 'databases' both → 'databas').
   */
  readonly surfaces: readonly string[];
}

export interface AbsentTermsResult {
  /** Every content term the query yielded, in the order the database returned them. */
  readonly terms: readonly QueryTerm[];
  /** The subset of `terms` that occurs in ZERO non-archived records of this project. */
  readonly absent: readonly QueryTerm[];
}

/**
 * Build the "this term appears nowhere" predicate: one NOT EXISTS per table PER KIND.
 *
 * Two arms per table rather than one `CASE WHEN kind = ...` arm, deliberately: a CASE over
 * two different columns is opaque to the planner and gives up the GIN index on both, which
 * turns a term check into a sequential scan of the whole project. The kind literal inside
 * each arm lets the planner discard the irrelevant one per row.
 *
 * Enumerated from LEXICAL_TABLES so the population is the registry, not whatever tables the
 * author of this function happened to remember (C3 — name the population). Adding a fourth
 * lexical table means editing the registry and a migration; this function needs no change.
 */
function buildAbsenceClauses(projectParam: string): string {
  const arms: string[] = [];
  for (const t of LEXICAL_TABLES) {
    const scope = `x.${t.projectColumn} = ${projectParam} AND x.${t.archivedColumn} IS NULL`;
    arms.push(
      `NOT EXISTS (SELECT 1 FROM ${t.table} x WHERE ${scope}` +
        ` AND term.kind = 'prose' AND x.${t.tsvColumn} @@ quote_literal(term.lexeme)::tsquery)`,
    );
    arms.push(
      `NOT EXISTS (SELECT 1 FROM ${t.table} x WHERE ${scope}` +
        ` AND term.kind = 'identifier' AND x.${t.identsColumn} @@ quote_literal(term.lexeme)::tsquery)`,
    );
  }
  return arms.join('\n         AND ');
}

/**
 * The whole thing, as one statement.
 *
 * Prose lexemes are produced INSIDE the database (`to_tsvector` → `tsvector_to_array`) rather
 * than by a TypeScript stemmer, because they have to be the same lexemes the documents were
 * indexed with — the same configuration, the same version of the same dictionary. Any
 * second implementation of the stemmer is a second answer to "what does this word reduce
 * to", and the two would diverge the first time a dictionary shipped an update.
 *
 * Identifier tokens are produced in TypeScript (utils/lexicalTokens) and passed in as an
 * array, because the identifier pattern is a pure regex with no dictionary behind it and the
 * two engines are held in step by an explicit differential test.
 */
function buildSql(): string {
  return `
    WITH surfaced AS (
      -- ts_debug() RATHER THAN to_tsvector(), so each lexeme keeps the word it came from.
      -- Same parser, same configuration, same dictionaries — it is the introspection form of
      -- the very call to_tsvector makes, which is why the two agree lexeme-for-lexeme (and
      -- src/tests/absentTerms.contract.test.ts asserts that agreement over real queries
      -- rather than leaving it as a claim). A token the dictionary discards (a stopword, a
      -- blank) has lexemes = '{}' and unnest yields no row, exactly as to_tsvector drops it.
      SELECT d.token AS surface, l AS lexeme
        FROM ts_debug($2::regconfig, $3::text) AS d,
             LATERAL unnest(d.lexemes) AS l
    ),
    terms AS (
      SELECT lexeme, 'prose'::text AS kind, array_agg(DISTINCT surface) AS surfaces
        FROM surfaced
       -- ⚠️ THE DE-DUPLICATION IS A CORRECTNESS FIX, NOT A TIDY-UP. MEASURED: the default
       -- parser emits anchorgate.ts:122 as a PROSE lexeme too, so a query for that string
       -- produced the SAME text under both kinds — present as an identifier (the document's
       -- services/anchorGate.ts:122 extracts to exactly it) and absent as prose (the
       -- document's prose vector holds services/anchorgate.ts plus 122, split differently).
       -- The caller was handed both answers about one string, and the wrong one is the one
       -- that says "we do not have that". A string we extracted as an identifier is checked
       -- as an identifier and not also as prose; the identifier column is the one built to
       -- answer for it.
         WHERE lexeme <> ALL($4::text[])
       GROUP BY lexeme
      UNION ALL
      -- An identifier literal was extracted VERBATIM from the query, so it IS its own
      -- surface form; there is no stemmer between the two.
      SELECT lexeme, 'identifier'::text AS kind, ARRAY[lexeme] AS surfaces
        FROM unnest($4::text[]) AS lexeme
    )
    SELECT term.lexeme,
           term.kind,
           term.surfaces,
           (${buildAbsenceClauses('$1')}) AS is_absent
      FROM terms AS term
  `;
}

/**
 * Return every content term of `query`, flagged with whether it occurs in ZERO non-archived
 * records of `projectId`.
 *
 * An empty query (or one that yields no content terms at all — pure stopwords, punctuation)
 * returns empty lists WITHOUT touching the database. Note what that means and what it does
 * NOT mean: "no terms" is not "everything is absent". A caller that treats an empty `absent`
 * list as a veto signal would veto nothing, which is the correct, conservative direction.
 */
export async function findAbsentTerms(
  query: string,
  projectId: string,
): Promise<AbsentTermsResult> {
  const identifiers = extractIdentifiers(query);
  if (query.trim() === '' && identifiers.length === 0) {
    return { terms: [], absent: [] };
  }

  const result = await db.query(buildSql(), [
    projectId,
    LEXICAL_SEARCH_CONFIG.tsConfig,
    query,
    identifiers,
  ]);

  const terms: QueryTerm[] = [];
  const absent: QueryTerm[] = [];
  for (const row of result.rows) {
    const term: QueryTerm = {
      lexeme: row.lexeme,
      kind: row.kind as TermKind,
      surfaces: Array.isArray(row.surfaces) ? row.surfaces : [row.lexeme],
    };
    terms.push(term);
    if (row.is_absent === true) absent.push(term);
  }

  return { terms, absent };
}

/** Exposed so a guard can assert the statement's shape without re-deriving it. */
export const ABSENT_TERMS_SQL = buildSql();
