/**
 * LEXICAL TOKENS — the JavaScript half of the identifier extractor.
 *
 * The SQL half lives in migration 091 as the IMMUTABLE function `mandrel_search_idents()`.
 * Both render the SAME pattern out of config/lexicalSearchConfig.ts; neither owns it.
 * src/tests/lexicalTokens.contract.test.ts runs the two engines side by side over real
 * corpus rows and fails if they ever disagree — which is the only thing that makes "one
 * definition, two languages" a fact rather than an intention.
 *
 * ⚠️ TWO MECHANICS HERE ARE LOAD-BEARING AND FAIL SILENTLY IF CHANGED. Both were measured
 * during the design spike and both look like style until they cost you a
 * day:
 *
 *  1. ON THE DOCUMENT SIDE, inject with `array_to_tsvector(ARRAY[...])`, never
 *     `to_tsvector()`. `to_tsvector` RE-PARSES its input, and the parser treats `_` as
 *     blank — so feeding it the token you just carefully extracted puts you back exactly
 *     where you started (`MANDREL_SEARCH_MIN_SIMILARITY` → `mandrel search min similar`).
 *     `array_to_tsvector` takes the strings as GIVEN and preserves them whole.
 *
 *  2. ON THE QUERY SIDE, build the tsquery by CASTING A QUOTED LITERAL —
 *     `'<lexeme>'::tsquery` — never `to_tsquery()` / `plainto_tsquery()`. Those re-parse
 *     too, with the same splitting. The cast is the only form that round-trips.
 *     `lexemeToTsqueryLiteral()` below is that form, with SQL quoting done properly.
 */

import {
  LEXICAL_SEARCH_CONFIG,
  LEXICAL_IDENTIFIER_PATTERN_JS,
} from '../config/lexicalSearchConfig.js';

/**
 * Extract the identifier-shaped tokens from a piece of text, lowercased and de-duplicated,
 * in first-appearance order.
 *
 * Truncates to `indexMaxChars` FIRST, exactly as the generated column does, so what this
 * function reports for a document is what the database actually indexed for it. Tokens
 * longer than `identifierMaxLength` are dropped (see that config entry for why).
 */
/**
 * ⚠️ COST, MEASURED — read this before pointing this function at a DOCUMENT.
 *
 * Node's backtracking regex engine is QUADRATIC in the length of a contiguous run of word
 * characters, because the `file.ext` alternative retries from every position inside the run.
 * Measured on this exact pattern (Node 24, one run of 'x'):
 *     8 KB  77 ms | 16 KB  309 ms | 32 KB  1.25 s | 64 KB  5.03 s
 * The same 64 KB as ORDINARY SPACED WORDS costs 2 ms, and Postgres — whose engine is not
 * backtracking — does the 64 KB run in 3.5 ms. So this is a property of the JavaScript half
 * only, and only for pathological input.
 *
 * P2a calls this on QUERIES, which are short, and never on stored documents (the document
 * side is the generated column, i.e. Postgres). The pattern is NOT changed to fix this: a
 * leading word-boundary guard would make it linear but would also stop matching `abc.ts`
 * inside `9abc.ts`, which is a behaviour change to a pattern that was measured and approved,
 * and it would have to be made in both languages at once. Recorded here, and reported to P2b,
 * rather than fixed silently.
 */
export function extractIdentifiers(text: string | null | undefined): string[] {
  if (!text) return [];
  const bounded = text.slice(0, LEXICAL_SEARCH_CONFIG.indexMaxChars);
  // A fresh regex per call: a /g regex carries mutable `lastIndex`, and a module-level one
  // shared across calls would skip matches depending on what the PREVIOUS caller did.
  const re = new RegExp(LEXICAL_IDENTIFIER_PATTERN_JS, 'g');
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of bounded.matchAll(re)) {
    const tok = m[0].toLowerCase();
    if (tok.length > LEXICAL_SEARCH_CONFIG.identifierMaxLength) continue;
    if (seen.has(tok)) continue;
    seen.add(tok);
    out.push(tok);
  }
  return out;
}

/**
 * Render ONE ALREADY-EXTRACTED lexeme as SQL text that casts to a single-term tsquery.
 *
 * Returns the literal INCLUDING its quotes, e.g. `'anchorgate.ts:122'`, ready to be
 * concatenated with `::tsquery`. Embedded single quotes are doubled, which is what
 * Postgres's own `quote_literal` does and what makes a lexeme like `don't` safe.
 *
 * This is deliberately NOT a parameterised value: a bound parameter of type tsquery would
 * have to be produced by one of the `*_tsquery()` functions, and those are precisely the
 * re-parsing forms this whole module exists to avoid. Callers that need to bind a lexeme at
 * RUNTIME should instead bind it as TEXT and cast in SQL with `quote_literal($n)::tsquery`
 * (which is what services/absentTerms.ts does) — same semantics, nothing concatenated.
 */
export function lexemeToTsqueryLiteral(lexeme: string): string {
  return `'${lexeme.replace(/'/g, "''")}'`;
}
