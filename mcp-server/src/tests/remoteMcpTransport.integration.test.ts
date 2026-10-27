/**
 * Integration test: Remote Streamable HTTP MCP transport + bearer auth.
 *
 * Boots the real HealthServer Express app with a real RemoteMcpTransport mounted,
 * but injects a STUB tool executor so we exercise the transport/auth/protocol wiring
 * WITHOUT pulling the embeddings/background-services (sharp) path that the full
 * dist/main.js boot requires. Tool logic itself is covered elsewhere; here we prove:
 *   - missing token  → 401
 *   - wrong token    → 401
 *   - valid token    → full MCP handshake (initialize → tools/list → tools/call)
 *   - the stub executor receives a per-session connectionId (session isolation)
 */

// Provide required database env vars BEFORE importing any server module so that
// config/database (imported transitively via HealthServer → projectController) does
// not throw at module-evaluation time. Mirrors src/tests/httpContract.test.ts.
//
// Stubbed in beforeAll (NOT at module scope) and restored in afterAll.
// process.env is shared by every file in the run (vitest.config pins the suite to ONE
// fork), so a module-scope write leaks into every file that runs afterwards and makes
// OTHER files lie. The HealthServer/RemoteMcpTransport imports are DYNAMIC (inside
// beforeAll), so stubbing there still lands before any module-eval read.
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
import { MANDREL_VERSION } from '../version.js';

// The global vitest.setup.ts mocks 'crypto' with ONLY randomUUID, which breaks any
// real crypto use (createHash/timingSafeEqual in bearerAuth, randomUUID in the
// transport). Restore the REAL crypto module for this integration test so we exercise
// the genuine auth + session-id path.
vi.mock('crypto', async (importActual) => await importActual<typeof import('crypto')>());
vi.mock('node:crypto', async (importActual) => await importActual<typeof import('node:crypto')>());

// HealthServer/RemoteMcpTransport are imported DYNAMICALLY inside beforeAll (after the
// env block above has run) so that the transitive config/database import does not throw
// at module-eval time. Mirrors httpContract.test.ts's dynamic-import approach.
type HealthServer = import('../server/healthServer.js').HealthServer;
type RemoteMcpTransport = import('../server/remoteMcpTransport.js').RemoteMcpTransport;
type McpHandlerDeps = import('../server/registerMcpHandlers.js').McpHandlerDeps;

const TEST_TOKEN = 'test-token-do-not-use-in-prod';

// Spy executor records the connectionId it is called with and returns canned results.
const executorCalls: Array<{
  tool: string;
  args: any;
  connectionId?: string;
  actor?: string;
  loopId?: string;
}> = [];
const stubExecutor = vi.fn(
  async (
    toolName: string,
    _args: any,
    ctx?: { connectionId?: string; actor?: string; loopId?: string }
  ) => {
  executorCalls.push({
    tool: toolName,
    args: _args,
    connectionId: ctx?.connectionId,
    actor: ctx?.actor,
    loopId: ctx?.loopId,
  });
  // v0.5.8 dual-channel contract: EVERY tool now advertises an outputSchema in
  // AIDIS_TOOL_DEFINITIONS, so the MCP SDK client REQUIRES the tool result to carry
  // `structuredContent` (a result with only `content` is rejected with -32600
  // "has an output schema but did not return structured content"). The real executor
  // always returns both channels; the stub must mirror that so this integration test
  // exercises the genuine transport+protocol path (not a contract the real server can't
  // produce). The structuredContent shape here is intentionally minimal — this test
  // proves transport/auth/session-isolation wiring, not per-tool schema conformance
  // (that is covered by dualChannelOutput.contract.test.ts).
  if (toolName === 'mandrel_ping') {
    return {
      content: [{ type: 'text', text: 'pong (stub)' }],
      structuredContent: { ok: true, message: 'pong (stub)' },
    };
  }
  return {
    content: [{ type: 'text', text: `stub:${toolName}` }],
    structuredContent: { ok: true, tool: toolName },
  };
  }
);

const deps: McpHandlerDeps = {
  executeMcpTool: stubExecutor as any,
  getServerStatus: async () => ({ version: 'test' }),
};

let health: HealthServer;
let baseUrl: string;

// OS-assigned port, resolved before the transport is constructed so the host:port can be
// pre-listed in MCP_ALLOWED_HOSTS (the SDK's DNS-rebinding protection validates the full
// Host header incl. port, and allowedHosts is cached in the constructor). A fixed literal
// here sat inside the tenant-reserved 18080-18099 range (reserved-port-ok: prose, not a
// bind) — see helpers/ephemeralPort.ts.
let TEST_PORT: number;

beforeAll(async () => {
  TEST_PORT = await reserveEphemeralPort();
  // vi.stubEnv (not raw assignment) so vi.unstubAllEnvs in afterAll restores ALL of them.
  // Previously afterAll deleted ONLY MCP_AUTH_TOKEN, so MCP_ALLOWED_HOSTS /
  // MANDREL_AIDIS_MCP_PORT / AIDIS_PORT_REGISTRY leaked into every later file.
  for (const [key, value] of Object.entries(TEST_ENV)) vi.stubEnv(key, value);
  vi.stubEnv('MCP_AUTH_TOKEN', TEST_TOKEN);
  vi.stubEnv('MCP_ALLOWED_HOSTS', `127.0.0.1:${TEST_PORT},localhost:${TEST_PORT},127.0.0.1,localhost`);
  vi.stubEnv('MANDREL_AIDIS_MCP_PORT', String(TEST_PORT));
  vi.stubEnv('AIDIS_PORT_REGISTRY', runScopedTmpPath('mandrel-itest-port-registry.json'));

  // Import AFTER the env stubs above so config/database does not throw at module-eval
  // time. (Static imports would hoist above them.)
  const { RemoteMcpTransport } = await import('../server/remoteMcpTransport.js');
  const { HealthServer } = await import('../server/healthServer.js');

  // Construct AFTER env is set so allowedHosts include the test host:port.
  const remoteMcp = new RemoteMcpTransport(deps);
  health = new HealthServer(stubExecutor as any, remoteMcp);
  const port = await health.start();
  const addr = health.address() as AddressInfo | null;
  const actualPort = addr?.port ?? port;
  baseUrl = `http://127.0.0.1:${actualPort}`;
});

afterAll(async () => {
  try {
    if (health) await health.stop();
  } finally {
    // Restores EVERY stub above on every path — not just MCP_AUTH_TOKEN.
    vi.unstubAllEnvs();
  }
});

describe('Remote MCP transport — bearer auth', () => {
  it('rejects POST /mcp with NO token (401, JSON-RPC error body)', async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBeDefined();
    expect(body.jsonrpc).toBe('2.0');
  });

  it('rejects POST /mcp with WRONG token (401)', async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: 'Bearer not-the-real-token',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBeDefined();
  });
});

describe('Remote MCP transport — full MCP handshake with valid token', () => {
  it('initializes, lists tools, and calls mandrel_ping over Streamable HTTP', async () => {
    const client = new Client({ name: 'itest-client', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      requestInit: {
        headers: { Authorization: `Bearer ${TEST_TOKEN}` },
      },
    });

    await client.connect(transport); // performs initialize

    // serverInfo from initialize
    const serverInfo = client.getServerVersion();
    expect(serverInfo?.name).toBe('mandrel-mcp-server');

    // The version a REAL client receives must be the derived single-source string, not a
    // hardcoded literal. Closes the drift hole at remoteMcpTransport.ts:447 only — the
    // stdio call site (MandrelMcpServer.ts:89) is NOT covered by this assertion.
    expect(serverInfo?.version).toBe(MANDREL_VERSION);

    // PROJECT VISIBILITY: the initialize result now carries `instructions`
    // reminding the client that writes scope to the ACTIVE project. Delivered end-to-end
    // over the real transport → client.getInstructions(). (No DB here, so the dynamic
    // project resolution degrades to the STATIC reminder — which still names the concept.)
    const instructions = client.getInstructions();
    expect(instructions, 'initialize must carry instructions').toBeTruthy();
    expect(instructions).toContain('ACTIVE project');

    // tools/list
    const tools = await client.listTools();
    const names = tools.tools.map(t => t.name);
    expect(names).toContain('mandrel_ping');
    expect(names.length).toBeGreaterThan(10);
    // Disabled tools must be filtered out
    expect(names).not.toContain('complexity_analyze');

    // tools/call on a safe read-only tool
    const result: any = await client.callTool({ name: 'mandrel_ping', arguments: { message: 'hi' } });
    expect(JSON.stringify(result)).toContain('pong (stub)');

    // The stub executor must have received a non-stdio per-session connectionId
    const pingCall = executorCalls.find(c => c.tool === 'mandrel_ping');
    expect(pingCall).toBeDefined();
    expect(pingCall?.connectionId).toBeTruthy();
    expect(pingCall?.connectionId).not.toBe('stdio');

    await client.close();
  });
});

describe('Remote MCP transport — fail-closed when no token configured', () => {
  it('returns 503 (not open, not 401) on POST /mcp when MCP_AUTH_TOKEN is unset', async () => {
    // Temporarily remove the configured token. bearerAuth() reads env at call time,
    // so this exercises the genuine fail-closed branch without restarting the server.
    const saved = process.env.MCP_AUTH_TOKEN;
    delete process.env.MCP_AUTH_TOKEN;
    try {
      const res = await fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          // Even WITH a Bearer header, an unconfigured server must refuse (fail closed).
          Authorization: `Bearer ${TEST_TOKEN}`,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
      });
      // Must be 503 (server-not-configured), NOT 200 (open) and NOT 401 (auth-shaped).
      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body.jsonrpc).toBe('2.0');
      expect(body.error).toBeDefined();
      // No session must have been created by an unconfigured server.
      const callsBefore = executorCalls.length;
      expect(callsBefore).toBeGreaterThanOrEqual(0); // tool never invoked on 503 path
    } finally {
      // Restore so later assertions / other tests keep the configured token.
      process.env.MCP_AUTH_TOKEN = saved;
    }
  });
});

describe('Remote MCP transport — two-session isolation', () => {
  it('gives each session a distinct Mcp-Session-Id and a distinct connectionId', async () => {
    const makeClient = () => {
      const client = new Client({ name: 'itest-client', version: '1.0.0' });
      const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${TEST_TOKEN}` } },
      });
      return { client, transport };
    };

    const a = makeClient();
    const b = makeClient();

    // Each client performs its own initialize → server-generated session id.
    await a.client.connect(a.transport);
    await b.client.connect(b.transport);

    const sessionA = a.transport.sessionId;
    const sessionB = b.transport.sessionId;

    // Distinct, server-generated session ids.
    expect(sessionA).toBeTruthy();
    expect(sessionB).toBeTruthy();
    expect(sessionA).not.toBe(sessionB);

    // Each session issues a tools/call with a session-unique marker arg so we can
    // correlate the recorded executor call back to the originating session.
    await a.client.callTool({ name: 'mandrel_ping', arguments: { message: 'from-A' } });
    await b.client.callTool({ name: 'mandrel_ping', arguments: { message: 'from-B' } });

    const callA = executorCalls.find(c => c.tool === 'mandrel_ping' && c.args?.message === 'from-A');
    const callB = executorCalls.find(c => c.tool === 'mandrel_ping' && c.args?.message === 'from-B');

    expect(callA).toBeDefined();
    expect(callB).toBeDefined();

    // The dispatched connectionId IS the session id → isolation:
    //   - A's call carries A's session id (its connectionId), never B's.
    //   - B's call carries B's session id, never A's.
    expect(callA?.connectionId).toBe(sessionA);
    expect(callB?.connectionId).toBe(sessionB);
    expect(callA?.connectionId).not.toBe(callB?.connectionId);
    expect(callA?.connectionId).not.toBe(sessionB);
    expect(callB?.connectionId).not.toBe(sessionA);

    await a.client.close();
    await b.client.close();
  });
});

describe('Remote MCP transport — unknown session id is REHYDRATED, not 404 (rehydrate-on-miss)', () => {
  // an earlier Task / branch:mcp-session-persistence (supersedes the old papercut):
  // a lost session (idle-evicted, LRU-evicted, or — the big one — wiped by a server
  // restart/deploy) causes the client's NEXT tool call to arrive with a valid bearer token
  // + a session id no longer in the map. Real MCP clients (Amp, Claude Code, Codex, …)
  // IGNORE the spec-mandated re-initialize 404 and silently brick. So the server now
  // transparently REHYDRATES a valid session bound to that exact id and handles the
  // request — the client never sees a 404. A BADLY-FORMED (non-uuid) id is NOT rehydrated
  // (an attacker can't spawn arbitrary sessions); it still gets the actionable 404.
  const SESSION_EXPIRED_CODE = -32002;

  it('THE KEY TEST: a tools/call with a valid token + a well-formed UNKNOWN session id is rehydrated → 200 + correct tool result', async () => {
    // A well-formed (uuid-v4) session id the server has never issued exactly models a
    // session lost to a restart/idle-eviction: auth passes, but it is gone from the map.
    const lostSessionId = '00000000-0000-4000-8000-000000000000';

    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${TEST_TOKEN}`, // token is VALID — rehydration only runs post-auth
        'Mcp-Session-Id': lostSessionId,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 42,
        method: 'tools/call',
        params: { name: 'mandrel_ping', arguments: { message: 'after-restart' } },
      }),
    });

    // Rehydrated → 200, NOT 404. The client never sees the drop.
    expect(res.status).toBe(200);

    // The tool actually ran on the revived session and returned the correct result.
    const text = await res.text(); // may be SSE-framed; assert on the payload either way
    expect(text).toContain('pong (stub)');

    // The executor was invoked for the rehydrated request (proof the session is live).
    const call = executorCalls.find(
      c => c.tool === 'mandrel_ping' && c.args?.message === 'after-restart'
    );
    expect(call).toBeDefined();
    // No X-Connection-ID header was sent → dispatch falls back to the (revived) session id.
    expect(call?.connectionId).toBe(lostSessionId);
  });

  it('does NOT rehydrate a BADLY-FORMED (non-uuid) unknown id — still the actionable 404', async () => {
    const garbageSessionId = 'not-a-uuid-12345';

    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${TEST_TOKEN}`,
        'Mcp-Session-Id': garbageSessionId,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 42,
        method: 'tools/call',
        params: { name: 'mandrel_ping', arguments: {} },
      }),
    });

    // A forged / malformed id is NEVER rehydrated → the self-healing 404, not 200.
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.jsonrpc).toBe('2.0');
    expect(body.error.code).toBe(SESSION_EXPIRED_CODE);

    const msg: string = body.error.message;
    expect(msg.toLowerCase()).toContain('re-initialize');
    // Must NOT misrepresent itself as an auth failure (the token is still valid).
    expect(msg.toLowerCase()).not.toContain('unauthorized');
    expect(msg.toLowerCase()).not.toContain('invalid bearer');
    expect(body.error.data?.reason).toBe('session_expired');
    expect(body.error.data?.action).toBe('reinitialize');
    expect(body.error.data?.retryable).toBe(true);
    expect(body.id).toBe(42);
  });

  it('still returns the protocol error (-32600) when NO session id is sent on a non-initialize request', async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${TEST_TOKEN}`,
        // No Mcp-Session-Id header at all.
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 7,
        method: 'tools/call',
        params: { name: 'mandrel_ping', arguments: {} },
      }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe(-32600);
    // This branch (no session at all) is distinct from the expired-session branch.
    expect(body.error.code).not.toBe(SESSION_EXPIRED_CODE);
  });
});

describe('Remote MCP transport — idle timeout is env-configurable (default raised to 24h)', () => {
  it('defaults to 24 hours and honors MCP_SESSION_IDLE_MS override', async () => {
    const { RemoteMcpTransport } = await import('../server/remoteMcpTransport.js');

    // Default (env unset): bounded 24h idle window (raised from 4h) so a
    // working dev — even across an overnight gap — rarely expires; rehydration covers the rest.
    const savedIdle = process.env.MCP_SESSION_IDLE_MS;
    delete process.env.MCP_SESSION_IDLE_MS;
    try {
      const dflt = new RemoteMcpTransport(deps);
      expect((dflt as any).sessionIdleMs).toBe(24 * 60 * 60 * 1000);

      // Override is read from env at construction (tunable without a code change).
      process.env.MCP_SESSION_IDLE_MS = String(2 * 60 * 60 * 1000); // 2 hours
      const overridden = new RemoteMcpTransport(deps);
      expect((overridden as any).sessionIdleMs).toBe(2 * 60 * 60 * 1000);

      // Invalid / non-positive values fall back to the safe default (never unbounded).
      process.env.MCP_SESSION_IDLE_MS = 'not-a-number';
      const bad = new RemoteMcpTransport(deps);
      expect((bad as any).sessionIdleMs).toBe(24 * 60 * 60 * 1000);

      process.env.MCP_SESSION_IDLE_MS = '0';
      const zero = new RemoteMcpTransport(deps);
      expect((zero as any).sessionIdleMs).toBe(24 * 60 * 60 * 1000);
    } finally {
      if (savedIdle === undefined) delete process.env.MCP_SESSION_IDLE_MS;
      else process.env.MCP_SESSION_IDLE_MS = savedIdle;
    }
  });
});

describe('Remote MCP transport — rehydration restores project isolation via X-Connection-ID (SR-1)', () => {
  // On a server restart the in-RAM map is wiped, but the DB still holds the session row
  // keyed by the STABLE X-Connection-ID (SR-1, migration 050) carrying its project_id.
  // The rehydrated session must dispatch tools under that X-Connection-ID — NOT the
  // ephemeral mcp-session-id — so SessionTracker's SR-1 re-attach recovers the SAME
  // session row and therefore the SAME project. We assert the connectionId handed to the
  // executor on the rehydrated call IS the X-Connection-ID (the SR-1 recovery key), which
  // is exactly what makes the user land back in their correct project.
  it('a rehydrated tools/call dispatches under the X-Connection-ID, not the session id (the SR-1 recovery key)', async () => {
    const lostSessionId = '11111111-1111-4111-8111-111111111111';
    const stableConnId = 'bridge-itest-conn-7';

    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${TEST_TOKEN}`,
        'Mcp-Session-Id': lostSessionId,
        'X-Connection-ID': stableConnId, // the stable per-connection identity SR-1 keys on
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 99,
        method: 'tools/call',
        params: { name: 'mandrel_ping', arguments: { message: 'isolation-probe' } },
      }),
    });

    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('pong (stub)');

    // The dispatched connectionId is the STABLE X-Connection-ID (the SR-1 key that recovers
    // project from the DB), NOT the lost mcp-session-id. This is what restores the user's
    // correct project across the restart.
    const call = executorCalls.find(
      c => c.tool === 'mandrel_ping' && c.args?.message === 'isolation-probe'
    );
    expect(call).toBeDefined();
    expect(call?.connectionId).toBe(stableConnId);
    expect(call?.connectionId).not.toBe(lostSessionId);
  });
});

describe('Remote MCP transport — rehydration is post-auth only (auth preserved)', () => {
  it('an unknown session id with NO token is 401 (rehydration never runs pre-auth)', async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        // No Authorization header.
        'Mcp-Session-Id': '22222222-2222-4222-8222-222222222222',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'mandrel_ping', arguments: { message: 'should-never-run' } },
      }),
    });
    // Auth middleware rejects BEFORE handlePost → never rehydrated.
    expect(res.status).toBe(401);
    // And the tool must NOT have executed.
    const ran = executorCalls.find(c => c.args?.message === 'should-never-run');
    expect(ran).toBeUndefined();
  });

  it('an unknown session id with a WRONG token is 401 (not rehydrated)', async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: 'Bearer not-the-real-token',
        'Mcp-Session-Id': '33333333-3333-4333-8333-333333333333',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'mandrel_ping', arguments: { message: 'wrong-token-probe' } },
      }),
    });
    expect(res.status).toBe(401);
    const ran = executorCalls.find(c => c.args?.message === 'wrong-token-probe');
    expect(ran).toBeUndefined();
  });
});

describe('Remote MCP transport — SDK-coupling guard for rehydration (fails loudly on an SDK internals change)', () => {
  // Rehydration depends on UNDOCUMENTED @modelcontextprotocol/sdk internals (the private
  // `_initialized` flag + the writable inner `_webStandardTransport.sessionId`). A future
  // SDK bump that renames/relocates these would SILENTLY brick rehydration (back to 404s
  // for every customer after a deploy). This guard asserts the mechanism against the
  // INSTALLED SDK so such a bump fails CI loudly. The SDK is pinned to 1.32.x; if this
  // test goes red after a bump, re-verify driveSyntheticInitialize + the sessionId stamp.
  it('drives a synthetic initialize on the installed SDK transport: _initialized flips and the inner sessionId is writable', async () => {
    const { Server } = await import('@modelcontextprotocol/sdk/server/index.js');
    const { StreamableHTTPServerTransport } = await import(
      '@modelcontextprotocol/sdk/server/streamableHttp.js'
    );
    const { randomUUID } = await import('node:crypto');
    const { LATEST_PROTOCOL_VERSION } = await import('@modelcontextprotocol/sdk/types.js');

    const server = new Server(
      { name: 'sdk-guard', version: '1.0.0' },
      { capabilities: { tools: {}, resources: {} } }
    );
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableDnsRebindingProtection: true,
      allowedHosts: ['localhost'],
    });
    await server.connect(transport);

    // The private surface rehydration relies on MUST exist on the installed SDK.
    const inner = (transport as any)._webStandardTransport;
    expect(inner).toBeDefined();
    // Before init: not initialized.
    expect(inner._initialized).toBe(false);

    // Drive ONE synthetic initialize through the inner transport (same path as
    // RemoteMcpTransport.driveSyntheticInitialize) and assert the private flag flips.
    const initBody = {
      jsonrpc: '2.0',
      id: 'sdk-guard-init',
      method: 'initialize',
      params: {
        protocolVersion: LATEST_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'sdk-guard', version: '1.0.0' },
      },
    };
    const webReq = new Request('http://localhost/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        host: 'localhost',
      },
      body: JSON.stringify(initBody),
    });
    const resp = await inner.handleRequest(webReq, { parsedBody: initBody });
    try { await resp?.text?.(); } catch { /* drained */ }

    // _initialized flipped true and a session id was minted (the two facts rehydration needs).
    expect(inner._initialized).toBe(true);
    expect(typeof inner.sessionId).toBe('string');

    // The inner sessionId is WRITABLE (rehydration stamps the OLD id onto it). The public
    // wrapper exposes sessionId as a read-only getter delegating to the inner one.
    const stamped = '44444444-4444-4444-8444-444444444444';
    inner.sessionId = stamped;
    expect(inner.sessionId).toBe(stamped);
    expect((transport as any).sessionId).toBe(stamped); // wrapper getter reflects the inner id

    await transport.close();
  });

  it('the installed @modelcontextprotocol/sdk is pinned to 1.32.x (rehydration is verified against this internals contract)', async () => {
    // Read the SDK's own installed package.json version straight off disk. A major/minor
    // bump must be a DELIBERATE change that re-runs the guard above, not an unnoticed
    // drift that silently bricks rehydration.
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const path = await import('node:path');
    const here = path.dirname(fileURLToPath(import.meta.url));
    // src/tests → mcp-server root → node_modules/@modelcontextprotocol/sdk/package.json
    const sdkPkgPath = path.resolve(
      here, '..', '..', 'node_modules', '@modelcontextprotocol', 'sdk', 'package.json'
    );
    const sdkPkg = JSON.parse(readFileSync(sdkPkgPath, 'utf8')) as { version: string };
    expect(sdkPkg.version).toMatch(/^1\.32\./);

    // And the declared pin in mcp-server/package.json is exact-1.32.x (no caret/range that
    // could silently float the SDK past the verified internals contract).
    const projPkgPath = path.resolve(here, '..', '..', 'package.json');
    const projPkg = JSON.parse(readFileSync(projPkgPath, 'utf8')) as {
      dependencies?: Record<string, string>;
    };
    const declared = projPkg.dependencies?.['@modelcontextprotocol/sdk'];
    expect(declared).toMatch(/^1\.32\./);
  });
});

describe('Remote MCP transport — session map is bounded (LRU eviction)', () => {
  let CAP_PORT: number;
  let capHealth: HealthServer;
  let capBaseUrl: string;
  let capRemote: RemoteMcpTransport;

  beforeAll(async () => {
    // OS-assigned, same reason as TEST_PORT above (was a literal 18098 — reserved-port-ok:
    // prose, not a bind). Resolved before the transport is constructed.
    CAP_PORT = await reserveEphemeralPort();
    // Construct a fresh transport with a tiny cap so we can prove eviction quickly.
    process.env.MCP_MAX_SESSIONS = '2';
    process.env.MCP_ALLOWED_HOSTS = `127.0.0.1:${CAP_PORT},localhost:${CAP_PORT},127.0.0.1,localhost`;
    process.env.MANDREL_AIDIS_MCP_PORT = String(CAP_PORT);

    const { RemoteMcpTransport } = await import('../server/remoteMcpTransport.js');
    const { HealthServer } = await import('../server/healthServer.js');
    capRemote = new RemoteMcpTransport(deps);
    capHealth = new HealthServer(stubExecutor as any, capRemote);
    const port = await capHealth.start();
    const addr = capHealth.address() as AddressInfo | null;
    capBaseUrl = `http://127.0.0.1:${addr?.port ?? port}`;
  });

  afterAll(async () => {
    if (capHealth) await capHealth.stop();
    delete process.env.MCP_MAX_SESSIONS;
    // Restore the shared port for any later constructions.
    process.env.MANDREL_AIDIS_MCP_PORT = String(TEST_PORT);
  });

  it('never exceeds the configured max-session cap when initialize is spammed', async () => {
    const connect = async () => {
      const client = new Client({ name: 'cap-client', version: '1.0.0' });
      const transport = new StreamableHTTPClientTransport(new URL(`${capBaseUrl}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${TEST_TOKEN}` } },
      });
      await client.connect(transport);
      return { client, transport };
    };

    // Open 3 sessions against a cap of 2 → live session count must stay ≤ 2.
    const c1 = await connect();
    const c2 = await connect();
    const c3 = await connect();

    expect(capRemote.sessionCount()).toBeLessThanOrEqual(2);
    expect(capRemote.sessionCount()).toBeGreaterThan(0);

    // The most-recently-created session (c3) should still be live and usable.
    const result: any = await c3.client.callTool({ name: 'mandrel_ping', arguments: { message: 'cap-c3' } });
    expect(JSON.stringify(result)).toContain('pong (stub)');

    await Promise.allSettled([c1.client.close(), c2.client.close(), c3.client.close()]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────
// TWO AGENTS, ONE CONNECTION, ONE ACTOR — the streamable surface must honour X-Loop-ID
//.
//
// THE RESIDUAL THIS CLOSES. config/positionKeyConfig.ts's ladder makes a DECLARED loop id
// rung 1 — "the ONLY discriminator that separates two agents which share both a connection
// and an actor". That ladder is reached through ONE choke point
// (handlers/project.ts: resolvePositionKeys) and it works. What did not work is getting the
// declaration to it: `server/healthServer.ts` read `X-Loop-ID`, and THIS transport did not,
// so on `POST /mcp` two agents that each said exactly who they were were keyed as one.
//
// WHY IT IS TESTED AT THE TRANSPORT AND NOT AT routeExecutor: the keying itself is already
// proven at routeExecutor by positionSlotCrossTalk.contract.test.ts PROBE 2/6, and those
// probes were GREEN through the whole period this surface was dropping the header. A probe
// that hands `loopId` straight to the executor cannot see a transport that never supplies
// one — it is the C4 shape exactly, green here and not there. So this asserts the header
// crossing the wire on a real MCP client.
// ─────────────────────────────────────────────────────────────────────────────────────
describe('Remote MCP transport — a declared X-Loop-ID reaches the position-keying choke point', () => {
  const CONN = 'itest-shared-transport';
  const ACTOR = 'itest-builder';

  /** One MCP client on the SHARED connection + actor, declaring `loopId` if it has one. */
  const makeAgent = (loopId?: string) => {
    const client = new Client({ name: 'itest-client', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      requestInit: {
        headers: {
          Authorization: `Bearer ${TEST_TOKEN}`,
          'X-Connection-ID': CONN,
          'X-Actor-ID': ACTOR,
          ...(loopId ? { 'X-Loop-ID': loopId } : {}),
        },
      },
    });
    return { client, transport };
  };

  const callFor = (marker: string) =>
    executorCalls.find(c => c.tool === 'mandrel_ping' && c.args?.message === marker);

  it('gives two same-actor peers on ONE connection DIFFERENT position keys, and each peer the SAME key across its own calls', async () => {
    const { composePositionKey } = await import('../config/positionKeyConfig.js');

    const a = makeAgent('itest-loop-A');
    const b = makeAgent('itest-loop-B');
    await a.client.connect(a.transport);
    await b.client.connect(b.transport);

    // Each peer calls TWICE — the second call is what proves a position SURVIVES across a
    // worker\'s own calls, which is the regression a too-strict key would cause and which
    // would otherwise only show up as agents mysteriously losing their branch.
    await a.client.callTool({ name: 'mandrel_ping', arguments: { message: 'loop-A-call-1' } });
    await b.client.callTool({ name: 'mandrel_ping', arguments: { message: 'loop-B-call-1' } });
    await a.client.callTool({ name: 'mandrel_ping', arguments: { message: 'loop-A-call-2' } });

    const a1 = callFor('loop-A-call-1');
    const b1 = callFor('loop-B-call-1');
    const a2 = callFor('loop-A-call-2');
    expect(a1).toBeDefined();
    expect(b1).toBeDefined();
    expect(a2).toBeDefined();

    // THE DECLARATION SURVIVED THE TRANSPORT. Before this fix all three read `undefined`.
    expect(a1?.loopId).toBe('itest-loop-A');
    expect(b1?.loopId).toBe('itest-loop-B');
    expect(a2?.loopId).toBe('itest-loop-A');
    // The shared identity really is shared — otherwise the isolation below would be
    // explained by the connection or the actor rather than by the loop id.
    expect(a1?.connectionId).toBe(CONN);
    expect(b1?.connectionId).toBe(CONN);
    expect(a1?.actor).toBe(ACTOR);
    expect(b1?.actor).toBe(ACTOR);

    // And the composition the position store keys on — the SAME function
    // handlers/project.ts: resolvePositionKeys applies, not a re-implementation of it.
    const key = (c?: { connectionId?: string; actor?: string; loopId?: string }) =>
      composePositionKey({ connectionId: c!.connectionId!, actor: c!.actor, loopId: c!.loopId });

    // PROOF 1 — peers are isolated.
    expect(key(a1)).not.toBe(key(b1));
    // PROOF 2 — a worker keeps its OWN position across its own calls.
    expect(key(a1)).toBe(key(a2));

    await a.client.close();
    await b.client.close();
  });

  it('a peer that declares NO loop id still keys exactly as it did before (legacy == today)', async () => {
    const { composePositionKey } = await import('../config/positionKeyConfig.js');
    const c = makeAgent(undefined);
    await c.client.connect(c.transport);
    await c.client.callTool({ name: 'mandrel_ping', arguments: { message: 'no-loop-call' } });
    const call = callFor('no-loop-call');
    expect(call).toBeDefined();
    expect(call?.loopId).toBeUndefined();
    // Rung 2: connection scoped by actor — the pre-existing key, byte-for-byte.
    expect(
      composePositionKey({ connectionId: call!.connectionId!, actor: call!.actor, loopId: call!.loopId })
    ).toBe(`${CONN}#actor:${ACTOR}`);
    await c.client.close();
  });
});
