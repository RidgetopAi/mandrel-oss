import { describe, expect, it } from 'vitest';
import type { Task } from '../src/board.js';
import { orderPickable, pickNext } from '../src/pick.js';

let n = 0;
function task(over: Partial<Task> & { punch?: Record<string, unknown> | null } = {}): Task {
  const { punch, ...rest } = over;
  n += 1;
  return {
    id: `t${n}`,
    title: `task ${n}`,
    stage: 'ready',
    status: 'todo',
    priority: 'medium',
    tags: [],
    createdAt: `2026-01-0${(n % 9) + 1}T00:00:00Z`,
    claimLive: false,
    metadata:
      punch === null
        ? {}
        : {
            punch: {
              doneWhen: [{ text: 'x', owner: 'lane', proof: 'a/b.test.ts' }],
              proofKind: 'test',
              ...punch,
            },
          },
    ...rest,
  };
}
const none = () => false;
const all = () => true;
const picks = (t: Task, closed: (id: string) => boolean = all) => pickNext([t], closed) !== null;

describe('pick eligibility', () => {
  it('accepts a complete ready task', () => expect(picks(task())).toBe(true));
  it('rejects other stages', () => expect(picks(task({ stage: 'draft' }))).toBe(false));
  it('rejects a missing punch', () => expect(picks(task({ punch: null }))).toBe(false));
  it('rejects empty doneWhen', () => expect(picks(task({ punch: { doneWhen: [] } }))).toBe(false));
  it('rejects string doneWhen', () => expect(picks(task({ punch: { doneWhen: 'prose' } }))).toBe(false));
  it('rejects a lane clause without proof', () =>
    expect(picks(task({ punch: { doneWhen: [{ text: 'x', owner: 'lane' }] } }))).toBe(false));
  it('accepts a human clause without proof', () =>
    expect(picks(task({ punch: { doneWhen: [{ text: 'x', owner: 'human' }] } }))).toBe(true));
  it('rejects an unknown owner', () =>
    expect(picks(task({ punch: { doneWhen: [{ text: 'x', owner: 'bot', proof: 'p' }] } }))).toBe(false));
  it('rejects a missing proofKind', () => expect(picks(task({ punch: { proofKind: null } }))).toBe(false));
  it('rejects the risk:gate tag', () => expect(picks(task({ tags: ['risk:gate'] }))).toBe(false));
  it('rejects the loop:exhausted tag', () => expect(picks(task({ tags: ['loop:exhausted'] }))).toBe(false));
  it('rejects a live claim', () => expect(picks(task({ claimLive: true }))).toBe(false));
  it('rejects an open dependency', () =>
    expect(picks(task({ punch: { dependsOn: ['d1'] } }), none)).toBe(false));
  it('accepts when every dependency is closed', () =>
    expect(picks(task({ punch: { dependsOn: ['d1', 'd2'] } }), all)).toBe(true));
  it('rejects when only some dependencies are closed', () =>
    expect(picks(task({ punch: { dependsOn: ['d1', 'd2'] } }), (id) => id === 'd1')).toBe(false));
});

describe('pick ordering', () => {
  it('orders priority first, then oldest', () => {
    const lowOld = task({ priority: 'low', createdAt: '2025-01-01T00:00:00Z' });
    const highNew = task({ priority: 'high', createdAt: '2026-05-01T00:00:00Z' });
    const highOld = task({ priority: 'high', createdAt: '2026-01-01T00:00:00Z' });
    const urgent = task({ priority: 'urgent', createdAt: '2026-09-01T00:00:00Z' });
    expect(orderPickable([lowOld, highNew, highOld, urgent], all).map((t) => t.id)).toEqual([
      urgent.id,
      highOld.id,
      highNew.id,
      lowOld.id,
    ]);
  });
  it('returns null when nothing is pickable', () => expect(pickNext([task({ tags: ['risk:gate'] })], all)).toBeNull());
  it('skips an excluded higher-priority task', () => {
    const gated = task({ priority: 'urgent', tags: ['risk:gate'] });
    const ok = task({ priority: 'low' });
    expect(pickNext([gated, ok], all)?.id).toBe(ok.id);
  });
});
