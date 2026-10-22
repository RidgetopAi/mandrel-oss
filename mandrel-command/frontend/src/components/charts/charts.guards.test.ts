/**
 * Chart token-discipline guard (P0.6) — the charting-layer analogue of the P0.3
 * ui.guards.test.ts. Chart TS/TSX resolves colours from the P0.2 token maps (via
 * chartTheme), NEVER from a hardcoded palette literal. This scans every source
 * file in this directory and fails if any contains a hex colour or an
 * rgb()/hsl() literal. (heatmapScale.ts parses/builds hex by nature but holds no
 * literal palette value — verified below.)
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, it, expect } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));

const sourceFiles = readdirSync(here).filter(
  (f) => (f.endsWith('.ts') || f.endsWith('.tsx')) && !f.endsWith('.test.ts') && !f.endsWith('.test.tsx'),
);

/** Strip block + line comments so doc notes referencing values never false-hit. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

const HEX = /#[0-9a-fA-F]{3,8}\b/g;
const RGB_HSL = /\b(?:rgb|rgba|hsl|hsla)\s*\(/gi;

describe('chart layer is token-sourced (P0.6)', () => {
  it('discovered the chart source files', () => {
    expect(sourceFiles.length).toBeGreaterThanOrEqual(8);
  });

  it.each(sourceFiles)('%s — no hardcoded hex colour literal', (file) => {
    const src = stripComments(readFileSync(resolve(here, file), 'utf8'));
    expect(src.match(HEX) ?? []).toEqual([]);
  });

  it.each(sourceFiles)('%s — no rgb()/hsl() literal colour', (file) => {
    const src = stripComments(readFileSync(resolve(here, file), 'utf8'));
    expect(src.match(RGB_HSL) ?? []).toEqual([]);
  });

  it('chartTheme.ts sources colour from the token maps (imports tokens)', () => {
    const src = readFileSync(resolve(here, 'chartTheme.ts'), 'utf8');
    expect(src).toMatch(/from '\.\.\/\.\.\/styles\/tokens'/);
  });
});
