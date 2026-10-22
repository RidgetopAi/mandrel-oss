import { describe, expect, it } from 'vitest';
import { loopPunch } from '../src/board.js';
import { claimStatusesFor } from '../src/config.js';
import { AuthError, EndpointError, MandrelBoard, mcpEndpoint, ToolError, TransportError } from '../src/board/mandrel.js';
import { FAKE_TOKEN, FAKE_URL, FakeMandrel, type FakeMandrelOptions, type SeenCall, type ToolReply } from './support/fake-mandrel-mcp.js';

const taskRecord = {
  id: 't1', title: 'T', stage: 'ready', status: 'todo', priority: 'high', tags: ['a'],
  createdAt: '2026-01-01T00:00:00Z', claimLive: false, metadata: { punch: { proofKind: 'test' } },
};

const ok = (structuredContent: Record<string, unknown>): ToolReply => ({ structuredContent });

/** A reply per gateway call, keyed `tool.action`. */
const replies = (byCall: Record<string, (c: SeenCall) => ToolReply>) => (c: SeenCall): ToolReply =>
  byCall[`${c.tool}.${String(c.args.action)}`]?.(c) ?? ok({});

function setup(opts: FakeMandrelOptions = {}, boardOpts: { token?: string; timeoutMs?: number } = {}) {
  const fake = new FakeMandrel(opts);
  const board = new MandrelBoard({
    url: FAKE_URL,
    authToken: boardOpts.token ?? FAKE_TOKEN,
    connectionId: 'conn-1',
    actorId: 'loop-actor',
    project: 'proj-1',
    fetch: fake.fetch,
    timeoutMs: boardOpts.timeoutMs,
  });
  return { fake, board };
}

const healthy = replies({
  'project.list': () => ok({ results: [{ id: 'p', name: 'P' }] }),
  'task.list': () => ok({ results: [taskRecord], hasMore: false }),
  'task.details': () => ok({ found: true, task: taskRecord }),
  'task.claim': () => ok({ claimed: true, claimId: 'c1', expiresAt: 'later' }),
  'task.renew': () => ok({ claimed: true, claimId: 'c1', expiresAt: 'later' }),
  'task.release': () => ok({ released: true }),
  'task.create': () => ok({ task: taskRecord }),
});

describe('MandrelBoard over MCP (streamable HTTP, gateway tools)', () => {
  it('maps every Board operation to its gateway call', async () => {
    const { fake, board } = setup({ handle: healthy });
    await board.listProjects();
    await board.listStage('ready');
    await board.get('t1');
    await board.claim('t1');
    await board.renew('t1', 'c1');
    await board.update('t1', { stage: 'claimed', notes: 'n' }, 'c1');
    await board.release('t1', 'c1');
    await board.create({ title: 'New', description: 'd', stage: 'draft', tags: ['repo:x'], dependencies: ['t0'], punch: { proofKind: 'test' } });
    await board.close();

    expect(fake.calls.map((c) => c.args)).toEqual([
      { action: 'list', limit: 100 },
      { action: 'list', stage: 'ready', limit: 100, offset: 0 },
      { action: 'details', taskId: 't1' },
      { action: 'claim', taskId: 't1' },
      { action: 'renew', taskId: 't1', claimId: 'c1' },
      { action: 'update', taskId: 't1', claimId: 'c1', stage: 'claimed', notes: 'n' },
      { action: 'details', taskId: 't1' },
      { action: 'release', taskId: 't1', claimId: 'c1' },
      { action: 'create', title: 'New', description: 'd', stage: 'draft', tags: ['repo:x'], dependencies: ['t0'], punch: { proofKind: 'test' } },
    ]);
    expect(fake.calls.map((c) => c.tool)).toEqual(['project', 'task', 'task', 'task', 'task', 'task', 'task', 'task', 'task']);
  });

  it('every request, initialize included, carries the token, identity and (except project list) the project', async () => {
    const { fake, board } = setup({ handle: healthy });
    await board.listProjects();
    await board.listStage('ready');
    await board.close();
    const posts = fake.requests.filter((r) => r.method === 'POST');
    expect(posts.map((r) => r.rpc)).toContain('initialize');
    for (const r of fake.requests) {
      expect(r.headers.get('authorization')).toBe(`Bearer ${FAKE_TOKEN}`);
      expect(r.headers.get('x-connection-id')).toBe('conn-1');
      expect(r.headers.get('x-actor-id')).toBe('loop-actor');
    }
    // project list is the one call made before the project exists, so it carries no project header.
    const [list, stage] = fake.calls;
    expect(list!.headers.get('x-mandrel-project')).toBeNull();
    expect(stage!.headers.get('x-mandrel-project')).toBe('proj-1');
  });

  it('initializes once and reuses the session for later calls', async () => {
    const { fake, board } = setup({ handle: healthy });
    for (let i = 0; i < 3; i++) await board.get('t1');
    expect(fake.initializes).toBe(1);
    expect(new Set(fake.calls.map((c) => c.sessionId)).size).toBe(1);
    await board.close();
  });

  it('close ends the session on the server', async () => {
    const { fake, board } = setup({ handle: healthy });
    await board.get('t1');
    expect(fake.sessions.size).toBe(1);
    await board.close();
    expect(fake.sessions.size).toBe(0);
    expect(fake.requests.at(-1)?.method).toBe('DELETE');
  });

  it('re-initializes when the server no longer holds the session, and the call goes through once', async () => {
    const { fake, board } = setup({ handle: healthy });
    await board.get('t1');
    fake.forgetSessions();
    await board.create({ title: 'once', description: '', stage: 'draft', tags: [], dependencies: [], punch: {} });
    expect(fake.initializes).toBe(2);
    expect(fake.requests.some((r) => r.status === 404)).toBe(true);
    expect(fake.calls.filter((c) => c.args.action === 'create')).toHaveLength(1);
    await board.close();
  });

  it('gives up with a TransportError when a fresh session expires again (no retry loop)', async () => {
    const fake = new FakeMandrel({ handle: healthy });
    // Every tools/call finds its session gone, as if the server restarted between each call.
    const forgetful = (async (input: string | URL | Request, init?: RequestInit) => {
      if (typeof init?.body === 'string' && init.body.includes('"tools/call"')) fake.forgetSessions();
      return fake.fetch(input, init);
    }) as typeof fetch;
    const board = new MandrelBoard({ url: FAKE_URL, authToken: FAKE_TOKEN, connectionId: 'c', actorId: 'a', project: 'p', fetch: forgetful });
    const err = await board.get('t1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TransportError);
    expect((err as Error).message).toContain('HTTP 404');
    expect(fake.initializes).toBe(2);
    await board.close();
  });

  it('a call the server never answers fails within the timeout, and the next call gets a fresh session', async () => {
    let hang = true;
    const { fake, board } = setup(
      { handle: (c) => (hang && c.args.action === 'details' ? new Promise<ToolReply>(() => undefined) : healthy(c)) },
      // Long enough that a healthy call on a loaded machine never trips it; only the hung call does.
      { timeoutMs: 1500 },
    );
    const started = Date.now();
    const err = await board.get('t1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TransportError);
    expect((err as Error).message).toMatch(/no answer from .* within 1500 ms/);
    expect(Date.now() - started).toBeLessThan(5_000);
    hang = false;
    expect((await board.get('t1'))?.id).toBe('t1');
    expect(fake.initializes).toBe(2);
    await board.close();
  });

  it('a refused token is an AuthError, not a tool error', async () => {
    const { board } = setup({}, { token: 'wrong' });
    const err = await board.listStage('ready').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AuthError);
    expect((err as Error).message).toContain('HTTP 401');
    expect((err as Error).message).not.toContain('wrong');
    await board.close();
  });

  it('a URL with no MCP endpoint (a proxy answering 405) is an EndpointError', async () => {
    const { board } = setup({ intercept: () => new Response('<html>405 Not Allowed</html>', { status: 405 }) });
    const err = await board.listStage('ready').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EndpointError);
    expect((err as Error).message).toContain(`HTTP 405: no MCP endpoint at ${FAKE_URL}/mcp`);
    await board.close();
  });

  it.each([
    ['create', (b: MandrelBoard) => b.create({ title: 'once', description: '', stage: 'draft', tags: [], dependencies: [], punch: {} })],
    ['claim', (b: MandrelBoard) => b.claim('t1')],
  ] as const)('a %s answered HTTP 500 after the server ran it is dispatched exactly once', async (action, op) => {
    // The server runs the call, then the answer is lost to a 500: a retry here would run it twice.
    const fake = new FakeMandrel({ handle: healthy });
    const lossy = (async (input: string | URL | Request, init?: RequestInit) => {
      const res = await fake.fetch(input, init);
      return typeof init?.body === 'string' && init.body.includes(`"action":"${action}"`) ? new Response('upstream error', { status: 500 }) : res;
    }) as typeof fetch;
    const board = new MandrelBoard({ url: FAKE_URL, authToken: FAKE_TOKEN, connectionId: 'c', actorId: 'a', project: 'p', fetch: lossy });
    await expect(op(board)).rejects.toBeInstanceOf(TransportError);
    expect(fake.calls.filter((c) => c.args.action === action)).toHaveLength(1);
    await board.close();
  });

  it('parses rows and details', async () => {
    const { board } = setup({ handle: healthy });
    const [row] = await board.listStage('ready');
    expect(row).not.toHaveProperty('metadata');
    expect((await board.get('t1'))?.metadata.punch?.proofKind).toBe('test');
    await board.close();
  });

  it('pages task list while hasMore', async () => {
    const { board } = setup({
      handle: (c) => ok({ results: [{ ...taskRecord, id: `t${String(c.args.offset)}` }], hasMore: c.args.offset === 0 }),
    });
    expect((await board.listStage('ready')).map((r) => r.id)).toEqual(['t0', 't1']);
    await board.close();
  });

  it('returns a typed refusal for a claim conflict', async () => {
    const { board } = setup({ handle: () => ok({ claimed: false, reason: 'held' }) });
    expect(await board.claim('t1')).toMatchObject({ ok: false, reason: 'held' });
    await board.close();
  });

  it('returns a fencing refusal from update as a refusal', async () => {
    const { board } = setup({ handle: () => ({ isError: true, text: 'claim mismatch', structuredContent: { reason: 'claim-lost' } }) });
    expect(await board.update('t1', { notes: 'n' }, 'c1')).toMatchObject({ ok: false, reason: 'claim-lost' });
    await board.close();
  });

  it('rejects an isError result with ToolError', async () => {
    const { board } = setup({ handle: () => ({ isError: true, text: 'bad params' }) });
    const err = await board.get('t1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ToolError);
    expect(err).not.toBeInstanceOf(TransportError);
    expect((err as Error).message).toContain('bad params');
    await board.close();
  });

  it.each(['claimed', 'verifying', 'evidence'] as const)(
    'a claim on a %s task sends allowedStatuses containing in_progress',
    async (stage) => {
      const { fake, board } = setup({ handle: healthy });
      await board.claim('t1', claimStatusesFor(stage));
      expect(fake.calls[0]!.args.allowedStatuses).toContain('in_progress');
      await board.close();
    },
  );

  it('a claim on a ready task sends no allowedStatuses (the server default is todo)', async () => {
    const { fake, board } = setup({ handle: healthy });
    await board.claim('t1', claimStatusesFor('ready'));
    expect(fake.calls[0]!.args).not.toHaveProperty('allowedStatuses');
    await board.close();
  });

  it('writes branch, sha and lane inside metadata.punch with every key the task already had', async () => {
    const stored = {
      doneWhen: [{ text: 'a', owner: 'human' }],
      proofKind: 'test',
      touches: ['x'],
      walkthrough: { verdict: 'PASS' },
      dependsOn: ['other'],
    };
    const { fake, board } = setup({
      handle: replies({ 'task.details': () => ok({ found: true, task: { ...taskRecord, metadata: { punch: stored } } }) }),
    });
    const lane = { branch: 'loop/x', sha: 'abc', round: 1 };
    const r = await board.update('t1', { stage: 'verifying', ...loopPunch({ branch: 'loop/x', sha: 'abc', lane }) }, 'c1');
    expect(r.ok).toBe(true);
    const upd = fake.calls.find((x) => x.args.action === 'update')!;
    expect(upd.args).not.toHaveProperty('punch');
    const sent = (upd.args.metadata as { punch: Record<string, unknown> }).punch;
    expect(sent).toMatchObject({ branch: 'loop/x', sha: 'abc', lane });
    for (const k of ['doneWhen', 'proofKind', 'touches', 'walkthrough']) expect(sent[k]).toEqual((stored as Record<string, unknown>)[k]);
    // the server refuses a caller-set dependsOn, so it is never re-sent
    expect(sent).not.toHaveProperty('dependsOn');
    await board.close();
  });

  it('sends a null only for a key the task carries', async () => {
    const { fake, board } = setup({
      handle: replies({ 'task.details': () => ok({ found: true, task: { ...taskRecord, metadata: { punch: { conflict: { a: 1 } } } } }) }),
    });
    await board.update('t1', loopPunch({ conflict: null, verdict: null }), 'c1');
    const sent = (fake.calls.find((x) => x.args.action === 'update')!.args.metadata as { punch: object }).punch;
    expect(sent).toEqual({ conflict: null });
    await board.close();
  });
});

describe('mcpEndpoint', () => {
  it.each([
    ['http://localhost:8080', 'http://localhost:8080/mcp'],
    ['http://localhost:8080/', 'http://localhost:8080/mcp'],
    ['https://you.mandrel.example/mcp', 'https://you.mandrel.example/mcp'],
    ['https://you.mandrel.example/mcp/', 'https://you.mandrel.example/mcp'],
    ['https://example.com/prefix', 'https://example.com/prefix/mcp'],
  ])('%s -> %s', (url, endpoint) => {
    expect(mcpEndpoint(url).href).toBe(endpoint);
  });
});
