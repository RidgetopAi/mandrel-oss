/**
 * `X-Loop-ID` REACHES THE EXECUTOR — the transport half of an earlier task.
 *
 * config/positionKeyConfig.ts makes a DECLARED loop id the strongest rung of position
 * keying, and positionSlotCrossTalk.contract.test.ts proves the keying honours it. Neither
 * of those proves a client can actually DECLARE one: they drive routeExecutor directly.
 * Without this file the strongest rung would be a rule about a field no HTTP caller can
 * set — a guard for something unreachable.
 *
 * SCOPE, STATED RATHER THAN IMPLIED: this covers the FLAT `/mcp/tools/*` surface only,
 * which is deliberately the whole population that needs it. That is the surface the Claude
 * Code stdio bridges POST to, and the one where nine agents share one declared
 * `X-Connection-ID`. The streamable `/mcp` transport keys on its per-client SDK session id,
 * so two clients there never share a slot to begin with, and it is left untouched.
 *
 * DB-free harness (mirrors healthServerActor.unit.test.ts): env stubbed in beforeAll,
 * HealthServer imported dynamically so config/database module-eval sees the env.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import * as http from 'node:http';

import type { McpExecutorContext } from '@/server/healthServer';

const TEST_ENV: Record<string, string> = {
  DATABASE_NAME: process.env.DATABASE_NAME || 'aidis_loopheader_test',
  DATABASE_USER: process.env.DATABASE_USER || 'test_user',
  DATABASE_PASSWORD: process.env.DATABASE_PASSWORD || 'test_pass',
  DATABASE_HOST: process.env.DATABASE_HOST || 'localhost',
  AIDIS_SKIP_DATABASE: process.env.AIDIS_SKIP_DATABASE || 'true',
  AIDIS_SKIP_BACKGROUND: process.env.AIDIS_SKIP_BACKGROUND || 'true',
  AIDIS_SKIP_STDIO: process.env.AIDIS_SKIP_STDIO || 'true',
};

type HealthServerCtor = typeof import('@/server/healthServer').HealthServer;

describe('POST /mcp/tools/:toolName carries the declared agent loop id', () => {
  let server: http.Server;
  let baseUrl: string;
  let capturedContext: McpExecutorContext | undefined;

  beforeAll(async () => {
    for (const [key, value] of Object.entries(TEST_ENV)) vi.stubEnv(key, value);
    const { HealthServer } = (await import('@/server/healthServer')) as { HealthServer: HealthServerCtor };
    const health: any = new HealthServer(
      async (_toolName: string, _args: unknown, context?: McpExecutorContext) => {
        capturedContext = context;
        return { content: [{ type: 'text', text: 'ok' }] };
      }
    );
    server = http.createServer(health.app as import('express').Application);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const addr = server.address();
    baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  });

  afterAll(async () => {
    try {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    } finally {
      vi.unstubAllEnvs();
    }
  });

  afterEach(() => {
    capturedContext = undefined;
    process.env.MCP_BRIDGE_AUTH_ENABLED = 'false';
  });

  const postTool = (headers: Record<string, string> = {}) =>
    fetch(`${baseUrl}/mcp/tools/mandrel_ping`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ arguments: {} }),
    });

  it('a declared X-Loop-ID arrives on the executor context verbatim', async () => {
    process.env.MCP_BRIDGE_AUTH_ENABLED = 'false';
    const res = await postTool({ 'X-Connection-ID': 'shared-bridge', 'X-Loop-ID': 'builder-04a4f00d' });
    expect(res.status).toBe(200);
    expect(capturedContext?.loopId).toBe('builder-04a4f00d');
    // …and it does NOT quietly rewrite the connection identity, which stays the transport's.
    expect(capturedContext?.connectionId).toBe('shared-bridge');
  });

  it('TWO agents on ONE connection arrive as TWO distinct loops', async () => {
    process.env.MCP_BRIDGE_AUTH_ENABLED = 'false';
    await postTool({ 'X-Connection-ID': 'shared-bridge', 'X-Loop-ID': 'agent-a' });
    const first = capturedContext?.loopId;
    await postTool({ 'X-Connection-ID': 'shared-bridge', 'X-Loop-ID': 'agent-b' });
    expect(first).toBe('agent-a');
    expect(capturedContext?.loopId).toBe('agent-b');
  });

  it('no X-Loop-ID → undefined, so keying falls back exactly as it did before', async () => {
    process.env.MCP_BRIDGE_AUTH_ENABLED = 'false';
    const res = await postTool({ 'X-Connection-ID': 'shared-bridge' });
    expect(res.status).toBe(200);
    expect(capturedContext?.loopId).toBeUndefined();
  });
});
