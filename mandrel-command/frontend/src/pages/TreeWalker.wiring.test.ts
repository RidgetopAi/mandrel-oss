/**
 * TreeWalker rebuild pattern guard (P3 "Insight" — follows the Decisions/Contexts screen
 * pattern). Source-level invariants — cheap, deterministic, drift-proof. Asserts the new
 * TreeWalker page + its `treewalker/` module:
 *   1. import ZERO antd (the redesign component discipline);
 *   2. wire data through the UNIFIED `api.treewalker.*` client (not axios/generated);
 *   3. REUSE the shared moat primitives — the typed-edge vocab (config/graphEdges) + the
 *      themed GraphView baseline — rather than re-copying them (a past incident / P0.6 intent);
 *   4. carry no hardcoded hex colours in the stylesheet (token-driven);
 *   5. define the NEW trust vocabulary in the module config (not scattered);
 *   6. HONOUR the data-gap policy: the backend thread endpoint is now LIVE (Mandrel
 *      an earlier task), so the config flag is true and the hook reads through the unified client
 *      (no-arg resume endpoint / explicit anchor) — and STILL renders an honest empty state for
 *      a genuinely-empty thread (it never fabricates a thread).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, it, expect } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const modDir = resolve(here, 'treewalker');

const pageSrc = readFileSync(resolve(here, 'TreeWalker.tsx'), 'utf8');
const partFiles = readdirSync(modDir).filter(
  (f) => /\.tsx?$/.test(f) && !f.endsWith('.css') && !f.includes('.test.'),
);
const partSrcs = partFiles.map((f) => ({ f, src: readFileSync(resolve(modDir, f), 'utf8') }));
const allTsSrcs = [{ f: 'TreeWalker.tsx', src: pageSrc }, ...partSrcs];

const HEX = /#[0-9a-fA-F]{3,8}\b/g;

describe('TreeWalker rebuild — no antd anywhere', () => {
  it.each(allTsSrcs)('$f does not import antd', ({ src }) => {
    expect(src).not.toMatch(/from\s+['"]antd['"]/);
    expect(src).not.toMatch(/from\s+['"]@ant-design\/icons['"]/);
  });
});

describe('TreeWalker rebuild — unified client only', () => {
  it('hooks read through the unified api client', () => {
    const hooks = readFileSync(resolve(modDir, 'hooks.ts'), 'utf8');
    expect(hooks).toMatch(/from\s+['"]\.\.\/\.\.\/api['"]/);
    expect(hooks).toMatch(/api\.treewalker\./);
  });

  it('no part imports axios or a generated/legacy client directly', () => {
    for (const { src } of allTsSrcs) {
      expect(src).not.toMatch(/from\s+['"]axios['"]/);
      expect(src).not.toMatch(/services\/api['"]/);
    }
  });
});

describe('TreeWalker rebuild — reuse the shared moat primitives (no re-copy)', () => {
  it('the module sources the edge vocabulary from config/graphEdges (not a local copy)', () => {
    const config = readFileSync(resolve(modDir, 'config.ts'), 'utf8');
    expect(config).toMatch(/from\s+['"]\.\.\/\.\.\/config\/graphEdges['"]/);
    expect(config).not.toMatch(/const\s+EDGE_LABELS\s*[:=]/);
  });
});

describe('TreeWalker rebuild — token-driven', () => {
  it.each(readdirSync(modDir).filter((f) => f.endsWith('.css')))(
    '%s carries no hardcoded hex colours',
    (f) => {
      const css = readFileSync(resolve(modDir, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
      expect(css.match(HEX) ?? []).toEqual([]);
    },
  );

  it.each(allTsSrcs)('$f carries no hardcoded hex colour literal', ({ src }) => {
    const stripped = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    expect(stripped.match(HEX) ?? []).toEqual([]);
  });
});

describe('TreeWalker rebuild — the NEW trust vocabulary lives in config', () => {
  it('config defines the CANONICAL trust vocab map (trusted/ok/unproven/stale/superseded/contradicted)', () => {
    const config = readFileSync(resolve(modDir, 'config.ts'), 'utf8');
    expect(config).toMatch(/TRUST_META/);
    for (const level of ['trusted', 'ok', 'unproven', 'stale', 'superseded', 'contradicted']) {
      expect(config).toContain(level);
    }
  });
});

describe('TreeWalker rebuild — live backend + honest empty policy (no fabricated thread)', () => {
  it('the backend-ready flag is now TRUE (endpoint shipped)', () => {
    const config = readFileSync(resolve(modDir, 'config.ts'), 'utf8');
    expect(config).toMatch(/backendReady:\s*true/);
  });

  it('the hook gates the read on backendReady, defaults to the resume endpoint, and keeps an unavailable state', () => {
    const hooks = readFileSync(resolve(modDir, 'hooks.ts'), 'utf8');
    expect(hooks).toMatch(/backendReady/);
    expect(hooks).toMatch(/unavailable/);
    // Reads through the unified client: explicit anchor OR the no-arg resume default.
    expect(hooks).toMatch(/getResumeThread/);
    expect(hooks).toMatch(/api\.treewalker\.getThread/);
  });

  it('the honest empty/loading fallbacks are still present (a genuinely-empty thread never fabricates)', () => {
    const view = readFileSync(resolve(modDir, 'StoryView.tsx'), 'utf8');
    expect(view).toMatch(/No records on this thread yet/);
  });

  it('the deleted grid-graph modules stay deleted and nothing imports them', () => {
    for (const gone of ['GraphCanvas', 'TreeWalkerNode', 'TreeWalkerEdge', 'StoryRail', 'graph']) {
      expect(partFiles.map((f) => f.replace(/\.tsx?$/, ''))).not.toContain(gone);
      for (const { src } of allTsSrcs) {
        expect(src).not.toMatch(new RegExp(`from\\s+['"]\\./(treewalker/)?${gone}['"]`));
      }
    }
  });
});
