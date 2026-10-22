import { describe, expect, it } from 'vitest';
import { loopPunch, type Task } from '../src/board.js';
import { FakeBoard } from '../src/board/fake.js';

const seed = (): Task => ({
  id: 't1',
  title: 'one',
  stage: 'ready',
  status: 'todo',
  priority: 'medium',
  tags: [],
  createdAt: '2026-01-01T00:00:00Z',
  claimLive: false,
  metadata: { punch: { doneWhen: [{ text: 'a', owner: 'human' }], proofKind: 'look', touches: ['x'] } },
});

async function claimed(now = () => 0) {
  const board = new FakeBoard({ tasks: [seed()], leaseMs: 1000, now });
  const c = await board.claim('t1');
  if (!c.ok) throw new Error('claim failed');
  return { board, claimId: c.claimId };
}

describe('FakeBoard', () => {
  it('refuses a second claim on a live claim with reason held', async () => {
    const { board } = await claimed();
    expect(await board.claim('t1')).toMatchObject({ ok: false, reason: 'held' });
  });

  it('allows a re-claim once the lease expires', async () => {
    let t = 0;
    const { board } = await claimed(() => t);
    t = 1000;
    expect((await board.claim('t1', ['todo', 'in_progress'])).ok).toBe(true);
  });

  it('refuses an update without the live claimId', async () => {
    const { board } = await claimed();
    expect((await board.update('t1', { stage: 'claimed' }, 'wrong')).ok).toBe(false);
    expect(await board.update('t1', { stage: 'claimed' }, '')).toMatchObject({ ok: false });
    expect((await board.get('t1'))?.stage).toBe('ready');
  });

  it('refuses an update on an unclaimed task', async () => {
    const board = new FakeBoard({ tasks: [seed()] });
    expect(await board.update('t1', { stage: 'claimed' }, 'x')).toMatchObject({ ok: false, reason: 'held' });
  });

  it('refuses stage blocked (not in the golden stage list)', async () => {
    const { board, claimId } = await claimed();
    const r = await board.update('t1', { stage: 'blocked' as never }, claimId);
    expect(r).toMatchObject({ ok: false, reason: 'invalid-stage' });
    expect((await board.get('t1'))?.stage).toBe('ready');
  });

  it('shallow-merges punch and lets null clear a key', async () => {
    const { board, claimId } = await claimed();
    const r = await board.update('t1', { stage: 'claimed', punch: { proofKind: 'test', touches: null } }, claimId);
    expect(r.ok).toBe(true);
    const punch = (await board.get('t1'))?.metadata.punch;
    expect(punch?.proofKind).toBe('test');
    expect(punch?.doneWhen).toEqual([{ text: 'a', owner: 'human' }]);
    expect(punch && 'touches' in punch).toBe(false);
  });

  it('refuses a claim on an in_progress task unless allowedStatuses includes in_progress', async () => {
    const { board, claimId } = await claimed();
    await board.release('t1', claimId);
    expect((await board.get('t1'))?.status).toBe('in_progress');
    expect(await board.claim('t1')).toMatchObject({ ok: false, reason: 'wrong-status' });
    expect(await board.claim('t1', ['todo'])).toMatchObject({ ok: false, reason: 'wrong-status' });
    expect((await board.claim('t1', ['todo', 'in_progress'])).ok).toBe(true);
  });

  it('never claims past the ceiling: a completed task stays wrong-status even when named', async () => {
    const done = { ...seed(), status: 'completed' };
    const board = new FakeBoard({ tasks: [done] });
    expect(await board.claim('t1', ['completed', 'todo'])).toMatchObject({ ok: false, reason: 'wrong-status' });
  });

  it('a top-level punch keeps contract keys and drops the rest', async () => {
    const { board, claimId } = await claimed();
    const r = await board.update(
      't1',
      { punch: { doneWhen: [{ text: 'b', owner: 'human' }], branch: 'loop/x', sha: 'abc' } },
      claimId,
    );
    expect(r.ok).toBe(true);
    const punch = (await board.get('t1'))?.metadata.punch;
    expect(punch?.doneWhen).toEqual([{ text: 'b', owner: 'human' }]);
    expect(punch).not.toHaveProperty('branch');
    expect(punch).not.toHaveProperty('sha');
  });

  it('metadata.punch stores loop-owned keys and null clears one', async () => {
    const { board, claimId } = await claimed();
    await board.update('t1', loopPunch({ branch: 'loop/x', conflict: { a: 1 } }), claimId);
    await board.update('t1', loopPunch({ conflict: null }), claimId);
    const punch = (await board.get('t1'))?.metadata.punch;
    expect(punch?.branch).toBe('loop/x');
    expect(punch).not.toHaveProperty('conflict');
    expect(punch?.proofKind).toBe('look');
  });

  it('refuses a direct dependsOn, as the server does', async () => {
    const { board, claimId } = await claimed();
    expect(await board.update('t1', loopPunch({ dependsOn: ['x'] }), claimId)).toMatchObject({ ok: false });
  });

  it('a stage change derives the status the way the server does', async () => {
    const { board, claimId } = await claimed();
    await board.update('t1', { stage: 'merged' }, claimId);
    expect((await board.get('t1'))?.status).toBe('completed');
  });

  it('list rows carry no metadata and reflect claim liveness', async () => {
    const { board } = await claimed();
    const [row] = await board.listStage('ready');
    expect(row).not.toHaveProperty('metadata');
    expect(row.claimLive).toBe(true);
    expect(await board.listStage('draft')).toEqual([]);
  });

  it('renew/release require the live claimId', async () => {
    const { board, claimId } = await claimed();
    expect(await board.renew('t1', 'nope')).toMatchObject({ ok: false, reason: 'claim-lost' });
    expect((await board.renew('t1', claimId)).ok).toBe(true);
    expect(await board.release('t1', 'nope')).toMatchObject({ ok: false });
    expect((await board.release('t1', claimId)).ok).toBe(true);
    expect((await board.claim('t1', ['todo', 'in_progress'])).ok).toBe(true);
  });
});
