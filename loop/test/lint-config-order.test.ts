import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { run } from '../src/run.js';

const root = join(import.meta.dirname, '..', '..');
const dir = mkdtempSync(join(tmpdir(), 'loop-lint-order-'));
const CONFIG = join(dir, 'mandrel-loop.config.json');
writeFileSync(
  CONFIG,
  JSON.stringify({
    mandrel: { url: 'http://localhost:8080', project: 'p' },
    models: { worker: 'a', critic: 'b' },
    repos: { app: { path: dir, gate: 'true' } },
  }),
);
const FILE = join(dir, 'punches.json');
writeFileSync(
  FILE,
  JSON.stringify([
    {
      title: 'Add the parser',
      description: 'Create src/parser.ts and test/parser.test.ts.',
      size: 's',
      repo: 'app',
      dependsOnIndex: [],
      doneWhen: [{ text: 'the parser parses', owner: 'lane', proof: 'test/parser.test.ts' }],
      proofKind: 'test',
    },
  ]),
);

const lint = async (args: string[]) => {
  const out: string[] = [];
  const code = await run(args, { out: (l) => out.push(l) });
  return { code, out: out.join('\n') };
};

describe('lint --config in either order', () => {
  it('accepts --config before and after the file, with the same output', async () => {
    const before = await lint(['lint', '--config', CONFIG, FILE]);
    const after = await lint(['lint', FILE, '--config', CONFIG]);
    expect(before.code).toBe(0);
    expect(after.code).toBe(0);
    expect(before.out).toContain('lint: clean');
    expect(after.out).toBe(before.out);
  });
});

function mdFiles(d: string): string[] {
  return readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? mdFiles(join(d, f)) : f.endsWith('.md') ? [join(d, f)] : []));
}

describe('docs: unknown-repo skip wording and the cost line', () => {
  it('no doc says an unknown-repo punch is logged once without "per tick"', () => {
    for (const f of mdFiles(join(root, 'docs', 'loop'))) {
      for (const m of readFileSync(f, 'utf8').matchAll(/logged once(?! per tick)/g)) {
        throw new Error(`${f}: "logged once" without "per tick" at offset ${m.index}`);
      }
    }
  });
  it('the user guide and loop/README.md each mention the per-run cost line', () => {
    for (const f of [join(root, 'docs', 'loop', 'user-guide.md'), join(root, 'loop', 'README.md')]) {
      expect(readFileSync(f, 'utf8'), f).toContain('claude run: role=<role> punch=<id8> cost=$<total_cost_usd>');
    }
  });
});
