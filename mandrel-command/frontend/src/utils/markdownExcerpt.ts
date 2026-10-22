/**
 * Markdown-aware plain-text excerpt helpers.
 *
 * Context content is GitHub-flavored markdown written by LLMs and users. When we
 * show a SHORT preview (card snippet, tooltip, timeline row) we must NOT render
 * markdown (a tiny snippet with half a table or a dangling `**` is worse than
 * plain text) and we must NOT substring the raw markdown (that leaves cut-off
 * `**`, `#`, `![](` fragments). Instead we strip the markdown syntax to clean
 * plain text first, THEN truncate on a word-ish boundary.
 *
 * This is the single shared excerpt path used by every preview/truncation site,
 * so previews can never drift back to showing raw-markdown fragments.
 */

/**
 * Strip GitHub-flavored markdown syntax from a string, leaving readable plain
 * text. Best-effort and intentionally conservative: it removes formatting marks
 * and structural punctuation while preserving the human-readable words.
 */
export function markdownToPlainText(input?: string | null): string {
  if (!input) {
    return '';
  }

  let text = String(input);

  // Fenced code blocks: keep the inner code text, drop the ``` / ~~~ fences.
  text = text.replace(/```[^\n`]*\n?([\s\S]*?)```/g, ' $1 ');
  text = text.replace(/~~~[^\n~]*\n?([\s\S]*?)~~~/g, ' $1 ');

  // Inline code: keep the contents, drop the backticks.
  text = text.replace(/`([^`]+)`/g, '$1');

  // Images: ![alt](url) -> alt
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');

  // Inline links: [text](url) -> text
  text = text.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');

  // Reference links: [text][ref] -> text
  text = text.replace(/\[([^\]]*)\]\[[^\]]*\]/g, '$1');

  // Bare autolinks: <https://...> -> https://...
  text = text.replace(/<((?:https?|mailto):[^>\s]+)>/g, '$1');

  // ATX headings: strip leading #'s (keep the heading text).
  text = text.replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, '');

  // Blockquote markers.
  text = text.replace(/^[ \t]{0,3}>[ \t]?/gm, '');

  // Horizontal rules (lines of only ---, ***, ___).
  text = text.replace(/^[ \t]{0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/gm, ' ');

  // Task-list checkboxes: [ ] / [x] (after any list marker).
  text = text.replace(/^([ \t]*)[-*+][ \t]+\[[ xX]\][ \t]+/gm, '$1');

  // List markers (unordered + ordered).
  text = text.replace(/^[ \t]*([-*+]|\d+[.)])[ \t]+/gm, '');

  // Emphasis / strong: **x** __x__ *x* _x_
  text = text.replace(/(\*\*|__)(.*?)\1/g, '$2');
  text = text.replace(/(\*|_)([^*_]+?)\1/g, '$2');

  // Strikethrough ~~x~~
  text = text.replace(/~~(.*?)~~/g, '$1');

  // Table cell separators -> spaces (drops the visual pipes).
  text = text.replace(/\|/g, ' ');

  // Collapse all runs of whitespace (incl. newlines) to single spaces.
  text = text.replace(/\s+/g, ' ').trim();

  return text;
}

/**
 * Produce a clean plain-text excerpt of (possibly) markdown content, truncated
 * to `maxLength` with an ellipsis. Strips markdown first so the preview never
 * shows cut-off syntax. Truncates on a word boundary when one is reasonably
 * close to the limit.
 */
export function markdownExcerpt(input?: string | null, maxLength = 150): string {
  const plain = markdownToPlainText(input);
  if (plain.length <= maxLength) {
    return plain;
  }

  const slice = plain.slice(0, maxLength);
  // Prefer to cut at the last space so we don't slice a word in half, but only
  // if that space isn't too far back (keep at least 60% of the budget).
  const lastSpace = slice.lastIndexOf(' ');
  const cut = lastSpace > maxLength * 0.6 ? slice.slice(0, lastSpace) : slice;
  return `${cut.trimEnd()}...`;
}
