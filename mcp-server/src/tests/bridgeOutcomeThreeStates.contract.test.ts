/**
 * bridgeOutcomeThreeStates.contract.test.ts — a schema REJECTION must never render as a
 * TRANSPORT FAILURE, and a transport failure must never render as a rejection.
 *
 * ## The defect this exists to keep fixed
 *
 * Measured against prod on 2026-08-22. A gateway call carrying an undeclared parameter is
 * correctly refused (`additionalProperties: false`), but the refusal reached the caller as:
 *
 *     ❌ Error calling task: HTTP call failed
 *
 * and, for the auth gate's JSON-RPC error frame (whose `error` is an OBJECT, not a string):
 *
 *     ❌ Error calling task: [object Object]
 *
 * Both are the same bug. `new Error(response.error || 'HTTP call failed')` produces a
 * message-shaped value carrying no information, and the CallToolResult it was wrapped in
 * carried no `isError`, so the client saw a SUCCESS whose text described a failure.
 *
 * "The server refused you" and "the call may not have happened" have OPPOSITE remedies: a
 * refusal must never be retried (an identical retry is refused identically); a transport
 * failure may be. An agent that reads a refusal as transient retries in a loop forever.
 * That happened twice in one session before it was diagnosed.
 *
 * ## The population this guard enumerates, and why it is the whole one
 *
 * Everything the bridge can observe on the wire partitions into exactly five cases, and
 * there is no sixth: either a response arrives or it does not; if it arrives the body
 * either parses as JSON or does not; if it parses it either carries `result`, or carries
 * `error`, or carries neither. One case each below.
 *
 *   1. parses, has `result`                → the tool ran; pass its payload through
 *   2. parses, has `error`, refusing status → REJECTED (permanent)
 *   3. parses, has `error` as an OBJECT     → REJECTED, and the object must be READ
 *   4. parses, has NEITHER                  → must quote the body, never a bare constant
 *   5. no response at all (connection dies) → UNREACHABLE (transport)
 *
 * Plus one case that is not a wire shape but a JUDGEMENT: 429 is not a permanent refusal.
 *
 * ## Why it spawns the real bridge
 *
 * Same reason as httpEnvelopeBridgeConsumers.contract.test.ts: the bug lives in a callback
 * in a file no unit test imports. A test that restates the branch proves only that we can
 * write the expectation twice, and a grep for a pattern fails OPEN the moment the code is
 * reworded (C3-B). This starts the real script against a stub server and reads exactly what
 * an MCP client would receive.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import http from 'http';
import net from 'net';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..', '..');
const BRIDGE = path.join(REPO_ROOT, 'claude-http-mcp-bridge.js');
/** The SDK is not installed at the repo root; the suite's own copy resolves it. */
const SDK_NODE_PATH = path.join(REPO_ROOT, 'mcp-server', 'node_modules');

/** The exact prose prod emits for the reported defect's trigger, captured live. */
const REAL_STRICT_REJECTION =
  "Validation failed for smart_search: Unknown parameter(s): 'notes'. This tool rejects " +
  'undeclared params (strict mode).';

const children: ChildProcessWithoutNullStreams[] = [];
const servers: http.Server[] = [];
const rawServers: net.Server[] = [];

afterAll(() => {
  for (const c of children) c.kill('SIGKILL');
  for (const s of servers) s.close();
  for (const s of rawServers) s.close();
});

/** A stub /mcp/tools/* that answers every tool call with one chosen status + raw body. */
async function startStub(status: number, rawBody: string): Promise<string> {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      // The bridge best-effort fetches the schema list at startup; refusing it is what a
      // stub must do rather than invent a tool surface.
      if (req.url?.endsWith('/schemas')) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end('{}');
        return;
      }
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(rawBody);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  return `http://127.0.0.1:${port}`;
}

/**
 * A server that accepts the TCP connection and then destroys it without replying — the
 * shape of a genuine transport failure, which is the control for every rejection case.
 */
async function startBlackHole(): Promise<string> {
  const server = net.createServer((sock) => {
    sock.on('data', () => sock.destroy());
  });
  rawServers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  return `http://127.0.0.1:${port}`;
}

type BridgeReply = { text: string; isError: unknown; raw: string };

/** Spawn the bridge, speak MCP over its stdio, and return what a client would receive. */
async function callThroughBridge(baseUrl: string, toolName = 'context_get'): Promise<BridgeReply> {
  const child = spawn(process.execPath, [BRIDGE], {
    env: { ...process.env, MANDREL_HTTP_URL: baseUrl, NODE_PATH: SDK_NODE_PATH },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  children.push(child);

  const frames = new Map<number, any>();
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
        if (typeof msg.id === 'number') frames.set(msg.id, msg);
      } catch {
        /* not a JSON-RPC frame */
      }
    }
  });

  const send = (o: unknown) => child.stdin.write(JSON.stringify(o) + '\n');
  const waitFor = async (id: number, ms = 20000): Promise<any> => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const hit = frames.get(id);
      if (hit) return hit;
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
      clientInfo: { name: 'three-states-contract-test', version: '1.0.0' },
    },
  });
  await waitFor(1);
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  send({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: toolName, arguments: { query: 'x', notes: 'undeclared' } },
  });
  const resp = await waitFor(2);
  child.kill('SIGKILL');

  const raw = JSON.stringify(resp);
  const text = resp?.result?.content?.map((c: any) => c?.text).join('\n') ?? '';
  return { text, isError: resp?.result?.isError, raw };
}

/**
 * The single sentence this whole file defends. A rejection may never wear the transport
 * vocabulary, and a transport failure may never wear the rejection vocabulary — because
 * a reader (human or agent) decides RETRY vs FIX from exactly these words.
 *
 * These match the BANNER, not a loose keyword. Measured while probing this guard: a regex
 * of /TRANSPORT/i was satisfied by the incidental lowercase phrase "transport error
 * contacting …" inside a detail string, so it stayed green with the banner removed. A
 * classifier's verdict must be asserted on the token that only the classifier can emit.
 */
const TRANSPORT_BANNER = /COULD NOT BE REACHED — TRANSPORT/;
const REJECTION_BANNER = /REJECTED this call — PERMANENT, DO NOT RETRY/;
/** Anything that would tell a caller "retry": the pre-fix constant included. */
const RETRY_SUGGESTING = /COULD NOT BE REACHED|HTTP call failed/i;

describe('a bridge call has three outcomes and they stay distinguishable', () => {
  it('case 1 (control): a real tool result passes through, unbannered and not isError', async () => {
    const base = await startStub(200, JSON.stringify({
      success: true,
      result: { content: [{ type: 'text', text: 'the tool ran fine' }] },
    }));
    const out = await callThroughBridge(base);
    expect(out.text).toContain('the tool ran fine');
    expect(out.text).not.toMatch(TRANSPORT_BANNER);
    expect(out.text).not.toMatch(REJECTION_BANNER);
    expect(out.isError).not.toBe(true);
  }, 30000);

  it('case 2: a strict-mode schema rejection reads as PERMANENT, names the param, and is isError', async () => {
    const base = await startStub(400, JSON.stringify({
      success: false,
      error: `MCP error -32602: Input validation failed: ${REAL_STRICT_REJECTION}`,
      type: 'McpError',
    }));
    const out = await callThroughBridge(base);
    // The whole point: the caller must be able to read WHICH parameter was wrong.
    expect(out.text).toContain("Unknown parameter(s): 'notes'");
    expect(out.text).toMatch(REJECTION_BANNER);
    // ...and must NOT be told the call might not have happened.
    expect(out.text).not.toMatch(RETRY_SUGGESTING);
    expect(out.isError).toBe(true);
  }, 30000);

  it('case 3: an error field that is an OBJECT is read, not stringified to [object Object]', async () => {
    const base = await startStub(401, JSON.stringify({
      jsonrpc: '2.0',
      error: { code: -32001, message: 'Unauthorized: invalid Bearer token.' },
      id: null,
    }));
    const out = await callThroughBridge(base);
    expect(out.text).toContain('Unauthorized: invalid Bearer token.');
    expect(out.text).not.toContain('[object Object]');
    expect(out.text).toMatch(REJECTION_BANNER);
    expect(out.isError).toBe(true);
  }, 30000);

  it('case 4: a body with neither result nor error quotes the body instead of a bare constant', async () => {
    const base = await startStub(500, JSON.stringify({ nothing: 'useful', marker: 'ODDBODY-4711' }));
    const out = await callThroughBridge(base);
    expect(out.text).toContain('ODDBODY-4711');
    expect(out.text).toContain('500');
    expect(out.text).not.toContain('HTTP call failed');
    expect(out.isError).toBe(true);
  }, 30000);

  it('JUDGEMENT: 429 is NOT a permanent refusal — the banner must not tell a caller to stop retrying a rate limit', async () => {
    // Not a wire shape but a decision this repo committed to, asserted so it cannot be
    // undone silently. Telling a caller not to retry a rate limit is the same
    // state-collapse this whole file exists to kill, mirrored.
    const base = await startStub(429, JSON.stringify({ success: false, error: 'Too Many Requests', retryable: true }));
    const out = await callThroughBridge(base);
    expect(out.text).toContain('Too Many Requests');
    expect(out.text).toMatch(TRANSPORT_BANNER);
    expect(out.text).not.toMatch(REJECTION_BANNER);
    expect(out.isError).toBe(true);
  }, 30000);

  it('case 5 (the other control): a genuine transport failure reads as TRANSPORT, never as a rejection', async () => {
    const base = await startBlackHole();
    const out = await callThroughBridge(base);
    expect(out.text).toMatch(TRANSPORT_BANNER);
    expect(out.text).not.toMatch(REJECTION_BANNER);
    expect(out.text).not.toMatch(/DO NOT RETRY/i);
    expect(out.isError).toBe(true);
  }, 30000);
});
