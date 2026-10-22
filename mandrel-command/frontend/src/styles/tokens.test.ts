/**
 * Design-token guards (P0.2).
 *
 *  1. DRIFT GUARD — the committed tokens.css must byte-match what tokens.ts
 *     renders. If someone edits tokens.ts without `npm run tokens:css`, this
 *     fails CI. This is what lets the CSS be a derived artifact with ZERO
 *     duplicated hex (single source = tokens.ts). (tests-are-the-rock.)
 *  2. FAITHFUL TRANSCRIPTION — the DARK values match the LOCKED design-language
 *     doc verbatim (the values are the spec).
 *  3. THEME INVARIANTS — radii/fonts/type/spacing are identical across themes;
 *     colors differ; light is a real (derived) palette, not a copy of dark.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import { dark, light, cssVar, renderTokensCss } from './tokens';

const here = dirname(fileURLToPath(import.meta.url));
const cssPath = resolve(here, './tokens.css');

describe('tokens.css drift guard', () => {
  it('committed tokens.css byte-matches tokens.ts render (run `npm run tokens:css` if this fails)', () => {
    const committed = readFileSync(cssPath, 'utf8');
    expect(committed).toBe(renderTokensCss());
  });
});

describe('DARK — faithful transcription of the locked design-language doc', () => {
  // Values transcribed verbatim from riverbend/docs/command-design-language.html
  const DOC: Record<string, string> = {
    bg: '#0A0C10',
    'bg-2': '#0D1015',
    s1: '#111419',
    s2: '#161A21',
    s3: '#1C222B',
    's-hover': '#20272F',
    line: '#20262F',
    'line-2': '#2A323D',
    'line-soft': '#181D24',
    tx: '#E8ECF2',
    'tx-2': '#9AA6B4',
    'tx-3': '#616C7B',
    'tx-4': '#454F5C',
    teal: '#2ED9C6',
    'teal-dim': '#1FA99A',
    'teal-glow': '#2ed9c626',
    violet: '#9B87FA',
    blue: '#4C9DFF',
    green: '#3ED08A',
    amber: '#F3B24C',
    rose: '#F2606A',
    'violet-glow': '#9b87fa22',
    'blue-glow': '#4c9dff22',
    'green-glow': '#3ed08a22',
    ok: '#3ED08A',
    warn: '#F3B24C',
    crit: '#F2606A',
    // Ink-on-accent — verbatim from the doc's .btn.primary { color:#04110f }
    'on-accent': '#04110f',
    r: '12px',
    'r-sm': '8px',
    'r-xs': '6px',
    font: '-apple-system,system-ui,"SF Pro Display","Segoe UI",Roboto,sans-serif',
    mono: 'ui-monospace,"SF Mono","JetBrains Mono",Menlo,monospace',
  };

  it.each(Object.entries(DOC))('--%s === doc value %s', (name, value) => {
    expect(dark[name]).toBe(value);
  });
});

describe('ink-on-accent tokens (button ink decoupled from --bg)', () => {
  it('--on-accent dark is the doc value #04110f (VERBATIM, not var(--bg))', () => {
    expect(dark['on-accent']).toBe('#04110f');
    // must NOT coincidentally equal the ground token any longer
    expect(dark['on-accent']).not.toBe(dark['bg']);
  });

  it('--on-crit is near-white in both themes (doc uses white on danger)', () => {
    expect(dark['on-crit']).toBe('#FFFFFF');
    expect(light['on-crit']).toBe('#FFFFFF');
  });

  it('--on-accent light is the approved dark ink (#04110f, ~6.6:1 AA on the deepened light teal)', () => {
    // Coordinator's approved default: brand-consistent dark-ink-on-teal,
    // AA-solid on the light teal #159B8B. --on-crit stays white.
    expect(light['on-accent']).toBe('#04110f');
    expect(light['on-accent']).not.toBe(light['bg']);
  });
});

describe('theme structure', () => {
  it('radii/fonts/type/spacing are theme-invariant', () => {
    for (const name of ['r', 'r-sm', 'r-xs', 'font', 'mono', 'fs-display', 'sp-4']) {
      expect(light[name]).toBe(dark[name]);
    }
  });

  it('light is a real palette, not a copy of dark (grounds/text/teal differ)', () => {
    for (const name of ['bg', 's1', 'tx', 'teal', 'line']) {
      expect(light[name]).not.toBe(dark[name]);
    }
  });

  it('every dark token has a light counterpart (no missing keys)', () => {
    expect(Object.keys(light).sort()).toEqual(Object.keys(dark).sort());
  });
});

describe('cssVar helper', () => {
  it('references a live custom property', () => {
    expect(cssVar('teal')).toBe('var(--teal)');
    expect(cssVar('bg-2')).toBe('var(--bg-2)');
  });
});

/**
 * LAYOUT GEOMETRY — the anti-drift guard for the rail/reader widths.
 *
 * These widths used to be per-page hardcodes, exempted from the token system by each
 * stylesheet's "residual px are structural geometry" header. They promptly DRIFTED:
 * Contexts ran 300px/68ch while Decisions ran 320px/70ch, so the two record screens no
 * longer lined up. The fix is the class, not the instance: define once here,
 * consume in every list+reader screen, and FAIL if a page restates the literal.
 *
 * Scope note: this guards the record screens that consume the tokens (Contexts, Decisions).
 * Other screens (Tasks, TreeWalker, Surveyor …) carry their own, deliberately different
 * geometry and are NOT claimed by these tokens — a guard that swept them would be a lie.
 */
describe('layout geometry tokens — defined ONCE, consumed by the record screens', () => {
  const RECORD_SCREEN_CSS = ['../pages/contexts/Contexts.module.css', '../pages/decisions/Decisions.module.css'];
  const readCss = (rel: string) => readFileSync(resolve(here, rel), 'utf8');

  it('the rail + reader widths are theme-invariant tokens with the canonical values', () => {
    // Canonical = the Decisions screen's live geometry at the time of the reversal
    // ("like Decisions is laid out now").
    expect(dark['rail-width']).toBe('320px');
    expect(dark['reader-width']).toBe('70ch');
    expect(dark['rail-max-h']).toBe('660px');
    expect(light['rail-width']).toBe(dark['rail-width']);
    expect(light['reader-width']).toBe(dark['reader-width']);
    expect(light['rail-max-h']).toBe(dark['rail-max-h']);
  });

  it.each(RECORD_SCREEN_CSS)('%s consumes the tokens (no rail/reader literal)', (rel) => {
    const css = readCss(rel).replace(/\/\*[\s\S]*?\*\//g, '');
    // The exact literals that drifted — neither page may restate any of these values.
    // Widths are matched in their real declaration shape; the scroll cap is matched on the
    // VALUE alone, because 640/660px drifted as a bare `max-height` with no other context.
    expect(css).not.toMatch(/\b(300|320)px\s+1fr\b/);
    expect(css).not.toMatch(/max-width:\s*(68|70)ch\b/);
    expect(css).not.toMatch(/max-height:\s*(640|660)px\b/);
    // …and all three must actually read the tokens.
    expect(css).toMatch(/grid-template-columns:\s*var\(--rail-width\)\s+1fr/);
    expect(css).toMatch(/max-width:\s*var\(--reader-width\)/);
    expect(css).toMatch(/max-height:\s*var\(--rail-max-h\)/);
  });
});
