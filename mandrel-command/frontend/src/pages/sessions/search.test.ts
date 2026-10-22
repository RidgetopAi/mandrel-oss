/**
 * The Sessions search predicate.
 *
 * ── THE TWO REPORTED SYMPTOMS, AS FIXTURES ───────────────────────────────────────────
 * 1. Searching "builder" returned nothing: `actor` was not in the haystack at all.
 * 2. Searching "ui" returned one unrelated session: the old filter was a bare substring
 *    test, so a two-letter query hit INSIDE ordinary words (b-ui-ld, g-ui-de, req-ui-re).
 * A third, unreported but present: the haystack was the fields joined into ONE string, so
 * a query could match across the seam between two of them.
 *
 * WHICH ASSERTIONS DISCRIMINATE, AND WHICH ARE ONLY PROPERTIES — measured against a
 * verbatim restore of the old implementation (8 failed / 12 passed), because the
 * distinction is invisible from the test names. Stated per ASSERTION, not per block:
 *   symptom 1: only `actor`, `session_goal`, `display_id` and `tags` go RED. The
 *     `title` / `description` / `project_name` rows were already searched, so they are
 *     properties too — they sit here because the field list is the unit worth reading.
 *   symptom 2: `"ui"` inside words, and the hyphenated tag, go RED.
 *   symptom 3: none go RED. The old code joined the fields with a SPACE, so it already
 *     answered these correctly. Delete the space and they bite, which is the only
 *     implementation they discriminate against. 'workon' is not a seam case at all — it
 *     is a word boundary inside ONE field ("work on daisy").
 * The real seam defect — one contiguous run matching across "…daisy| |coordinator…" — is NOT
 * pinned by anything here: under AND-over-terms, 'daisy coordinator' is true either way.
 */
import { describe, it, expect } from 'vitest';
import { matchesSearch } from './search';
import type { SessionListRow } from './hooks';

function row(over: Partial<SessionListRow> = {}): SessionListRow {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    display_id: 'sess-42',
    title: 'Rebuild the session stream',
    description: 'Building the guide for the new suite',
    project_name: 'riverbend',
    actor: 'builder',
    session_goal: 'ship the accordion',
    tags: ['ui-polish', 'p1'],
    ...over,
  };
}

describe('symptom 1 — the searched fields', () => {
  it.each([
    ['actor', 'builder'],
    ['title', 'rebuild'],
    ['description', 'building'],
    ['project_name', 'riverbend'],
    ['session_goal', 'accordion'],
    // '42', not 'sess': `title` contains the word "session", so 'sess' is a word-prefix
    // there too and this row passed with display_id dropped from the searched fields
    // entirely. Every query here must be unique to the field it names, or the row proves
    // nothing about that field.
    ['display_id', '42'],
    ['tags', 'polish'],
  ])('%s is searched — %s matches', (_field, query) => {
    expect(matchesSearch(row(), query)).toBe(true);
  });

  it('a term present in NO field does not match', () => {
    expect(matchesSearch(row(), 'kubernetes')).toBe(false);
  });
});

describe('symptom 2 — a term must START a word, not sit inside one', () => {
  const inWords = row({
    title: 'Building the guide',
    description: 'requires the suite',
    project_name: 'daisy',
    actor: 'coordinator',
    session_goal: undefined,
    display_id: 'x-1',
    tags: [],
  });

  it('"ui" does not match building / guide / requires / suite', () => {
    expect(matchesSearch(inWords, 'ui')).toBe(false);
  });

  it('but a real word-prefix still matches — partial typing stays useful', () => {
    expect(matchesSearch(inWords, 'sess')).toBe(false); // no such word here
    expect(matchesSearch(row(), 'sess')).toBe(true); // 'session' / 'sess-42'
    expect(matchesSearch(inWords, 'guid')).toBe(true);
    expect(matchesSearch(inWords, 'build')).toBe(true);
  });

  it('a term that starts a word inside a hyphenated value matches — hyphens are boundaries', () => {
    expect(matchesSearch(row(), 'polish')).toBe(true); // tag 'ui-polish'
  });
});

describe('symptom 3 — a match never crosses a field boundary', () => {
  const seam = row({
    title: 'work on daisy',
    description: 'coordinator did it',
    project_name: undefined,
    actor: undefined,
    session_goal: undefined,
    display_id: undefined,
    tags: [],
  });

  it('two terms may land in DIFFERENT fields (an AND across the row)', () => {
    expect(matchesSearch(seam, 'daisy coordinator')).toBe(true);
  });

  it('but a single term never spans the seam between two fields', () => {
    // 'daisycoordinator' is only "present" if the fields were concatenated first.
    expect(matchesSearch(seam, 'daisycoordinator')).toBe(false);
  });

  it('nor does a single term span a word boundary inside one field', () => {
    expect(matchesSearch(seam, 'workon')).toBe(false);
  });
});

describe('every term must match (AND), not just one', () => {
  it('one hit plus one miss is a miss', () => {
    expect(matchesSearch(row(), 'builder kubernetes')).toBe(false);
  });
});

describe('the EMPTY, ZERO and ABSENT populations', () => {
  it('a blank or whitespace-only query matches everything', () => {
    expect(matchesSearch(row(), '')).toBe(true);
    expect(matchesSearch(row(), '   ')).toBe(true);
    expect(matchesSearch(row(), '-,.')).toBe(true);
  });

  it('a row with every searched field absent matches nothing but the blank query', () => {
    const bare = {
      id: '22222222-2222-4222-8222-222222222222',
    } as SessionListRow;
    expect(matchesSearch(bare, '')).toBe(true);
    expect(matchesSearch(bare, 'anything')).toBe(false);
  });

  it('null / empty-string / empty-array field values do not throw and do not match', () => {
    const nulls = {
      id: '33333333-3333-4333-8333-333333333333',
      title: '',
      description: undefined,
      project_name: null as unknown as string,
      actor: null,
      session_goal: '',
      display_id: undefined,
      tags: [],
    } as SessionListRow;
    expect(matchesSearch(nulls, 'x')).toBe(false);
    expect(matchesSearch(nulls, '')).toBe(true);
  });

  it('a tags array holding a null does not throw', () => {
    const dirty = row({ tags: [null as unknown as string, 'real'] });
    expect(matchesSearch(dirty, 'real')).toBe(true);
  });

  it('matching is case-insensitive in both directions', () => {
    expect(matchesSearch(row({ title: 'DAISY' }), 'daisy')).toBe(true);
    expect(matchesSearch(row({ title: 'daisy' }), 'DAISY')).toBe(true);
  });
});
