import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { mergerOptions, sweep } from '../src/merger.js';
import { boardWith, evidenceTask, git, makeRepo, script } from './merger-helpers.js';

async function direct(gateBody: string, prepare?: (work: string) => void, gateTimeoutMs?: number) {
  const repo = makeRepo();
  const gate = script(repo.root, 'gate.sh', gateBody);
  prepare?.(repo.work);
  const task = evidenceTask(repo.branchSha);
  const board = boardWith(task);
  const pre = git(repo.work, 'rev-parse', 'main');
  const results = await sweep(board, mergerOptions(repo.work, { mode: 'direct', gateCommand: gate, ...(gateTimeoutMs ? { gateTimeoutMs } : {}) }));
  return { repo, board, task, pre, results, after: (await board.get(task.id))! };
}

describe('merger direct mode', () => {
  it('gate exit 0: pushes the merge and sets stage merged', async () => {
    const { repo, after, results } = await direct('exit 0');
    expect(results[0]?.action).toBe('merged');
    expect(git(repo.origin, 'merge-base', '--is-ancestor', repo.branchSha, 'refs/heads/main')).toBe('');
    expect(git(repo.origin, 'rev-parse', 'refs/heads/main')).toBe(git(repo.work, 'rev-parse', 'main'));
    expect(after.stage).toBe('merged');
    expect(after.metadata.punch?.merge).toEqual({ sha: git(repo.origin, 'rev-parse', 'refs/heads/main'), rc: 0 });
  });

  it('gate exit 1: main reset, stage ready, mergeFailures 1, gate tail as note', async () => {
    const { repo, after, pre } = await direct('echo gate-said-no; exit 1');
    expect(git(repo.work, 'rev-parse', 'main')).toBe(pre);
    expect(git(repo.origin, 'rev-parse', 'refs/heads/main')).toBe(pre);
    expect(after.stage).toBe('ready');
    expect(after.metadata.punch?.mergeFailures).toBe(1);
    expect(JSON.stringify(after.metadata.noteLog)).toContain('gate-said-no');
  });

  it('gate exit 2: main unchanged, stays at evidence, nothing counted', async () => {
    const { repo, after, pre } = await direct('exit 2');
    expect(git(repo.work, 'rev-parse', 'main')).toBe(pre);
    expect(git(repo.origin, 'rev-parse', 'refs/heads/main')).toBe(pre);
    expect(after.stage).toBe('evidence');
    expect(after.metadata.punch).not.toHaveProperty('mergeFailures');
  });

  it('gate timeout: reset, stays at evidence, nothing counted', async () => {
    const { repo, after, pre } = await direct('sleep 5', undefined, 200);
    expect(git(repo.work, 'rev-parse', 'main')).toBe(pre);
    expect(after.stage).toBe('evidence');
    expect(after.metadata.punch).not.toHaveProperty('mergeFailures');
  });

  it('preflight: an untracked file in the main checkout touches nothing', async () => {
    const { repo, after, pre, results } = await direct('exit 0', (w) => writeFileSync(join(w, 'stray.txt'), 'x'));
    expect(results[0]?.action).toBe('could-not-measure');
    expect(git(repo.work, 'rev-parse', 'main')).toBe(pre);
    expect(git(repo.origin, 'rev-parse', 'refs/heads/main')).toBe(pre);
    expect(after.stage).toBe('evidence');
  });

  it('preflight: checkout not on main touches nothing', async () => {
    const { results, after } = await direct('exit 0', (w) => git(w, 'checkout', 'feat'));
    expect(results[0]?.action).toBe('could-not-measure');
    expect(after.stage).toBe('evidence');
  });

  it('preflight: main behind the remote touches nothing', async () => {
    const { results, after } = await direct('exit 0', (w) => {
      git(w, 'checkout', '-q', 'main');
      writeFileSync(join(w, 'o.txt'), 'o');
      git(w, 'add', '-A');
      git(w, 'commit', '-m', 'local only');
    });
    expect(results[0]?.action).toBe('could-not-measure');
    expect(after.stage).toBe('evidence');
  });

  it('merge conflict parks the punch at evidence with conflict set, main untouched', async () => {
    const { repo, after, pre, results } = await direct('exit 0', (w) => {
      writeFileSync(join(w, 'feature.txt'), 'different\n');
      git(w, 'add', '-A');
      git(w, 'commit', '-m', 'collide');
      git(w, 'push', 'origin', 'main');
    });
    expect(results[0]?.action).toBe('conflict');
    expect(git(repo.work, 'status', '--porcelain')).toBe('');
    expect(git(repo.work, 'rev-parse', 'main')).not.toBe(repo.branchSha);
    expect(git(repo.origin, 'rev-parse', 'refs/heads/main')).toBe(git(repo.work, 'rev-parse', 'main'));
    expect(pre).not.toBe('');
    expect(after.stage).toBe('evidence');
    expect(after.metadata.punch?.conflict).toBeTruthy();
  });
});
