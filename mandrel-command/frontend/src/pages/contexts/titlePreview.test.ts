/**
 * THE CONTEXTS RAIL'S TITLE PREVIEW IS PINNED TO THE CARD IT LIVES IN
 * (part 1 — the "sixth contextTitle" Lane B named).
 *
 * ════════════════════════════════════════════════════════════════════════════════════
 * THE DEFECT THIS EXISTS TO CATCH
 * ════════════════════════════════════════════════════════════════════════════════════
 * `CONTEXTS_CONFIG.titlePreviewChars` was a free number (140). Lane B collapsed five
 * other clip lengths into one measured budget and said out loud that this one was NOT
 * pinned to anything — which is the state this file ends: not by copying that budget, but
 * by DERIVING this number from the only constraint that actually governs it.
 *
 * ════════════════════════════════════════════════════════════════════════════════════
 * WHY THIS PREVIEW LEGITIMATELY DIFFERS FROM THE RECORD-HEADLINE BUDGET
 * ════════════════════════════════════════════════════════════════════════════════════
 * `deriveRecordHeadline`'s budget answers "how much of a record fits in ONE LINE OF TEXT
 * a reader or an agent will consume". This slice answers a different question: "how much
 * of a record can a 320px, two-line, line-clamped CARD ever draw". MEASURED on this tree:
 * the rail is `--rail-width` (320px), the card pads by `--sp-3` on each side, and
 * `.itemTitle` carries `-webkit-line-clamp: 2`. The CSS is what the user sees; the slice
 * cannot make the card show more, and it must not make it show LESS.
 *
 * So the slice has exactly two jobs and neither is a headline budget:
 *   1. never remove a character the card could have rendered;
 *   2. bound the DOM payload — `contexts.content` is a TEXT column whose validator ceiling
 *      is in the millions of characters, and its first line can be all of that.
 * Both are properties of the CARD. Pinning this to the record budget would tie a geometry
 * to a text measurement, and the next change to either would silently be wrong.
 *
 * ════════════════════════════════════════════════════════════════════════════════════
 * WHAT THIS GUARD ASSERTS, AND WHAT IT CANNOT
 * ════════════════════════════════════════════════════════════════════════════════════
 * The rail width and the padding are IMPORTED from `styles/tokens` (this package's token
 * source of truth), so a token change moves the derived bound automatically and this file
 * needs no update. The line clamp lives in CSS, which JS cannot import, so it is read OFF
 * DISK from the stylesheet and compared — the same technique `tokens.test.ts` already uses
 * next door. That comparison is the only thing standing between the CSS and the config.
 *
 * It CANNOT assert anything about `mcp-server/src/config/recordHeadlineConfig.ts`: the
 * frontend is a browser bundle and that module is in another package. Whether the two
 * should be coupled at all is a live question that belongs to whoever owns the
 * cross-package pinning mechanism; this file deliberately makes no claim about that
 * number, rather than a claim it cannot execute.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { CONTEXTS_CONFIG, TITLE_PREVIEW_GEOMETRY, maxRenderableTitleChars } from './config';
import { contextTitle } from './parts';
import { dark as TOKENS } from '../../styles/tokens';

// Same idiom as `styles/tokens.test.ts`, which reads its generated CSS the same way.
const here = dirname(fileURLToPath(import.meta.url));
const CSS_PATH = resolve(here, './Contexts.module.css');

describe('the contexts rail title preview is derived from the card', () => {
  it('reads its geometry from the design tokens, not from a literal', () => {
    expect(TITLE_PREVIEW_GEOMETRY.railWidthPx).toBe(parseFloat(TOKENS['rail-width']));
    expect(TITLE_PREVIEW_GEOMETRY.itemPaddingPx).toBe(parseFloat(TOKENS['sp-3']));
    // Non-empty trap: a token lookup that came back NaN would make every bound below
    // vacuously satisfiable.
    expect(Number.isFinite(TITLE_PREVIEW_GEOMETRY.railWidthPx)).toBe(true);
    expect(TITLE_PREVIEW_GEOMETRY.railWidthPx).toBeGreaterThan(0);
    expect(Number.isFinite(TITLE_PREVIEW_GEOMETRY.itemPaddingPx)).toBe(true);
    expect(TITLE_PREVIEW_GEOMETRY.itemPaddingPx).toBeGreaterThan(0);
  });

  it('the line clamp in the config IS the one the stylesheet applies', () => {
    // The CSS is the thing the browser obeys. JS cannot import it, so read it.
    const css = readFileSync(CSS_PATH, 'utf8');
    const m = css.match(/\.itemTitle\s*\{[^}]*?-webkit-line-clamp:\s*(\d+)/s);
    if (!m) {
      // C1 third state: could-not-measure is not "it matched".
      throw new Error(
        'Could not find `-webkit-line-clamp` inside `.itemTitle` in Contexts.module.css. ' +
          'The preview budget is derived from that clamp; re-point this guard rather than ' +
          'deleting it.'
      );
    }
    expect(Number(m[1])).toBe(TITLE_PREVIEW_GEOMETRY.lineClamp);
  });

  it('THE POINT: the slice never cuts a character the card could have drawn', () => {
    expect(CONTEXTS_CONFIG.titlePreviewChars).toBeGreaterThanOrEqual(maxRenderableTitleChars);
  });

  it('...and it is still a payload bound, not an unbounded render', () => {
    // The other job. A first line can be millions of characters; the card cannot.
    expect(CONTEXTS_CONFIG.titlePreviewChars).toBeLessThan(maxRenderableTitleChars * 2);
  });

  it('the clip is actually applied — a long first line comes back at the budget', () => {
    const long = 'x'.repeat(CONTEXTS_CONFIG.titlePreviewChars * 10);
    expect(contextTitle(long)).toHaveLength(CONTEXTS_CONFIG.titlePreviewChars);
  });

  it('the empty and absent populations get the placeholder, not an empty title', () => {
    for (const v of ['', '   ', '\n\n', null, undefined]) {
      expect(contextTitle(v as string | null | undefined)).toBe('(untitled context)');
    }
  });

  it('markdown lead markers are stripped, and stripping is charged inside the budget', () => {
    expect(contextTitle('## Heading here\nbody')).toBe('Heading here');
    expect(contextTitle('- bullet lead\nbody')).toBe('bullet lead');
    const marked = '# ' + 'y'.repeat(CONTEXTS_CONFIG.titlePreviewChars * 3);
    expect(contextTitle(marked).length).toBeLessThanOrEqual(CONTEXTS_CONFIG.titlePreviewChars);
  });
});
