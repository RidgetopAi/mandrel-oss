/**
 * LEXICAL TOKENS — unit test for the JavaScript half of the identifier extractor.
 * (SEARCH P2a.)
 *
 * This file covers the parts that need no database: what the pattern matches, what it
 * rejects, and the two bounds (truncation, token length). The half that cannot be asserted
 * here — that the JavaScript and Postgres renderings of the SAME pattern agree — is a
 * DIFFERENTIAL test against a live database and lives in lexicalSearchSchema.contract.test.ts.
 * Neither file is sufficient alone: this one proves the extractor is right, that one proves
 * there is only one extractor.
 */

import { describe, test, expect } from 'vitest';
import { extractIdentifiers, lexemeToTsqueryLiteral } from '../utils/lexicalTokens.js';
import {
  LEXICAL_SEARCH_CONFIG,
  LEXICAL_IDENTIFIER_PATTERN_JS,
  LEXICAL_INDEX_MAX_CHARS_CEILING,
  pgPatternToJsSource,
} from '../config/lexicalSearchConfig.js';

describe('extractIdentifiers — the three shapes it exists for', () => {
  test('SCREAMING_SNAKE survives whole (the token the parser would shred into 4 words)', () => {
    expect(extractIdentifiers('why is MANDREL_SEARCH_MIN_SIMILARITY set')).toEqual([
      'mandrel_search_min_similarity',
    ]);
  });

  test('file.ext, with and without :line — and the document form yields the query form', () => {
    expect(extractIdentifiers('see anchorGate.ts:122')).toEqual(['anchorgate.ts:122']);
    expect(extractIdentifiers('see plain.md')).toEqual(['plain.md']);
    // THE WHOLE REASON A QUERY EVER FINDS A DOCUMENT: the pattern matches the TAIL of the
    // path form, so the document's token is byte-identical to the bare query's token.
    expect(extractIdentifiers('services/anchorGate.ts:122')).toEqual(['anchorgate.ts:122']);
  });

  test('hex 7-40 chars, bounded at both ends', () => {
    expect(extractIdentifiers('at 5320bd9 we shipped')).toEqual(['5320bd9']);
    expect(extractIdentifiers('at 5320bd9204273cc24dc41ae77ca96ecc2610dccf we shipped')).toEqual([
      '5320bd9204273cc24dc41ae77ca96ecc2610dccf',
    ]);
    // Too short to be a sha, and not a word boundary on either side.
    expect(extractIdentifiers('deadbe and abcdef')).toEqual([]);
    expect(extractIdentifiers('x5320bd9y')).toEqual([]);
  });

  test('ordinary prose yields nothing — the extractor is not a tokenizer', () => {
    expect(extractIdentifiers('the quick brown fox jumps over the lazy dog')).toEqual([]);
    expect(extractIdentifiers('')).toEqual([]);
    expect(extractIdentifiers(null)).toEqual([]);
    expect(extractIdentifiers(undefined)).toEqual([]);
  });

  test('lowercased and de-duplicated, in first-appearance order', () => {
    // `AnchorGate.TS:1` does not match at all (the extension alternative requires a
    // LOWERCASE extension) — so the only tokens here are MY_VAR, once, and the lowercase
    // file reference, once, in the order they first appear.
    expect(
      extractIdentifiers('AnchorGate.TS:1 then MY_VAR then anchorgate.ts:1 then MY_VAR'),
    ).toEqual(['my_var', 'anchorgate.ts:1']);
    // Case folding collapses the two spellings of the same reference to one token.
    expect(extractIdentifiers('AnchorGate.ts:1 anchorgate.ts:1')).toEqual(['anchorgate.ts:1']);
  });
});

describe('the two bounds', () => {
  test('a token longer than identifierMaxLength is dropped, one shorter is kept', () => {
    const max = LEXICAL_SEARCH_CONFIG.identifierMaxLength;
    const tooLong = 'a'.repeat(max) + '.ts'; // length max+3
    const justUnder = 'b'.repeat(max - 3) + '.ts'; // length max
    expect(extractIdentifiers(tooLong)).toEqual([]);
    expect(extractIdentifiers(justUnder)).toEqual([justUnder.toLowerCase()]);
  });

  test('extraction stops at indexMaxChars — what the column indexed is what we report', () => {
    const budget = LEXICAL_SEARCH_CONFIG.indexMaxChars;
    // Filler is ordinary SPACED words, not one long run of word characters. That is not an
    // aesthetic choice: see the cost note in utils/lexicalTokens.ts — the JavaScript engine
    // is quadratic in the length of a CONTIGUOUS word-character run, and a 64KB single run
    // costs ~5s where the same input in ordinary words costs ~2ms. Filling with a run would
    // make this one assertion the slowest thing in the suite while testing nothing extra.
    const filler = (n: number) => 'xy '.repeat(Math.ceil(n / 3)).slice(0, n);
    expect(extractIdentifiers(filler(budget) + ' BEYOND_THE_BUDGET')).toEqual([]);
    expect(extractIdentifiers(filler(budget - 30) + ' WITHIN_THE_BUDGET')).toEqual([
      'within_the_budget',
    ]);
  });

  test('the budget is under the ceiling that makes to_tsvector throw', () => {
    // The ceiling is what stops a well-meaning env override from turning a search knob into
    // a write-rejecting one; assert the SHIPPED default actually sits under it.
    expect(LEXICAL_SEARCH_CONFIG.indexMaxChars).toBeLessThanOrEqual(
      LEXICAL_INDEX_MAX_CHARS_CEILING,
    );
  });
});

describe('the query-side literal', () => {
  test('wraps in single quotes and doubles any embedded quote', () => {
    expect(lexemeToTsqueryLiteral('anchorgate.ts:122')).toBe("'anchorgate.ts:122'");
    expect(lexemeToTsqueryLiteral("don't")).toBe("'don''t'");
  });
});

describe('the pattern is rendered, not hand-maintained', () => {
  test('POSIX word-boundary escapes become explicit JS lookarounds', () => {
    expect(pgPatternToJsSource('\\mfoo\\M')).toBe('(?<![0-9A-Za-z_])foo(?![0-9A-Za-z_])');
  });

  test('the JS pattern is exactly the rendering of the configured POSIX pattern', () => {
    expect(LEXICAL_IDENTIFIER_PATTERN_JS).toBe(
      pgPatternToJsSource(LEXICAL_SEARCH_CONFIG.identifierPatternPg),
    );
    // And it compiles — a rendering that produces an invalid regex would otherwise only
    // fail at the first call site that used it.
    expect(() => new RegExp(LEXICAL_IDENTIFIER_PATTERN_JS, 'g')).not.toThrow();
  });

  test('the alternation order is the one that makes the two engines agree', () => {
    // The measured divergence, asserted as behaviour rather than described in a comment:
    // with SCREAMING_SNAKE first, JS stops at `ABC_DEF` where POSIX takes `ABC_DEF.ts`.
    // The shipped order must take the longer token, which is what POSIX does.
    expect(extractIdentifiers('ABC_DEF.ts and MY_VAR.js:12')).toEqual([
      'abc_def.ts',
      'my_var.js:12',
    ]);
  });
});
