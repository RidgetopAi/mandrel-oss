/**
 * "Tests are the rock" for the SINGLE source of highlight matching (Feature B).
 * These pin exactly which runs become matches — case-insensitive, multi-word OR,
 * regex-safe — and that a blank/whitespace/absent term or a no-match input is a
 * clean no-op (one whole-string slice). Every highlight surface splits with this,
 * so proving it here proves the matching for markdown, plain-text, and list cards.
 */
import { splitOnTerm, buildHighlightRegex, hasHighlightTerm } from './highlightMatch';

describe('splitOnTerm — matching', () => {
  it('wraps a case-insensitive match (found regardless of case)', () => {
    expect(splitOnTerm('The Session Lock held', 'session')).toEqual([
      { text: 'The ', match: false },
      { text: 'Session', match: true },
      { text: ' Lock held', match: false },
    ]);
  });

  it('matches every occurrence, not just the first', () => {
    const slices = splitOnTerm('foo bar foo', 'foo');
    expect(slices.filter((s) => s.match).map((s) => s.text)).toEqual(['foo', 'foo']);
  });

  it('OR-matches a multi-word term (each word highlighted)', () => {
    const slices = splitOnTerm('the quick brown fox', 'quick fox');
    expect(slices.filter((s) => s.match).map((s) => s.text)).toEqual(['quick', 'fox']);
  });

  it('escapes regex metacharacters so a special term matches literally (no throw)', () => {
    expect(() => splitOnTerm('a+b and (x) and a.b', 'a+b')).not.toThrow();
    const slices = splitOnTerm('cost is a+b dollars', 'a+b');
    expect(slices.some((s) => s.match && s.text === 'a+b')).toBe(true);
    // The `+` is literal, not "one-or-more a": it must NOT match plain "aaa".
    expect(splitOnTerm('aaa', 'a+b').some((s) => s.match)).toBe(false);
  });

  it('preserves original casing of the matched text', () => {
    const slices = splitOnTerm('MixEdCase', 'mixedcase');
    expect(slices).toEqual([{ text: 'MixEdCase', match: true }]);
  });

  it('produces no empty slices for adjacent matches', () => {
    const slices = splitOnTerm('foofoo', 'foo');
    expect(slices).toEqual([
      { text: 'foo', match: true },
      { text: 'foo', match: true },
    ]);
    expect(slices.some((s) => s.text === '')).toBe(false);
  });
});

describe('splitOnTerm — clean no-op degradation', () => {
  it('undefined term → whole string, no match', () => {
    expect(splitOnTerm('hello world', undefined)).toEqual([
      { text: 'hello world', match: false },
    ]);
  });

  it('blank / whitespace-only term → no-op', () => {
    expect(splitOnTerm('hello', '')).toEqual([{ text: 'hello', match: false }]);
    expect(splitOnTerm('hello', '   ')).toEqual([{ text: 'hello', match: false }]);
  });

  it('term with no match in the text → whole string, no match', () => {
    expect(splitOnTerm('hello world', 'xyz')).toEqual([
      { text: 'hello world', match: false },
    ]);
  });

  it('empty text → single empty non-match slice (never a crash)', () => {
    expect(splitOnTerm('', 'foo')).toEqual([{ text: '', match: false }]);
  });
});

describe('buildHighlightRegex / hasHighlightTerm', () => {
  it('returns null (no-op signal) for blank/whitespace/undefined', () => {
    expect(buildHighlightRegex(undefined)).toBeNull();
    expect(buildHighlightRegex('')).toBeNull();
    expect(buildHighlightRegex('   ')).toBeNull();
    expect(hasHighlightTerm('  ')).toBe(false);
  });
  it('returns a regex for a real term', () => {
    expect(buildHighlightRegex('foo')).toBeInstanceOf(RegExp);
    expect(hasHighlightTerm('foo')).toBe(true);
  });
});
