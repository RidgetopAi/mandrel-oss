/**
 * bridgeAuth — SECURITY interim shield (an earlier task PHASE 1; default flipped fail-CLOSED in
 * PHASE 2) integration tests.
 *
 * Exercises the REAL bridge routes wired in HealthServer (GET /mcp/tools,
 * GET /mcp/tools/schemas, POST /mcp/tools/:toolName) through the REAL bridgeAuth() guard.
 * The guard reads MCP_BRIDGE_AUTH_ENABLED + the secrets at CALL time, so a single server
 * instance is reused and env is flipped per test.
 *
 * NOTE: the suite-wide baseline sets MCP_BRIDGE_AUTH_ENABLED='false' in
 * vitest.setup.ts (so the many tool-surface tests can run un-credentialled). This file drives
 * BOTH postures explicitly:
 *   - DEFAULT (flag UNSET) → ENFORCE — deletes the flag so the guard reads the flipped
 *     production default (fail-CLOSED): no credential → 401. This is the regression that proves
 *     the default flip is real (against pre-flip code it would 200).
 *   - EXPLICITLY DISABLED (flag='false') → pass-through — the byte-identical opt-out.
 * afterEach restores the flag to the 'false' baseline so the env-leak guard stays satisfied.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import * as http from 'node:http';

// vitest.setup mocks crypto with ONLY randomUUID; restore real crypto — both the guard's
// verifyCommandJwt and this file's HS256 test-signer need a real createHmac.
vi.unmock('crypto');
vi.unmock('node:crypto');

import { createHmac } from 'node:crypto';

// DB-free harness (mirrors httpContract.test.ts). Stubbed in beforeAll (NOT at module
// scope) and restored in afterAll. HealthServer is imported DYNAMICALLY in
// beforeAll, so the stubs still land before any module-eval read.
const TEST_ENV: Record<string, string> = {
  DATABASE_NAME: process.env.DATABASE_NAME || 'aidis_bridgeauth_test',
  DATABASE_USER: process.env.DATABASE_USER || 'test_user',
  DATABASE_PASSWORD: process.env.DATABASE_PASSWORD || 'test_pass',
  DATABASE_HOST: process.env.DATABASE_HOST || 'localhost',
  AIDIS_SKIP_DATABASE: process.env.AIDIS_SKIP_DATABASE || 'true',
  AIDIS_SKIP_BACKGROUND: process.env.AIDIS_SKIP_BACKGROUND || 'true',
  AIDIS_SKIP_STDIO: process.env.AIDIS_SKIP_STDIO || 'true',
};

// HealthServer is imported DYNAMICALLY in beforeAll (below): a static import is ESM-hoisted
// ABOVE the env setup above, and its transitive config/database.ts throws when DATABASE_NAME
// is unset at import time. Deferring the import lets the env be in place first.
type HealthServerCtor = typeof import('@/server/healthServer').HealthServer;

/** Sign an HS256 JWT the same way mandrel-command AuthService does (jsonwebtoken HS256). */
function signHs256(payload: Record<string, unknown>, secret: string): string {
  const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const signingInput = `${enc({ alg: 'HS256', typ: 'JWT' })}.${enc(payload)}`;
  const sig = createHmac('sha256', secret).update(signingInput).digest('base64url');
  return `${signingInput}.${sig}`;
}

/** Build an `alg: "none"` token (classic bypass attempt) — must be REJECTED. */
function makeAlgNoneToken(payload: Record<string, unknown>): string {
  const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${enc({ alg: 'none', typ: 'JWT' })}.${enc(payload)}.`;
}

const STATIC_TOKEN = 'test-static-bridge-token-abc123';
const JWT_SECRET = 'test-command-jwt-secret-xyz789';
const nowSec = () => Math.floor(Date.now() / 1000);

describe('bridgeAuth — on-box /mcp/tools/* gate', () => {
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    // MUST precede the dynamic import below (config/database module-eval reads these).
    for (const [key, value] of Object.entries(TEST_ENV)) vi.stubEnv(key, value);

    const { HealthServer } = (await import('@/server/healthServer')) as { HealthServer: HealthServerCtor };
    const health = new HealthServer(
      // Mock tool executor — the POST handler wraps this in { success, result }.
      async (_toolName: string, _args: unknown) => ({ content: [{ type: 'text', text: 'ok' }] }),
    );
    const app = (health as any).app as import('express').Application;
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    try {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    } finally {
      // Leave process.env exactly as this file found it.
      vi.unstubAllEnvs();
    }
  });

  afterEach(() => {
    // Reset every knob the guard reads so tests don't bleed into each other. Restore the flag
    // to the suite-wide 'false' baseline set in vitest.setup.ts (NOT delete) — the env-leak
    // guard snapshots that baseline, so a bare delete would trip it.
    process.env.MCP_BRIDGE_AUTH_ENABLED = 'false';
    delete process.env.MCP_AUTH_TOKEN;
    delete process.env.MANDREL_JWT_SECRET;
  });

  const get = (path: string, headers: Record<string, string> = {}) =>
    fetch(`${baseUrl}${path}`, { method: 'GET', headers });
  const postTool = (tool: string, headers: Record<string, string> = {}) =>
    fetch(`${baseUrl}/mcp/tools/${tool}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ arguments: {} }),
    });

  describe('DEFAULT (flag UNSET) — fail-CLOSED: enforcement is ON by default', () => {
    // The flipped production default lives here: with MCP_BRIDGE_AUTH_ENABLED UNSET the guard
    // ENFORCES. Against pre-flip code (default pass-through) each of these would 200 → that is
    // the mutation this suite catches.
    it('GET /mcp/tools with NO credential → 401 (was 200 pre-flip)', async () => {
      delete process.env.MCP_BRIDGE_AUTH_ENABLED; // the true production default
      process.env.MCP_AUTH_TOKEN = STATIC_TOKEN; // a credential source IS configured
      const res = await get('/mcp/tools');
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error.message).toMatch(/missing Bearer token/i);
    });

    it('POST /mcp/tools/:toolName with NO credential → 401', async () => {
      delete process.env.MCP_BRIDGE_AUTH_ENABLED;
      process.env.MCP_AUTH_TOKEN = STATIC_TOKEN;
      const res = await postTool('mandrel_ping');
      expect(res.status).toBe(401);
    });

    it('a VALID static token → passes (200) even with the flag unset', async () => {
      delete process.env.MCP_BRIDGE_AUTH_ENABLED;
      process.env.MCP_AUTH_TOKEN = STATIC_TOKEN;
      const res = await get('/mcp/tools', { Authorization: `Bearer ${STATIC_TOKEN}` });
      expect(res.status).toBe(200);
    });

    it('flag unset AND no credential source configured → 503 fail-closed (never open)', async () => {
      delete process.env.MCP_BRIDGE_AUTH_ENABLED;
      // MCP_AUTH_TOKEN + MANDREL_JWT_SECRET both unset, OAuth disabled by default.
      const res = await get('/mcp/tools', { Authorization: `Bearer ${STATIC_TOKEN}` });
      expect(res.status).toBe(503);
    });
  });

  describe('EXPLICITLY DISABLED (MCP_BRIDGE_AUTH_ENABLED=false) — opt-out pass-through', () => {
    it('GET /mcp/tools serves WITHOUT a credential (200, tool list, no auth header)', async () => {
      process.env.MCP_BRIDGE_AUTH_ENABLED = 'false';
      const res = await get('/mcp/tools');
      expect(res.status).toBe(200);
      expect(res.headers.get('www-authenticate')).toBeNull();
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(Array.isArray(body.tools)).toBe(true);
    });

    it('GET /mcp/tools/schemas serves WITHOUT a credential (200)', async () => {
      process.env.MCP_BRIDGE_AUTH_ENABLED = 'false';
      const res = await get('/mcp/tools/schemas');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
    });

    it('POST /mcp/tools/:toolName serves WITHOUT a credential (200)', async () => {
      process.env.MCP_BRIDGE_AUTH_ENABLED = 'false';
      const res = await postTool('mandrel_ping');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
    });

    it('is unaffected even when a static token IS configured (flag explicitly off)', async () => {
      process.env.MCP_BRIDGE_AUTH_ENABLED = 'false';
      process.env.MCP_AUTH_TOKEN = STATIC_TOKEN;
      const res = await postTool('mandrel_ping'); // no Authorization header
      expect(res.status).toBe(200);
    });
  });

  describe('flag ON — enforcement', () => {
    it('no credential → 401', async () => {
      process.env.MCP_BRIDGE_AUTH_ENABLED = 'true';
      process.env.MCP_AUTH_TOKEN = STATIC_TOKEN;
      const res = await get('/mcp/tools');
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error.message).toMatch(/missing Bearer token/i);
    });

    it('valid static MCP_AUTH_TOKEN → passes (200)', async () => {
      process.env.MCP_BRIDGE_AUTH_ENABLED = 'true';
      process.env.MCP_AUTH_TOKEN = STATIC_TOKEN;
      const res = await get('/mcp/tools', { Authorization: `Bearer ${STATIC_TOKEN}` });
      expect(res.status).toBe(200);
    });

    it('valid HS256 command login JWT (MANDREL_JWT_SECRET) → passes (200)', async () => {
      process.env.MCP_BRIDGE_AUTH_ENABLED = 'true';
      process.env.MANDREL_JWT_SECRET = JWT_SECRET;
      const jwt = signHs256({ userId: 'u1', username: 'operator', exp: nowSec() + 3600 }, JWT_SECRET);
      const res = await postTool('mandrel_ping', { Authorization: `Bearer ${jwt}` });
      expect(res.status).toBe(200);
    });

    it('static token AND jwt secret both set — either credential works', async () => {
      process.env.MCP_BRIDGE_AUTH_ENABLED = 'true';
      process.env.MCP_AUTH_TOKEN = STATIC_TOKEN;
      process.env.MANDREL_JWT_SECRET = JWT_SECRET;
      const jwt = signHs256({ username: 'operator', exp: nowSec() + 3600 }, JWT_SECRET);
      expect((await get('/mcp/tools', { Authorization: `Bearer ${STATIC_TOKEN}` })).status).toBe(200);
      expect((await get('/mcp/tools', { Authorization: `Bearer ${jwt}` })).status).toBe(200);
    });

    it('garbage token → 401', async () => {
      process.env.MCP_BRIDGE_AUTH_ENABLED = 'true';
      process.env.MCP_AUTH_TOKEN = STATIC_TOKEN;
      process.env.MANDREL_JWT_SECRET = JWT_SECRET;
      const res = await get('/mcp/tools', { Authorization: 'Bearer not-a-real-token' });
      expect(res.status).toBe(401);
    });

    it('JWT signed with the WRONG secret → 401', async () => {
      process.env.MCP_BRIDGE_AUTH_ENABLED = 'true';
      process.env.MANDREL_JWT_SECRET = JWT_SECRET;
      const forged = signHs256({ username: 'attacker', exp: nowSec() + 3600 }, 'wrong-secret');
      const res = await postTool('mandrel_ping', { Authorization: `Bearer ${forged}` });
      expect(res.status).toBe(401);
    });

    it('EXPIRED but correctly-signed JWT → 401', async () => {
      process.env.MCP_BRIDGE_AUTH_ENABLED = 'true';
      process.env.MANDREL_JWT_SECRET = JWT_SECRET;
      const expired = signHs256({ username: 'operator', exp: nowSec() - 10 }, JWT_SECRET);
      const res = await postTool('mandrel_ping', { Authorization: `Bearer ${expired}` });
      expect(res.status).toBe(401);
    });

    it('alg:"none" token (bypass attempt) → 401', async () => {
      process.env.MCP_BRIDGE_AUTH_ENABLED = 'true';
      process.env.MANDREL_JWT_SECRET = JWT_SECRET;
      const bypass = makeAlgNoneToken({ username: 'attacker', exp: nowSec() + 3600 });
      const res = await postTool('mandrel_ping', { Authorization: `Bearer ${bypass}` });
      expect(res.status).toBe(401);
    });

    it('flag ON but NO credential source configured → 503 fail-closed (never open)', async () => {
      process.env.MCP_BRIDGE_AUTH_ENABLED = 'true';
      // MCP_AUTH_TOKEN + MANDREL_JWT_SECRET both unset, OAuth disabled by default.
      const res = await get('/mcp/tools', { Authorization: `Bearer ${STATIC_TOKEN}` });
      expect(res.status).toBe(503);
    });
  });
});
