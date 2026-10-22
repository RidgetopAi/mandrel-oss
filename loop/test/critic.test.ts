import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { FakeBoard } from '../src/board/fake.js';
import type { Task } from '../src/board.js';
import { defaultCriticDeps, readVerdict, runCritic, type CriticDeps } from '../src/critic.js';
import { parseConfig } from '../src/settings.js';

const ROOT = mkdtempSync(join(tmpdir(), 'loop-critic-'));
const REPO = join(ROOT, 'repo');
const WORKDIR = join(ROOT, 'work');
const BIN_DIR = join(ROOT, 'bin');
const CHOICE = join(BIN_DIR, 'choice.json');
const STDOUT_LINE = join(BIN_DIR, 'stdout-line');
const ARGV_LOG = join(BIN_DIR, 'argv');
const git = (...a: string[]) => execFileSync('git', a, { cwd: REPO, encoding: 'utf8' }).trim();

mkdirSync(REPO);
mkdirSync(BIN_DIR);
git('init', '-q', '-b', 'main');
git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'x');
const SHA = git('rev-parse', 'HEAD');

// The fake claude: records its argv, writes the verdict chosen by the test into the evidence directory.
const FAKE = join(BIN_DIR, 'claude');
writeFileSync(
  FAKE,
  `#!/bin/sh
echo "$@" > "${ARGV_LOG}"
pwd >> "${ARGV_LOG}"
cat > /dev/null
if [ -f "${CHOICE}" ]; then cp "${CHOICE}" "$MANDREL_LOOP_EVIDENCE_DIR/verdict.json"; fi
if [ -f "${STDOUT_LINE}" ]; then cat "${STDOUT_LINE}"; fi
`,
);
chmodSync(FAKE, 0o755);

/** The test-set variable: what the fake claude will write. */
let chosen: unknown;
let markerLine: string | null;

const config = parseConfig(
  JSON.stringify({
    mandrel: { url: 'http://localhost:8080', project: 'p' },
    models: { worker: 'worker-model', critic: 'critic-model' },
    repos: { 'repo:r': { path: REPO, gate: 'true' } },
    workdir: WORKDIR,
    critic: { maxAttempts: 2 },
  }),
  ROOT,
);

const deps = (): CriticDeps => ({ ...defaultCriticDeps({ PATH: process.env.PATH, HOME: ROOT, MANDREL_LOOP_CLAUDE_BIN: FAKE }), card: 'CARD' });
const verdictOf = (verdict: string, extra: Record<string, unknown> = {}) => ({
  verdict,
  note: `n-${verdict}`,
  clauses: [{ index: 0, verified: true }],
  ...extra,
});

async function setup(punch: Record<string, unknown> = {}): Promise<{ board: FakeBoard; id: string; claimId: string }> {
  const board = new FakeBoard();
  const t = await board.create({
    title: 'T',
    description: 'D',
    stage: 'verifying',
    tags: ['repo:r'],
    dependencies: [],
    punch: { doneWhen: [{ text: 'it works', owner: 'lane', proof: 'x' }], proofKind: 'test', branch: 'builder/x', sha: SHA, ...punch },
  });
  const claim = await board.claim(t.id);
  if (!claim.ok) throw new Error('claim');
  return { board, id: t.id, claimId: claim.claimId };
}

const stageOf = async (b: FakeBoard, id: string): Promise<Task> => (await b.get(id))!;

beforeEach(() => {
  for (const f of [CHOICE, STDOUT_LINE, ARGV_LOG]) if (existsSync(f)) execFileSync('rm', [f]);
  chosen = undefined;
  markerLine = null;
});

function arm(): void {
  if (chosen !== undefined) writeFileSync(CHOICE, JSON.stringify(chosen));
  if (markerLine !== null) writeFileSync(STDOUT_LINE, markerLine);
}

describe('critic transitions', () => {
  const cases: [string, string][] = [
    ['PASS', 'evidence'],
    ['FAIL', 'ready'],
    ['COULD-NOT-MEASURE', 'verifying'],
    ['CONTRACT-DEFECT', 'draft'],
  ];
  it.each(cases)('%s leaves the punch at %s', async (verdict, stage) => {
    chosen = verdictOf(verdict);
    arm();
    const { board, id, claimId } = await setup();
    const out = await runCritic(board, config, id, claimId, deps());
    expect(out.verdict).toBe(verdict);
    const t = await stageOf(board, id);
    expect(t.stage).toBe(stage);
    const failures = t.metadata.punch?.walkthroughFailures;
    expect(failures).toBe(verdict === 'FAIL' ? 1 : undefined);
    const wt = t.metadata.punch?.walkthrough as Record<string, unknown> | undefined;
    if (verdict === 'PASS') expect(wt).toMatchObject({ verdict: 'PASS', round: 1, branch: 'builder/x', sha: SHA });
    else expect(wt).toBeUndefined();
    expect((t.metadata.noteLog as string[]).join('\n')).toContain(verdict);
  });

  it('passes a configured critic.permissionMode to claude', async () => {
    chosen = verdictOf('PASS');
    arm();
    const { board, id, claimId } = await setup();
    const custom = parseConfig(
      JSON.stringify({
        mandrel: { url: 'http://localhost:8080', project: 'p' },
        models: { worker: 'worker-model', critic: 'critic-model' },
        repos: { 'repo:r': { path: REPO, gate: 'true' } },
        workdir: WORKDIR,
        critic: { permissionMode: 'acceptEdits' },
      }),
      ROOT,
    );
    await runCritic(board, custom, id, claimId, deps());
    const [args] = readFileSync(ARGV_LOG, 'utf8').trim().split('\n');
    expect(args).toBe('-p --output-format json --permission-mode acceptEdits --model critic-model');
  });

  it('runs claude with --permission-mode <critic.permissionMode> --model <models.critic> inside a worktree at the recorded sha, then removes it', async () => {
    chosen = verdictOf('PASS');
    arm();
    const { board, id, claimId } = await setup();
    await runCritic(board, config, id, claimId, deps());
    const [args, cwd] = readFileSync(ARGV_LOG, 'utf8').trim().split('\n');
    expect(args).toBe('-p --output-format json --permission-mode bypassPermissions --model critic-model');
    expect(cwd).toContain(join(WORKDIR, 'critic'));
    expect(existsSync(cwd!)).toBe(false);
    expect(git('worktree', 'list').split('\n')).toHaveLength(1);
  });

  it('FAIL at critic.maxAttempts tags the task loop:exhausted', async () => {
    chosen = verdictOf('FAIL');
    arm();
    const { board, id, claimId } = await setup({ walkthroughFailures: 1 });
    const out = await runCritic(board, config, id, claimId, deps());
    expect(out.exhausted).toBe(true);
    const t = await stageOf(board, id);
    expect(t.tags).toContain('loop:exhausted');
    expect(t.metadata.punch?.walkthroughFailures).toBe(2);
    expect(t.stage).toBe('ready');
  });

  it('a PASS after a prior failure records round 2', async () => {
    chosen = verdictOf('PASS');
    arm();
    const { board, id, claimId } = await setup({ walkthroughFailures: 1 });
    await runCritic(board, config, id, claimId, deps());
    expect((await stageOf(board, id)).metadata.punch?.walkthrough).toMatchObject({ round: 2 });
  });

  it('a PASS that breaks a mechanical rule is a FAIL on the board', async () => {
    chosen = verdictOf('PASS', { clauses: [{ index: 0, verified: false }] });
    arm();
    const { board, id, claimId } = await setup();
    await runCritic(board, config, id, claimId, deps());
    const t = await stageOf(board, id);
    expect(t.stage).toBe('ready');
    expect(t.metadata.punch?.walkthroughFailures).toBe(1);
  });

  it('no verdict at all is COULD-NOT-MEASURE and counts nothing', async () => {
    arm();
    const { board, id, claimId } = await setup();
    const out = await runCritic(board, config, id, claimId, deps());
    expect(out.verdict).toBe('COULD-NOT-MEASURE');
    const t = await stageOf(board, id);
    expect(t.stage).toBe('verifying');
    expect(t.metadata.punch?.walkthroughFailures).toBeUndefined();
  });

  it('an unknown sha is COULD-NOT-MEASURE', async () => {
    chosen = verdictOf('PASS');
    arm();
    const { board, id, claimId } = await setup({ sha: '0'.repeat(40) });
    const out = await runCritic(board, config, id, claimId, deps());
    expect(out.verdict).toBe('COULD-NOT-MEASURE');
    expect((await stageOf(board, id)).stage).toBe('verifying');
  });
});

describe('verdict source of record', () => {
  it('falls back to the last marker line when there is no verdict.json', async () => {
    markerLine = `noise\nMANDREL-LOOP-VERDICT: ${JSON.stringify(verdictOf('CONTRACT-DEFECT'))}\n`;
    arm();
    const { board, id, claimId } = await setup();
    await runCritic(board, config, id, claimId, deps());
    expect((await stageOf(board, id)).stage).toBe('draft');
  });

  it('verdict.json wins when the marker line disagrees', async () => {
    chosen = verdictOf('PASS');
    markerLine = `MANDREL-LOOP-VERDICT: ${JSON.stringify(verdictOf('FAIL'))}\n`;
    arm();
    const { board, id, claimId } = await setup();
    const out = await runCritic(board, config, id, claimId, deps());
    expect(out.verdict).toBe('PASS');
    expect((await stageOf(board, id)).stage).toBe('evidence');
  });

  it('readVerdict rejects an unknown verdict value', () => {
    const dir = mkdtempSync(join(ROOT, 'ev-'));
    writeFileSync(join(dir, 'verdict.json'), JSON.stringify({ verdict: 'MAYBE' }));
    expect(() => readVerdict(dir, '')).toThrow(/verdict must be one of/);
  });
});
