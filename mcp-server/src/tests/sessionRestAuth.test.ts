/**
 * sessionRestAuth — SECURITY gate for the mcp-server's /api/v2/sessions/* REST family
 * (an earlier task / the trust-boundary change).
 *
 * Regression guard for a LIVE exposure: the mcp-server's own `/api/v2/sessions/*` REST
 * endpoints (:8080) served + mutated real session data to UNAUTHENTICATED callers on the (reserved-port-ok: doc comment naming prod's :8080, binds nothing)
 * public internet — both via an nginx bypass on command.example.com and directly on
 * mandrel.example.com — because the router was mounted with NO auth middleware.
 *
 * This exercises the REAL routes wired in HealthServer through the REAL bearerAuth() static
 * guard (MCP_AUTH_TOKEN), the sole trust-boundary crossing from the Command backend (:5000, (reserved-port-ok: doc comment naming prod's :5000, binds nothing)
 * authenticates the USER) into this mcp-server (:8080, presented the INTERNAL SERVICE TOKEN). (reserved-port-ok: doc comment naming prod's :8080, binds nothing)
 * The guard reads MCP_AUTH_TOKEN at CALL time, so one server instance is reused and env is
 * flipped per test.
 *
 * MUTATION-PROBE: remove `bearerAuth()` from the `/api/v2/sessions` mount in healthServer.ts
 * and every "no/blank/wrong token → 401" case below MUST fail (the un-gated router would let
 * the request through to its handler) — that is what proves these tests catch the regression.
 *
 * DB-free by design (mirrors bridgeAuth.test.ts): AIDIS_SKIP_DATABASE=true. The guard rejects
 * BEFORE any handler/DB is reached on the unauthorized path (deterministic 401); the authorized
 * path only needs to prove it PASSES the gate (status !== 401 and no auth-rejection body), not
 * that the DB-backed handler returns clean data.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import * as http from 'node:http';

// vitest.setup mocks crypto with ONLY randomUUID; restore real crypto — the guard's
// constant-time compare uses createHash/timingSafeEqual (same reason bridgeAuth.test.ts does).
vi.unmock('crypto');
vi.unmock('node:crypto');

// DB-free harness (mirrors bridgeAuth.test.ts / httpContract.test.ts). Stubbed in beforeAll
// (NOT at module scope) and restored in afterAll. HealthServer is imported DYNAMICALLY in
// beforeAll so the stubs land before any module-eval read.
const TEST_ENV: Record<string, string> = {
  DATABASE_NAME: process.env.DATABASE_NAME || 'aidis_sessionrestauth_test',
  DATABASE_USER: process.env.DATABASE_USER || 'test_user',
  DATABASE_PASSWORD: process.env.DATABASE_PASSWORD || 'test_pass',
  DATABASE_HOST: process.env.DATABASE_HOST || 'localhost',
  AIDIS_SKIP_DATABASE: process.env.AIDIS_SKIP_DATABASE || 'true',
  AIDIS_SKIP_BACKGROUND: process.env.AIDIS_SKIP_BACKGROUND || 'true',
  AIDIS_SKIP_STDIO: process.env.AIDIS_SKIP_STDIO || 'true',
};

type HealthServerCtor = typeof import('@/server/healthServer').HealthServer;

const STATIC_TOKEN = 'test-internal-mcp-service-token-abc123';
const UUID = '11111111-1111-4111-8111-111111111111';

// Every /api/v2/sessions sub-route enumerated from api/v2/sessionRoutes.ts — the full family
// the ONE mount-level guard must cover (list, active, stats, compare, start, :id, activities
// GET+POST, files GET+POST, sync-files, productivity, end).
const ROUTES: Array<{ name: string; method: 'get' | 'post'; path: string }> = [
  { name: 'GET  /api/v2/sessions (list)', method: 'get', path: '/api/v2/sessions' },
  { name: 'GET  /api/v2/sessions/active', method: 'get', path: '/api/v2/sessions/active' },
  { name: 'GET  /api/v2/sessions/stats', method: 'get', path: '/api/v2/sessions/stats' },
  { name: 'GET  /api/v2/sessions/compare', method: 'get', path: '/api/v2/sessions/compare' },
  { name: 'POST /api/v2/sessions/start', method: 'post', path: '/api/v2/sessions/start' },
  { name: 'GET  /api/v2/sessions/:id', method: 'get', path: `/api/v2/sessions/${UUID}` },
  { name: 'GET  /api/v2/sessions/:id/activities', method: 'get', path: `/api/v2/sessions/${UUID}/activities` },
  { name: 'POST /api/v2/sessions/:id/activities', method: 'post', path: `/api/v2/sessions/${UUID}/activities` },
  { name: 'GET  /api/v2/sessions/:id/files', method: 'get', path: `/api/v2/sessions/${UUID}/files` },
  { name: 'POST /api/v2/sessions/:id/files', method: 'post', path: `/api/v2/sessions/${UUID}/files` },
  { name: 'POST /api/v2/sessions/:id/sync-files', method: 'post', path: `/api/v2/sessions/${UUID}/sync-files` },
  { name: 'POST /api/v2/sessions/:id/productivity', method: 'post', path: `/api/v2/sessions/${UUID}/productivity` },
  { name: 'POST /api/v2/sessions/:id/end', method: 'post', path: `/api/v2/sessions/${UUID}/end` },
];

describe('mcp-server /api/v2/sessions REST gate', () => {
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

  const call = (
    method: 'get' | 'post',
    path: string,
    headers: Record<string, string> = {},
  ) =>
    fetch(`${baseUrl}${path}`, {
      method: method.toUpperCase(),
      headers:
        method === 'post' ? { 'Content-Type': 'application/json', ...headers } : headers,
      body: method === 'post' ? JSON.stringify({}) : undefined,
    });

  describe('UNAUTHENTICATED → 401 (the exposure is closed)', () => {
    it.each(ROUTES)('$name → 401 with NO Authorization header', async ({ method, path }) => {
      process.env.MCP_AUTH_TOKEN = STATIC_TOKEN; // guard configured; caller presents nothing
      const res = await call(method, path);
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error.message).toMatch(/missing Bearer token/i);
    });

    it.each(ROUTES)('$name → 401 with a WRONG Bearer token', async ({ method, path }) => {
      process.env.MCP_AUTH_TOKEN = STATIC_TOKEN;
      const res = await call(method, path, { Authorization: 'Bearer not-the-service-token' });
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error.message).toMatch(/invalid Bearer token/i);
    });

    it('a BLANK Bearer token → 401 (treated as missing)', async () => {
      process.env.MCP_AUTH_TOKEN = STATIC_TOKEN;
      const res = await call('get', '/api/v2/sessions', { Authorization: 'Bearer ' });
      expect(res.status).toBe(401);
    });
  });

  describe('AUTHORIZED → passes the gate (NOT 401)', () => {
    it.each(ROUTES)('$name → reaches its handler with the valid service token', async ({ method, path }) => {
      process.env.MCP_AUTH_TOKEN = STATIC_TOKEN;
      const res = await call(method, path, { Authorization: `Bearer ${STATIC_TOKEN}` });
      // The DB-backed handler may 200/400/500 (no live DB), but it must NOT be the auth
      // rejection — the guard let the request through.
      expect(res.status).not.toBe(401);
      expect(res.status).not.toBe(503); // not the "server misconfigured" fail-closed either
    });
  });

  describe('FAIL-CLOSED — server has no token configured', () => {
    it('MCP_AUTH_TOKEN unset → 503, never open (even for a would-be caller)', async () => {
      delete process.env.MCP_AUTH_TOKEN;
      const res = await call('get', '/api/v2/sessions', { Authorization: `Bearer ${STATIC_TOKEN}` });
      expect(res.status).toBe(503);
    });
  });
});
