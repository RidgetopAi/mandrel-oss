/**
 * Integration test: MCP request limits.
 *
 * Boots the real HealthServer Express app with a real RemoteMcpTransport and a STUB tool
 * executor (same harness as remoteMcpTransport.integration.test.ts) and proves, at the HTTP
 * surface:
 *   1. AUTH BEFORE PARSE — an unauthenticated body is never parsed: an over-limit body and a
 *      malformed one both get 401, not the 413/400 a parser running first would produce. Over
 *      every body-reading route on the app, plus a structural check that no app-wide body
 *      parser exists to run ahead of the routes.
 *   2. BODY LIMIT — an authenticated /mcp body over MCP_MAX_REQUEST_BODY_BYTES is refused 413
 *      (JSON-RPC shaped) and never reaches the handler; the flat surface keeps its own limit.
 *   3. TOOL-INPUT ELEMENT LIMIT — a tools/call whose arguments carry more than
 *      MCP_MAX_TOOL_INPUT_ELEMENTS elements is refused -32602 on /mcp and 400 on the flat
 *      surface, and the executor never runs; exactly the limit still passes.
 * Every limit is read from config/mcpRequestLimitsConfig.ts, never re-typed here.
 */

const TEST_ENV: Record<string, string> = {
  DATABASE_NAME: process.env.DATABASE_NAME || 'aidis_remote_mcp_itest',
  DATABASE_USER: process.env.DATABASE_USER || 'itest_user',
  DATABASE_PASSWORD: process.env.DATABASE_PASSWORD || 'itest_pass',
  DATABASE_HOST: process.env.DATABASE_HOST || 'localhost',
  AIDIS_SKIP_DATABASE: process.env.AIDIS_SKIP_DATABASE || 'true',
  AIDIS_SKIP_BACKGROUND: process.env.AIDIS_SKIP_BACKGROUND || 'true',
  AIDIS_SKIP_STDIO: process.env.AIDIS_SKIP_STDIO || 'true',
};

import { runScopedTmpPath } from './helpers/runScopedTmp.js';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { AddressInfo } from 'node:net';
import { reserveEphemeralPort } from './helpers/ephemeralPort.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import {
  MCP_FLAT_MAX_REQUEST_BODY_BYTES,
  MCP_MAX_REQUEST_BODY_BYTES,
  MCP_MAX_TOOL_INPUT_ELEMENTS,
} from '../config/mcpRequestLimitsConfig.js';

// vitest.setup.ts mocks 'crypto' with only randomUUID; bearerAuth + the transport need the
// real module (same reason as remoteMcpTransport.integration.test.ts).
vi.mock('crypto', async (importActual) => await importActual<typeof import('crypto')>());
vi.mock('node:crypto', async (importActual) => await importActual<typeof import('node:crypto')>());

type HealthServer = import('../server/healthServer.js').HealthServer;
type McpHandlerDeps = import('../server/registerMcpHandlers.js').McpHandlerDeps;

const TEST_TOKEN = 'test-token-limits-do-not-use-in-prod';

const executorCalls: Array<{ tool: string; args: any }> = [];
const stubExecutor = vi.fn(async (toolName: string, args: any) => {
  executorCalls.push({ tool: toolName, args });
  return {
    content: [{ type: 'text', text: `stub:${toolName}` }],
    structuredContent: { ok: true, message: `stub:${toolName}` },
  };
});

const deps: McpHandlerDeps = {
  executeMcpTool: stubExecutor as any,
  getServerStatus: async () => ({ version: 'test' }),
};

let health: HealthServer;
let baseUrl: string;

const MCP_HEADERS = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
const AUTH = { Authorization: `Bearer ${TEST_TOKEN}` };

/** A syntactically VALID JSON-RPC initialize body of exactly `bytes` bytes. */
function initializeBodyOfSize(bytes: number): string {
  const skeleton = (pad: string) =>
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { pad } });
  const overhead = Buffer.byteLength(skeleton(''));
  const body = skeleton('x'.repeat(bytes - overhead));
  expect(Buffer.byteLength(body)).toBe(bytes);
  return body;
}

/** Tool arguments carrying exactly `n` elements: one object member + (n - 1) array elements. */
function argsWithElements(n: number): { items: number[] } {
  return { items: new Array(n - 1).fill(0) };
}

beforeAll(async () => {
  const port = await reserveEphemeralPort();
  for (const [key, value] of Object.entries(TEST_ENV)) vi.stubEnv(key, value);
  vi.stubEnv('MCP_AUTH_TOKEN', TEST_TOKEN);
  // vitest.setup.ts turns the flat-surface guard OFF for the whole suite; this file asserts
  // auth-before-parse on that surface too, so it runs with the shipped default (ON).
  vi.stubEnv('MCP_BRIDGE_AUTH_ENABLED', 'true');
  vi.stubEnv('MCP_ALLOWED_HOSTS', `127.0.0.1:${port},localhost:${port},127.0.0.1,localhost`);
  vi.stubEnv('MANDREL_AIDIS_MCP_PORT', String(port));
  vi.stubEnv('AIDIS_PORT_REGISTRY', runScopedTmpPath('mandrel-limits-itest-port-registry.json'));

  const { RemoteMcpTransport } = await import('../server/remoteMcpTransport.js');
  const { HealthServer } = await import('../server/healthServer.js');
  health = new HealthServer(stubExecutor as any, new RemoteMcpTransport(deps));
  const started = await health.start();
  const addr = health.address() as AddressInfo | null;
  baseUrl = `http://127.0.0.1:${addr?.port ?? started}`;
});

afterAll(async () => {
  try {
    if (health) await health.stop();
  } finally {
    vi.unstubAllEnvs();
  }
});

describe('MCP request limits — auth runs before any body is parsed', () => {
  // Every route on this app that reads a request body. Unauthenticated, each must answer 401
  // to a body a parser would refuse — proof that no parser ran ahead of the guard.
  const BODY_ROUTES = [
    '/mcp',
    '/mcp/tools/mandrel_ping',
    '/api/v2/projects/00000000-0000-4000-8000-000000000000/set-primary',
    '/api/v2/sessions/00000000-0000-4000-8000-000000000000/activities',
    '/api/decisions/00000000-0000-4000-8000-000000000000/answer',
  ];

  it.each(BODY_ROUTES)('unauthenticated malformed JSON on POST %s → 401, not a parse error', async (route) => {
    const res = await fetch(`${baseUrl}${route}`, {
      method: 'POST',
      headers: MCP_HEADERS,
      body: '{"this is": not json',
    });
    expect(res.status).toBe(401);
  });

  it('unauthenticated over-limit body on POST /mcp → 401, not 413 (the body is never parsed)', async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: MCP_HEADERS,
      body: initializeBodyOfSize(MCP_MAX_REQUEST_BODY_BYTES + 1),
    });
    expect(res.status).toBe(401);
  });

  it('the app mounts no app-wide body parser that could run ahead of a route guard', () => {
    // Express 5: app.router.stack. An app-level layer has no `.route`; express.json() and
    // express.urlencoded() layers are named jsonParser / urlencodedParser.
    const stack = ((health as any).app.router.stack as Array<{ name?: string; route?: unknown }>);
    expect(stack.length).toBeGreaterThan(0);
    const appLevelParsers = stack
      .filter((layer) => !layer.route)
      .map((layer) => layer.name)
      .filter((name) => name === 'jsonParser' || name === 'urlencodedParser');
    expect(appLevelParsers).toEqual([]);
  });
});

describe('MCP request limits — request body size', () => {
  it('authenticated /mcp body of MCP_MAX_REQUEST_BODY_BYTES + 1 → 413, JSON-RPC shaped, handler never runs', async () => {
    const before = executorCalls.length;
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { ...MCP_HEADERS, ...AUTH },
      body: initializeBodyOfSize(MCP_MAX_REQUEST_BODY_BYTES + 1),
    });
    expect(res.status).toBe(413);
    const body = await res.json();
    expect(body.jsonrpc).toBe('2.0');
    expect(body.error.code).toBe(ErrorCode.InvalidRequest);
    expect(body.error.message).toContain(String(MCP_MAX_REQUEST_BODY_BYTES));
    expect(executorCalls.length).toBe(before);
  });

  it('a normal initialize, and a body of exactly MCP_MAX_REQUEST_BODY_BYTES, both get past the parser', async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { ...MCP_HEADERS, ...AUTH },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'limits', version: '1' } },
      }),
    });
    expect(res.status).toBe(200);
    await res.text();
    // The boundary itself: a body AT the limit gets past the parser to the transport (which
    // answers its own 4xx for the pad-only params — anything but 413 proves the parser let it in).
    const atLimit = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { ...MCP_HEADERS, ...AUTH },
      body: initializeBodyOfSize(MCP_MAX_REQUEST_BODY_BYTES),
    });
    expect(atLimit.status).not.toBe(413);
    await atLimit.text();
  });

  it('authenticated malformed JSON on /mcp → 400 JSON-RPC parse error (-32700)', async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { ...MCP_HEADERS, ...AUTH },
      body: '{"this is": not json',
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe(ErrorCode.ParseError);
  });

  it('the flat surface keeps its own limit: MCP_FLAT_MAX_REQUEST_BODY_BYTES + 1 → 413, flat-shaped', async () => {
    const before = executorCalls.length;
    const pad = 'x'.repeat(MCP_FLAT_MAX_REQUEST_BODY_BYTES);
    const res = await fetch(`${baseUrl}/mcp/tools/mandrel_ping`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...AUTH },
      body: JSON.stringify({ arguments: { message: pad } }),
    });
    expect(res.status).toBe(413);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(executorCalls.length).toBe(before);
  });

  it('flat call with no JSON body (wrong Content-Type, or none) → 400, not a 500, and the executor never runs', async () => {
    const before = executorCalls.length;
    for (const init of [
      { method: 'POST', headers: { 'Content-Type': 'text/plain', ...AUTH }, body: '{"arguments":{}}' },
      { method: 'POST', headers: { ...AUTH } },
    ]) {
      const res = await fetch(`${baseUrl}/mcp/tools/mandrel_ping`, init);
      expect(res.status).toBe(400);
      expect((await res.json()).success).toBe(false);
    }
    expect(executorCalls.length).toBe(before);
  });
});

describe('MCP request limits — tool-input element count', () => {
  it('gateway (/mcp): MCP_MAX_TOOL_INPUT_ELEMENTS + 1 → -32602 and the executor never runs; exactly the limit passes', async () => {
    const client = new Client({ name: 'limits-client', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      requestInit: { headers: AUTH },
    });
    await client.connect(transport);
    try {
      const before = executorCalls.length;
      const over = argsWithElements(MCP_MAX_TOOL_INPUT_ELEMENTS + 1);
      await expect(client.callTool({ name: 'mandrel_ping', arguments: over })).rejects.toMatchObject({
        code: ErrorCode.InvalidParams,
      });
      expect(executorCalls.length).toBe(before);

      const atLimit = argsWithElements(MCP_MAX_TOOL_INPUT_ELEMENTS);
      const ok: any = await client.callTool({ name: 'mandrel_ping', arguments: atLimit });
      expect(JSON.stringify(ok)).toContain('stub:mandrel_ping');
      expect(executorCalls.length).toBe(before + 1);
      expect(executorCalls[executorCalls.length - 1].args.items).toHaveLength(MCP_MAX_TOOL_INPUT_ELEMENTS - 1);
    } finally {
      await client.close();
    }
  });

  it('flat (/mcp/tools/:tool): MCP_MAX_TOOL_INPUT_ELEMENTS + 1 → 400 and the executor never runs; exactly the limit passes', async () => {
    const before = executorCalls.length;
    const over = await fetch(`${baseUrl}/mcp/tools/mandrel_ping`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...AUTH },
      body: JSON.stringify({ arguments: argsWithElements(MCP_MAX_TOOL_INPUT_ELEMENTS + 1) }),
    });
    expect(over.status).toBe(400);
    const overBody = await over.json();
    expect(overBody.success).toBe(false);
    expect(overBody.error).toContain(`maximum of ${MCP_MAX_TOOL_INPUT_ELEMENTS} elements`);
    expect(executorCalls.length).toBe(before);

    const ok = await fetch(`${baseUrl}/mcp/tools/mandrel_ping`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...AUTH },
      body: JSON.stringify({ arguments: argsWithElements(MCP_MAX_TOOL_INPUT_ELEMENTS) }),
    });
    expect(ok.status).toBe(200);
    expect(executorCalls.length).toBe(before + 1);
  });
});
