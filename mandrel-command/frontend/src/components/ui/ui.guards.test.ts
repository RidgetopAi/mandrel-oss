/**
 * Primitive token-discipline guard (P0.3).
 *
 * The primitives MUST read colour/type from the P0.2 design tokens via
 * `var(--token)` — no hardcoded palette values. This test SCANS every
 * `*.module.css` in this directory and fails CI if any primitive:
 *   1. contains a hex colour literal (#rgb / #rrggbb / #rrggbbaa), or
 *   2. contains an rgb()/rgba()/hsl()/hsla() literal colour, or
 *   3. sets a `font-size` in px (the type scale must be a `--fs-*` token), or
 *   4. does not reference the token layer at all.
 *
 * Residual literal px are STRUCTURAL only (hairline border-widths, glyph/dot/
 * spinner geometry, the 999px pill, tooltip offsets, the sr-only clip) — there is
 * no border-width/size token in the locked, drift-guarded P0.2 set, and this
 * task must NOT extend it. Colour + type — the design-language surface — are
 * enforced to be 100% token-driven here. (tests-are-the-rock.)
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, it, expect } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));

const moduleCssFiles = readdirSync(here).filter((f) => f.endsWith('.module.css'));

/** Strip CSS comments so notes referencing values never cause false hits. */
function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

const HEX = /#[0-9a-fA-F]{3,8}\b/g;
const RGB_HSL = /\b(?:rgb|rgba|hsl|hsla)\s*\(/gi;
const FONT_SIZE_PX = /font-size\s*:\s*[^;]*\bpx\b/gi;

describe('primitive CSS is token-driven (P0.3)', () => {
  it('discovered the primitive stylesheets', () => {
    // Sanity: if the glob ever returns nothing, the guard would vacuously pass.
    expect(moduleCssFiles.length).toBeGreaterThanOrEqual(12);
  });

  it.each(moduleCssFiles)('%s — no hardcoded hex colour', (file) => {
    const css = stripComments(readFileSync(resolve(here, file), 'utf8'));
    expect(css.match(HEX) ?? []).toEqual([]);
  });

  it.each(moduleCssFiles)('%s — no rgb()/hsl() literal colour', (file) => {
    const css = stripComments(readFileSync(resolve(here, file), 'utf8'));
    expect(css.match(RGB_HSL) ?? []).toEqual([]);
  });

  it.each(moduleCssFiles)('%s — font-size uses a --fs-* token (never px)', (file) => {
    const css = stripComments(readFileSync(resolve(here, file), 'utf8'));
    expect(css.match(FONT_SIZE_PX) ?? []).toEqual([]);
  });

  // Stack/Grid are pure flex/grid wrappers whose spacing tokens are applied via
  // inline `var(--sp-N)` in the .tsx (see Stack.tsx/Grid.tsx), so their minimal
  // stylesheet holds only the display invariant — no var() by design.
  const INLINE_TOKEN_LAYOUT = new Set(['Stack.module.css', 'Grid.module.css']);
  const tokenRefFiles = moduleCssFiles.filter((f) => !INLINE_TOKEN_LAYOUT.has(f));

  it.each(tokenRefFiles)('%s — references the design-token layer (var(--…))', (file) => {
    const css = stripComments(readFileSync(resolve(here, file), 'utf8'));
    expect(css).toMatch(/var\(--/);
  });

  it('the inline-token layout wrappers apply spacing tokens in their component', () => {
    for (const mod of ['Stack.tsx', 'Grid.tsx']) {
      const src = readFileSync(resolve(here, mod), 'utf8');
      expect(src).toMatch(/var\(--sp-/);
    }
  });
});
