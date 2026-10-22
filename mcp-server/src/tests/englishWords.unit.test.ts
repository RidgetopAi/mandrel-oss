/**
 * ENGLISH WORD LIST — unit test for the absent-term discriminator.
 * (SEARCH P2a, acceptance criterion 4.)
 *
 * The list is the difference between "you asked about a thing we do not have" and "you
 * phrased it your own way". The two groups below are the acceptance criterion verbatim, and
 * they are not decoration: the second group is what absent-alone gets WRONG (it vetoes 16 of
 * 17 negatives but loses 6 of 33 real answers, against 12/17 and 1/33 for absent-and-not-a-
 * word), and `favourite` is the specific loss that made the BRITISH list non-optional.
 */

import { describe, test, expect } from 'vitest';
import { isEnglishWord, englishWordCount } from '../services/englishWords.js';
import { LEXICAL_SEARCH_CONFIG } from '../config/lexicalSearchConfig.js';

describe('isEnglishWord — the acceptance sets', () => {
  test.each(['Kubernetes', 'Terraform', 'PagerDuty', 'gRPC'])(
    '%s is NOT an English word (a thing we do not have, not a phrasing)',
    (term) => {
      expect(isEnglishWord(term)).toBe(false);
    },
  );

  test.each(['encyclopedia', 'unsound', 'anybody', 'favourite'])(
    '%s IS an English word (ordinary phrasing, must never be vetoed)',
    (term) => {
      expect(isEnglishWord(term)).toBe(true);
    },
  );

  test('favourite is the BRITISH half doing work — favorite passes too', () => {
    // Asserted together so a regression that dropped one list cannot pass by luck.
    expect(isEnglishWord('favourite')).toBe(true);
    expect(isEnglishWord('favorite')).toBe(true);
  });
});

describe('isEnglishWord — the rules around the lookup', () => {
  test('case and surrounding whitespace do not matter', () => {
    expect(isEnglishWord('  ENCYCLOPEDIA  ')).toBe(true);
  });

  test('a hyphenated compound counts when every part does', () => {
    const sep = LEXICAL_SEARCH_CONFIG.compoundSeparator;
    expect(isEnglishWord(`well${sep}known`)).toBe(true);
    expect(isEnglishWord(`read${sep}only`)).toBe(true);
    // …and does not when a part does not.
    expect(isEnglishWord(`well${sep}kubernetes`)).toBe(false);
  });

  test('an empty part is not a word — the population that slips through a naive split', () => {
    const sep = LEXICAL_SEARCH_CONFIG.compoundSeparator;
    expect(isEnglishWord(`${sep}known`)).toBe(false);
    expect(isEnglishWord(`well${sep}`)).toBe(false);
    expect(isEnglishWord(`well${sep}${sep}known`)).toBe(false);
    expect(isEnglishWord(sep)).toBe(false);
  });

  test('empty and whitespace-only are not words', () => {
    expect(isEnglishWord('')).toBe(false);
    expect(isEnglishWord('   ')).toBe(false);
  });

  test('gibberish is not a word', () => {
    expect(isEnglishWord('zxqwvbnmlkj')).toBe(false);
  });
});

describe('the list itself', () => {
  test('loads a real list, not an empty Set', () => {
    // THE FALSE-GREEN THIS CLOSES: if the vendored file went missing and the loader fell
    // back to an empty Set, every "is NOT an English word" assertion above would still
    // PASS, and the discriminator would veto the entire English language in production.
    // The loader throws rather than falling back — this asserts the loaded size directly so
    // the guard cannot be satisfied by absence.
    expect(englishWordCount()).toBeGreaterThan(50_000);
  });
});
