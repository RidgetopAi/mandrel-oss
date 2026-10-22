import React from 'react';
import { Link } from 'react-router-dom';
import { segmentNavIds } from '../../utils/navIdLinkify';
import { splitOnTerm } from '../../utils/highlightMatch';
import { highlightConfig } from '../../config/highlight';
import { useHighlightTerm } from './HighlightRegion';
import '../../styles/searchHighlight.css';

/**
 * Render a PLAIN-TEXT string with id-shaped tokens turned into clickable in-app
 * links — WITHOUT running the text through the markdown pipeline — AND (Feature B)
 * with a search term highlighted.
 *
 * WHY (vs MarkdownContent): some surfaces hold prose that is NOT markdown and must
 * keep its plain-text semantics — chiefly the decision detail fields (problem /
 * decision / rationale / alternatives), which render inside antd <Paragraph>, plus
 * task description / tags / dependencies. Piping them through full markdown could
 * reinterpret leading `#`/`-`/etc. So this is the plain-text sibling of the linkify
 * layer: it reuses the SINGLE source of id detection (segmentNavIds) AND the SINGLE
 * source of highlight matching (splitOnTerm) — the same matchers the markdown/HAST
 * path uses (no drifting second copies).
 *
 * COMPOSITION (highlight ∘ linkify, same term as the markdown path): first split
 * into link/text segments (segmentNavIds), then within EACH segment split on the
 * search term (splitOnTerm) and wrap matches in <mark>. A matched run inside a
 * linkified id therefore both LINKS and HIGHLIGHTS — mirroring the markdown
 * pipeline's linkify→highlight order.
 *
 * SECURITY: input is rendered as React children (text nodes / <mark> / <Link>),
 * never via dangerouslySetInnerHTML; the only attribute we set is a <Link> `to`
 * built by buildNavHref (strict `/r/<hex>`). No untrusted text reaches an
 * attribute — no XSS surface.
 *
 * Whitespace/line breaks are preserved by the caller's container (e.g. antd
 * <Paragraph>), matching prior behavior.
 */
export interface LinkifiedTextProps {
  text?: string | null;
  /**
   * Search term to highlight. Usually omitted (picked up ambiently from an
   * enclosing HighlightRegion); an explicit prop overrides it. Blank = no-op.
   */
  highlightQuery?: string;
}

/** Render a string with search-term matches wrapped in <mark> (clean no-op when none). */
function renderHighlighted(value: string, term: string | undefined, keyBase: string): React.ReactNode {
  const slices = splitOnTerm(value, term);
  if (slices.length === 1 && !slices[0].match) return value;
  return slices.map((slice, i) =>
    slice.match ? (
      <mark key={`${keyBase}-${i}`} className={highlightConfig.markClassName}>
        {slice.text}
      </mark>
    ) : (
      <React.Fragment key={`${keyBase}-${i}`}>{slice.text}</React.Fragment>
    ),
  );
}

const LinkifiedText: React.FC<LinkifiedTextProps> = ({ text, highlightQuery }) => {
  const value = text ?? '';
  const term = useHighlightTerm(highlightQuery);
  const segments = segmentNavIds(value);

  return (
    <>
      {segments.map((seg, i) =>
        seg.href ? (
          <Link key={i} to={seg.href}>
            {renderHighlighted(seg.text, term, `l${i}`)}
          </Link>
        ) : (
          <React.Fragment key={i}>
            {renderHighlighted(seg.text, term, `t${i}`)}
          </React.Fragment>
        ),
      )}
    </>
  );
};

export default LinkifiedText;
