/**
 * Punch List pattern guard — the same source-level invariants the
 * Tasks rebuild carries: ZERO antd, the unified `api.*` client only, token-driven CSS
 * (no hex), and the stage config carries lane A's full enum in pipeline order.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, it, expect } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const modDir = resolve(here, 'punch');

const pageSrc = readFileSync(resolve(here, 'Punch.tsx'), 'utf8');
const partFiles = readdirSync(modDir).filter((f) => /\.tsx?$/.test(f));
const partSrcs = partFiles.map((f) => ({ f, src: readFileSync(resolve(modDir, f), 'utf8') }));
const allTsSrcs = [{ f: 'Punch.tsx', src: pageSrc }, ...partSrcs];

const HEX = /#[0-9a-fA-F]{3,8}\b/g;

describe('Punch List — no antd anywhere', () => {
  it('discovered the module', () => {
    expect(partFiles.length).toBeGreaterThanOrEqual(10);
  });
  it.each(allTsSrcs)('$f does not import antd', ({ src }) => {
    expect(src).not.toMatch(/from\s+['"]antd['"]/);
    expect(src).not.toMatch(/from\s+['"]@ant-design\/icons['"]/);
  });
});

describe('Punch List — unified client only', () => {
  it('hooks read through the unified api client', () => {
    const hooks = readFileSync(resolve(modDir, 'hooks.ts'), 'utf8');
    expect(hooks).toMatch(/from\s+['"]\.\.\/\.\.\/api['"]/);
    expect(hooks).toMatch(/api\.attachments\./);
  });
  it('no part imports axios or the legacy service client directly', () => {
    for (const { src } of allTsSrcs) {
      expect(src).not.toMatch(/from\s+['"]axios['"]/);
      expect(src).not.toMatch(/services\/api['"]/);
      expect(src).not.toMatch(/apiService/);
    }
  });
  it('no part puts the bearer token in an image URL', () => {
    for (const { src } of allTsSrcs) {
      expect(src).not.toMatch(/aidis_token/);
      expect(src).not.toMatch(/[?&]token=/);
    }
  });
});

describe('Punch List — the stage enum is lane A\'s, in pipeline order', () => {
  it('config carries all seven stages in order and the blocked lane is not one of them', () => {
    const config = readFileSync(resolve(modDir, 'config.ts'), 'utf8');
    const order = ['draft', 'ready', 'claimed', 'verifying', 'evidence', 'merged', 'deployed'];
    const idx = order.map((s) => config.indexOf(`stage: '${s}'`));
    expect(idx.every((i) => i >= 0)).toBe(true);
    expect([...idx].sort((a, b) => a - b)).toEqual(idx);
    expect(config).not.toMatch(/stage: 'blocked'/);
  });
});

describe('Punch List — token-driven', () => {
  it('the stylesheet carries no hardcoded hex colours', () => {
    const css = readFileSync(resolve(modDir, 'Punch.module.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(css.match(HEX) ?? []).toEqual([]);
    expect(css).toMatch(/var\(--/);
  });
});

describe('Punch List — card/detail text does not escape its container', () => {
  const css = readFileSync(resolve(modDir, 'Punch.module.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  // Long unbroken strings (uuids, urls) are the reported symptom; overflow-wrap: anywhere
  // is the one declaration measured to fix it (min-width:0 on .cardTitle is inert for it).
  const ruleFor = (selector: string) => {
    const match = css.match(new RegExp(`\\.${selector}\\s*\\{([^}]*)\\}`));
    return match?.[1] ?? '';
  };

  it.each(['cardTitle', 'detailTitle', 'detailProse'])(
    '.%s declares overflow-wrap: anywhere',
    (selector) => {
      expect(ruleFor(selector)).toMatch(/overflow-wrap:\s*anywhere/);
    },
  );
});
