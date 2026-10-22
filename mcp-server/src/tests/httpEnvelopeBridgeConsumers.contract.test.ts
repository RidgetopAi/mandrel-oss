/**
 * httpEnvelopeBridgeConsumers.contract.test.ts — the CONSUMER half of the /mcp/tools
 * envelope correction.
 *
 * ## The defect this exists to keep fixed
 *
 * `/mcp/tools/*` answers an IN-BAND tool error with HTTP 200 and a real CallToolResult:
 * `isError: true`, and content text that says what went wrong and what to do instead.
 * There is NO top-level `error` field on that body — the prose IS the error. When the
 * server's envelope began reporting `success: false` for such a result (which is the
 * truthful thing for it to say), every consumer that branched on `success` and then
 * reached for `response.error` found nothing, and substituted a generic string. The
 * actionable text was discarded at precisely the moment it was most needed.
 *
 * ## Why the assertions are on the MESSAGE
 *
 * The failure mode is LOSS, not a thrown-vs-returned distinction. A test that only checks
 * "the call resolved" passes with the prose replaced by 'HTTP call failed'. So every
 * assertion below names a substring of the tool's own text.
 *
 * ## Why BOTH envelope shapes, and why that is a requirement rather than thoroughness
 *
 * The bridge runs on the control box; the mcp-server runs on another box. They deploy
 * INDEPENDENTLY, in either order, so there is a window in which one is new and the other
 * is old. A consumer that is correct only against the new server breaks every caller for
 * the length of that window. Keying on the PAYLOAD (`result`) rather than on the FLAG
 * (`success`) is what removes the window: the payload is byte-identical under both
 * shapes. Hence the same expectation is asserted twice, once per shape.
 *
 * ## Why it spawns the real bridge instead of re-implementing its branch
 *
 * The bug was six lines inside a callback in a file no suite touched. A test that
 * restates those six lines proves only that we can write our expectations down twice,
 * and a test that greps the file for a pattern fails OPEN the moment the code is moved
 * or reworded (C3-B). This starts the actual script against a stub HTTP server, speaks
 * real MCP over its stdio, and reads what a client would receive. If the branch is
 * reverted the text changes, which is what the mutation probe for this guard measures.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..', '..');
const BRIDGE = path.join(REPO_ROOT, 'claude-http-mcp-bridge.js');
/** The SDK is not installed at the repo root; the suite's own copy resolves it. */
const SDK_NODE_PATH = path.join(REPO_ROOT, 'mcp-server', 'node_modules');

/**
 * The in-band error body, in the shape the server really emits: the prose lives in
 * `result.content[0].text` and there is deliberately no top-level `error`.
 */
const IN_BAND_TEXT =
  '❌ Context not found: deadbeef\n\n💡 The id may be wrong. Use context_get_recent to list ids.';
const IN_BAND_RESULT = {
  content: [{ type: 'text', text: IN_BAND_TEXT }],
  isError: true,
  structuredContent: { ok: false, found: false },
};

/** A transport/auth refusal: an `error`, and NO result at all. */
const TRANSPORT_REFUSAL = { success: false, error: 'Unauthorized' };

type Envelope = Record<string, unknown>;

const children: ChildProcessWithoutNullStreams[] = [];
const servers: http.Server[] = [];

afterAll(() => {
  for (const c of children) c.kill('SIGKILL');
  for (const s of servers) s.close();
});

/** A stub /mcp/tools/* that answers every tool call with one chosen envelope. */
async function startStub(envelope: Envelope): Promise<string> {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      // The bridge best-effort fetches /mcp/tools/schemas at startup; refusing it is fine
      // and is what a stub must do rather than invent a tool surface.
      if (req.url?.endsWith('/schemas')) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end('{}');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(envelope));
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  return `http://127.0.0.1:${port}`;
}

/**
 * Spawn the bridge, speak MCP over its stdio, and return the text a client would see for
 * one tools/call. Newline-delimited JSON-RPC, which is what StdioServerTransport speaks.
 */
async function callThroughBridge(envelope: Envelope, toolName = 'context_get'): Promise<string> {
  const baseUrl = await startStub(envelope);
  const child = spawn(process.execPath, [BRIDGE], {
    env: { ...process.env, MANDREL_HTTP_URL: baseUrl, NODE_PATH: SDK_NODE_PATH },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  children.push(child);

  const texts = new Map<number, string>();
  let buf = '';
  child.stdout.on('data', (chunk) => {
    buf += chunk.toString();
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (typeof msg.id === 'number') {
          texts.set(msg.id, JSON.stringify(msg));
        }
      } catch {
        /* not a JSON-RPC frame */
      }
    }
  });

  const send = (o: unknown) => child.stdin.write(JSON.stringify(o) + '\n');
  const waitFor = async (id: number, ms = 8000): Promise<any> => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const hit = texts.get(id);
      if (hit) return JSON.parse(hit);
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`no JSON-RPC response for id ${id} within ${ms}ms`);
  };

  send({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'envelope-contract-test', version: '1.0.0' },
    },
  });
  await waitFor(1);
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });

  send({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: toolName, arguments: { id: 'deadbeef' } },
  });
  const resp = await waitFor(2);
  child.kill('SIGKILL');

  // Whether the bridge resolved the result or turned it into an error content block, the
  // question this file asks is the same one: what TEXT reached the caller.
  return JSON.stringify(resp);
}

describe('the stdio bridge preserves an in-band tool error message', () => {
  it('delivers the tool\'s own prose when the envelope says success:TRUE (old server)', async () => {
    const out = await callThroughBridge({ success: true, result: IN_BAND_RESULT });
    expect(out).toContain('Context not found: deadbeef');
    expect(out).toContain('context_get_recent');
    expect(out).not.toContain('HTTP call failed');
  }, 20000);

  it('delivers the SAME prose when the envelope says success:FALSE (new server)', async () => {
    const out = await callThroughBridge({ success: false, result: IN_BAND_RESULT });
    expect(out).toContain('Context not found: deadbeef');
    expect(out).toContain('context_get_recent');
    expect(out).not.toContain('HTTP call failed');
  }, 20000);

  it('still surfaces a genuine transport refusal, which carries no result at all', async () => {
    const out = await callThroughBridge(TRANSPORT_REFUSAL);
    expect(out).toContain('Unauthorized');
    expect(out).not.toContain('Context not found');
  }, 20000);
});
