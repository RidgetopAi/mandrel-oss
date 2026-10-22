import { afterEach, describe, expect, it } from 'vitest';
import { MandrelBoard, TransportError } from '../src/board/mandrel.js';
import { FAKE_TOKEN, FakeMandrel } from './support/fake-mandrel-mcp.js';

const task = { id: 't1', title: 'T', stage: 'ready', status: 'todo', priority: 'medium', tags: [], createdAt: 'now', metadata: {} };

let fake: FakeMandrel | undefined;
let board: MandrelBoard | undefined;

/** A fake Mandrel on a real port that destroys the socket of the first `n` tools/call requests. */
async function serve(n: number): Promise<{ board: MandrelBoard; destroyed: () => number }> {
  fake = new FakeMandrel({ handle: () => ({ structuredContent: { found: true, task, claimed: true, claimId: 'c', expiresAt: 'x' } }) });
  let destroyed = 0;
  const url = await fake.listen((rpc) => rpc === 'tools/call' && destroyed < n && ++destroyed > 0);
  board = new MandrelBoard({ url, authToken: FAKE_TOKEN, connectionId: 'c', actorId: 'a', project: 'p' });
  return { board, destroyed: () => destroyed };
}

afterEach(async () => {
  await board?.close();
  await fake?.stop();
  board = fake = undefined;
});

describe('MandrelBoard socket-level failures', () => {
  it('retries a read once after the server destroys the socket', async () => {
    const s = await serve(1);
    expect((await s.board.get('t1'))?.id).toBe('t1');
    expect(s.destroyed()).toBe(1);
    expect(fake!.calls).toHaveLength(1);
  });

  it('keeps the underlying socket error code in the error when every read is destroyed', async () => {
    const s = await serve(Infinity);
    const err = await s.board.get('t1').then(() => undefined, (e: Error) => e);
    expect(err).toBeInstanceOf(TransportError);
    expect(err?.message).toMatch(/UND_ERR_SOCKET|ECONNRESET/);
    expect(s.destroyed()).toBe(2);
  });

  it('does not retry a write after the server destroys the socket', async () => {
    const s = await serve(Infinity);
    await expect(s.board.claim('t1')).rejects.toBeInstanceOf(TransportError);
    expect(s.destroyed()).toBe(1);
  });
});
