/**
 * Pure-logic tests for the Feature B highlight TextDecorator and its composition
 * with Feature C's linkify — at the HAST level, no React render needed.
 *
 * These prove: (1) the decorator wraps matches in a bare <mark> element node (no
 * attributes → minimal sanitize surface), (2) a no-op term returns text unchanged,
 * (3) it REUSES the composable rehypeDecorateText factory (single walk) and skips
 * <pre>, and (4) the ORDER contract — linkify then highlight — lets a term inside a
 * linkified id both LINK and HIGHLIGHT while a <mark> never breaks id detection.
 */
import { buildHighlightDecorator, rehypeHighlightTerm } from './highlightText';
import { rehypeLinkifyNavIds } from './navIdLinkify';
import type { HastElement, HastNode, HastText } from './rehypeDecorateText';

const el = (tagName: string, children: HastNode[]): HastElement => ({
  type: 'element',
  tagName,
  properties: {},
  children,
});
const txt = (value: string): HastText => ({ type: 'text', value });

describe('buildHighlightDecorator', () => {
  it('wraps a match in a bare <mark> element node (no attributes)', () => {
    const nodes = buildHighlightDecorator('lock')('a lock here') as HastElement[];
    expect(nodes.map((n) => (n as any).tagName ?? (n as any).type)).toEqual([
      'text',
      'mark',
      'text',
    ]);
    const mark = nodes[1] as HastElement;
    expect(mark.tagName).toBe('mark');
    expect(mark.properties).toEqual({}); // no attributes → schema needs only the tag
    expect((mark.children[0] as HastText).value).toBe('lock');
  });

  it('is a clean no-op for a blank term (single unchanged text node)', () => {
    expect(buildHighlightDecorator('')('unchanged text')).toEqual([txt('unchanged text')]);
    expect(buildHighlightDecorator(undefined)('unchanged text')).toEqual([
      txt('unchanged text'),
    ]);
  });

  it('is a clean no-op when the term does not occur', () => {
    expect(buildHighlightDecorator('zzz')('nothing to see')).toEqual([txt('nothing to see')]);
  });
});

describe('rehypeHighlightTerm — reuses the factory, skips <pre>', () => {
  const run = (tree: HastNode, term: string) => {
    (rehypeHighlightTerm(term)() as (t: HastNode) => void)(tree);
    return tree;
  };

  it('highlights matching text in the tree', () => {
    const tree = el('div', [el('p', [txt('the alpha and beta')])]);
    run(tree, 'alpha');
    const p = (tree as HastElement).children[0] as HastElement;
    expect(p.children.map((c) => (c as any).tagName ?? (c as any).type)).toEqual([
      'text',
      'mark',
      'text',
    ]);
  });

  it('does NOT highlight inside a <pre> code block (skipped subtree)', () => {
    const tree = el('div', [el('pre', [el('code', [txt('alpha')])])]);
    run(tree, 'alpha');
    const pre = (tree as HastElement).children[0] as HastElement;
    const code = pre.children[0] as HastElement;
    // Untouched: still a single text node, no <mark> injected.
    expect(code.children).toEqual([txt('alpha')]);
  });
});

describe('composition — linkify BEFORE highlight (the order contract)', () => {
  // Simulate MarkdownContent's pipeline order on a shared tree: linkify then highlight.
  const linkifyThenHighlight = (tree: HastNode, term: string) => {
    (rehypeLinkifyNavIds() as (t: HastNode) => void)(tree);
    (rehypeHighlightTerm(term)() as (t: HastNode) => void)(tree);
    return tree;
  };

  it('an id that also matches the term LINKS (whole id) AND HIGHLIGHTS inside it', () => {
    // term "b822" is a prefix of the id b822dfcb.
    const tree = el('p', [txt('see b822dfcb now')]);
    linkifyThenHighlight(tree, 'b822');
    const p = tree as HastElement;
    // Linkify produced an <a href="/r/b822dfcb"> around the WHOLE id (detection ran
    // first, so the <mark> could not split the token).
    const anchor = p.children.find(
      (c) => (c as HastElement).tagName === 'a',
    ) as HastElement;
    expect(anchor).toBeDefined();
    expect((anchor.properties as any).href).toBe('/r/b822dfcb');
    // Highlight then descended INTO the link and wrapped the matching run in <mark>.
    const markInLink = anchor.children.find(
      (c) => (c as HastElement).tagName === 'mark',
    ) as HastElement;
    expect(markInLink).toBeDefined();
    expect((markInLink.children[0] as HastText).value.toLowerCase()).toBe('b822');
    // The rest of the id remains link text (so the whole token still resolves).
    const joined = anchor.children
      .map((c) =>
        (c as HastElement).tagName === 'mark'
          ? ((c as HastElement).children[0] as HastText).value
          : (c as HastText).value,
      )
      .join('');
    expect(joined).toBe('b822dfcb');
  });

  it('highlighting ordinary prose next to an id leaves the id link intact', () => {
    const tree = el('p', [txt('lock and b822dfcb')]);
    linkifyThenHighlight(tree, 'lock');
    const p = tree as HastElement;
    const anchor = p.children.find(
      (c) => (c as HastElement).tagName === 'a',
    ) as HastElement;
    expect((anchor.properties as any).href).toBe('/r/b822dfcb');
    // The word "lock" outside the link is highlighted.
    const hasMark = p.children.some((c) => (c as HastElement).tagName === 'mark');
    expect(hasMark).toBe(true);
  });
});
