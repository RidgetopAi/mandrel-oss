import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { mergerOptions, sweep } from '../src/merger.js';
import { boardWith, evidenceTask, makeRepo, script } from './merger-helpers.js';

const loopEnv = {
  ...process.env,
  MANDREL_TOKEN: 'mandrel-secret-value',
  SECRET_X: 'unrelated-secret-value',
  GH_TOKEN: 'gh-secret-value',
  HOME: '/loop/home',
};

describe('merger child environments', () => {
  it('direct mode: the gate sees PATH and HOME but neither MANDREL_TOKEN nor SECRET_X nor GH_TOKEN', async () => {
    const repo = makeRepo();
    const dump = join(repo.root, 'gate-env.txt');
    const gate = script(repo.root, 'gate.sh', `env > "${dump}"; exit 0`);
    const results = await sweep(
      boardWith(evidenceTask(repo.branchSha)),
      mergerOptions(repo.work, { mode: 'direct', gateCommand: gate }, loopEnv),
    );
    expect(results[0]?.action).toBe('merged');
    const seen = readFileSync(dump, 'utf8');
    expect(seen).toMatch(/^PATH=/m);
    expect(seen).toMatch(/^HOME=\/loop\/home$/m);
    for (const secret of ['MANDREL_TOKEN', 'SECRET_X', 'GH_TOKEN', 'mandrel-secret-value', 'unrelated-secret-value', 'gh-secret-value']) {
      expect(seen).not.toContain(secret);
    }
  });

  it('pr mode: gh receives GH_TOKEN but not MANDREL_TOKEN or SECRET_X', async () => {
    const repo = makeRepo();
    const dump = join(repo.root, 'gh-env.txt');
    const gh = script(
      repo.root,
      'gh',
      `env > "${dump}"\nif [ "$1 $2" = "pr create" ]; then echo "https://github.com/o/r/pull/42"; fi`,
    );
    const results = await sweep(
      boardWith(evidenceTask(repo.branchSha)),
      mergerOptions(repo.work, { mode: 'pr', ghBin: gh }, loopEnv),
    );
    expect(results[0]?.action).toBe('pr-opened');
    const seen = readFileSync(dump, 'utf8');
    expect(seen).toMatch(/^GH_TOKEN=gh-secret-value$/m);
    expect(seen).toMatch(/^PATH=/m);
    expect(seen).not.toContain('MANDREL_TOKEN');
    expect(seen).not.toContain('SECRET_X');
  });
});
