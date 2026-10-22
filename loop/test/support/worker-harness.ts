import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import type { Task } from '../../src/board.js';
import { FakeBoard } from '../../src/board/fake.js';
import { parseConfig, type LoopConfig } from '../../src/settings.js';

export const TASK_ID = 'abcdef12-3456-4789-8abc-def012345678';

export const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', env: { PATH: process.env.PATH!, HOME: cwd } }).trim();

export interface Harness {
  root: string;
  repo: string;
  bin: string;
  config: LoopConfig;
  board: FakeBoard;
  env: NodeJS.ProcessEnv;
}

/** A temp repo with one commit on main, a config pointing at it, and a ready punch. */
export function makeHarness(fakeClaude: string, extra: Partial<Task> = {}, envExtra: NodeJS.ProcessEnv = {}): Harness {
  const root = mkdtempSync(join(tmpdir(), 'loop-worker-'));
  const repo = join(root, 'repo');
  const bin = join(root, 'bin');
  mkdirSync(repo);
  mkdirSync(bin);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 't@example.com');
  git(repo, 'config', 'user.name', 'T');
  writeFileSync(join(repo, 'README.md'), 'hi\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'init');
  const script = join(bin, 'claude');
  writeFileSync(script, fakeClaude);
  chmodSync(script, 0o755);
  const config = parseConfig(
    JSON.stringify({
      mandrel: { url: 'http://localhost:8080', project: 'p' },
      repos: { 'demo-repo': { path: repo, gate: 'true' } },
      models: { worker: 'w-model', critic: 'c-model' },
      workdir: join(root, 'work'),
    }),
    root,
  );
  const task: Task = {
    id: TASK_ID,
    title: 'Add the Widget!',
    stage: 'ready',
    status: 'todo',
    priority: 'medium',
    tags: ['repo:demo-repo'],
    createdAt: '2026-01-01T00:00:00Z',
    claimLive: false,
    metadata: {
      description: 'build it',
      punch: { doneWhen: [{ text: 'it works', owner: 'lane', proof: 'test/x.test.ts' }], proofKind: 'test' },
    },
    ...extra,
  };
  const board = new FakeBoard({ tasks: [task] });
  const env = { PATH: `${bin}:${process.env.PATH}`, HOME: root, LANG: 'C', ...envExtra };
  return { root, repo, bin, config, board, env };
}

/** A fake claude (node script, so the shell adds no env keys) that commits `file` on the current branch. */
export const committingClaude = (file = 'widget.txt'): string =>
  `#!/usr/bin/env node
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(file)}, String(Date.now()) + Math.random());
execFileSync('git', ['add', '-A']);
execFileSync('git', ['-c', 'user.email=f@x', '-c', 'user.name=F', 'commit', '-q', '-m', 'work']);
`;

export const noopClaude = '#!/usr/bin/env node\nprocess.exit(0);\n';
