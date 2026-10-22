import React from 'react';
import { Link } from 'react-router-dom';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import { markdownExcerpt, markdownToPlainText } from '../../utils/markdownExcerpt';
import { rehypeLinkifyNavIds } from '../../utils/navIdLinkify';
import { rehypeHighlightTerm } from '../../utils/highlightText';
import { useHighlightTerm } from './HighlightRegion';
import './MarkdownContent.css';
import '../../styles/searchHighlight.css';

/**
 * Shared, sanitized GitHub-flavored markdown renderer for context content.
 *
 * This is the ONE component every full-content render site uses, so formatting,
 * overflow handling, and (critically) the security posture are defined in a
 * single place and cannot drift.
 *
 * Security posture (the #1 requirement):
 *  - Content is authored by LLMs (Claude/GPT/Gemini/...) and users, so it is
 *    UNTRUSTED. We never use dangerouslySetInnerHTML with it.
 *  - We do NOT enable rehype-raw, so raw HTML embedded in the markdown source is
 *    treated as literal text (or dropped), never parsed into live DOM. A
 *    `<script>` / `<iframe>` / `<img onerror=...>` in the source therefore cannot
 *    become an executing element.
 *  - rehype-sanitize runs as defense-in-depth on the produced HAST: the default
 *    schema strips event-handler attributes and restricts href/src to safe
 *    protocols, so markdown like `[x](javascript:alert(1))` or
 *    `![x](javascript:alert(1))` loses its dangerous URL.
 *  - Links render with rel="noopener noreferrer" and target="_blank".
 */

// Clone the library default schema (already strict: no script/iframe, no on*
// handlers, only http/https/mailto/... protocols) and only widen it enough to
// render GFM task-list checkbox state. We intentionally keep it strict otherwise.
const sanitizeSchema = {
  ...defaultSchema,
  // Feature B widens the tag allow-list by EXACTLY ONE tag — `<mark>` — so the
  // highlight decorator's marks survive sanitize. No attributes are added for it
  // (our marks are bare), and no protocols/other tags are touched: sanitize stays
  // the strict final authority (script/iframe/on*-handlers/js: urls still stripped).
  tagNames: [...(defaultSchema.tagNames || []), 'mark'],
  attributes: {
    ...defaultSchema.attributes,
    // GFM task lists emit `<input type="checkbox" checked disabled>`. The default
    // schema allows `type` + `disabled` but not `checked`; allow it so a checked
    // task item actually renders checked. `checked`/`disabled` are inert here.
    input: [...(defaultSchema.attributes?.input || []), 'checked'],
  },
};

const remarkPlugins = [remarkGfm];

export interface MarkdownContentProps {
  /** Raw content string (markdown or plain text). Null/undefined renders empty. */
  content?: string | null;
  /** Extra class appended to the `.markdown-content` wrapper. */
  className?: string;
  /** Inline styles applied to the wrapper (e.g. maxHeight + overflow for a pane). */
  style?: React.CSSProperties;
  /**
   * Search term to highlight (Feature B). Usually omitted — the term is picked up
   * ambiently from an enclosing HighlightRegion — but an explicit prop overrides it
   * (direct/testable usage). Blank is a clean no-op.
   */
  highlightQuery?: string;
}

const components: Components = {
  // Strip react-markdown's internal `node` prop so it never leaks into the DOM
  // as `node="[object Object]"`; href has already been protocol-sanitized by
  // rehype-sanitize at this point.
  a({ node: _node, children, href, ...props }) {
    // INTERNAL links (linkified ids `/r/<id>`, or any author-written in-app path)
    // render as a react-router <Link> so the record opens in the SAME tab via
    // client-side navigation — no full page reload, no new tab. A relative-path
    // href starting with a single '/' (but not '//', which is protocol-relative
    // and therefore external) is in-app.
    if (typeof href === 'string' && href.startsWith('/') && !href.startsWith('//')) {
      return <Link to={href}>{children}</Link>;
    }
    // EXTERNAL links keep the hardened new-tab behavior.
    return (
      <a {...props} href={href} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    );
  },
};

const MarkdownContent: React.FC<MarkdownContentProps> = ({
  content,
  className,
  style,
  highlightQuery,
}) => {
  const text = content ?? '';
  const wrapperClass = className ? `markdown-content ${className}` : 'markdown-content';
  const term = useHighlightTerm(highlightQuery);

  // Rehype pipeline order is LOAD-BEARING:
  //   1. rehypeLinkifyNavIds — id-shaped tokens → internal `/r/<id>` links.
  //   2. rehypeHighlightTerm — (only when a term is active) wraps matches in <mark>;
  //      runs AFTER linkify so a <mark> can never split an id token, and composes
  //      with links (highlights inside a linkified id too).
  //   3. rehypeSanitize      — the FINAL security authority over the WHOLE tree
  //      (runs LAST, so it validates our injected links AND marks).
  const rehypePlugins = React.useMemo(() => {
    const plugins: unknown[] = [rehypeLinkifyNavIds];
    if (term) plugins.push(rehypeHighlightTerm(term));
    plugins.push([rehypeSanitize, sanitizeSchema]);
    return plugins as any;
  }, [term]);

  return (
    <div className={wrapperClass} style={style}>
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={rehypePlugins}
        components={components}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
};

export default MarkdownContent;

// Re-export the excerpt helpers from the shared markdown module so preview sites
// can pull the component or the excerpt from one place.
export { markdownExcerpt, markdownToPlainText };
