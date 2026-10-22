/**
 * SessionDetail rebuild pattern guard (the last pre-redesign page, brought onto the
 * proven detail pattern — mirrors ProjectDetail.wiring.test.ts). Asserts the rebuilt
 * SessionDetail page + its `sessionDetail/` module:
 *   1. import ZERO antd (migrated fully off the old component lib);
 *   2. wire data through the UNIFIED `api.sessions.*` client (not the old
 *      SessionsService / sessionsClient / axios);
 *   3. carry no hardcoded hex colours in the stylesheet (token-driven);
 *   4. keep every screen tunable in config.ts (configs-not-hardcoded) — no magic
 *      staleness / recency literal inline in the page.
 * Source-level invariants — cheap, deterministic, drift-proof.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, it, expect } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const modDir = resolve(here, 'sessionDetail');

const pageSrc = readFileSync(resolve(here, 'SessionDetail.tsx'), 'utf8');
const partFiles = readdirSync(modDir).filter((f) => /\.tsx?$/.test(f) && !f.endsWith('.css'));
const partSrcs = partFiles.map((f) => ({ f, src: readFileSync(resolve(modDir, f), 'utf8') }));
const allTsSrcs = [{ f: 'SessionDetail.tsx', src: pageSrc }, ...partSrcs];

const HEX = /#[0-9a-fA-F]{3,8}\b/g;

describe('SessionDetail rebuild — no antd anywhere', () => {
  it.each(allTsSrcs)('$f does not import antd', ({ src }) => {
    expect(src).not.toMatch(/from\s+['"]antd['"]/);
    expect(src).not.toMatch(/from\s+['"]@ant-design\/icons['"]/);
  });
});

describe('SessionDetail rebuild — unified client only', () => {
  it('hooks read through the unified api.sessions client', () => {
    const hooks = readFileSync(resolve(modDir, 'hooks.ts'), 'utf8');
    expect(hooks).toMatch(/from\s+['"]\.\.\/\.\.\/api['"]/);
    expect(hooks).toMatch(/api\.sessions\.get/);
    expect(hooks).toMatch(/api\.sessions\.files/);
  });

  it('no part imports axios or the retired session clients directly', () => {
    for (const { src } of allTsSrcs) {
      expect(src).not.toMatch(/from\s+['"]axios['"]/);
      expect(src).not.toMatch(/api\/sessionsClient/);
      expect(src).not.toMatch(/SessionsService/);
      expect(src).not.toMatch(/api\/generated/);
    }
  });
});

describe('SessionDetail rebuild — token-driven', () => {
  it('the layout stylesheet carries no hardcoded hex colours', () => {
    const css = readFileSync(resolve(modDir, 'SessionDetail.module.css'), 'utf8').replace(
      /\/\*[\s\S]*?\*\//g,
      '',
    );
    expect(css.match(HEX) ?? []).toEqual([]);
  });
});

describe('SessionDetail rebuild — configs-not-hardcoded', () => {
  it('staleness + recency tunables live in config.ts, not inline in the page', () => {
    const config = readFileSync(resolve(modDir, 'config.ts'), 'utf8');
    expect(config).toMatch(/detailStaleMs/);
    expect(config).toMatch(/liveWithinMs/);
    // the page does not inline a raw ms recency/staleness literal
    expect(pageSrc).not.toMatch(/1000\s*\*\s*60\s*\*\s*60/);
    expect(pageSrc).not.toMatch(/1000\s*\*\s*60\s*\*\s*2/);
  });
});
