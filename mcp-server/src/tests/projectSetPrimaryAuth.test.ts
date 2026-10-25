/**
 * projectSetPrimaryAuth — SECURITY gate for the mcp-server's POST /api/v2/projects/:id/set-primary
 * MUTATION endpoint (sibling sweep of the session-routes auth fix / the trust-boundary change).
 *
 * Regression guard for an unauthenticated MUTATION: this route flips which project is primary for
 * every new session and was mounted on :8080 with NO auth middleware, so an anonymous caller could (reserved-port-ok: doc comment naming prod's :8080, binds nothing)
 * change prod state directly. This exercises the REAL route wired in HealthServer through the REAL
 * bearerAuth() static guard (MCP_AUTH_TOKEN) — the same mount-level pattern the /api/v2/sessions
 * family uses (714f00d). The sole legitimate caller is the Command backend (:5000), which presents (reserved-port-ok: doc comment naming prod's :5000, binds nothing)
 * MCP_AUTH_TOKEN as the INTERNAL SERVICE TOKEN via McpService.callMcpEndpoint → authHeader().
 *
 * MUTATION-PROBE: remove `bearerAuth()` from the set-primary mount in healthServer.ts and every
 * "no/blank/wrong token → 401" case below MUST fail (the un-gated route would reach its handler) —
 * that is what proves this test catches the regression.
 *
 * DB-free by design (mirrors sessionRestAuth.test.ts): AIDIS_SKIP_DATABASE=true. The guard rejects
 * BEFORE the handler/DB on the unauthorized path (deterministic 401/503); the authorized path only
 * needs to prove it PASSES the gate (status !== 401 / !== 503), not that the DB-backed mutation runs.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import * as http from 'node:http';

// vitest.setup mocks crypto with ONLY randomUUID; restore real crypto — the guard's constant-time
// compare uses createHash/timingSafeEqual (same reason bridgeAuth/sessionRestAuth tests do).
vi.unmock('crypto');
vi.unmock('node:crypto');

const TEST_ENV: Record<string, string> = {
  DATABASE_NAME: process.env.DATABASE_NAME || 'aidis_setprimaryauth_test',
  DATABASE_USER: process.env.DATABASE_USER || 'test_user',
  DATABASE_PASSWORD: process.env.DATABASE_PASSWORD || 'test_pass',
  DATABASE_HOST: process.env.DATABASE_HOST || 'localhost',
  AIDIS_SKIP_DATABASE: process.env.AIDIS_SKIP_DATABASE || 'true',
  AIDIS_SKIP_BACKGROUND: process.env.AIDIS_SKIP_BACKGROUND || 'true',
  AIDIS_SKIP_STDIO: process.env.AIDIS_SKIP_STDIO || 'true',
};

type HealthServerCtor = typeof import('@/server/healthServer').HealthServer;

const STATIC_TOKEN = 'test-internal-mcp-service-token-setprimary';
const UUID = '22222222-2222-4222-8222-222222222222';
const PATH = `/api/v2/projects/${UUID}/set-primary`;

describe('mcp-server POST /api/v2/projects/:id/set-primary auth gate', () => {
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    for (const [key, value] of Object.entries(TEST_ENV)) vi.stubEnv(key, value);

    const { HealthServer } = (await import('@/server/healthServer')) as { HealthServer: HealthServerCtor };
    const health = new HealthServer(async () => ({ content: [{ type: 'text', text: 'ok' }] }));
    const app = (health as unknown as { app: import('express').Application }).app;
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
      vi.unstubAllEnvs();
    }
  });

  afterEach(() => {
    delete process.env.MCP_AUTH_TOKEN;
  });

  const post = (headers: Record<string, string> = {}) =>
    fetch(`${baseUrl}${PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({}),
    });

  describe('UNAUTHENTICATED → 401 (the anon mutation is closed)', () => {
    it('NO Authorization header → 401', async () => {
      process.env.MCP_AUTH_TOKEN = STATIC_TOKEN;
      const res = await post();
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error.message).toMatch(/missing Bearer token/i);
    });

    it('WRONG Bearer token → 401', async () => {
      process.env.MCP_AUTH_TOKEN = STATIC_TOKEN;
      const res = await post({ Authorization: 'Bearer not-the-service-token' });
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error.message).toMatch(/invalid Bearer token/i);
    });

    it('BLANK Bearer token → 401 (treated as missing)', async () => {
      process.env.MCP_AUTH_TOKEN = STATIC_TOKEN;
      const res = await post({ Authorization: 'Bearer ' });
      expect(res.status).toBe(401);
    });
  });

  describe('AUTHORIZED → passes the gate (NOT 401)', () => {
    it('valid service token → reaches the handler (not the auth rejection)', async () => {
      process.env.MCP_AUTH_TOKEN = STATIC_TOKEN;
      const res = await post({ Authorization: `Bearer ${STATIC_TOKEN}` });
      // The DB-backed handler may 200/400/500 (no live DB), but it must NOT be the auth
      // rejection (401) nor the "server misconfigured" fail-closed (503) — the guard let it through.
      expect(res.status).not.toBe(401);
      expect(res.status).not.toBe(503);
    });
  });

  describe('FAIL-CLOSED — server has no token configured', () => {
    it('MCP_AUTH_TOKEN unset → 503, never open', async () => {
      delete process.env.MCP_AUTH_TOKEN;
      const res = await post({ Authorization: `Bearer ${STATIC_TOKEN}` });
      expect(res.status).toBe(503);
    });
  });
});
