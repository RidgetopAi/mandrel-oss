/**
 * buildSearchMatchPredicate / capSearchLimit — unit test.
 *
 * Pure (no DB): locks the SQL CONTRACT + SECURITY of the centralized id-prefix +
 * partial-tag predicate that decision_search (and any future search caller) layers onto
 * its free-text query. These are the in-package primitives in utils/idResolver that REUSE
 * the resolver's normalizeShortId — so this also guards against drift between the search
 * path and the by-id resolve path.
 *
 * Asserts:
 *   - empty / '*' query → null (no predicate; non-query path stays unchanged).
 *   - a hex id-prefix (>= floor) → id-prefix OR partial-tag clauses, parameterized.
 *   - a full UUID → id-prefix clause present (the maximal prefix).
 *   - a short / non-hex query → partial-tag ONLY (no id clause; avoids flooding on 'ab').
 *   - EVERY value is a BOUND parameter ($n) — nothing is concatenated into SQL.
 *   - capSearchLimit caps only an AMBIGUOUS prefix, leaving full-UUID / text limits alone.
 */

import { describe, test, expect } from 'vitest';

import {
  buildSearchMatchPredicate,
  capSearchLimit,
  queryLooksLikeId,
  queryIsAmbiguousIdPrefix,
} from '../utils/idResolver.js';
import {
  SEARCH_ID_PREFIX_MIN_LENGTH,
  SEARCH_ID_MAX_CANDIDATES,
} from '../config/searchConfig.js';

const COLS = { idColumn: 'id', tagsColumn: 'tags' };

describe('buildSearchMatchPredicate', () => {
  test('empty / wildcard query → null (no predicate)', () => {
    expect(buildSearchMatchPredicate('', 2, COLS)).toBeNull();
    expect(buildSearchMatchPredicate('   ', 2, COLS)).toBeNull();
    expect(buildSearchMatchPredicate('*', 2, COLS)).toBeNull();
    expect(buildSearchMatchPredicate(undefined, 2, COLS)).toBeNull();
  });

  test('8-hex id-prefix → id-prefix LIKE clause + partial-tag clause, all parameterized', () => {
    const c = buildSearchMatchPredicate('0f3906cd', 2, COLS)!;
    expect(c).not.toBeNull();
    // id-prefix uses the dash-stripped text form, bound (no concatenation of the value).
    expect(c.sql).toContain(`REPLACE(id::text, '-', '') LIKE $2 || '%'`);
    // partial-tag uses an ILIKE against any tag element, bound.
    expect(c.sql).toContain('unnest(tags)');
    expect(c.sql.toLowerCase()).toContain('ilike');
    // params: normalized prefix + the %substring% tag pattern — in that order.
    expect(c.params).toEqual(['0f3906cd', '%0f3906cd%']);
    expect(c.nextParamIndex).toBe(4);
  });

  test('dashed partial is normalized like the resolver (dash-stripped, lower-cased)', () => {
    const c = buildSearchMatchPredicate('0F3906CD-DB79', 5, COLS)!;
    expect(c.params[0]).toBe('0f3906cddb79'); // dashes stripped, lower-cased
    expect(c.sql).toContain('$5'); // id clause at the live start index
  });

  test('a full UUID → id-prefix clause present (maximal prefix)', () => {
    const uuid = '0f3906cd-db79-4f00-8abc-0123456789ab';
    const c = buildSearchMatchPredicate(uuid, 2, COLS)!;
    expect(c.sql).toContain('LIKE $2');
    expect(c.params[0]).toBe('0f3906cddb794f008abc0123456789ab');
  });

  test('a short / non-hex query → partial-tag ONLY (no id-prefix clause)', () => {
    const c = buildSearchMatchPredicate('ref', 2, COLS)!; // 3 chars, hex-ish but below floor
    // No id-prefix clause (would be `REPLACE(... LIKE`); the partial-tag clause uses ILIKE.
    expect(c.sql).not.toContain('REPLACE(');
    expect(c.sql).toContain('unnest(tags)');
    expect(c.params).toEqual(['%ref%']);

    const c2 = buildSearchMatchPredicate('design', 2, COLS)!; // non-hex word
    expect(c2.sql).not.toContain('REPLACE(');
    expect(c2.params).toEqual(['%design%']);
  });

  test('SECURITY: a LIKE-metachar / quote in the query stays a BOUND value, never inlined', () => {
    const c = buildSearchMatchPredicate(`bad' OR 1=1 --`, 2, COLS)!;
    // The raw injection string is only ever a bound param; the SQL fragment carries $n only.
    expect(c.sql).not.toContain('OR 1=1');
    expect(c.params).toContain(`%bad' OR 1=1 --%`);
  });
});

describe('queryLooksLikeId / queryIsAmbiguousIdPrefix', () => {
  test('floor honored from config', () => {
    const justBelow = 'a'.repeat(SEARCH_ID_PREFIX_MIN_LENGTH - 1);
    const atFloor = 'a'.repeat(SEARCH_ID_PREFIX_MIN_LENGTH);
    expect(queryLooksLikeId(justBelow)).toBe(false);
    expect(queryLooksLikeId(atFloor)).toBe(true);
  });
  test('full UUID looks like id but is NOT an ambiguous prefix', () => {
    const uuid = '0f3906cd-db79-4f00-8abc-0123456789ab';
    expect(queryLooksLikeId(uuid)).toBe(true);
    expect(queryIsAmbiguousIdPrefix(uuid)).toBe(false);
  });
  test('a hex prefix is an ambiguous prefix', () => {
    expect(queryIsAmbiguousIdPrefix('0f3906cd')).toBe(true);
  });
});

describe('capSearchLimit', () => {
  test('caps an ambiguous prefix to SEARCH_ID_MAX_CANDIDATES', () => {
    expect(capSearchLimit('0f3906cd', 1000)).toBe(SEARCH_ID_MAX_CANDIDATES);
  });
  test('leaves a full-UUID query limit alone', () => {
    expect(capSearchLimit('0f3906cd-db79-4f00-8abc-0123456789ab', 5)).toBe(5);
  });
  test('leaves a plain text query limit alone', () => {
    expect(capSearchLimit('pgvector', 50)).toBe(50);
  });
  test('leaves an undefined query limit alone', () => {
    expect(capSearchLimit(undefined, 20)).toBe(20);
  });
});
