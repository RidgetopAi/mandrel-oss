/**
 * Pure-logic tests for the SINGLE source of id detection (segmentNavIds) plus the
 * href builder and the composable rehype linkify plugin. These are the "tests are
 * the rock" guard for Feature C: they pin exactly which tokens become links, which
 * ordinary hex-ish words are LEFT ALONE (no false positives), and that the plugin
 * skips <a>/<pre> subtrees so it never double-links or rewrites code.
 */

import {
  segmentNavIds,
  buildNavHref,
  linkifyNavIdsDecorator,
  rehypeLinkifyNavIds,
} from './navIdLinkify';
import type { HastNode, HastElement } from './rehypeDecorateText';

describe('buildNavHref', () => {
  it('builds /r/<short-id>', () => {
    expect(buildNavHref('b822f00d')).toBe('/r/b822f00d');
  });
  it('strips dashes and lowercases a full UUID', () => {
    expect(buildNavHref('0F39F00D-DB79-4D2A-8B3C-1A2B3C4D5E6F')).toBe(
      '/r/0f39f00ddb794d2a8b3c1a2b3c4d5e6f',
    );
  });
});

describe('segmentNavIds — DETECTS id forms', () => {
  const linkSegs = (s: string) => segmentNavIds(s).filter((seg) => seg.href);

  it('detects an 8-hex short id that contains a digit', () => {
    const segs = segmentNavIds('see b822f00d here');
    expect(segs).toEqual([
      { text: 'see ' },
      { text: 'b822f00d', href: '/r/b822f00d' },
      { text: ' here' },
    ]);
  });

  it('detects a full dashed UUID (whole token, not just its first 8 hex)', () => {
    const uuid = '0f39f00d-db79-4d2a-8b3c-1a2b3c4d5e6f';
    const segs = segmentNavIds(`ref ${uuid}.`);
    expect(segs).toContainEqual({
      text: uuid,
      href: '/r/0f39f00ddb794d2a8b3c1a2b3c4d5e6f',
    });
  });

  it('detects threading tags task:/decision:/context: and links the whole token', () => {
    expect(segmentNavIds('task:34910609')).toEqual([
      { text: 'task:34910609', href: '/r/34910609' },
    ]);
    expect(segmentNavIds('decision:6aaaf00d')).toEqual([
      { text: 'decision:6aaaf00d', href: '/r/6aaaf00d' },
    ]);
    expect(segmentNavIds('context:0f39f00d')).toEqual([
      { text: 'context:0f39f00d', href: '/r/0f39f00d' },
    ]);
  });

  it('detects multiple ids in one string', () => {
    expect(linkSegs('a1b2c3d4 and e5f6a7b8')).toHaveLength(2);
  });

  it('accepts uppercase hex and normalizes the href to lowercase', () => {
    expect(segmentNavIds('B822F00D')).toEqual([
      { text: 'B822F00D', href: '/r/b822f00d' },
    ]);
  });
});

describe('segmentNavIds — LEAVES non-ids alone (no false positives)', () => {
  const noLinks = (s: string) => expect(segmentNavIds(s).some((x) => x.href)).toBe(false);

  it('ignores an all-letter hex word (no digit): deadbeef, deface, facade', () => {
    noLinks('deadbeef');
    noLinks('the facade of a defaced cafe');
  });

  it('ignores a hex run shorter than the 8-char floor', () => {
    noLinks('abc123');
    noLinks('1a2b3c'); // 6
  });

  it('ignores a hex run longer than 32 (e.g. a 40-char sha1 / 64-char sha256)', () => {
    noLinks('a'.repeat(39) + '1'); // 40 chars, has a digit → still not an id
    noLinks('deadbeef'.repeat(8)); // 64 chars
  });

  it('ignores hex embedded in a larger token (0xdeadbeef1, foo-0f39f00d1)', () => {
    noLinks('0xdeadbeef1');
    noLinks('foo-0f39f00d1bar');
  });

  it('ignores ordinary prose with short hex-ish words', () => {
    noLinks('The decade cafe faced a facade and fed a bee.');
  });

  it('returns a single plain-text segment for empty / plain input', () => {
    expect(segmentNavIds('')).toEqual([{ text: '' }]);
    expect(segmentNavIds('just words')).toEqual([{ text: 'just words' }]);
  });
});

describe('linkifyNavIdsDecorator — HAST output', () => {
  it('wraps an id token in an <a> element whose href is the /r landing', () => {
    const nodes = linkifyNavIdsDecorator('id b822f00d');
    const anchor = nodes.find(
      (n): n is HastElement => (n as HastElement).tagName === 'a',
    );
    expect(anchor).toBeDefined();
    expect(anchor!.properties).toEqual({ href: '/r/b822f00d' });
    expect(anchor!.children).toEqual([{ type: 'text', value: 'b822f00d' }]);
  });

  it('returns a single unchanged text node when there is nothing to linkify', () => {
    expect(linkifyNavIdsDecorator('plain deadbeef text')).toEqual([
      { type: 'text', value: 'plain deadbeef text' },
    ]);
  });
});

describe('rehypeLinkifyNavIds — tree transform + skip subtrees', () => {
  const run = (tree: HastNode) => {
    const transformer = rehypeLinkifyNavIds();
    transformer(tree as any);
    return tree;
  };

  it('linkifies id tokens inside a paragraph text node', () => {
    const tree: any = {
      type: 'root',
      children: [
        { type: 'element', tagName: 'p', properties: {}, children: [{ type: 'text', value: 'ref b822f00d' }] },
      ],
    };
    run(tree);
    const p = tree.children[0];
    const anchor = p.children.find((c: any) => c.tagName === 'a');
    expect(anchor.properties.href).toBe('/r/b822f00d');
  });

  it('does NOT descend into <a> (never double-links) or <pre> (never rewrites code)', () => {
    const tree: any = {
      type: 'root',
      children: [
        { type: 'element', tagName: 'a', properties: { href: '/x' }, children: [{ type: 'text', value: 'b822f00d' }] },
        { type: 'element', tagName: 'pre', properties: {}, children: [
          { type: 'element', tagName: 'code', properties: {}, children: [{ type: 'text', value: 'b822f00d' }] },
        ] },
      ],
    };
    run(tree);
    // The <a> keeps its single text child (no nested <a> injected).
    expect(tree.children[0].children).toEqual([{ type: 'text', value: 'b822f00d' }]);
    // The <pre>/<code> text is untouched.
    expect(tree.children[1].children[0].children).toEqual([{ type: 'text', value: 'b822f00d' }]);
  });
});
