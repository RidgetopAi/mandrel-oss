import { markdownToPlainText, markdownExcerpt } from './markdownExcerpt';

describe('markdownToPlainText', () => {
  it('returns empty string for null/undefined/empty', () => {
    expect(markdownToPlainText(undefined)).toBe('');
    expect(markdownToPlainText(null)).toBe('');
    expect(markdownToPlainText('')).toBe('');
  });

  it('strips heading markers but keeps the text', () => {
    expect(markdownToPlainText('# ★ HANDOFF')).toBe('★ HANDOFF');
    expect(markdownToPlainText('### Sub heading')).toBe('Sub heading');
  });

  it('strips bold / italic / strikethrough markers', () => {
    expect(markdownToPlainText('a **bold** and *italic* and ~~gone~~')).toBe(
      'a bold and italic and gone'
    );
    expect(markdownToPlainText('__strong__ and _em_')).toBe('strong and em');
  });

  it('strips inline and fenced code fences but keeps code text', () => {
    expect(markdownToPlainText('use `npm ci` now')).toBe('use npm ci now');
    expect(markdownToPlainText('```js\nconst x = 1;\n```')).toBe('const x = 1;');
  });

  it('reduces links and images to their text/alt', () => {
    expect(markdownToPlainText('see [the docs](https://example.com)')).toBe('see the docs');
    expect(markdownToPlainText('![a diagram](https://x/y.png)')).toBe('a diagram');
  });

  it('strips list markers and task-list checkboxes', () => {
    expect(markdownToPlainText('- one\n- two')).toBe('one two');
    expect(markdownToPlainText('1. first\n2. second')).toBe('first second');
    expect(markdownToPlainText('- [ ] todo\n- [x] done')).toBe('todo done');
  });

  it('flattens tables and blockquotes into readable text', () => {
    expect(markdownToPlainText('> quoted line')).toBe('quoted line');
    const table = '| a | b |\n| - | - |\n| 1 | 2 |';
    const out = markdownToPlainText(table);
    expect(out).toContain('a');
    expect(out).toContain('b');
    expect(out).not.toContain('|');
  });

  it('collapses whitespace and newlines', () => {
    expect(markdownToPlainText('a\n\n\nb   c')).toBe('a b c');
  });
});

describe('markdownExcerpt', () => {
  it('returns the full clean text when under the limit', () => {
    expect(markdownExcerpt('# Hello **world**', 100)).toBe('Hello world');
  });

  it('truncates long content with an ellipsis and no cut-off syntax', () => {
    const long = '# Heading\n\n' + 'word '.repeat(80);
    const out = markdownExcerpt(long, 40);
    expect(out.endsWith('...')).toBe(true);
    expect(out.length).toBeLessThanOrEqual(43); // 40 + '...'
    // No leftover markdown syntax fragments in the preview.
    expect(out).not.toContain('#');
    expect(out).not.toContain('**');
  });

  it('does not show a dangling ** from a truncated bold run', () => {
    const content = 'This is **a very important and quite long bold statement** indeed';
    const out = markdownExcerpt(content, 20);
    expect(out).not.toContain('**');
  });

  it('handles null/undefined gracefully', () => {
    expect(markdownExcerpt(undefined, 50)).toBe('');
    expect(markdownExcerpt(null, 50)).toBe('');
  });
});
