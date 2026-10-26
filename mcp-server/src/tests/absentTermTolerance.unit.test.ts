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
import { describe, test, expect, vi } from 'vitest';
import { decideEmptyState, editDistance, vocabularyOf, isOrdinal, nearMissFallbackLexemes } from '../services/absentTermVeto.js';
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
    expect(v.absentTerms[0].exempt).toBe('near-miss');
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
    expect(v.absentTerms[0].exempt).toBe('ordinal');
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

/**
 * THE S0b PROBE CASES (the auditor verdict, table in
 * riverbend-reports/oss-classification-2026-10-24/s0b/probe-cases.json). Same corpus as the
 * probe: these are the cases where the private lift-ratio design and this one diverged.
 */
describe('S0b probe cases', () => {
  const CORPUS = vocabularyOf(['business trip flight hotel booked expenses travel denver client contract'
    + ' renewal running database migration runner config script deploy setup guide']);
  const p = (s: string, l = s) => prose(s, l);
  const SETUP3 = [p('setup'), p('guide', 'guid'), p('deploy')];
  const NINE = [...SETUP3, p('database', 'databas'), p('migration', 'migrat'), p('runner'),
    p('config'), p('script'), p('travel')];

  // C6 / C13: an absent ORDINARY English word ("yesterday") is not a second unknown subject.
  // The private design counted it against the present-share ratio and emptied the search.
  test('C6: kubernetes + 3 matched + "yesterday" does NOT empty the search', () => {
    const v = decideEmptyState(probe(SETUP3, [p('kubernetes', 'kubernet'), p('yesterday')]), CORPUS);
    expect(v.absentTerms.find((a) => a.term === 'yesterday')?.english).toBe(true);
    expect(v.veto).toBe(false);
  });
  test('C13: kubernetes + 9 matched + 3 absent English words does NOT empty the search', () => {
    const v = decideEmptyState(probe(NINE,
      [p('kubernetes', 'kubernet'), p('yesterday'), p('morning', 'morn'), p('quickly', 'quick')]), CORPUS);
    expect(v.veto).toBe(false);
  });

  // C7 / C14: INTENDED BEHAVIOUR, documented — two or more unknown names veto however long the
  // question (absentTermToleratedAbsent = 1). The private ratio rule let these through at .75.
  test('C7: 2 unknown names + 6 matched vetoes (tolerance is for ONE unknown name)', () => {
    const six = [p('database', 'databas'), p('migration', 'migrat'), p('runner'), p('config'), p('script'), p('deploy')];
    const v = decideEmptyState(probe(six, [p('kubernetes', 'kubernet'), p('terraform')]), CORPUS);
    expect(v.vetoedBy).toEqual(['kubernetes', 'terraform']);
  });
  test('C14: 3 unknown names + 9 matched vetoes', () => {
    const v = decideEmptyState(probe(NINE,
      [p('kubernetes', 'kubernet'), p('terraform'), p('pagerduty', 'pagerduti')]), CORPUS);
    expect(v.vetoedBy).toEqual(['kubernetes', 'terraform', 'pagerduty']);
  });

  // C10 / C11: typos the private design missed — first-character typo, and a typo whose STEM
  // is too short to compare. Compared on the surface word against retrieved-row words.
  test('C10: "ousiness" (first-character typo) is a near-miss of "business"', () => {
    const v = decideEmptyState(probe([p('trip')], [p('ousiness', 'ousi')]), CORPUS);
    expect(v.absentTerms[0]).toMatchObject({ nearMissOf: 'business', exempt: 'near-miss' });
    expect(v.veto).toBe(false);
  });
  test('C11: "runing" (stem "rune") is a near-miss of "running"', () => {
    const v = decideEmptyState(probe([p('database', 'databas')], [p('runing', 'rune')]), CORPUS);
    expect(v.absentTerms[0]).toMatchObject({ nearMissOf: 'running', exempt: 'near-miss' });
    expect(v.veto).toBe(false);
  });
});

describe('whole-project near-miss fallback (would-empty path only)', () => {
  const typo = probe([prose('trip')], [prose('buisiness', 'buisi')]);

  test('asks for nothing when the retrieved rows already explain the typo', () => {
    expect(nearMissFallbackLexemes(typo, decideEmptyState(typo, VOCAB))).toEqual([]);
  });

  test('asks for the vetoing lexeme when the rows cannot, and the project lexemes rescue it', () => {
    const first = decideEmptyState(typo, new Set());
    expect(first.veto).toBe(true);
    expect(nearMissFallbackLexemes(typo, first)).toEqual(['buisi']);
    const second = decideEmptyState(typo, new Set(), new Set(['busi', 'trip']));
    expect(second.absentTerms[0]).toMatchObject({ nearMissOf: 'busi', exempt: 'near-miss' });
    expect(second.veto).toBe(false);
  });

  test('a real unknown name still vetoes after the fallback', () => {
    const k = probe([prose('setup')], [prose('kubernetes', 'kubernet')]);
    expect(nearMissFallbackLexemes(k, decideEmptyState(k, VOCAB))).toEqual(['kubernet']);
    expect(decideEmptyState(k, VOCAB, new Set(['busi', 'trip', 'setup'])).veto).toBe(true);
  });
});

describe('MANDREL_SEARCH_ABSENT_TERM_TOLERATED_ABSENT parse (0 = no tolerance)', () => {
  const load = async (raw: string) => {
    vi.resetModules();
    vi.stubEnv('MANDREL_SEARCH_ABSENT_TERM_TOLERATED_ABSENT', raw);
    try {
      return (await import('../config/hybridSearchConfig.js')).HYBRID_SEARCH_CONFIG.absentTermToleratedAbsent;
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  };
  test('0 is accepted', async () => { expect(await load('0')).toBe(0); });
  test('a negative is rejected (falls back to the default 1, like every other knob)', async () => {
    expect(await load('-1')).toBe(1);
  });
  test('garbage is rejected the same way', async () => { expect(await load('1.5')).toBe(1); });
});

