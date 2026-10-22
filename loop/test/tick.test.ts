import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import type { Claim, Task } from '../src/board.js';
import { FakeBoard } from '../src/board/fake.js';
import { TICK_CONFIG } from '../src/config.js';
import { makeNotifier, notifyingBoard, type Transition } from '../src/notify.js';
import { parseConfig } from '../src/settings.js';
import { tick, type TickDeps } from '../src/tick.js';
import type { WorkerResult } from '../src/worker.js';
import { evidenceTask, makeRepo, script } from './merger-helpers.js';

const task = (n: number, over: Partial<Task> = {}, punch: Record<string, unknown> = {}): Task => ({
  id: `0000000${n}-0000-4000-8000-000000000000`,
  title: `punch ${n}`,
  stage: 'ready',
  status: 'todo',
  priority: 'medium',
  tags: ['repo:r'],
  createdAt: `2026-01-0${n}T00:00:00Z`,
  claimLive: false,
  metadata: {
    punch: { doneWhen: [{ text: 'works', owner: 'lane', proof: 't.test.ts' }], proofKind: 'test', ...punch },
  },
  ...over,
});

const config = (extra: Record<string, unknown> = {}) =>
  parseConfig(
    JSON.stringify({
      mandrel: { url: 'http://localhost:8080', project: 'p' },
      models: { worker: 'a', critic: 'b' },
      workdir: '/nonexistent-workdir',
      repos: { r: { path: '/nonexistent-repo', gate: 'true' } },
      ...extra,
    }),
    '/nonexistent',
  );

/** A worker that "builds" instantly: moves the punch to verifying, as the real one does. */
const building = (seen: string[] = []): TickDeps['worker'] =>
  async (id, { board, claim }): Promise<WorkerResult> => {
    seen.push(id);
    await board.update(id, { stage: 'verifying' }, (claim as Claim).claimId);
    await board.release(id, (claim as Claim).claimId);
    return { outcome: 'built', note: 'built' };
  };

const stagesOf = async (board: FakeBoard, id: string) => (await board.get(id))!.stage;

describe('tick: lanes', () => {
  it('dispatches at most `lanes` workers per sweep', async () => {
    const board = new FakeBoard({ tasks: [task(1), task(2)] });
    const seen: string[] = [];
    const r = await tick({ board, config: config({ lanes: 1 }), env: {}, err: () => undefined, worker: building(seen) });
    expect(r.dispatched).toBe(1);
    expect(seen).toHaveLength(1);
    expect((await board.listStage('ready')).length).toBe(1);
  });

  it('dispatches both punches when two lanes are free', async () => {
    const board = new FakeBoard({ tasks: [task(1), task(2)] });
    const seen: string[] = [];
    await tick({ board, config: config({ lanes: 2 }), env: {}, err: () => undefined, worker: building(seen) });
    expect(seen).toHaveLength(2);
  });

  it('counts a live claimed punch as a busy lane', async () => {
    const board = new FakeBoard({ tasks: [task(1, { stage: 'claimed' }), task(2)] });
    await board.claim(task(1).id);
    const seen: string[] = [];
    await tick({ board, config: config({ lanes: 1 }), env: {}, err: () => undefined, worker: building(seen) });
    expect(seen).toHaveLength(0);
  });
});

describe('tick: sweeps', () => {
  it('puts a claimed punch with a lapsed lease back to ready, then dispatches it', async () => {
    let now = 1_000;
    const board = new FakeBoard({ tasks: [task(1, { stage: 'claimed' })], now: () => now, leaseMs: 100 });
    await board.claim(task(1).id);
    now += 1_000;
    const seen: string[] = [];
    await tick({ board, config: config(), env: {}, err: () => undefined, worker: building(seen) });
    expect(seen).toEqual([task(1).id]);
  });

  it('promotes a draft whose dependencies are all closed, and only then', async () => {
    const dep = task(1, { stage: 'merged', status: 'completed' });
    const open = task(2, { status: 'in_progress' });
    const ready = task(3, { stage: 'draft' }, { dependsOn: [dep.id] });
    const blocked = task(4, { stage: 'draft' }, { dependsOn: [dep.id, open.id] });
    const board = new FakeBoard({ tasks: [dep, open, ready, blocked] });
    await tick({ board, config: config({ lanes: 1 }), env: {}, err: () => undefined, worker: async () => ({ outcome: 'failed', note: 'x' }) });
    expect(await stagesOf(board, ready.id)).not.toBe('draft');
    expect(await stagesOf(board, blocked.id)).toBe('draft');
  });

  it('halts after three consecutive not-started workers and puts each punch back to ready', async () => {
    const board = new FakeBoard({ tasks: [task(1), task(2), task(3)] });
    const worker: TickDeps['worker'] = async (id, { board: b, claim }) => {
      await b.release(id, (claim as Claim).claimId);
      return { outcome: 'not-started', note: 'no repo' };
    };
    const r = await tick({ board, config: config({ lanes: 3 }), env: {}, err: () => undefined, worker });
    expect(r.consecutiveNotStarted).toBe(TICK_CONFIG.maxConsecutiveNotStarted);
    expect(r.halted).toBe(true);
    expect((await board.listStage('ready')).length).toBe(3);
  });

  it('carries the streak across ticks and resets it on a started worker', async () => {
    const board = new FakeBoard({ tasks: [task(1)] });
    const r = await tick({ board, config: config(), env: {}, err: () => undefined, worker: building() }, 2);
    expect(r.consecutiveNotStarted).toBe(0);
    expect(r.halted).toBe(false);
  });
});

describe('notify', () => {
  const cfg = config({ notify: { webhookUrlEnv: 'HOOK_URL' } });

  async function server(status: number) {
    const bodies: string[] = [];
    const srv = createServer((req: IncomingMessage, res) => {
      let b = '';
      req.on('data', (c: Buffer) => (b += c.toString()));
      req.on('end', () => {
        bodies.push(b);
        res.statusCode = status;
        res.end();
      });
    });
    await new Promise<void>((ok) => srv.listen(0, '127.0.0.1', ok));
    return { url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}/hook`, bodies, close: () => srv.close() };
  }

  it('prints one JSON line per transition and POSTs the same object', async () => {
    const hook = await server(200);
    const lines: string[] = [];
    const board = new FakeBoard({ tasks: [task(1)] });
    const nb = notifyingBoard(board, makeNotifier(cfg, { out: (l) => lines.push(l), err: () => undefined, env: { HOOK_URL: hook.url } }));
    await tick({ board: nb, config: cfg, env: {}, err: () => undefined, worker: building() });
    hook.close();
    const got = lines.map((l) => JSON.parse(l) as Transition);
    expect(got.map((t) => `${t.from}>${t.to}`)).toEqual(['ready>claimed', 'claimed>verifying']);
    expect(hook.bodies.map((b) => JSON.parse(b))).toEqual(got);
  });

  it('logs a webhook failure and leaves the punch where the transition put it', async () => {
    const hook = await server(500);
    const errs: string[] = [];
    const board = new FakeBoard({ tasks: [task(1)] });
    const nb = notifyingBoard(board, makeNotifier(cfg, { out: () => undefined, err: (l) => errs.push(l), env: { HOOK_URL: hook.url } }));
    const r = await tick({ board: nb, config: cfg, env: {}, err: () => undefined, worker: building() });
    hook.close();
    expect(r.outcomes.map((o) => o.outcome)).toEqual(['built']);
    expect(await stagesOf(board, task(1).id)).toBe('verifying');
    expect(errs.some((e) => e.includes('webhook answered 500'))).toBe(true);
  });

  it('survives a webhook that cannot be reached at all', async () => {
    const errs: string[] = [];
    const board = new FakeBoard({ tasks: [task(1)] });
    const failing = (() => Promise.reject(new Error('connect refused'))) as unknown as typeof fetch;
    const nb = notifyingBoard(
      board,
      makeNotifier(cfg, { out: () => undefined, err: (l) => errs.push(l), env: { HOOK_URL: 'http://127.0.0.1:9/' }, fetch: failing }),
    );
    const r = await tick({ board: nb, config: cfg, env: {}, err: () => undefined, worker: building() });
    expect(r.outcomes.map((o) => o.outcome)).toEqual(['built']);
    expect(await stagesOf(board, task(1).id)).toBe('verifying');
    expect(errs.join('\n')).toContain('connect refused');
  });
});

describe('tick: merge results', () => {
  it('prints the punch id8 and the PR url on the tick that opens a pull request', async () => {
    const repo = makeRepo();
    const evidence = evidenceTask(repo.branchSha, { tags: ['repo:r'] });
    const board = new FakeBoard({ tasks: [evidence] });
    const gh = script(mkdtempSync(join(tmpdir(), 'tick-gh-')), 'gh', 'if [ "$1 $2" = "pr create" ]; then echo "https://github.com/o/r/pull/42"; fi');
    const errs: string[] = [];
    const cfg = config({ repos: { r: { path: repo.work, remote: 'origin', main: 'main', gate: 'true' } }, merge: { mode: 'pr' } });
    await tick({ board, config: cfg, env: { ...process.env, MANDREL_LOOP_GH_BIN: gh }, err: (l) => errs.push(l), worker: building() });
    expect(errs).toContain(`tick: ${evidence.id.slice(0, 8)} pr-opened: https://github.com/o/r/pull/42`);
  });
});
