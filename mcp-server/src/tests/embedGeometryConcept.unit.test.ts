/**
 * conceptEmbedding SELF-PROBE — the guard on the test-side embedder itself.
 *
 * Every ranking guard in this suite is only as good as the geometry its fixtures embed
 * into. patternEmbedding() takes no argument and returns the same vector for every input,
 * so on it cosine is 1.0 between ANY two texts and a ranking assertion passes with the
 * ranking deleted. This file is the executable statement of that fact and of the
 * replacement's contract. It needs no database.
 *
 * SCOPE OF THE CLAIM (amendment A3): conceptEmbedding proves MECHANISM — that a fixture
 * and a query with no literal token overlap can still be related through a DECLARED
 * synonym table, so a ranking guard is exercising the embedding column and not a lexical
 * path. It is not a semantic model and this file does not claim retrieval quality.
 */
import { describe, test, expect } from 'vitest';
import {
  conceptEmbedding,
  conceptTokens,
  cosine,
  patternEmbedding,
  embedDim,
  CONCEPT_BUCKETS,
  CONCEPT_RESERVED_DIMS,
} from './helpers/embedGeometry.js';

/** The acceptance threshold from the build plan: unrelated texts must be under this. */
const CONCEPT_UNRELATED_MAX_COSINE = 0.5;

describe('conceptEmbedding self-probe', () => {
  test('identical text embeds to cosine ~1', () => {
    expect(cosine(conceptEmbedding('alpha beta'), conceptEmbedding('alpha beta'))).toBeCloseTo(1, 10);
  });

  test('concept-disjoint text embeds below the unrelated ceiling', () => {
    const c = cosine(conceptEmbedding('alpha'), conceptEmbedding('zeta'));
    expect(c).toBeLessThan(CONCEPT_UNRELATED_MAX_COSINE);
  });

  test('THE REASON THIS HELPER EXISTS: patternEmbedding cannot make that distinction', () => {
    // patternEmbedding accepts no argument at all — input-independence is structural, not
    // incidental. Both "identical" and "disjoint" therefore embed to the SAME vector, and
    // the disjoint case blows straight through the ceiling the test above enforces.
    expect(patternEmbedding.length).toBe(0);
    const patternDisjoint = cosine(patternEmbedding(), patternEmbedding());
    expect(patternDisjoint).toBeCloseTo(1, 10);
    expect(patternDisjoint).toBeGreaterThanOrEqual(CONCEPT_UNRELATED_MAX_COSINE);
  });

  test('the declared synonym table relates texts with ZERO literal token overlap', () => {
    const fixture = 'rotate the credential lease';
    const query = 'expiring secrets';
    // Asserted, not asserted-in-prose: the two share no token, so any similarity between
    // them can only have come through the declared table.
    const overlap = conceptTokens(fixture).filter(t => conceptTokens(query).includes(t));
    expect(overlap).toEqual([]);
    expect(cosine(conceptEmbedding(fixture), conceptEmbedding(query)))
      .toBeGreaterThan(CONCEPT_UNRELATED_MAX_COSINE);
  });

  test('declared buckets occupy distinct dimensions, so no two concepts collide', () => {
    const names = Object.keys(CONCEPT_BUCKETS);
    expect(CONCEPT_RESERVED_DIMS).toBe(names.length);
    const dims = names.map(n => conceptEmbedding(n).findIndex(x => x !== 0));
    expect(new Set(dims).size).toBe(names.length);
    expect(Math.max(...dims)).toBeLessThan(CONCEPT_RESERVED_DIMS);
  });

  test('output is a unit vector at the ACTIVE embedder geometry, never a zero vector', () => {
    for (const text of ['retrieval ranking', '', 'the and of', 'zeta']) {
      const v = conceptEmbedding(text);
      expect(v.length).toBe(embedDim());
      expect(Math.sqrt(v.reduce((a, x) => a + x * x, 0))).toBeCloseTo(1, 10);
    }
  });
});
