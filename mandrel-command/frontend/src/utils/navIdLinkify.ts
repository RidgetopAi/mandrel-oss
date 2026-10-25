/**
 * Detection + linkification of Mandrel record ids inside rendered content.
 *
 * SINGLE SOURCE OF ID DETECTION: `segmentNavIds` is the ONE function
 * that recognizes id-shaped tokens. BOTH content renderers consume it — the
 * markdown/HAST path (rehypeLinkifyNavIds, via the composable rehypeDecorateText
 * factory) and the plain-text path (components/common/LinkifiedText). There is no
 * second regex to drift.
 *
 * WHAT COUNTS AS AN ID (three forms, most-specific first so a UUID is never split):
 *   1. Threading tag   `task:<hex>` / `decision:<hex>` / `context:<hex>` — the whole
 *      token becomes a link to the referenced record.
 *   2. Full UUID       8-4-4-4-12 hex.
 *   3. Bare short/long hex, MIN..MAX chars, that CONTAINS AT LEAST ONE DIGIT.
 *
 * AVOIDING FALSE POSITIVES ON ORDINARY WORDS (the hard requirement): the bare-hex
 * form additionally requires a digit. Every real Mandrel short id has digits
 * (e.g. 1a2b3c4d, 2b3c4d5e), while all-letter hex words that read as
 * English ("deadbeef", "deface", "facade", "cabbage"→has non-hex, "decade") do NOT,
 * so they are left as plain text. Combined with word-ish boundaries (a match cannot
 * be preceded/followed by a word char or dash) this excludes: hex embedded in an
 * identifier (`0xdeadbeef1`), a partial dashed id, and long digests — a 40-char
 * sha1 / 64-char sha256 exceeds MAX and its trailing hex char breaks the boundary,
 * so it never matches. Fail-safe by design: a token we DON'T link stays readable,
 * and a token we DO link that turns out not to resolve lands on the /r not-found
 * page — never a silent wrong jump.
 */

import { navLinksConfig } from '../config/navLinks';
import type { HastNode, TextDecorator } from './rehypeDecorateText';
import { rehypeDecorateText } from './rehypeDecorateText';

const MIN = navLinksConfig.shortIdMinLength;
const MAX = navLinksConfig.shortIdMaxLength;
const BASE = navLinksConfig.resolveRouteBase;

/** The threading-tag keywords whose `:<id>` suffix references a record. */
const TAG_KINDS = 'task|decision|context';

/**
 * The master matcher, rebuilt per scan (a fresh RegExp avoids shared `lastIndex`
 * state). Alternation order is load-bearing: tag → full-UUID → bare-hex, so a
 * dashed UUID is captured whole instead of its leading 8 hex being taken as a
 * bare short id. `(?<![\w-])`/`(?![\w-])` are the word-ish boundaries; the bare
 * branch's `(?=[0-9a-f]*[0-9])` enforces the at-least-one-digit rule.
 */
const PATTERN =
  '(?<![\\w-])' +
  '(?:' +
  `(?:(?<kind>${TAG_KINDS}):(?<tagid>[0-9a-f]{${MIN},${MAX}}))` +
  '|' +
  '(?<uuid>[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})' +
  '|' +
  `(?<bare>(?=[0-9a-f]*[0-9])[0-9a-f]{${MIN},${MAX}})` +
  ')' +
  '(?![\\w-])';

function createRegex(): RegExp {
  return new RegExp(PATTERN, 'gi');
}

/** Strip dashes + lowercase — mirrors the backend resolver's normalizeShortId. */
function normalizeId(rawId: string): string {
  return rawId.replace(/-/g, '').toLowerCase();
}

/**
 * The client-side landing href for a bare id: `${resolveRouteBase}/<normalized>`.
 * ResolveRedirectPage handles this route — it calls GET /api/resolve/<id> and then
 * client-side navigates to the typed detail page (or disambiguates / shows
 * not-found). The id is normalized (dashes stripped) so the href is canonical; the
 * backend re-normalizes anyway.
 */
export function buildNavHref(rawId: string): string {
  return `${BASE}/${normalizeId(rawId)}`;
}

/** A slice of a decorated text string: plain text, or (when href is set) a link. */
export interface NavSegment {
  /** The visible text of this slice. */
  text: string;
  /** When present, this slice is a link to this href (the /r landing). */
  href?: string;
}

/**
 * Split a text string into ordered segments, marking id tokens as links. Pure and
 * fully unit-testable. A string with no ids returns a single plain-text segment.
 */
export function segmentNavIds(value: string): NavSegment[] {
  if (!value) return [{ text: value }];

  const regex = createRegex();
  const segments: NavSegment[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(value)) !== null) {
    const full = match[0];
    const start = match.index;

    // Text before this match.
    if (start > lastIndex) {
      segments.push({ text: value.slice(lastIndex, start) });
    }

    // The id to resolve: the tag's id part, or the whole token (uuid / bare).
    const groups = match.groups ?? {};
    const idPart = groups.tagid ?? full;
    segments.push({ text: full, href: buildNavHref(idPart) });

    lastIndex = start + full.length;

    // Guard against a zero-length match (should not happen here) causing a loop.
    if (regex.lastIndex === start) regex.lastIndex++;
  }

  // Trailing text after the last match.
  if (lastIndex < value.length) {
    segments.push({ text: value.slice(lastIndex) });
  }

  // Nothing matched → one plain-text segment (a clean no-op).
  return segments.length > 0 ? segments : [{ text: value }];
}

/**
 * TextDecorator for the HAST pipeline: turn id tokens into `<a href="/r/..">`
 * element nodes. The link's visible child is the matched token text (a plain text
 * node → React-escaped on render, so no XSS). Non-id text passes through unchanged.
 * The custom `a` renderer in MarkdownContent turns an internal `/r/..` href into a
 * single-tab react-router <Link>.
 */
export const linkifyNavIdsDecorator: TextDecorator = (value: string): HastNode[] => {
  const segments = segmentNavIds(value);
  // Fast path: nothing to linkify → hand back one text node unchanged.
  if (segments.length === 1 && !segments[0].href) {
    return [{ type: 'text', value }];
  }
  return segments.map((seg) =>
    seg.href
      ? {
          type: 'element',
          tagName: 'a',
          properties: { href: seg.href },
          children: [{ type: 'text', value: seg.text }],
        }
      : { type: 'text', value: seg.text },
  );
};

/**
 * The rehype plugin: linkify id tokens in all text nodes, skipping <a> (never
 * double-link) and <pre> (never rewrite code blocks). Runs BEFORE rehype-sanitize
 * (sanitize stays the final authority over the whole tree).
 *
 * FEATURE B HOOK POINT: a search-term highlight is a second TextDecorator wrapped
 * the SAME way — `rehypeDecorateText(highlightDecorator, { skipTags: ['pre'] })` —
 * added to MarkdownContent's rehypePlugins array IMMEDIATELY AFTER this plugin and
 * BEFORE rehypeSanitize. Because it too only splits text nodes, it composes with
 * these links automatically (it will highlight terms even inside a link). It must
 * run AFTER linkify (so a <mark> can't split an id token) and may need to widen the
 * sanitize schema to allow <mark>.
 */
export const rehypeLinkifyNavIds = rehypeDecorateText(linkifyNavIdsDecorator, {
  skipTags: ['a', 'pre'],
});
