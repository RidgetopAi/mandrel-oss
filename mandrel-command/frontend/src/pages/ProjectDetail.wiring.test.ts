/**
 * ProjectDetail rebuild pattern guard (P2 — follows the Contexts/Tasks/Decisions/Projects
 * screen-rebuild pattern). Asserts the rebuilt ProjectDetail page + its `projectDetail/`
 * module:
 *   1. import ZERO antd (migrated fully off the old component lib);
 *   2. wire data through the UNIFIED `api.*` client (not axios/generated/old useProjects hooks);
 *   3. carry no hardcoded hex colours in the stylesheet (token-driven);
 *   4. keep every screen tunable in config.ts (configs-not-hardcoded) — no magic recency
 *      threshold literal in the page.
 * Source-level invariants — cheap, deterministic, drift-proof.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, it, expect } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const modDir = resolve(here, 'projectDetail');

const pageSrc = readFileSync(resolve(here, 'ProjectDetail.tsx'), 'utf8');
const partFiles = readdirSync(modDir).filter((f) => /\.tsx?$/.test(f) && !f.endsWith('.css'));
const partSrcs = partFiles.map((f) => ({ f, src: readFileSync(resolve(modDir, f), 'utf8') }));
const allTsSrcs = [{ f: 'ProjectDetail.tsx', src: pageSrc }, ...partSrcs];

const HEX = /#[0-9a-fA-F]{3,8}\b/g;

describe('ProjectDetail rebuild — no antd anywhere', () => {
  it.each(allTsSrcs)('$f does not import antd', ({ src }) => {
    expect(src).not.toMatch(/from\s+['"]antd['"]/);
    expect(src).not.toMatch(/from\s+['"]@ant-design\/icons['"]/);
  });
});

describe('ProjectDetail rebuild — unified client only', () => {
  it('hooks read through the unified api client', () => {
    const hooks = readFileSync(resolve(modDir, 'hooks.ts'), 'utf8');
    expect(hooks).toMatch(/from\s+['"]\.\.\/\.\.\/api['"]/);
    expect(hooks).toMatch(/api\.projects\./);
    expect(hooks).toMatch(/api\.decisions\./);
  });

  it('no part imports axios or the old useProjects hooks directly', () => {
    for (const { src } of allTsSrcs) {
      expect(src).not.toMatch(/from\s+['"]axios['"]/);
      expect(src).not.toMatch(/hooks\/useProjects['"]/);
      expect(src).not.toMatch(/services\/projectApi['"]/);
    }
  });
});

describe('ProjectDetail rebuild — token-driven', () => {
  it('the layout stylesheet carries no hardcoded hex colours', () => {
    const css = readFileSync(resolve(modDir, 'ProjectDetail.module.css'), 'utf8').replace(
      /\/\*[\s\S]*?\*\//g,
      '',
    );
    expect(css.match(HEX) ?? []).toEqual([]);
  });
});

describe('ProjectDetail rebuild — configs-not-hardcoded', () => {
  it('the recency threshold + tunables live in config.ts, not inline in the page', () => {
    const config = readFileSync(resolve(modDir, 'config.ts'), 'utf8');
    expect(config).toMatch(/dormantAfterMs/);
    // the page derives active/dormant via the config predicate, not a local time literal
    expect(pageSrc).toMatch(/isProjectActive/);
    expect(pageSrc).not.toMatch(/1000\s*\*\s*60\s*\*\s*60/);
  });
});
