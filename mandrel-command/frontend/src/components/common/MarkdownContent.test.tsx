/*
 * This suite does NOT use @testing-library; it renders the real pipeline to an
 * HTML STRING via react-dom/server's renderToStaticMarkup.
 * no-script-url is disabled below: the `javascript:` strings are intentional
 * malicious payloads that the sanitization tests assert are neutralized.
 */
/* eslint-disable no-script-url */
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { StaticRouter } from 'react-router-dom/server';
import MarkdownContent from './MarkdownContent';
import HighlightRegion from './HighlightRegion';

/**
 * These tests render the REAL react-markdown + remark-gfm + rehype-sanitize
 * pipeline to a static HTML string (no @testing-library dependency) and assert
 * on the produced markup. Importing react-markdown here also proves the CRA/Jest
 * ESM transform is configured — without the transformIgnorePatterns
 * override this file fails to even import.
 *
 * Wrapped in StaticRouter (the server-render router) because MarkdownContent now
 * renders internal links (linkified ids + in-app paths) as react-router <Link>,
 * which needs router context — StaticRouter avoids the useLayoutEffect SSR warning.
 */
const mdToHtml = (content: string): string =>
  renderToStaticMarkup(
    <StaticRouter location="/">
      <MarkdownContent content={content} />
    </StaticRouter>,
  );

/** Render with an explicit highlight term (Feature B). */
const mdToHtmlH = (content: string, term?: string): string =>
  renderToStaticMarkup(
    <StaticRouter location="/">
      <MarkdownContent content={content} highlightQuery={term} />
    </StaticRouter>,
  );

/** Render inside a HighlightRegion so the term is AMBIENT (no prop threaded). */
const mdInRegion = (content: string, term?: string): string =>
  renderToStaticMarkup(
    <StaticRouter location="/">
      <HighlightRegion term={term}>
        <MarkdownContent content={content} />
      </HighlightRegion>
    </StaticRouter>,
  );

describe('MarkdownContent rendering', () => {
  it('renders headings as heading tags', () => {
    const html = mdToHtml('# Title');
    expect(html).toContain('<h1');
    expect(html).toContain('Title');
  });

  it('renders bold and italic', () => {
    const html = mdToHtml('**bold** and *italic*');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<em>italic</em>');
  });

  it('renders unordered lists', () => {
    const html = mdToHtml('- one\n- two');
    expect(html).toContain('<ul');
    expect(html).toContain('<li>');
    expect(html).toContain('one');
    expect(html).toContain('two');
  });

  it('renders fenced code blocks', () => {
    const html = mdToHtml('```js\nconst x = 1;\n```');
    expect(html).toContain('<pre>');
    expect(html).toContain('<code');
    expect(html).toContain('const x = 1;');
  });

  it('renders GFM tables', () => {
    const html = mdToHtml('| a | b |\n| - | - |\n| 1 | 2 |');
    expect(html).toContain('<table>');
    expect(html).toContain('<th');
    expect(html).toContain('<td');
  });

  it('renders GFM strikethrough and task lists', () => {
    expect(mdToHtml('~~gone~~')).toContain('<del>');
    const tasks = mdToHtml('- [x] done\n- [ ] todo');
    expect(tasks).toContain('type="checkbox"');
    expect(tasks).toContain('checked');
  });

  it('degrades gracefully on plain text (renders a paragraph)', () => {
    const html = mdToHtml('just some plain text, no markdown here');
    expect(html).toContain('<p>just some plain text, no markdown here</p>');
  });

  it('renders safe http links with rel=noopener noreferrer and target=_blank', () => {
    const html = mdToHtml('[docs](https://example.com)');
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('target="_blank"');
    // react-markdown's internal `node` prop must not leak into the DOM.
    expect(html).not.toContain('node=');
    expect(html).not.toContain('[object Object]');
  });

  it('renders empty for null/undefined content', () => {
    expect(renderToStaticMarkup(<MarkdownContent content={null} />)).not.toContain('undefined');
    expect(renderToStaticMarkup(<MarkdownContent content={undefined} />)).not.toContain('null');
  });
});

describe('MarkdownContent sanitization (load-bearing XSS guard)', () => {
  it('neutralizes a raw <script> tag (no executable script element)', () => {
    const html = mdToHtml('Hello <script>alert(1)</script> world');
    // The raw HTML is treated as inert text, never parsed into a live element:
    // no <script> tag exists in the output, so nothing can execute. (The literal
    // characters "alert(1)" may remain as harmless visible text, like GitHub.)
    expect(html).not.toContain('<script');
    expect(html).not.toContain('</script>');
  });

  it('neutralizes a raw <iframe>', () => {
    const html = mdToHtml('<iframe src="https://evil.example"></iframe>');
    expect(html).not.toContain('<iframe');
  });

  it('strips inline event handlers from raw HTML (img onerror)', () => {
    const html = mdToHtml('<img src=x onerror="alert(1)">');
    expect(html).not.toContain('onerror');
    expect(html).not.toContain('alert(1)');
  });

  it('strips javascript: URLs from markdown links', () => {
    const html = mdToHtml('[click me](javascript:alert(1))');
    expect(html.toLowerCase()).not.toContain('javascript:');
  });

  it('strips javascript: URLs from markdown images', () => {
    const html = mdToHtml('![x](javascript:alert(1))');
    expect(html.toLowerCase()).not.toContain('javascript:');
  });

  it('strips data: URLs from markdown images (no data:text/html payload)', () => {
    const html = mdToHtml('![x](data:text/html;base64,PHNjcmlwdD4=)');
    expect(html.toLowerCase()).not.toContain('data:text/html');
  });

  it('does not pass through arbitrary raw HTML attributes/styles', () => {
    const html = mdToHtml('<div style="position:fixed" onclick="steal()">x</div>');
    expect(html).not.toContain('onclick');
    expect(html).not.toContain('steal()');
  });
});

describe('MarkdownContent id interlinking (Feature C)', () => {
  it('linkifies an id token in content to an internal /r/<id> link', () => {
    const html = mdToHtml('See b822dfcb for details.');
    expect(html).toContain('href="/r/b822dfcb"');
    expect(html).toContain('b822dfcb');
    // Internal links render as a react-router Link — a SAME-TAB navigation, so no
    // target=_blank on it (that is reserved for external links).
    expect(html).toMatch(/<a href="\/r\/b822dfcb">b822dfcb<\/a>/);
  });

  it('leaves an ordinary hex-ish word (no digit) as plain text — no link', () => {
    const html = mdToHtml('The deadbeef facade of a defaced cafe.');
    expect(html).not.toContain('href="/r/');
    expect(html).toContain('deadbeef');
  });

  it('linkifies a threading tag (decision:<id>) inside content', () => {
    const html = mdToHtml('per decision:6aaad6ce we shipped it');
    expect(html).toContain('href="/r/6aaad6ce"');
  });

  it('survives sanitize: the injected link uses a safe relative href (no XSS)', () => {
    // linkify runs BEFORE sanitize, so sanitize validates our anchors too. A
    // relative /r/ href is safe; no javascript:/data: could ever be produced.
    const html = mdToHtml('id 0f3906cd here');
    expect(html.toLowerCase()).not.toContain('javascript:');
    expect(html).toContain('href="/r/0f3906cd"');
  });

  it('does NOT linkify an id inside a fenced code block', () => {
    const html = mdToHtml('```\nb822dfcb\n```');
    expect(html).toContain('<pre>');
    expect(html).not.toContain('href="/r/b822dfcb"');
  });
});

describe('MarkdownContent search-term highlight (Feature B)', () => {
  it('wraps a matching term in <mark> (case-insensitive)', () => {
    const html = mdToHtmlH('The Session lock was held', 'session');
    expect(html).toContain('<mark>Session</mark>');
  });

  it('no term → NO <mark> (identical to the plain render, clean no-op)', () => {
    const content = 'plain body with a term inside';
    expect(mdToHtmlH(content, undefined)).not.toContain('<mark');
    expect(mdToHtmlH(content, undefined)).toBe(mdToHtml(content));
  });

  it('blank / whitespace-only term → NO <mark> (no-op, no empty marks)', () => {
    expect(mdToHtmlH('body text', '')).not.toContain('<mark');
    expect(mdToHtmlH('body text', '   ')).not.toContain('<mark');
  });

  it('term with no match → NO <mark>', () => {
    expect(mdToHtmlH('body text', 'zzz')).not.toContain('<mark');
  });

  it('does NOT highlight inside a fenced code block (pre skipped)', () => {
    const html = mdToHtmlH('```\nsession\n```', 'session');
    expect(html).toContain('<pre>');
    expect(html).not.toContain('<mark');
  });

  it('COMPOSES with linkify: an id that matches the term LINKS and HIGHLIGHTS', () => {
    // term "b822" is a prefix of id b822dfcb: the whole id still links, and the
    // matching run is <mark>ed inside the link.
    const html = mdToHtmlH('see b822dfcb here', 'b822');
    expect(html).toContain('href="/r/b822dfcb"');
    expect(html).toMatch(/<mark>b822<\/mark>/i);
    // The <mark> sits INSIDE the anchor (highlight ran after linkify).
    expect(html).toMatch(/<a href="\/r\/b822dfcb"><mark>b822<\/mark>dfcb<\/a>/i);
  });

  it('a <mark> never breaks id detection (full id still resolves to /r/<id>)', () => {
    const html = mdToHtmlH('id 0f3906cd matters', '0f39');
    expect(html).toContain('href="/r/0f3906cd"');
  });

  it('picks up the term AMBIENTLY from an enclosing HighlightRegion', () => {
    const html = mdInRegion('the ambient session term', 'session');
    expect(html).toContain('<mark>session</mark>');
    // The region root carries Feature A's data-highlight-query marker.
    expect(html).toContain('data-highlight-query="session"');
  });
});

describe('MarkdownContent sanitize still strips danger WITH a highlight term (no XSS regression)', () => {
  it('allows <mark> but still strips a raw <script>', () => {
    const html = mdToHtmlH('Hello <script>alert(1)</script> session', 'session');
    expect(html).toContain('<mark>session</mark>'); // widened: mark is allowed
    expect(html).not.toContain('<script'); // NOT widened: script still stripped
    expect(html).not.toContain('</script>');
  });

  it('still strips javascript: URLs from links even with a term active', () => {
    const html = mdToHtmlH('[click me](javascript:alert(1)) session', 'session');
    expect(html.toLowerCase()).not.toContain('javascript:');
    expect(html).toContain('<mark>session</mark>');
  });

  it('still strips inline event handlers with a term active', () => {
    const html = mdToHtmlH('<img src=x onerror="alert(1)"> session', 'session');
    expect(html).not.toContain('onerror');
    expect(html).not.toContain('alert(1)');
  });

  it('the <mark> we allow carries no attributes (schema widened by tag only)', () => {
    // A term whose text is attribute-shaped must still yield a BARE <mark>.
    const html = mdToHtmlH('the class=evil marker', 'class=evil');
    // The produced mark opening tag is exactly `<mark>` (no attributes injected).
    expect(html).toMatch(/<mark>class=evil<\/mark>/);
    expect(html).not.toMatch(/<mark [^>]/);
  });
});
