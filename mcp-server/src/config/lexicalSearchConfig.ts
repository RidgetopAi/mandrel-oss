/**
 * LEXICAL SEARCH — the tunables for the P2a lexical layer ( * migration 091).
 *
 * STANDING PRINCIPLE (the operator): no hardcoded variables. Everything the lexical layer is
 * parameterised by lives HERE — the identifier pattern, the truncation budget, the word
 * list path, the feature flag — never a literal in a handler, a service, or a test.
 *
 * WHAT THE LEXICAL LAYER IS FOR, in one paragraph. Plain Postgres full-text search would
 * make our WORST case worse, because the parser treats `_` as blank:
 * `to_tsvector('english','MANDREL_SEARCH_MIN_SIMILARITY')` is `'mandrel' 'search' 'min'
 * 'similar'` — a globally unique identifier shredded into the four commonest words in this
 * corpus. `ts_debug` shows that is the PARSER, not the dictionary; the `simple`
 * configuration splits identically. And a file:line reference tokenises DIFFERENTLY in a
 * document (`services/anchorgate.ts` + `122`) than in a query (`anchorgate.ts:122`), so
 * those never match either. So we index identifiers VERBATIM in a second tsvector
 * alongside the prose one, and query it with a form that does not re-parse.
 *
 * P2a BUILT THESE PRIMITIVES DARK; P2b WIRED THEM IN. `enabled` below is now
 * default ON, and handlers/smartSearch.ts reads it. The fusion, veto and empty-state tunables
 * live next door in config/hybridSearchConfig.ts — this file stays the answer to "what is a
 * lexical token and how is it indexed", which is the half migration 091 also has to agree with.
 */

import { fileURLToPath } from 'node:url';

/** Read a positive-integer env var, falling back to `fallback` on missing/garbage. */
function envInt(name: string, fallback: number): number {
  const raw = process.env[name]; // env-read: via-callers
  if (raw === undefined || raw === '') return fallback;
  const v = Number(raw);
  return Number.isInteger(v) && v > 0 ? v : fallback;
}

/** Read a boolean env var ('1'/'true'/'yes' → true), falling back on missing/garbage. */
function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name]; // env-read: via-callers
  if (raw === undefined || raw === '') return fallback;
  const v = raw.trim().toLowerCase();
  if (v === '1' || v === 'true' || v === 'yes') return true;
  if (v === '0' || v === 'false' || v === 'no') return false;
  return fallback;
}

// ─────────────────────────────────────────────────────────────────────────────────────────
// THE IDENTIFIER PATTERN — ONE definition, rendered into TWO regex dialects.
// ─────────────────────────────────────────────────────────────────────────────────────────
//
// Three shapes, and only three, because these are the shapes that BREAK under the default
// parser and that we actually type at each other:
//   1. SCREAMING_SNAKE names   MANDREL_SEARCH_MIN_SIMILARITY
//   2. file.ext, optional :line   anchorGate.ts:122   (also matches the tail of the
//      document form `services/anchorGate.ts:122`, which is WHY a query for the bare form
//      finds the document form — measured, and the reason the two ever match at all)
//   3. 7-40 char hex           532f00d  /  a full commit sha  /  a record id prefix
//
// ⚠️ THE ALTERNATION ORDER IS LOAD-BEARING, AND IT IS NOT THE ORDER THE SPIKE WROTE.
// MEASURED 2026-08-21, both engines, same input `'ABC_DEF.ts and MY_VAR.js:12'`:
//   Postgres (POSIX ARE, LEFTMOST-LONGEST)  →  ABC_DEF.ts | MY_VAR.js:12
//   JavaScript (leftmost-FIRST-alternative) →  ABC_DEF    | MY_VAR
// With SCREAMING_SNAKE listed first, JS stops at the shorter alternative and the two
// languages disagree on any `SCREAMING.ext` token — silently, in exactly the direction that
// makes a document and a query stop matching. Listing the file.ext alternative FIRST makes
// JS's first-match coincide with POSIX's longest-match. Postgres is unaffected by the
// reorder (POSIX longest-match is order-independent), which was verified on the real corpus,
// not assumed. The differential test in src/tests/lexicalTokens.contract.test.ts is what
// keeps this true: it runs BOTH engines over real corpus rows and asserts identical output.
//
// Written in POSIX ARE (Postgres) form because THAT is the copy the database stores inside
// the migration's IMMUTABLE function; the JS form below is derived from it mechanically so
// there is no second hand-maintained string to drift.
const IDENTIFIER_PATTERN_PG_DEFAULT =
  '([A-Za-z][A-Za-z0-9_]*\\.[a-z]{1,4}(?::[0-9]+)?' + // file.ext[:line]  — FIRST, see above
  '|[A-Z][A-Z0-9]*(?:_[A-Z0-9]+){1,}' +               // SCREAMING_SNAKE
  '|\\m[0-9a-f]{7,40}\\M)';                           // hex sha / id prefix

/**
 * POSIX ARE word-boundary escapes and their JS lookaround equivalents. Postgres's `\m` /
 * `\M` mean "at the start / end of a word", where a word character is `[[:alnum:]_]`; JS
 * has no such escape, and plain `\b` is NOT equivalent (it is a *transition*, so it also
 * fires between `_` and a letter under some engines' word definitions). The explicit
 * lookarounds below say exactly what Postgres means.
 */
const PG_TO_JS_BOUNDARY: ReadonlyArray<readonly [string, string]> = [
  ['\\m', '(?<![0-9A-Za-z_])'],
  ['\\M', '(?![0-9A-Za-z_])'],
];

/** Render the canonical POSIX pattern into JavaScript regex source. */
export function pgPatternToJsSource(pgPattern: string): string {
  let out = pgPattern;
  for (const [pg, js] of PG_TO_JS_BOUNDARY) out = out.split(pg).join(js);
  return out;
}

/**
 * Where the vendored word list lives, resolved from THIS MODULE'S URL so it is correct
 * whether we are running from `src/` (tsx, which is how the containers run) or from
 * `dist/` (tsc output) — the same anchoring idiom version.ts uses for package.json.
 * `src/config/x.ts` and `dist/config/x.js` are the same depth below the package root.
 */
const WORDLIST_PATH_DEFAULT = fileURLToPath(
  new URL('../../vendor/wordlists/english-words.txt', import.meta.url),
);

/**
 * THE TRUNCATION BUDGET, and why it is not optional.
 *
 * `to_tsvector` THROWS `string is too long for tsvector (N bytes, max 1048575 bytes)` on a
 * large enough document — measured, not assumed. Because the columns migration 091 adds are
 * GENERATED (see that file for why), a throw there is not a bad search result: it is a
 * REJECTED WRITE. `contexts.content` is a TEXT column whose validator ceiling is
 * TEXT_ANTI_ABUSE_CEILING (5,000,000 chars), so the input can comfortably reach the throw.
 * So the generated expression indexes `left(<text>, LEXICAL_INDEX_MAX_CHARS)`.
 *
 * HOW THE DEFAULT WAS CHOSEN — measured on PostgreSQL 16.14, bytes of tsvector produced per
 * INPUT CHARACTER, over adversarial inputs:
 *   ascii 1-char words           0.087
 *   ascii unique 2-char words    0.292
 *   3-byte CJK 1-char words      2.081
 *   4-byte CJK 1-char words      3.912
 *   3-byte CJK 2-char words      4.667
 *   4-byte CJK 2-char words      5.333   ← worst observed
 * `left()` counts CHARACTERS, not bytes, which is why a character budget has to be sized
 * against the multi-byte case and not the ASCII one. Rounding the worst ratio up to 6:
 * 65,536 × 6 = 393,216 bytes, against a 1,048,575-byte hard limit — a 2.7× margin. The
 * largest `contexts.content` in the real corpus is 57,192 chars, so this truncates nothing
 * we have ever stored.
 * env: MANDREL_LEXICAL_INDEX_MAX_CHARS
 */
const INDEX_MAX_CHARS_DEFAULT = 65_536;

/**
 * The hard limit the budget must stay under, expressed the way Postgres expresses it, so
 * the fail-closed check below is readable against the error message it prevents.
 */
const TSVECTOR_MAX_BYTES = 1_048_575;

/** The worst measured tsvector-bytes-per-input-char ratio, rounded UP (see above). */
const TSVECTOR_WORST_BYTES_PER_CHAR = 6;

/** The largest budget that cannot reach the throw even on the worst measured input. */
export const LEXICAL_INDEX_MAX_CHARS_CEILING = Math.floor(
  TSVECTOR_MAX_BYTES / TSVECTOR_WORST_BYTES_PER_CHAR,
);

const indexMaxChars = envInt('MANDREL_LEXICAL_INDEX_MAX_CHARS', INDEX_MAX_CHARS_DEFAULT);

// GUARD THE GUARD (a past incident — a config knob is an attack surface on its own feature).
// Raising this past the ceiling does not degrade search; it makes `context_store` start
// REJECTING large writes, with a Postgres error nobody would trace back to a search knob.
// Fail CLOSED at module load rather than at some future 200KB context.
if (indexMaxChars > LEXICAL_INDEX_MAX_CHARS_CEILING) {
  throw new Error(
    `MANDREL_LEXICAL_INDEX_MAX_CHARS=${indexMaxChars} exceeds the safe ceiling ` +
      `${LEXICAL_INDEX_MAX_CHARS_CEILING}. Above it, to_tsvector can exceed its ` +
      `${TSVECTOR_MAX_BYTES}-byte limit and THROW — and because contexts.search_tsv is a ` +
      `GENERATED column, that throw rejects the INSERT, not just the index entry. ` +
      `See config/lexicalSearchConfig.ts for the measurements behind the ceiling.`,
  );
}

export const LEXICAL_SEARCH_CONFIG = {
  /**
   * THE FEATURE FLAG for the whole lexical layer. P2a shipped the columns, the extractor, the
   * absent-term probe and the word list DARK (default false, nothing read it). P2b
   * wires them into smart_search and flips the default ON — a phase whose default
   * stayed off would ship no behaviour, and the point of the flag from here is that the
   * behaviour can be taken back out in seconds without a revert.
   *
   * WHAT TURNING IT OFF RESTORES, exactly: handlers/smartSearch.ts skips the lexical query,
   * the absent-term probe and the fusion, and returns mergeCandidates() over the semantic
   * pool — the pre-P2b order, byte for byte. `absentTerms` then reports null rather than an
   * empty array, because "the probe did not run" and "nothing was absent" are different
   * facts and a caller must not read one as the other.
   *
   * REQUIRES MIGRATION 091. With it on against a database that lacks search_tsv/search_idents,
   * both lexical round trips throw, are caught per-source, and name themselves in
   * `degradedSources` — the search still answers semantically and SAYS it is degraded, which
   * is the fail-partial contract, not a silent fallback.
   * env: MANDREL_LEXICAL_SEARCH_ENABLED
   */
  enabled: envBool('MANDREL_LEXICAL_SEARCH_ENABLED', true),

  /**
   * The text-search configuration used for the PROSE half. Held here because it must be the
   * SAME value the migration's generated column uses — a mismatch would stem the query one
   * way and the document another, and match nothing, silently.
   * env: MANDREL_LEXICAL_TS_CONFIG
   */
  tsConfig: process.env.MANDREL_LEXICAL_TS_CONFIG || 'english', // env-read: via-callers

  /** The canonical identifier pattern, POSIX ARE dialect (what Postgres stores). */
  identifierPatternPg:
    process.env.MANDREL_LEXICAL_IDENTIFIER_PATTERN || IDENTIFIER_PATTERN_PG_DEFAULT, // env-read: via-callers

  /**
   * Longest identifier token we will index. The `file.ext` alternative has an unbounded
   * head (`[A-Za-z][A-Za-z0-9_]*`), so a pathological document can produce a multi-kilobyte
   * "identifier". Bounding it keeps the index small and keeps every token comfortably
   * inside what `array_to_tsvector` will accept. 128 is far above any real identifier.
   * env: MANDREL_LEXICAL_IDENTIFIER_MAX_LENGTH
   */
  identifierMaxLength: envInt('MANDREL_LEXICAL_IDENTIFIER_MAX_LENGTH', 128),

  /** See INDEX_MAX_CHARS_DEFAULT above for the measurements. */
  indexMaxChars,

  /**
   * The vendored SCOWL-derived list (american + british, lowercased, deduped). See
   * vendor/wordlists/README.md for provenance and the recipe that reproduces the bytes.
   * env: MANDREL_LEXICAL_WORDLIST_PATH
   */
  wordlistPath: process.env.MANDREL_LEXICAL_WORDLIST_PATH || WORDLIST_PATH_DEFAULT, // env-read: via-callers

  /**
   * The separator that makes a hyphenated compound count as English when every part does
   * ("well-known", "read-only"). Config rather than a literal because the same rule is
   * asserted in the tests and must come from one place.
   */
  compoundSeparator: '-',
} as const;

/** The identifier pattern in JavaScript dialect, DERIVED — never hand-maintained. */
export const LEXICAL_IDENTIFIER_PATTERN_JS = pgPatternToJsSource(
  LEXICAL_SEARCH_CONFIG.identifierPatternPg,
);

/**
 * THE TABLES THE LEXICAL LAYER COVERS, and the columns migration 091 adds to each.
 *
 * This registry is the population absent-term detection reads. It is here, not inlined in
 * the service, because "which tables carry lexical columns" is a fact the migration and the
 * service must agree on, and two copies of that fact is exactly the drift we keep paying
 * for. A fourth table gets added here and to a migration — nowhere else.
 *
 * `archivedColumn` is the soft-delete column each table's own search already excludes by
 * default (`archived_at IS NULL`, on all three) — an absent-term claim must
 * be made over the SAME rows a search would actually return, or it will call a term absent
 * that a caller can still see.
 */
export interface LexicalTable {
  /** Table name. */
  readonly table: string;
  /** The project-scoping column. An absent-term claim is PER PROJECT, never per database. */
  readonly projectColumn: string;
  /** tsvector of the prose (`to_tsvector(tsConfig, <the table's search text>)`). */
  readonly tsvColumn: string;
  /** tsvector of the verbatim identifier tokens. */
  readonly identsColumn: string;
  /** Soft-delete column to exclude. Every table in this registry has one today. */
  readonly archivedColumn: string;
}

export const LEXICAL_TABLES: readonly LexicalTable[] = Object.freeze([
  Object.freeze({
    table: 'contexts',
    projectColumn: 'project_id',
    tsvColumn: 'search_tsv',
    identsColumn: 'search_idents',
    archivedColumn: 'archived_at',
  }),
  Object.freeze({
    table: 'technical_decisions',
    projectColumn: 'project_id',
    tsvColumn: 'search_tsv',
    identsColumn: 'search_idents',
    archivedColumn: 'archived_at',
  }),
  Object.freeze({
    table: 'tasks',
    projectColumn: 'project_id',
    tsvColumn: 'search_tsv',
    identsColumn: 'search_idents',
    archivedColumn: 'archived_at',
  }),
]);
