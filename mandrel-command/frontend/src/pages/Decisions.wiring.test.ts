/**
 * Decisions rebuild pattern guard (P2 — follows the Contexts/Tasks screen-rebuild pattern).
 * Asserts the rebuilt Decisions page + its `decisions/` module:
 *   1. import ZERO antd (migrated fully off the old component lib);
 *   2. wire data through the UNIFIED `api.*` client (not axios/generated);
 *   3. surface the TYPED thread box from real graph edges (api.decisions.links) — NEVER a
 *      semantic `related` list (data-gap policy: never conflate the two);
 *   4. carry no hardcoded hex colours in the stylesheet (token-driven);
 *   5. reuse the SHARED typed-edge vocabulary (config/graphEdges) + the shared RecordLink
 *      type rather than re-copying them.
 * Source-level invariants — cheap, deterministic, drift-proof.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, it, expect } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const modDir = resolve(here, 'decisions');

const pageSrc = readFileSync(resolve(here, 'Decisions.tsx'), 'utf8');
const partFiles = readdirSync(modDir).filter((f) => /\.tsx?$/.test(f) && !f.endsWith('.css'));
const partSrcs = partFiles.map((f) => ({ f, src: readFileSync(resolve(modDir, f), 'utf8') }));
const allTsSrcs = [{ f: 'Decisions.tsx', src: pageSrc }, ...partSrcs];

const HEX = /#[0-9a-fA-F]{3,8}\b/g;

describe('Decisions rebuild — no antd anywhere', () => {
  it.each(allTsSrcs)('$f does not import antd', ({ src }) => {
    expect(src).not.toMatch(/from\s+['"]antd['"]/);
    expect(src).not.toMatch(/from\s+['"]@ant-design\/icons['"]/);
  });
});

describe('Decisions rebuild — unified client only', () => {
  it('hooks read through the unified api client', () => {
    const hooks = readFileSync(resolve(modDir, 'hooks.ts'), 'utf8');
    expect(hooks).toMatch(/from\s+['"]\.\.\/\.\.\/api['"]/);
    expect(hooks).toMatch(/api\.decisions\./);
  });

  it('no part imports axios or the old decisions clients directly', () => {
    for (const { src } of allTsSrcs) {
      expect(src).not.toMatch(/from\s+['"]axios['"]/);
      expect(src).not.toMatch(/services\/decisionApi['"]/);
      expect(src).not.toMatch(/api\/decisionsClient['"]/);
    }
  });
});

describe('Decisions rebuild — typed thread box, not a semantic list (the moat)', () => {
  it('the thread box reads api.decisions.links (typed edges), never a semantic related list', () => {
    const hooks = readFileSync(resolve(modDir, 'hooks.ts'), 'utf8');
    expect(hooks).toMatch(/api\.decisions\.links\(/);
    expect(hooks).not.toMatch(/api\.decisions\.related\(/);
    // The thread box renders the typed RecordLink edges via the shared edge vocabulary —
    // never a semantic `related` list.
    const threadBox = readFileSync(resolve(modDir, 'ThreadBox.tsx'), 'utf8');
    expect(threadBox).toMatch(/RecordLink/);
    expect(threadBox).toMatch(/edgeLabel\(/);
    expect(threadBox).not.toMatch(/\.related\b/);
    expect(threadBox).not.toMatch(/related:/);
  });
});

describe('Decisions rebuild — reuse the shared graph-edge vocabulary (no third copy)', () => {
  it('the module sources the edge labels + dots from config/graphEdges (not a local copy)', () => {
    const config = readFileSync(resolve(modDir, 'config.ts'), 'utf8');
    expect(config).toMatch(/from\s+['"]\.\.\/\.\.\/config\/graphEdges['"]/);
    // The vocabulary must NOT be re-defined locally in the decisions module.
    expect(config).not.toMatch(/const\s+EDGE_LABELS\s*[:=]/);
  });
});

describe('Decisions rebuild — token-driven', () => {
  it('the layout stylesheet carries no hardcoded hex colours', () => {
    const css = readFileSync(resolve(modDir, 'Decisions.module.css'), 'utf8').replace(
      /\/\*[\s\S]*?\*\//g,
      '',
    );
    expect(css.match(HEX) ?? []).toEqual([]);
  });
});
