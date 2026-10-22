import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { lintPunches, type Violation } from '../src/lint.js';
import { run } from '../src/run.js';

const fixture = (name: string): string => new URL(`./fixtures/${name}`, import.meta.url).pathname;
const load = (name: string): unknown => JSON.parse(readFileSync(fixture(name), 'utf8'));

async function cli(file: string): Promise<{ code: number; lines: string[] }> {
  const lines: string[] = [];
  const code = await run(['lint', file], { out: (l) => lines.push(l) });
  return { code, lines };
}

describe('lint on punches-bad.json', () => {
  it('exits 1 and names every seeded offence by punch and clause index', async () => {
    const { code, lines } = await cli(fixture('punches-bad.json'));
    expect(code).toBe(1);
    const text = lines.join('\n');
    expect(text).toMatch(/punch 0 clause 1: \[missing-proof\]/);
    expect(text).toMatch(/punch 0 clause 2: \[banned-word\].*systemctl/);
    expect(text).toMatch(/punch 0 clause 3: \[rooted-path\]/);
    expect(text).toMatch(/punch 0 clause 4: \[process-phrase\].*in the foreground/);
    expect(text).toMatch(/punch 0 clause 5: \[non-relative-proof\]/);
  });

  it('reports exactly the five seeded offences and leaves the clean clause alone', () => {
    const v = lintPunches(load('punches-bad.json'));
    expect(v.map((x: Violation) => [x.punch, x.clause, x.rule])).toEqual([
      [0, 1, 'missing-proof'],
      [0, 2, 'banned-word'],
      [0, 3, 'rooted-path'],
      [0, 4, 'process-phrase'],
      [0, 5, 'non-relative-proof'],
    ]);
  });
});

describe('lint on punches-good.json', () => {
  it('exits 0', async () => {
    const { code, lines } = await cli(fixture('punches-good.json'));
    expect(code).toBe(0);
    expect(lines.at(-1)).toBe('lint: clean');
  });
});

describe('lint rules', () => {
  const base = { title: 't', description: 'd', size: 's', repo: 'r', dependsOnIndex: [], proofKind: 'test' };
  const clause = (c: object) => [{ ...base, doneWhen: [c] }];

  it('does not flag words that merely contain a banned word, or relative paths', () => {
    expect(lintPunches(clause({ text: 'dockerfile docs mention loop/src/x.ts and and/or', owner: 'human' }))).toEqual([]);
  });

  it('flags ~/ and windows rooted paths and URL / parent-escaping proofs', () => {
    const rules = (c: object) => lintPunches(clause(c)).map((v) => v.rule);
    expect(rules({ text: 'reads ~/.config/x', owner: 'human' })).toEqual(['rooted-path']);
    expect(rules({ text: 'reads C:\\Users\\x', owner: 'human' })).toEqual(['rooted-path']);
    expect(rules({ text: 'ok', owner: 'lane', proof: 'https://x.test/a' })).toEqual(['non-relative-proof']);
    expect(rules({ text: 'ok', owner: 'lane', proof: '../outside.test.ts' })).toEqual(['non-relative-proof']);
  });

  it('rejects a forward or self dependency and a non-array input', () => {
    const p = [{ ...base, dependsOnIndex: [0], doneWhen: [{ text: 'ok', owner: 'human' }] }];
    expect(lintPunches(p).map((v) => v.rule)).toEqual(['dependency']);
    expect(lintPunches({}).map((v) => v.rule)).toEqual(['shape']);
  });

  it('honours an injected config', () => {
    const cfg = { bannedWords: ['frobnicate'], rootedPathRoots: [], processClaimPhrases: [] };
    const v = lintPunches(clause({ text: 'we frobnicate it', owner: 'human' }), cfg);
    expect(v.map((x) => x.rule)).toEqual(['banned-word']);
  });
});

describe('lint cross-punch proof ordering', () => {
  const mk = (description: string, dependsOnIndex: number[], proof: string, touches?: string[]) => ({
    title: 't', description, size: 's', repo: 'r', dependsOnIndex, proofKind: 'test',
    ...(touches ? { touches } : {}),
    doneWhen: [{ text: 'works', owner: 'lane', proof }],
  });
  const withFile = (name: string, punches: unknown[]): string => {
    const dir = mkdtempSync(join(tmpdir(), 'lint-order-'));
    const file = join(dir, name);
    writeFileSync(file, JSON.stringify(punches));
    return file;
  };

  it('exits 1 naming both punches when punch 0 cites a proof only punch 1 creates (description or touches)', async () => {
    for (const second of [
      mk('Add loop/test/foo.test.ts covering foo.', [0], 'loop/test/bar.test.ts'),
      mk('Add foo tests.', [0], 'loop/test/bar.test.ts', ['loop/test/foo.test.ts']),
    ]) {
      const first = mk('Add foo().', [], 'loop/test/foo.test.ts');
      const { code, lines } = await cli(withFile('p.json', [first, second]));
      expect(code).toBe(1);
      const text = lines.join('\n');
      expect(text).toMatch(/punch 0 clause 0: \[proof-created-later\].*punch 1.*punch 0/);
    }
  });

  it('exits 0 when the function and its test are in one punch', async () => {
    const one = mk('Add foo() and loop/test/foo.test.ts.', [], 'loop/test/foo.test.ts');
    const { code } = await cli(withFile('p.json', [one]));
    expect(code).toBe(0);
  });

  it('allows a proof created by an earlier punch', () => {
    const a = mk('Add loop/test/foo.test.ts.', [], 'loop/test/foo.test.ts');
    const b = mk('Wire it.', [0], 'loop/test/foo.test.ts');
    expect(lintPunches([a, b])).toEqual([]);
  });
});
