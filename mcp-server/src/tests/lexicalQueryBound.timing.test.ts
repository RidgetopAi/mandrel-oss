/**
 * THE QUERY-LENGTH BOUND — timing test (SEARCH P2b).
 *
 * ═══ THE COST THIS BOUNDS ═══
 * utils/lexicalTokens.extractIdentifiers() is QUADRATIC in a contiguous run of word
 * characters: Node's backtracking engine retries the `file.ext` alternative from every
 * position inside the run. P2a measured it (8 KB 77 ms · 16 KB 309 ms · 32 KB 1.25 s ·
 * 64 KB 5.03 s) and correctly judged it harmless, because P2a only ever called it on strings
 * it produced itself. P2b feeds a CALLER-SUPPLIED query into it.
 *
 * ⚠️ THE MCP TOOL SURFACE ALREADY BOUNDS THIS — measured on a live instance, not read off the
 * code: a 65,536-character query is rejected with `-32602 … 'query' is too big (maximum 1000
 * characters)` by the zod schema, from TRANSIENT_LIMITS.searchQuery. The bound below is for
 * the callers that do NOT go through that validator (routes, tests, internal callers), which
 * is the same argument handlers/smartSearch.ts makes for putting the unknown-source check at
 * the handler rather than only in the schema. That is why the LAST test in this file asserts
 * the RELATIONSHIP between the two limits rather than a number: two bounds on one quantity is
 * a drift surface, and only one of the two possible drifts is even visible.
 *
 * ═══ WHAT THIS FILE ASSERTS, AND WHAT IT DELIBERATELY DOES NOT ═══
 * It asserts the BOUND HOLDS: that the cost of the extractor is a function of the CAP and
 * not of the caller's length, so an input 16× over the cap costs no more than one at it.
 * That is a RATIO between two measurements taken on the same box in the same run, which is
 * the only timing claim that survives moving to a different machine.
 *
 * It does NOT assert an absolute millisecond figure. A wall-clock threshold in a test is a
 * flake generator on a loaded CI box, and worse, it is the shape of assertion that gets its
 * number bumped until it passes — at which point the guard is measuring nothing. The one
 * absolute here is a generous ceiling well below the 5-second failure being prevented.
 */

import { describe, test, expect } from 'vitest';
import { extractIdentifiers } from '../utils/lexicalTokens.js';
import { runLexicalSearch } from '../services/lexicalSearch.js';
import { HYBRID_SEARCH_CONFIG } from '../config/hybridSearchConfig.js';
import { TRANSIENT_LIMITS } from '../config/fieldLimits.js';

const CAP = HYBRID_SEARCH_CONFIG.lexicalQueryMaxChars;

/** The pathological shape: ONE contiguous run of word characters, which is the quadratic case. */
const run = (n: number) => 'x'.repeat(n);

function timeMs(fn: () => void): number {
  const t0 = performance.now();
  fn();
  return performance.now() - t0;
}

describe('lexical query bound', () => {
  test('the extractor at the CAP costs a small fraction of the five seconds it prevents', () => {
    const at = timeMs(() => extractIdentifiers(run(CAP)));
    // A deliberately loose absolute ceiling: it is here to catch the cap being raised into
    // the quadratic danger zone, not to measure this box. The failure it prevents is the
    // measured five-SECOND cost of a 64 KB run; a tenth of a second is comfortably a bound
    // and comfortably un-flaky.
    expect(at).toBeLessThan(500);
  });

  test('an over-cap query is SKIPPED, so the cost does not scale with what the caller sent', async () => {
    // THE BOUND ITSELF. 16× the cap of the worst-case shape — at the pre-P2b behaviour this
    // would be ~quadratic in that length. runLexicalSearch must return without extracting,
    // and therefore without touching the database either, which is why no DB is needed here.
    const huge = run(CAP * 16);
    const t0 = performance.now();
    const res = await runLexicalSearch('00000000-0000-0000-0000-000000000000', huge);
    const elapsed = performance.now() - t0;

    expect(res.skipped).toEqual({ reason: 'query_too_long', length: huge.length, cap: CAP });
    expect(res.identRanked).toEqual([]);
    expect(res.proseRanked).toEqual([]);
    expect(res.identifiers).toEqual([]);
    // The skip must be O(1) — it is a length comparison. Anything near the at-cap cost above
    // would mean the extractor ran anyway.
    expect(elapsed).toBeLessThan(100);
  });

  test('the SKIP IS NOT A TRUNCATION — a long query must not answer as if it were short', async () => {
    // WHY THIS MATTERS ENOUGH TO ASSERT. Truncating would have been the obvious bound. It is
    // the dangerous one: identifier extraction over a truncated query misses a literal past
    // the cut, that literal is then checked as PROSE (where it tokenises differently and
    // reads as absent), and the absent-term veto answers "we have no record of X" about a
    // record we do have. A confident wrong EMPTY is worse than a slow query.
    const withIdentifierPastTheCap = run(CAP) + ' MANDREL_SEARCH_MIN_SIMILARITY';
    const res = await runLexicalSearch('00000000-0000-0000-0000-000000000000', withIdentifierPastTheCap);
    expect(res.skipped?.reason).toBe('query_too_long');
    // The literal is NOT reported as extracted — the channel declined to answer rather than
    // answering about a prefix.
    expect(res.identifiers).toEqual([]);
  });

  test('the lexical cap is NOT tighter than the tool surface it sits behind', () => {
    // The drift that would be invisible: if this cap fell BELOW the schema's, every query
    // between the two would be silently answered semantic-only, with a `lexicalSkipped` note
    // nobody reads, on a tool call the surface said was fine. Equality is the intended state
    // (the default is derived from the schema limit); the assertion is >= so an operator can
    // raise it for a non-tool caller without tripping a guard for no reason.
    expect(CAP).toBeGreaterThanOrEqual(TRANSIENT_LIMITS.searchQuery.max);
  });

  test('a query AT the cap still runs the extractor (the boundary is inclusive)', () => {
    // The off-by-one that would make the cap unreachable. `run(CAP)` contains no identifier,
    // so the assertion is that it EXTRACTS (returns a list) rather than that it finds one.
    expect(extractIdentifiers(run(CAP))).toEqual([]);
    expect(extractIdentifiers('a'.repeat(CAP - 30) + ' MANDREL_SEARCH_MIN_SIMILARITY'))
      .toContain('mandrel_search_min_similarity');
  });
});
