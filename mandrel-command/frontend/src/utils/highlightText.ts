/**
 * Feature B — the search-term HIGHLIGHT decorator for the MarkdownContent rehype
 * pipeline. This is the SECOND TextDecorator that composes through Feature C's
 * `rehypeDecorateText` factory (navIdLinkify.ts documents the exact hook point):
 * it is added to MarkdownContent's rehypePlugins IMMEDIATELY AFTER
 * rehypeLinkifyNavIds and BEFORE rehypeSanitize.
 *
 * WHY IT REUSES THE FACTORY: there is exactly ONE text-splitting walk
 * (rehypeDecorateText) shared by linkify and highlight — no second pipeline. And
 * the term-MATCHING itself is the single source `splitOnTerm` (highlightMatch.ts),
 * shared with the plain-text path and the list-card excerpts.
 *
 * COMPOSITION: highlight runs AFTER linkify, so a linkified id is already an `<a>`
 * whose visible text is a plain text node; because highlight does NOT skip `<a>`,
 * it descends and can wrap a matching run in `<mark>` INSIDE the link — the id
 * still links AND highlights. It runs BEFORE sanitize, so sanitize stays the final
 * authority (MarkdownContent widens the schema to allow the `<mark>` TAG only).
 *
 * SKIP: `<pre>` (code blocks) is skipped, mirroring linkify — we do not rewrite
 * code. `<a>` is intentionally NOT skipped (we want to highlight inside links).
 *
 * SECURITY: the decorator only reads text-node strings and builds NEW `<mark>`
 * element nodes whose child is a plain text node (React-escaped on render); it
 * never sets innerHTML and never moves text into an attribute — no XSS surface.
 */

import type { HastNode, TextDecorator } from './rehypeDecorateText';
import { rehypeDecorateText } from './rehypeDecorateText';
import { splitOnTerm } from './highlightMatch';

/**
 * Build a TextDecorator that wraps case-insensitive matches of `term` in a bare
 * `<mark>` element node. A blank term or a text with no match returns the text
 * unchanged (a clean no-op — no empty marks).
 */
export function buildHighlightDecorator(term: string | undefined | null): TextDecorator {
  return (value: string): HastNode[] => {
    const slices = splitOnTerm(value, term);
    // Fast path: nothing matched → one unchanged text node.
    if (slices.length === 1 && !slices[0].match) {
      return [{ type: 'text', value }];
    }
    return slices.map((slice) =>
      slice.match
        ? {
            type: 'element',
            tagName: 'mark',
            // Bare <mark>: no attributes, so the sanitize schema only needs the TAG
            // allowed (not any attribute). Styled by the element selector in
            // styles/searchHighlight.css.
            properties: {},
            children: [{ type: 'text', value: slice.text }],
          }
        : { type: 'text', value: slice.text },
    );
  };
}

/**
 * The rehype plugin: highlight `term` in all eligible text nodes. Skips `<pre>`
 * (never rewrite code blocks); does NOT skip `<a>` (highlight inside links too).
 * Build it per-render with the active term and place it AFTER rehypeLinkifyNavIds
 * and BEFORE rehypeSanitize.
 */
export function rehypeHighlightTerm(term: string | undefined | null) {
  return rehypeDecorateText(buildHighlightDecorator(term), { skipTags: ['pre'] });
}
