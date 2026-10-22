import { describe, expect, it } from 'vitest';
import { runWorker } from '../src/worker.js';
import { committingClaude, git, makeHarness, noopClaude, TASK_ID } from './support/worker-harness.js';

const punchOf = async (h: ReturnType<typeof makeHarness>) => (await h.board.get(TASK_ID))!;

describe('worker runner', () => {
  it('builds: ends at verifying with lane branch and the real sha', async () => {
    const h = makeHarness(committingClaude());
    const res = await runWorker(TASK_ID, { board: h.board, config: h.config, env: h.env });
    expect(res?.outcome).toBe('built');
    const t = await punchOf(h);
    expect(t.stage).toBe('verifying');
    const lane = t.metadata.punch!.lane as { branch: string; sha: string; round: number };
    expect(lane.branch).toMatch(/^loop\/[0-9a-f]{8}-/);
    expect(lane.branch).toBe('loop/abcdef12-add-the-widget');
    expect(lane.sha).toBe(git(h.repo, 'rev-parse', lane.branch));
    expect(lane.round).toBe(1);
    expect((await h.board.get(TASK_ID))!.claimLive).toBe(false);
  });

  it('a fake that exits 0 without committing leaves the punch ready with dispatchFailures 1', async () => {
    const h = makeHarness(noopClaude);
    const res = await runWorker(TASK_ID, { board: h.board, config: h.config, env: h.env });
    expect(res?.outcome).toBe('failed');
    const t = await punchOf(h);
    expect(t.stage).toBe('ready');
    expect(t.metadata.punch!.dispatchFailures).toBe(1);
    expect(t.tags).not.toContain('loop:exhausted');
    expect(t.claimLive).toBe(false);
  });

  it('adds loop:exhausted at worker.maxAttempts', async () => {
    const h = makeHarness(noopClaude);
    for (let i = 0; i < h.config.worker.maxAttempts; i++) {
      await runWorker(TASK_ID, { board: h.board, config: h.config, env: h.env });
    }
    const t = await punchOf(h);
    expect(t.metadata.punch!.dispatchFailures).toBe(h.config.worker.maxAttempts);
    expect(t.tags).toContain('loop:exhausted');
  });

  it('a commit on an orphan branch (no merge-base with main) is a failure', async () => {
    const orphan = `#!/usr/bin/env node
const { execFileSync } = require('node:child_process');
const g = (...a) => execFileSync('git', ['-c', 'user.email=f@x', '-c', 'user.name=F', ...a], { stdio: 'pipe' });
const branch = g('rev-parse', '--abbrev-ref', 'HEAD').toString().trim();
g('checkout', '-q', '--orphan', 'tmp-orphan');
require('node:fs').writeFileSync('o.txt', 'x');
g('add', '-A');
g('commit', '-q', '-m', 'orphan');
g('branch', '-f', branch, 'HEAD');
`;
    const h = makeHarness(orphan);
    const res = await runWorker(TASK_ID, { board: h.board, config: h.config, env: h.env });
    expect(res?.outcome).toBe('failed');
    expect(res?.note).toMatch(/merge-base/);
    const t = await punchOf(h);
    expect(t.stage).toBe('ready');
    expect(t.metadata.punch!.dispatchFailures).toBe(1);
  });

  it('a retry reuses the recorded branch and fails when the head did not move', async () => {
    const h = makeHarness(committingClaude());
    await runWorker(TASK_ID, { board: h.board, config: h.config, env: h.env });
    const first = (await punchOf(h)).metadata.punch!.lane as { branch: string; sha: string };
    // critic bounced it back to ready; a worker that commits nothing must not pass.
    const claim = await h.board.claim(TASK_ID, ['todo', 'in_progress']);
    if (!claim.ok) throw new Error('claim');
    await h.board.update(TASK_ID, { stage: 'ready' }, claim.claimId);
    await h.board.release(TASK_ID, claim.claimId);
    const idle = makeHarness(noopClaude);
    const res = await runWorker(TASK_ID, { board: h.board, config: h.config, env: { ...h.env, MANDREL_LOOP_CLAUDE_BIN: `${idle.bin}/claude` } });
    expect(res?.outcome).toBe('failed');
    expect(res?.note).toMatch(/head did not move/);
    expect((await punchOf(h)).stage).toBe('ready');

    // and a worker that does commit moves it on the SAME branch with round 2
    const again = await runWorker(TASK_ID, { board: h.board, config: h.config, env: h.env });
    expect(again?.outcome).toBe('built');
    const lane = (await punchOf(h)).metadata.punch!.lane as { branch: string; sha: string; round: number };
    expect(lane.branch).toBe(first.branch);
    expect(lane.sha).not.toBe(first.sha);
    expect(lane.sha).toBe(git(h.repo, 'rev-parse', lane.branch));
    expect(lane.round).toBe(2);
  });

  it('no repo tag: not started, nothing counted, note names the tag', async () => {
    const h = makeHarness(committingClaude(), { tags: [] });
    const res = await runWorker(TASK_ID, { board: h.board, config: h.config, env: h.env });
    expect(res?.outcome).toBe('not-started');
    const t = await punchOf(h);
    expect(t.stage).toBe('ready');
    expect(t.metadata.punch!.dispatchFailures).toBeUndefined();
    expect(JSON.stringify(t.metadata.noteLog)).toContain('repo:');
    expect(t.claimLive).toBe(false);
  });

  it('missing binary: not started, nothing counted', async () => {
    const h = makeHarness(committingClaude());
    const res = await runWorker(TASK_ID, { board: h.board, config: h.config, env: { ...h.env, MANDREL_LOOP_CLAUDE_BIN: 'no-such-claude-bin' } });
    expect(res?.outcome).toBe('not-started');
    const t = await punchOf(h);
    expect(t.metadata.punch!.dispatchFailures).toBeUndefined();
    expect(t.claimLive).toBe(false);
  });
});
