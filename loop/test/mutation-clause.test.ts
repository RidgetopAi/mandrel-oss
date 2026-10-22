import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CRITIC_CONFIG } from '../src/config.js';
import { lintWarnings } from '../src/lint.js';
import { run } from '../src/run.js';

const card = readFileSync(new URL('../cards/planner.md', import.meta.url), 'utf8');
const MUTATION_CLAUSE = {
  text: `${CRITIC_CONFIG.mutationClauseText}: delete the guard in f(); revert the default in g(). Unmutated control GREEN.`,
  owner: 'lane',
  proof: 'walkthrough evidence (not committed to the repo)',
};
const punch = (proofKind: string, extra: unknown[] = []) => ({
  title: 'T',
  description: 'creates src/a.ts and test/a.test.ts',
  size: 's',
  repo: 'r',
  dependsOnIndex: [],
  doneWhen: [{ text: 'a returns 1', owner: 'lane', proof: 'test/a.test.ts' }, ...extra],
  proofKind,
});

function lintCli(punches: unknown): Promise<{ code: number; lines: string[] }> {
  const file = join(mkdtempSync(join(tmpdir(), 'loop-mut-')), 'punches.json');
  writeFileSync(file, JSON.stringify(punches));
  const lines: string[] = [];
  return run(['lint', file], { out: (l) => lines.push(l) }).then((code) => ({ code, lines }));
}

describe('planner card mutation clause', () => {
  it('instructs the Critic-applies-and-shows-RED clause for test-proof punches', () => {
    expect(card).toContain('Critic applies and shows RED: <mutation>; <mutation>. Unmutated control GREEN.');
    expect(card).toMatch(/proofKind.*`test`/);
    expect(card).toMatch(/WARNS/);
  });
});

describe('lint mutation-clause warning', () => {
  it('warns on a test-proof punch without the clause, leaving the exit status at 0', async () => {
    const { code, lines } = await lintCli([punch('test')]);
    expect(code).toBe(0);
    expect(lines.join('\n')).toMatch(/punch 0: warning \[missing-mutation-clause\]/);
    expect(lines.at(-1)).toBe('lint: clean');
  });

  it('does not warn when the clause is present', async () => {
    const { code, lines } = await lintCli([punch('test', [MUTATION_CLAUSE])]);
    expect(code).toBe(0);
    expect(lines.join('\n')).not.toMatch(/warning/);
  });

  it('does not warn on a non-test punch', () => {
    expect(lintWarnings([punch('browser')])).toEqual([]);
  });

  it('leaves a failing list failing: exit 1 whether or not it warns', async () => {
    const bad = punch('test');
    bad.doneWhen[0] = { text: 'x', owner: 'lane', proof: undefined } as never;
    expect((await lintCli([bad])).code).toBe(1);
  });
});
