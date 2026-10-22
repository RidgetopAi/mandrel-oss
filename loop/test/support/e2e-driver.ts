/**
 * End-to-end driver for scripts/test/loop-e2e.test.sh: one punch from ready to merged against a real
 * git origin and clone, a FakeBoard, and fake `claude` and `gh` executables. Not a vitest file.
 * Prints one line per mode: `mode=<mode> stages=<ready claimed ...> ticks=<n>`; exits non-zero on failure.
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeBoard } from '../../src/board/fake.js';
import type { Task } from '../../src/board.js';
import type { ClaimRefused, Transition } from '../../src/notify.js';
import { run } from '../../src/run.js';

const MODES = ['pr', 'direct'] as const;
const MAX_TICKS = 12;
const IDENTITY = { GIT_AUTHOR_NAME: 'e2e', GIT_AUTHOR_EMAIL: 'e2e@example.com', GIT_COMMITTER_NAME: 'e2e', GIT_COMMITTER_EMAIL: 'e2e@example.com' };
Object.assign(process.env, IDENTITY);

const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

function executable(path: string, body: string): string {
  writeFileSync(path, body);
  chmodSync(path, 0o755);
  return path;
}

// Worker: commit a file on the worktree's branch. Critic (told its evidence dir): write a PASS verdict.
const FAKE_CLAUDE = `#!/usr/bin/env node
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const dir = process.env.MANDREL_LOOP_EVIDENCE_DIR;
if (dir) {
  fs.writeFileSync(dir + '/verdict.json', JSON.stringify({ verdict: 'PASS', note: 'fake critic', clauses: [{ index: 0, verified: true, evidence: 'fake' }] }));
} else {
  fs.writeFileSync('widget.txt', 'built by the fake worker\\n');
  execFileSync('git', ['add', '-A']);
  execFileSync('git', ['-c', 'user.email=f@x', '-c', 'user.name=F', 'commit', '-q', '-m', 'work']);
}
`;

// gh: \`pr create\` prints a PR url, \`pr view\` reports it merged. Calls are logged beside the script.
const fakeGh = (log: string): string => `#!/usr/bin/env bash
echo "$@" >> '${log}'
case "$1 $2" in
  "pr create") echo "https://example.invalid/acme/widgets/pull/7" ;;
  "pr view") echo '{"state":"MERGED"}' ;;
  *) exit 1 ;;
esac
`;

async function runMode(mode: (typeof MODES)[number]): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), `loop-e2e-${mode}-`));
  const origin = join(root, 'origin.git');
  const clone = join(root, 'clone');
  const bin = join(root, 'bin');
  for (const d of [origin, bin]) mkdirSync(d);
  git(origin, 'init', '-q', '--bare', '-b', 'main');
  git(root, 'clone', '-q', origin, clone);
  git(clone, 'checkout', '-q', '-b', 'main');
  writeFileSync(join(clone, 'README.md'), 'e2e\n');
  git(clone, 'add', '-A');
  git(clone, 'commit', '-q', '-m', 'init');
  git(clone, 'push', '-q', 'origin', 'main');

  const claude = executable(join(bin, 'claude'), FAKE_CLAUDE);
  const ghLog = join(bin, 'gh.log');
  const gh = executable(join(bin, 'gh'), fakeGh(ghLog));
  const config = join(root, 'mandrel-loop.config.json');
  writeFileSync(
    config,
    JSON.stringify({
      mandrel: { url: 'http://localhost:8080', project: 'e2e' },
      repos: { widgets: { path: clone, gate: 'true' } },
      models: { worker: 'worker-model', critic: 'critic-model' },
      merge: { mode },
      workdir: join(root, 'work'),
    }),
  );

  const task: Task = {
    id: 'e2e00000-0000-4000-8000-000000000001',
    title: 'Add the widget',
    stage: 'ready',
    status: 'todo',
    priority: 'medium',
    tags: ['repo:widgets'],
    createdAt: '2026-01-01T00:00:00Z',
    claimLive: false,
    metadata: {
      description: 'build the widget',
      punch: { doneWhen: [{ text: 'widget.txt exists', owner: 'lane', proof: 'test/widget.test.ts' }], proofKind: 'test' },
    },
  };
  const board = new FakeBoard({ tasks: [task] });
  const env = {
    PATH: `${bin}:${process.env.PATH ?? ''}`,
    HOME: root,
    LANG: 'C',
    MANDREL_TOKEN: 'e2e-token',
    ANTHROPIC_API_KEY: 'e2e-key',
    MANDREL_LOOP_CLAUDE_BIN: claude,
    MANDREL_LOOP_GH_BIN: gh,
  };

  const transitions: Transition[] = [];
  const refusals: ClaimRefused[] = [];
  const errs: string[] = [];
  let ticks = 0;
  while (ticks < MAX_TICKS && (await board.get(task.id))!.stage !== 'merged') {
    ticks++;
    const code = await run(['once', '--config', config], {
      board: () => board,
      env,
      out: (l) => {
        const event = JSON.parse(l) as Transition | ClaimRefused;
        if (event.event === 'claim-refused') refusals.push(event);
        else transitions.push(event);
      },
      err: (l) => errs.push(l),
      auth: { uid: () => 1000, ghAuthOk: () => true },
    });
    if (code !== 0) throw new Error(`${mode}: once exited ${code}\n${errs.join('\n')}`);
  }
  // FakeBoard enforces the server's claim rules, so a refusal here is a refusal the server would give.
  if (refusals.length > 0) throw new Error(`${mode}: board refused claims: ${JSON.stringify(refusals)}`);
  const final = (await board.get(task.id))!;
  if (final.stage !== 'merged') throw new Error(`${mode}: stopped at ${final.stage} after ${ticks} ticks\n${errs.join('\n')}`);

  // The merge really happened in git, not just on the board.
  const branch = git(clone, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/loop/');
  const onOrigin = git(origin, 'branch', '--list', branch.replace(/^\s+/, ''));
  if (mode === 'direct') {
    const widget = git(origin, 'show', 'main:widget.txt');
    if (!widget.includes('fake worker')) throw new Error('direct: origin/main lacks the merged widget');
  } else if (!onOrigin) {
    throw new Error(`pr: branch ${branch} was never pushed to origin`);
  }
  const stages = [transitions[0]!.from, ...transitions.map((t) => t.to)];
  return `mode=${mode} stages=${stages.join(' ')} ticks=${ticks}`;
}

for (const mode of MODES) console.log(await runMode(mode));
