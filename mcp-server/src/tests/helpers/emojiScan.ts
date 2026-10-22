/**
 * ONE emoji detector + payload-line scanner for the machine-lean MCP surface tests.
 *
 * Extracted VERBATIM from ws1ResponseShape.contract.test.ts (WS1 an earlier task) so WS2's
 * briefing test reuses the SAME definition instead of a second copy that
 * can drift. Definitions moved, not changed — ws1ResponseShape re-imports
 * from here and its probes remain the scanner's adversarial suite.
 */

/**
 * The emoji detector — one definition for the behavioral sweep AND the static scan.
 * Covers the pictographic planes + the dingbat/misc-symbol blocks + the variation
 * selector every "text emoji" (⚠️/⏰/✏️…) carries. Deliberately does NOT match plain
 * punctuation (bullets, em-dashes, arrows ≤ U+2190 range excluded on purpose: `→` is
 * data-bearing in mint reports and is not emoji packaging).
 */
export const EMOJI_RE =
  // FE0F (the emoji variation selector) rides as an ALTERNATION, not inside the class —
  // it is a combining character and eslint's no-misleading-character-class is right that
  // a class containing it reads as if it matched a composed glyph.
  /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{2139}\u{231A}\u{231B}\u{23E9}-\u{23FA}]|\u{FE0F}/u;

/**
 * Lines in `source` that would put emoji into an MCP payload: every line EXCEPT
 * comments and logger calls. Returns the offending lines (empty = clean).
 */
export function emojiPayloadLines(source: string): string[] {
  return source.split('\n').filter((line) => {
    const t = line.trim();
    if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return false;
    if (/\blogger\.(info|warn|error|debug)\b/.test(line)) return false;
    return EMOJI_RE.test(line);
  });
}
