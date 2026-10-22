/**
 * SINGLE SOURCE of search-term MATCHING for highlighting.
 *
 * Every surface that highlights a search term splits its text with `splitOnTerm`
 * here — there is no second matcher to drift:
 *   - the markdown/HAST pipeline (utils/highlightText → MarkdownContent),
 *   - the plain-text path (components/common/LinkifiedText — decision fields, task
 *     description, tags/deps),
 *   - the list-card excerpts (utils/contextHelpers.highlightSearchTermsAsNodes).
 *
 * Matching rules (mirrors the prior contextHelpers behavior so the list view and
 * the detail view agree):
 *   - the term is split on whitespace into one-or-more sub-terms (OR-matched), so
 *     a multi-word query like "session lock" highlights both words;
 *   - matching is CASE-INSENSITIVE;
 *   - regex metacharacters in a sub-term are ESCAPED (a term like "a+b" or "(x)"
 *     matches literally and never throws);
 *   - a blank / whitespace-only / undefined term is a clean NO-OP (one non-match
 *     slice covering the whole string) — never an empty `<mark>` and never a crash;
 *   - overlapping is avoided by the left-to-right regex scan; adjacent matches
 *     produce no empty slices.
 *
 * PURE + fully unit-testable (no React, no DOM). The renderers decide what a
 * matched slice becomes (a `<mark>` element node, a React <mark>, …).
 */

/** One contiguous slice of a string: `match` true means it should be highlighted. */
export interface HighlightSlice {
  text: string;
  match: boolean;
}

/** Escape regex metacharacters so a sub-term matches literally. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Build the case-insensitive alternation matcher for a term, or null when the term
 * is blank (the no-op signal). Split into sub-terms on whitespace; each is escaped.
 */
export function buildHighlightRegex(term: string | undefined | null): RegExp | null {
  const trimmed = term?.trim();
  if (!trimmed) return null;
  const subTerms = trimmed.split(/\s+/).filter(Boolean).map(escapeRegExp);
  if (subTerms.length === 0) return null;
  return new RegExp(`(${subTerms.join('|')})`, 'gi');
}

/**
 * Split `value` into ordered slices, marking sub-term matches. A blank term or a
 * value with no match returns a single non-match slice (the whole string) — the
 * clean no-op every renderer can pass straight through.
 */
export function splitOnTerm(value: string, term: string | undefined | null): HighlightSlice[] {
  if (!value) return [{ text: value, match: false }];
  const regex = buildHighlightRegex(term);
  if (!regex) return [{ text: value, match: false }];

  const slices: HighlightSlice[] = [];
  let lastIndex = 0;
  let m: RegExpExecArray | null;

  while ((m = regex.exec(value)) !== null) {
    const start = m.index;
    const matched = m[0];

    // A zero-length match cannot happen with this pattern, but guard the loop.
    if (matched.length === 0) {
      regex.lastIndex++;
      continue;
    }
    if (start > lastIndex) {
      slices.push({ text: value.slice(lastIndex, start), match: false });
    }
    slices.push({ text: matched, match: true });
    lastIndex = start + matched.length;
  }

  if (lastIndex < value.length) {
    slices.push({ text: value.slice(lastIndex), match: false });
  }

  // No match at all → the whole string as one non-match slice (clean no-op).
  return slices.length > 0 ? slices : [{ text: value, match: false }];
}

/** True when the term would actually highlight something (a non-blank term). */
export function hasHighlightTerm(term: string | undefined | null): boolean {
  return buildHighlightRegex(term) !== null;
}
