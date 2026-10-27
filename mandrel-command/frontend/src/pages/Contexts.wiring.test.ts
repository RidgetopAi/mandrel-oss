/**
 * Contexts rebuild pattern guard (P2 — follows the Sessions/Dashboard screen-rebuild
 * pattern). Asserts the rebuilt Contexts page + its `contexts/` module:
 *   1. import ZERO antd (migrated fully off the old component lib);
 *   2. wire data through the UNIFIED `api.*` client (not axios/generated);
 *   3. surface the TYPED thread box from real graph edges — NOT the semantic `related`
 *      list (data-gap policy: never conflate the two);
 *   4. carry no hardcoded hex colours in the stylesheet (token-driven).
 * Source-level invariants — cheap, deterministic, drift-proof.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, it, expect } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const modDir = resolve(here, 'contexts');

const pageSrc = readFileSync(resolve(here, 'Contexts.tsx'), 'utf8');
const partFiles = readdirSync(modDir).filter((f) => /\.tsx?$/.test(f) && !f.endsWith('.css'));
const partSrcs = partFiles.map((f) => ({ f, src: readFileSync(resolve(modDir, f), 'utf8') }));
const allTsSrcs = [{ f: 'Contexts.tsx', src: pageSrc }, ...partSrcs];

const HEX = /#[0-9a-fA-F]{3,8}\b/g;

describe('Contexts rebuild — no antd anywhere', () => {
  it.each(allTsSrcs)('$f does not import antd', ({ src }) => {
    expect(src).not.toMatch(/from\s+['"]antd['"]/);
    expect(src).not.toMatch(/from\s+['"]@ant-design\/icons['"]/);
  });
});

describe('Contexts rebuild — unified client only', () => {
  it('hooks read through the unified api client', () => {
    const hooks = readFileSync(resolve(modDir, 'hooks.ts'), 'utf8');
    expect(hooks).toMatch(/from\s+['"]\.\.\/\.\.\/api['"]/);
    expect(hooks).toMatch(/api\.contexts\./);
  });

  it('no part imports axios or the generated service clients directly', () => {
    for (const { src } of allTsSrcs) {
      expect(src).not.toMatch(/from\s+['"]axios['"]/);
      expect(src).not.toMatch(/services\/api['"]/);
      expect(src).not.toMatch(/api\/contextsClient['"]/);
    }
  });
});

describe('Contexts rebuild — typed thread box, not semantic related (the moat)', () => {
  it('the thread box reads api.contexts.links (typed edges), never the semantic related list', () => {
    const hooks = readFileSync(resolve(modDir, 'hooks.ts'), 'utf8');
    // The typed-edge thread box is fed by links (structure), full stop.
    expect(hooks).toMatch(/api\.contexts\.links\(/);
    // The moat's teeth: ThreadBox (the thread-box render) must render typed ContextLink
    // edges and NEVER the semantic `related` data — the two are never conflated
    // (data-gap policy). The separate, clearly-labelled "Related" section
    // (ContextDetail, semantic similarity) is a DISTINCT feature and may call related() —
    // the invariant is that the THREAD BOX itself is links-only.
    const threadBox = readFileSync(resolve(modDir, 'ThreadBox.tsx'), 'utf8');
    expect(threadBox).toMatch(/ContextLink/);
    expect(threadBox).toMatch(/edgeLabel\(/);
    expect(threadBox).not.toMatch(/\.related\b/);
    expect(threadBox).not.toMatch(/related:/);
    // And the related() call, where present, must be the semantic Related section —
    // never wired into the ThreadBox/links path.
    expect(threadBox).not.toMatch(/api\.contexts\.related/);
  });
});

describe('Contexts rebuild — token-driven', () => {
  it('the layout stylesheet carries no hardcoded hex colours', () => {
    const css = readFileSync(resolve(modDir, 'Contexts.module.css'), 'utf8').replace(
      /\/\*[\s\S]*?\*\//g,
      '',
    );
    expect(css.match(HEX) ?? []).toEqual([]);
  });
});
