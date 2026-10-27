/**
 * JSON-RPC error-code preservation on the streamable /mcp surface
 * (sibling sweep of the HTTP-500 defect).
 *
 * THE SIBLING DEFECT — same disease, one layer over, found by MEASURING the other surface
 * rather than assuming the HTTP fix covered it:
 *   registerMcpHandlers' CallTool catch re-wrapped EVERY failure as
 *   `McpError(ErrorCode.InternalError)`. So a strict-mode `Unknown parameter(s)` throw —
 *   ALREADY correctly classified as McpError(-32602, "Invalid params") by
 *   validationMiddleware — reached the client as an INTERNAL SERVER ERROR. Measured
 *   pre-fix over the real transport:
 *     {"code":-32603,"message":"MCP error -32603: Failed to execute tool:
 *                               MCP error -32602: Input validation failed: …"}
 *
 * WHY THIS IS THE SAME BUG, NOT A COSMETIC ONE
 *   On the streamable surface the HTTP status is 200 for every tool outcome — JSON-RPC
 *   carries the outcome in the BODY, which is protocol-correct. The `error.code` IS the
 *   retry signal on this surface, exactly as the HTTP status is on /mcp/tools/*: an MCP
 *   client backs off and retries on InternalError and gives up on InvalidParams. Flattening
 *   -32602 → -32603 therefore tells a retrying agent client to retry a request that can
 *   never succeed — the identical self-inflicted-load and alert-poisoning failure the HTTP
 *   fix exists to stop. This is why the fix had to be applied on BOTH surfaces.
 *
 * FAIL CLOSED: only an error that ALREADY carries a JSON-RPC classification is preserved.
 * A plain Error / a DB fault / a thrown string still becomes -32603 InternalError, exactly
 * as before — an unrecognised fault is never downgraded into a client error.
 *
 * No DB: a stub executor throws the errors under test, so this proves the transport's
 * classification wiring in isolation.
 */

import { runScopedTmpPath } from './helpers/runScopedTmp.js';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { AddressInfo } from 'node:net';
import { reserveEphemeralPort } from './helpers/ephemeralPort.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';

// The global vitest.setup.ts mocks 'crypto' with ONLY randomUUID, which breaks the real
// crypto used by bearerAuth (timingSafeEqual) and the transport (randomUUID).
vi.mock('crypto', async (i) => await i<typeof import('crypto')>());
vi.mock('node:crypto', async (i) => await i<typeof import('node:crypto')>());

const TEST_ENV: Record<string, string> = {
  DATABASE_NAME: 'errcode_pres_itest',
  DATABASE_USER: 'itest_user',
  DATABASE_PASSWORD: 'itest_pass',
  DATABASE_HOST: 'localhost',
  AIDIS_SKIP_DATABASE: 'true',
  AIDIS_SKIP_BACKGROUND: 'true',
  AIDIS_SKIP_STDIO: 'true',
};

// A throwaway value for a LOCAL listener that exists only for the duration of this file.
// Not a credential: nothing outside this process ever accepts it.
const TEST_TOKEN = 'errcode-pres-local-test-token';

/** The tool name → what the stub executor throws. Drives every case below. */
const THROWS: Record<string, () => unknown> = {
  throws_invalid_params: () =>
    new McpError(ErrorCode.InvalidParams, "Validation failed for task_update: Unknown parameter(s): 'notes'."),
  throws_invalid_request: () => new McpError(ErrorCode.InvalidRequest, 'invalid request'),
  throws_method_not_found: () => new McpError(ErrorCode.MethodNotFound, 'no such tool'),
  throws_internal: () => new McpError(ErrorCode.InternalError, 'a genuine internal fault'),
  throws_plain: () => new Error('a genuine internal fault with no code'),
  throws_string: () => 'a thrown string',
  throws_bare_code: () => Object.assign(new Error('looks like one but is not an McpError'), { code: -32602 }),
};

const stubExecutor = vi.fn(async (toolName: string) => {
  const make = THROWS[toolName];
  if (make) throw make();
  return { content: [{ type: 'text', text: 'ok' }], structuredContent: { ok: true } };
});

let health: any;
let baseUrl: string;
let sessionId: string;

async function rpc(body: unknown, withSession = true) {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    Authorization: `Bearer ${TEST_TOKEN}`,
  };
  if (withSession && sessionId) headers['mcp-session-id'] = sessionId;
  const res = await fetch(`${baseUrl}/mcp`, { method: 'POST', headers, body: JSON.stringify(body) });
  const text = await res.text();
  // The transport replies as SSE; the JSON-RPC envelope is the `data:` line.
  const dataLine = text.split('\n').find((l) => l.startsWith('data:'));
  const json = dataLine ? JSON.parse(dataLine.slice(5).trim()) : undefined;
  return { status: res.status, sid: res.headers.get('mcp-session-id'), json };
}

/** Call a tool over the real streamable transport and return its JSON-RPC error object. */
async function callToolExpectingError(name: string): Promise<{ code: number; message: string }> {
  const r = await rpc({ jsonrpc: '2.0', id: Math.floor(Math.random() * 1e6), method: 'tools/call', params: { name, arguments: {} } });
  // JSON-RPC transports the failure in the BODY at HTTP 200 — that is correct for this
  // surface, and asserted explicitly below.
  expect(r.status).toBe(200);
  expect(r.json?.error).toBeDefined();
  return r.json.error;
}

describe('streamable /mcp preserves a tool error\'s JSON-RPC classification', () => {
  beforeAll(async () => {
    const port = await reserveEphemeralPort();
    for (const [k, v] of Object.entries(TEST_ENV)) vi.stubEnv(k, v);
    vi.stubEnv('MCP_AUTH_TOKEN', TEST_TOKEN);
    vi.stubEnv('MCP_ALLOWED_HOSTS', `127.0.0.1:${port},localhost:${port},127.0.0.1,localhost`);
    vi.stubEnv('MANDREL_AIDIS_MCP_PORT', String(port));
    vi.stubEnv('AIDIS_PORT_REGISTRY', runScopedTmpPath('mandrel-errcode-pres-registry.json'));

    const { RemoteMcpTransport } = await import('../server/remoteMcpTransport.js');
    const { HealthServer } = await import('../server/healthServer.js');
    const remoteMcp = new RemoteMcpTransport({
      executeMcpTool: stubExecutor as any,
      getServerStatus: async () => ({ version: 'test' }),
    } as any);
    health = new HealthServer(stubExecutor as any, remoteMcp);
    const started = await health.start();
    const addr = health.address() as AddressInfo | null;
    baseUrl = `http://127.0.0.1:${addr?.port ?? started}`;

    const init = await rpc(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'errcode-test', version: '1.0.0' } },
      },
      false
    );
    expect(init.status).toBe(200);
    sessionId = init.sid!;
    expect(sessionId).toBeTruthy();
    await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' });
  }, 60000);

  afterAll(async () => {
    try {
      if (health) await health.stop();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('-32602 InvalidParams survives to the client as -32602 (was flattened to -32603)', async () => {
    const err = await callToolExpectingError('throws_invalid_params');
    // THE FUSE. Pre-fix this was -32603 InternalError, telling a retrying MCP client to
    // retry a strict-mode param rejection that can never succeed.
    expect(err.code).toBe(ErrorCode.InvalidParams);
    expect(err.code).toBe(-32602);
    expect(err.code).not.toBe(ErrorCode.InternalError);
    // The excellent diagnostic is preserved verbatim — only the classification changed.
    expect(err.message).toContain("Unknown parameter(s): 'notes'");
  });

  it('-32600 InvalidRequest and -32601 MethodNotFound survive too (the whole client-error class)', async () => {
    expect((await callToolExpectingError('throws_invalid_request')).code).toBe(ErrorCode.InvalidRequest);
    expect((await callToolExpectingError('throws_method_not_found')).code).toBe(ErrorCode.MethodNotFound);
  });

  it('FAIL CLOSED: a plain Error is still -32603 InternalError', async () => {
    const err = await callToolExpectingError('throws_plain');
    expect(err.code).toBe(ErrorCode.InternalError);
    expect(err.message).toContain('Failed to execute tool');
  });

  it('FAIL CLOSED: a thrown non-Error (string) is still -32603 InternalError', async () => {
    expect((await callToolExpectingError('throws_string')).code).toBe(ErrorCode.InternalError);
  });

  it('FAIL CLOSED: a bare object merely CARRYING code=-32602 is not trusted — still -32603', async () => {
    // Preservation keys on `instanceof McpError`, i.e. an error a classifying layer
    // DELIBERATELY produced — not on any object that happens to have a `code` property.
    // A DB/library error that coincidentally carries a numeric `code` must not be able to
    // launder itself into a client error and out of our 5xx incident signal.
    expect((await callToolExpectingError('throws_bare_code')).code).toBe(ErrorCode.InternalError);
  });

  it('-32603 InternalError from the executor stays -32603 (a genuine fault is unchanged)', async () => {
    expect((await callToolExpectingError('throws_internal')).code).toBe(ErrorCode.InternalError);
  });

  it('a SUCCEEDING tool call is untouched — the fix only touches failures', async () => {
    const r = await rpc({ jsonrpc: '2.0', id: 99, method: 'tools/call', params: { name: 'mandrel_ping', arguments: {} } });
    expect(r.status).toBe(200);
    expect(r.json?.error).toBeUndefined();
    expect(r.json?.result).toBeDefined();
  });
});
