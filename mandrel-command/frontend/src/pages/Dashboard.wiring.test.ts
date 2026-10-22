/**
 * Dashboard pattern guard (P1 — the screen-rebuild pattern every later screen
 * follows). Asserts the rebuilt Dashboard page + its sub-components:
 *   1. import ZERO antd (migrated fully off the old component lib);
 *   2. wire data through the UNIFIED `api.*` client (not axios/generated);
 *   3. compose ONLY the P0.3 primitives + P0.6 charts;
 *   4. carry no hardcoded hex colours (token-driven).
 * These are source-level invariants — cheap, deterministic, and drift-proof.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, it, expect } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const dashDir = resolve(here, 'dashboard');

const pageSrc = readFileSync(resolve(here, 'Dashboard.tsx'), 'utf8');
const partFiles = readdirSync(dashDir).filter((f) => /\.tsx?$/.test(f) && !f.endsWith('.css'));
const partSrcs = partFiles.map((f) => ({ f, src: readFileSync(resolve(dashDir, f), 'utf8') }));
const allTsSrcs = [{ f: 'Dashboard.tsx', src: pageSrc }, ...partSrcs];

const HEX = /#[0-9a-fA-F]{3,8}\b/g;

describe('Dashboard rebuild — no antd anywhere', () => {
  it.each(allTsSrcs)('$f does not import antd', ({ src }) => {
    expect(src).not.toMatch(/from\s+['"]antd['"]/);
    expect(src).not.toMatch(/from\s+['"]@ant-design\/icons['"]/);
  });
});

describe('Dashboard rebuild — unified client only', () => {
  it('hooks read through the unified api client', () => {
    const hooks = readFileSync(resolve(dashDir, 'hooks.ts'), 'utf8');
    expect(hooks).toMatch(/from\s+['"]\.\.\/\.\.\/api['"]/);
    expect(hooks).toMatch(/api\.(dashboard|decisions|sessions|projects)\./);
  });

  it('no component imports axios or the generated service clients directly', () => {
    for (const { src } of allTsSrcs) {
      expect(src).not.toMatch(/from\s+['"]axios['"]/);
      expect(src).not.toMatch(/services\/api['"]/);
      expect(src).not.toMatch(/api\/generated['"]/);
    }
  });
});

describe('Dashboard rebuild — composes only the P0.3 primitives + P0.6 charts', () => {
  // Invariant 3: every UI building block comes from the sanctioned foundation —
  // components/ui (P0.3 primitives) or components/charts (P0.6). Any import that
  // reaches into some OTHER components/* folder means a stray component crept in.
  const COMPONENT_IMPORT = /from\s+['"][^'"]*\/components\/([a-zA-Z0-9_-]+)/g;

  it.each(allTsSrcs)('$f pulls components only from ui or charts', ({ src }) => {
    const folders = [...src.matchAll(COMPONENT_IMPORT)].map((m) => m[1]);
    for (const folder of folders) {
      expect(['ui', 'charts']).toContain(folder);
    }
  });
});

describe('Dashboard rebuild — token-driven', () => {
  it('the layout stylesheet carries no hardcoded hex colours', () => {
    const css = readFileSync(resolve(dashDir, 'Dashboard.module.css'), 'utf8').replace(
      /\/\*[\s\S]*?\*\//g,
      '',
    );
    expect(css.match(HEX) ?? []).toEqual([]);
  });
});
