import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Task } from '../src/board.js';
import { FakeBoard } from '../src/board/fake.js';

export const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', env: gitEnv }).trim();

// Identity for every git the merger spawns too: the gate runs tests with no global git config.
Object.assign(process.env, {
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@example.com',
});
const gitEnv = process.env;

export interface Repo {
  root: string;
  origin: string;
  work: string;
  branchSha: string;
}

/** A temp bare origin, a clone on main, and a pushed-nowhere local branch `feat` with one commit. */
export function makeRepo(branchFile = 'feature.txt'): Repo {
  const root = mkdtempSync(join(tmpdir(), 'merger-'));
  const origin = join(root, 'origin.git');
  const work = join(root, 'work');
  mkdirSync(origin);
  git(origin, 'init', '--bare', '-b', 'main');
  git(root, 'clone', origin, work);
  git(work, 'checkout', '-b', 'main');
  writeFileSync(join(work, 'base.txt'), 'base\n');
  git(work, 'add', '-A');
  git(work, 'commit', '-m', 'base');
  git(work, 'push', 'origin', 'main');
  git(work, 'checkout', '-b', 'feat');
  writeFileSync(join(work, branchFile), 'feature\n');
  git(work, 'add', '-A');
  git(work, 'commit', '-m', 'feature');
  const branchSha = git(work, 'rev-parse', 'HEAD');
  git(work, 'checkout', 'main');
  return { root, origin, work, branchSha };
}

export function script(dir: string, name: string, body: string): string {
  const p = join(dir, name);
  writeFileSync(p, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(p, 0o755);
  return p;
}

export function evidenceTask(sha: string, over: Partial<Task> = {}, punch: Record<string, unknown> = {}): Task {
  return {
    id: 'daa8bb19-0000-0000-0000-000000000001',
    title: 'loop: thing',
    stage: 'evidence',
    status: 'in_progress',
    priority: 'medium',
    tags: ['repo:x'],
    createdAt: '2026-01-01T00:00:00Z',
    claimLive: false,
    metadata: {
      punch: {
        doneWhen: [{ text: 'clause one', owner: 'lane', proof: 'a.test.ts' }],
        proofKind: 'test',
        branch: 'feat',
        verdict: {
          result: 'PASS',
          sha,
          clauses: [
            { text: 'clause one holds', result: 'PASS' },
            { text: 'clause two holds', result: 'PASS' },
          ],
        },
        ...punch,
      },
    },
    ...over,
  };
}

export const boardWith = (t: Task): FakeBoard => new FakeBoard({ tasks: [t] });
