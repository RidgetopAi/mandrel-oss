/**
 * Unit tests for the shared search-predicate builder.
 *
 * These are pure (no DB): they assert the SQL fragment + bound params produced for
 * id-lookup (full UUID + hex prefix), partial-tag, content, and the config-driven
 * gating + ambiguity cap. The DB-integration counterpart
 * (searchIdTagLookup.db.test.ts) proves the predicate actually returns the right
 * rows against Postgres.
 */

import {
  buildSearchPredicate,
  isFullUuid,
  looksLikeId,
  isAmbiguousIdPrefix,
  capLimitForQuery,
} from '../utils/searchPredicates';
import { searchConfig } from '../config/search';

const FULL_UUID = '0f3906cd-db79-4f82-b065-4426427640e7';
const HEX_PREFIX = '0f3906cd';

describe('searchPredicates — classifiers', () => {
  it('recognizes a full UUID', () => {
    expect(isFullUuid(FULL_UUID)).toBe(true);
    expect(isFullUuid(FULL_UUID.toUpperCase())).toBe(true);
    expect(isFullUuid(HEX_PREFIX)).toBe(false);
    expect(isFullUuid('not-a-uuid')).toBe(false);
  });

  it('treats a long-enough hex prefix as an id (config: idPrefixMinLength)', () => {
    expect(searchConfig.idPrefixMinLength).toBe(6);
    expect(looksLikeId(HEX_PREFIX)).toBe(true); // 8 chars >= 6
    expect(looksLikeId('0f3906')).toBe(true); // exactly 6
    expect(looksLikeId('0f39')).toBe(false); // 4 < 6 → plain text
    expect(looksLikeId(FULL_UUID)).toBe(true);
    expect(looksLikeId('bucket')).toBe(false); // 'bucket' has non-hex chars
  });

  it('flags a bare hex prefix (not a full UUID) as ambiguous', () => {
    expect(isAmbiguousIdPrefix(HEX_PREFIX)).toBe(true);
    expect(isAmbiguousIdPrefix(FULL_UUID)).toBe(false); // full UUID is exact, not ambiguous
    expect(isAmbiguousIdPrefix('ref:resume')).toBe(false);
  });

  it('caps the page limit for ambiguous id-prefix queries (config: idMaxCandidates)', () => {
    expect(capLimitForQuery(HEX_PREFIX, 1000)).toBe(searchConfig.idMaxCandidates);
    expect(capLimitForQuery(HEX_PREFIX, 5)).toBe(5); // smaller request honored
    expect(capLimitForQuery(FULL_UUID, 1000)).toBe(1000); // exact id not capped
    expect(capLimitForQuery('bucket', 1000)).toBe(1000); // plain text not capped
    expect(capLimitForQuery(undefined, 1000)).toBe(1000);
  });
});

describe('searchPredicates — buildSearchPredicate', () => {
  it('content match: ILIKE %query% + partial-tag, params bound, no id clause', () => {
    const clause = buildSearchPredicate('hello world', 1, {
      textColumns: ['c.content'],
      idColumn: 'c.id',
      tagsColumn: 'c.tags',
    });
    expect(clause.sql).toContain('c.content ILIKE $1');
    // partial-tag substring via unnest + ILIKE
    expect(clause.sql).toMatch(/unnest\(c\.tags\).*ILIKE \$2/s);
    // no id clause for a non-hex query
    expect(clause.sql).not.toContain('c.id::text');
    expect(clause.params).toEqual(['%hello world%', '%hello world%']);
    expect(clause.nextParamIndex).toBe(3);
  });

  it('full UUID: adds an id-prefix (LIKE) clause, lowercased + bound', () => {
    const clause = buildSearchPredicate(FULL_UUID.toUpperCase(), 1, {
      textColumns: ['c.content'],
      idColumn: 'c.id',
      tagsColumn: 'c.tags',
    });
    expect(clause.sql).toContain("REPLACE(c.id::text, '-', '') LIKE $2 || '%'");
    // dash-stripped + lowercased
    expect(clause.params).toContain(FULL_UUID.replace(/-/g, ''));
    // content $1, id $2, tag $3
    expect(clause.nextParamIndex).toBe(4);
  });

  it('hex prefix: adds id-prefix LIKE clause', () => {
    const clause = buildSearchPredicate(HEX_PREFIX, 1, {
      textColumns: ['c.content'],
      idColumn: 'c.id',
      tagsColumn: 'c.tags',
    });
    expect(clause.sql).toContain("REPLACE(c.id::text, '-', '') LIKE $2 || '%'");
    expect(clause.params).toContain(HEX_PREFIX);
  });

  it('dashed partial (0f3906cd-db79): treated as id, dashes stripped', () => {
    const dashed = '0f3906cd-db79';
    expect(looksLikeId(dashed)).toBe(true);
    const clause = buildSearchPredicate(dashed, 1, {
      textColumns: ['c.content'],
      idColumn: 'c.id',
      tagsColumn: 'c.tags',
    });
    expect(clause.sql).toContain("REPLACE(c.id::text, '-', '') LIKE $2 || '%'");
    expect(clause.params).toContain('0f3906cddb79'); // dash-stripped
  });

  it('preserves caller extra OR clauses (no regression for exact type match)', () => {
    const clause = buildSearchPredicate('milestone', 5, {
      textColumns: ['c.content'],
      idColumn: 'c.id',
      tagsColumn: 'c.tags',
      extraOrClauses: [
        {
          template: (idx) => ({ sql: `LOWER(c.context_type) = LOWER($${idx})`, consumed: 1 }),
          params: ['milestone'],
        },
      ],
    });
    expect(clause.sql).toContain('c.content ILIKE $5');
    expect(clause.sql).toContain('LOWER(c.context_type) = LOWER($6)');
    expect(clause.sql).toMatch(/unnest\(c\.tags\).*ILIKE \$7/s);
    expect(clause.params).toEqual(['%milestone%', 'milestone', '%milestone%']);
    expect(clause.nextParamIndex).toBe(8);
  });

  it('SECURITY: never concatenates the raw query into SQL (only $n placeholders)', () => {
    const malicious = "abc'; DROP TABLE contexts;--";
    const clause = buildSearchPredicate(malicious, 1, {
      textColumns: ['c.content'],
      idColumn: 'c.id',
      tagsColumn: 'c.tags',
    });
    expect(clause.sql).not.toContain('DROP TABLE');
    expect(clause.sql).not.toContain(malicious);
    // the raw text shows up only inside a bound param wrapped in %...%
    expect(clause.params).toContain(`%${malicious}%`);
  });

  it('works for task columns (title/description + tags + id)', () => {
    const clause = buildSearchPredicate(HEX_PREFIX, 3, {
      textColumns: ['t.title', 't.description'],
      idColumn: 't.id',
      tagsColumn: 't.tags',
    });
    expect(clause.sql).toContain('t.title ILIKE $3');
    expect(clause.sql).toContain('t.description ILIKE $3');
    expect(clause.sql).toContain("REPLACE(t.id::text, '-', '') LIKE $4 || '%'");
    expect(clause.sql).toMatch(/unnest\(t\.tags\).*ILIKE \$5/s);
  });
});
