/**
 * A server that echoes request headers into an error body must not get the token into anything the
 * loop prints, throws or writes to a task note. Population: every status class the client turns into
 * an error message (auth, endpoint, session, server error) plus a tool error's own text.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FakeBoard } from '../src/board/fake.js';
import type { Task } from '../src/board.js';
import { MandrelBoard } from '../src/board/mandrel.js';
import { run } from '../src/run.js';
import { boardBackedHandler, FAKE_URL, FakeMandrel } from './support/fake-mandrel-mcp.js';

const CANARY = ['canary', 'token', '7f3a91'].join('-');
const OTHER_BEARER = ['other', 'secret', '42'].join('-');
const dir = mkdtempSync(join(tmpdir(), 'loop-redact-'));

/** A body that echoes the request's Authorization header, as a misbehaving proxy or server might. */
const echo = (req: Request, status: number): Response =>
  new Response(`echo Authorization=${req.headers.get('authorization')}; raw=${CANARY}; also Bearer ${OTHER_BEARER}`, { status });

function config(): string {
  const file = join(mkdtempSync(join(dir, 'cfg-')), 'mandrel-loop.config.json');
  writeFileSync(
    file,
    JSON.stringify({
      mandrel: { url: FAKE_URL, project: 'p' },
      repos: { widgets: { path: dir, gate: 'true' } },
      models: { worker: 'a', critic: 'b' },
      merge: { mode: 'direct' },
    }),
  );
  return file;
}

async function cli(cmd: 'doctor' | 'once', fake: FakeMandrel): Promise<string> {
  const lines: string[] = [];
  await run([cmd, '--config', config()], {
    out: (l) => lines.push(l),
    err: (l) => lines.push(l),
    env: { HOME: dir, MANDREL_TOKEN: CANARY, ANTHROPIC_API_KEY: 'k', PATH: process.env.PATH },
    fetch: fake.fetch,
    auth: { uid: () => 1000, ghAuthOk: () => true },
    doctor: { pathExists: () => false },
  });
  return lines.join('\n');
}

const expectClean = (text: string): void => {
  expect(text).not.toContain(CANARY);
  expect(text).not.toContain(OTHER_BEARER);
};

describe('the token never leaves through a server error body', () => {
  it.each([401, 403, 404, 405, 500])('doctor output and the thrown error are clean when the server echoes it with HTTP %i', async (status) => {
    const fake = new FakeMandrel({ token: CANARY, intercept: (req) => echo(req, status) });
    const out = await cli('doctor', fake);
    expect(out).toContain('doctor: check mandrel-');
    expect(out).toContain('<redacted>');
    expectClean(out);
    const board = new MandrelBoard({ url: FAKE_URL, authToken: CANARY, connectionId: 'c', actorId: 'a', project: 'p', fetch: fake.fetch });
    const err = (await board.listStage('ready').catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(Error);
    expectClean(`${err.message} ${JSON.stringify(err)}`);
    await board.close();
  });

  it('a tool error whose text and structured content echo the token is clean', async () => {
    const fake = new FakeMandrel({
      token: CANARY,
      handle: () => ({ isError: true, text: `bad: Bearer ${CANARY}`, structuredContent: { reason: 'held', message: `held by ${CANARY}` } }),
    });
    const board = new MandrelBoard({ url: FAKE_URL, authToken: CANARY, connectionId: 'c', actorId: 'a', project: 'p', fetch: fake.fetch });
    const err = (await board.get('t1').catch((e: unknown) => e)) as Error & { structured?: unknown };
    expectClean(`${err.message} ${JSON.stringify(err.structured)}`);
    const refused = await board.claim('t1');
    expect(refused).toMatchObject({ ok: false, reason: 'held' });
    expectClean(JSON.stringify(refused));
    await board.close();
  });

  it('a claim refusal answered as a normal result, with the token in its message, is clean', async () => {
    const fake = new FakeMandrel({ token: CANARY, handle: () => ({ structuredContent: { claimed: false, reason: 'held', message: `held; Authorization=Bearer ${CANARY}` } }) });
    const board = new MandrelBoard({ url: FAKE_URL, authToken: CANARY, connectionId: 'c', actorId: 'a', project: 'p', fetch: fake.fetch });
    const refused = await board.claim('t1');
    expect(refused).toMatchObject({ ok: false, reason: 'held' });
    expectClean(JSON.stringify(refused));
    await board.close();
  });

  it('a refusal whose reason carries the token is clean (the reviewer n1)', async () => {
    const fake = new FakeMandrel({ token: CANARY, handle: () => ({ structuredContent: { claimed: false, reason: `held:${CANARY}` } }) });
    const board = new MandrelBoard({ url: FAKE_URL, authToken: CANARY, connectionId: 'c', actorId: 'a', project: 'p', fetch: fake.fetch });
    const refused = await board.claim('t1');
    expect(refused).toMatchObject({ ok: false });
    expectClean(JSON.stringify(refused));
    await board.close();
  });

  it.each([
    ['URL-encoded', (t: string) => encodeURIComponent(t)],
    ['JSON-escaped', (t: string) => JSON.stringify(t).slice(1, -1)],
  ])('a base64 token with + / = and a quote echoed %s is clean (review nit n2)', async (_form, encode) => {
    const token = 'ab+c/d=e"f\\g==';
    const fake = new FakeMandrel({ token, intercept: () => new Response(`echo ${encode(token)}`, { status: 401 }) });
    const board = new MandrelBoard({ url: FAKE_URL, authToken: token, connectionId: 'c', actorId: 'a', project: 'p', fetch: fake.fetch });
    const err = (await board.listStage('ready').catch((e: unknown) => e)) as Error;
    expect(err.message).toContain('<redacted>');
    expect(err.message).not.toContain(encode(token));
    await board.close();
  });

  it('the task note a failed tick writes is clean', async () => {
    const task: Task = {
      id: 'aa000000-0000-4000-8000-000000000001', title: 'T', stage: 'ready', status: 'todo', priority: 'medium',
      tags: ['repo:widgets'], createdAt: '2026-01-01T00:00:00Z', claimLive: false,
      metadata: { punch: { doneWhen: [{ text: 'x', owner: 'lane', proof: 'test/x.test.ts' }], proofKind: 'test' } },
    };
    const store = new FakeBoard({ tasks: [task] });
    let failed = 0;
    const fake = new FakeMandrel({
      token: CANARY,
      handle: boardBackedHandler(store),
      // The move to `claimed` fails with a 500 whose body echoes the headers, and the lease is gone (as
      // after a server restart), so the tick re-claims and writes the error into a note.
      intercept: (req, body) => {
        if (!(body.includes('"action":"update"') && body.includes('"stage":"claimed"') && failed++ === 0)) return undefined;
        const args = (JSON.parse(body) as { params: { arguments: { taskId: string; claimId: string } } }).params.arguments;
        void store.release(args.taskId, args.claimId);
        return echo(req, 500);
      },
    });
    const out = await cli('once', fake);
    expect(failed).toBe(1);
    const notes = (await store.get(task.id))!.metadata.noteLog as string[];
    expect(notes.join('\n')).toContain('loop: worker not started');
    expectClean(`${out}\n${notes.join('\n')}`);
  });
});
