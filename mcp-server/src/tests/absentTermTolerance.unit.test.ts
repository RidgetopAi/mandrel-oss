/**
 * ABSENT-TERM VETO — tolerance for one unfamiliar word.
 *
 * smart_search used to return ZERO rows for an ordinary question holding a single word that
 * is absent from the corpus and not in the English word list: a typo ("buisiness"), an
 * ordinal ("7th") or a quoted identifier ("SIAC_GEE"). The veto keeps its purpose — a
 * question about a thing the corpus lacks still returns empty — but three exemptions apply:
 *   1. ordinals are ordinary words
 *   2. a near-miss spelling of a corpus word is not absent
 *   3. one absent term does not veto a multi-word question whose other terms match
 *
 * DB-free: the probe is built by hand, so this runs in the gate's unit stage. The end-to-end
 * pass over a seeded corpus is absentTermTolerance.contract.test.ts.
 */
import { describe, test, expect } from 'vitest';
import { decideEmptyState, editDistance, vocabularyOf, isOrdinal } from '../services/absentTermVeto.js';
import type { AbsentTermsResult, QueryTerm } from '../services/absentTerms.js';

const prose = (surface: string, lexeme = surface): QueryTerm => ({ lexeme, kind: 'prose', surfaces: [surface] });
const ident = (lit: string): QueryTerm => ({ lexeme: lit, kind: 'identifier', surfaces: [lit] });
const probe = (present: QueryTerm[], absent: QueryTerm[]): AbsentTermsResult =>
  ({ terms: [...present, ...absent], absent });

// The corpus: a business trip on the 7th.
const VOCAB = vocabularyOf([
  'Flew to Denver for the business trip on the 7th, met the client about the contract renewal',
]);
const PRESENT = [prose('busi', 'busi'), prose('trip'), prose('denver'), prose('client')];

describe('absent-term veto tolerance', () => {
  test('typo "buisiness" is a near-miss of "business": no veto', () => {
    const v = decideEmptyState(probe([prose('trip')], [prose('buisiness')]), VOCAB);
    expect(v.absentTerms[0].nearMissOf).toBe('business');
    expect(v.veto).toBe(false);
  });

  test('the near-miss check is what saves the SHORT typo question', () => {
    // one matched term only: the multi-word tolerance cannot apply, so only the edit-distance
    // check stands between this question and an empty result.
    expect(decideEmptyState(probe([prose('trip')], [prose('buisiness')]), VOCAB).veto).toBe(false);
    expect(decideEmptyState(probe([prose('trip')], [prose('buisiness')]), new Set()).veto).toBe(true);
  });

  test('ordinal "7th" is an ordinary word: no veto, even on a short question', () => {
    expect(isOrdinal('7th')).toBe(true);
    expect(isOrdinal('27TH')).toBe(true);
    expect(isOrdinal('7thing')).toBe(false);
    const v = decideEmptyState(probe([prose('trip')], [prose('7th')]), VOCAB);
    expect(v.veto).toBe(false);
  });

  test('a long question with one unknown identifier is not vetoed', () => {
    const v = decideEmptyState(probe(PRESENT, [ident('SIAC_GEE')]), VOCAB);
    expect(v.absentTerms.map((a) => a.term)).toEqual(['SIAC_GEE']);
    expect(v.veto).toBe(false);
  });

  test('a short question whose only substantive term is absent still vetoes', () => {
    const v = decideEmptyState(probe([prose('setup')], [prose('kubernetes', 'kubernet')]), VOCAB);
    expect(v.veto).toBe(true);
    expect(v.vetoedBy).toEqual(['kubernetes']);
  });

  test('a long question with TWO unknown names still vetoes (tolerance is for one)', () => {
    const v = decideEmptyState(probe(PRESENT, [ident('SIAC_GEE'), prose('kubernetes', 'kubernet')]), VOCAB);
    expect(v.veto).toBe(true);
  });

  test('a short unknown word is not near-missed into a corpus word', () => {
    // "trpx" is one edit from "trip" but below the minimum length: still absent.
    const v = decideEmptyState(probe([prose('setup')], [prose('trpx')]), VOCAB);
    expect(v.veto).toBe(true);
  });

  test('editDistance counts a transposition as one edit and respects the cap', () => {
    expect(editDistance('buisiness', 'business', 2)).toBe(1);
    expect(editDistance('kubernetes', 'business', 1)).toBe(2);
  });
});
