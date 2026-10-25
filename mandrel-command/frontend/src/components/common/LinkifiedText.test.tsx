/*
 * LinkifiedText: plain-text id-linkify + Feature B search-term highlight, composed.
 * Rendered to a static HTML string (no @testing-library, matching MarkdownContent's
 * suite) and wrapped in StaticRouter because it emits react-router <Link>s.
 */
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { StaticRouter } from 'react-router-dom/server';
import LinkifiedText from './LinkifiedText';
import HighlightRegion from './HighlightRegion';

const render = (text: string, term?: string): string =>
  renderToStaticMarkup(
    <StaticRouter location="/">
      <LinkifiedText text={text} highlightQuery={term} />
    </StaticRouter>,
  );

const renderInRegion = (text: string, term?: string): string =>
  renderToStaticMarkup(
    <StaticRouter location="/">
      <HighlightRegion term={term}>
        <LinkifiedText text={text} />
      </HighlightRegion>
    </StaticRouter>,
  );

describe('LinkifiedText — highlight', () => {
  it('wraps a matching term in <mark> (case-insensitive)', () => {
    const html = render('The Problem Statement', 'problem');
    expect(html).toMatch(/<mark[^>]*>Problem<\/mark>/);
  });

  it('no term → plain text, NO <mark> (clean no-op)', () => {
    const html = render('some decision rationale', undefined);
    expect(html).not.toContain('<mark');
    expect(html).toContain('some decision rationale');
  });

  it('blank / whitespace term → NO <mark>', () => {
    expect(render('body', '')).not.toContain('<mark');
    expect(render('body', '   ')).not.toContain('<mark');
  });

  it('term with no match → NO <mark>', () => {
    expect(render('body', 'zzz')).not.toContain('<mark');
  });

  it('picks up the term AMBIENTLY from an enclosing HighlightRegion', () => {
    const html = renderInRegion('ambient rationale text', 'rationale');
    expect(html).toMatch(/<mark[^>]*>rationale<\/mark>/);
  });
});

describe('LinkifiedText — composition (highlight ∘ linkify)', () => {
  it('an id that also matches the term LINKS (whole id) AND HIGHLIGHTS inside it', () => {
    // term "b822" is a prefix of id b822f00d.
    const html = render('see b822f00d now', 'b822');
    expect(html).toContain('href="/r/b822f00d"');
    expect(html).toMatch(/<mark[^>]*>b822<\/mark>/);
    // The <mark> is INSIDE the <a> (segment linkified first, then split on term).
    expect(html).toMatch(/<a href="\/r\/b822f00d"><mark[^>]*>b822<\/mark>f00d<\/a>/);
  });

  it('links an id and highlights ordinary prose beside it', () => {
    const html = render('problem b822f00d here', 'problem');
    expect(html).toContain('href="/r/b822f00d"');
    expect(html).toMatch(/<mark[^>]*>problem<\/mark>/);
  });

  it('renders no raw HTML injection surface (term/text are escaped)', () => {
    const html = render('<script>alert(1)</script> danger', 'danger');
    // React escapes the text; no live <script> element is produced.
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toMatch(/<mark[^>]*>danger<\/mark>/);
  });
});
