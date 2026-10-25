/**
 * sessionsProxyToken.test.ts — SECURITY: the Command backend presents the INTERNAL SERVICE
 * TOKEN on every proxied call to the mcp-server's now-gated /api/v2/sessions/* family
 * (an earlier task / the trust-boundary change).
 *
 * The trust boundary: the Command backend (:5000) authenticates the USER (JWT), then proxies (reserved-port-ok: doc comment naming prod's :5000, binds nothing)
 * to the mcp-server (:8080) which requires the internal service token (MCP_AUTH_TOKEN). This (reserved-port-ok: doc comment naming prod's :8080, binds nothing)
 * proves the SECOND leg — every outbound fetch from sessionsProxy.ts to the mcp-server carries
 * `Authorization: Bearer <MCP_AUTH_TOKEN>`. Without it, the mcp-server gate returns 401 and the
 * Command UI's session views break.
 *
 * MUTATION-PROBE: drop `...McpService.authHeader()` from mcpProxyHeaders() in sessionsProxy.ts
 * (or unset MCP_AUTH_TOKEN) and every assertion below MUST fail — that is what proves the test
 * catches a regression.
 *
 * DB-free: AuthService (the gate's DB calls) and global fetch (the mcp-server) are mocked, so
 * this is a pure outbound-header contract test. The token is set BEFORE requiring sessionsProxy
 * so config/environment (config.mcp.authToken ← MCP_AUTH_TOKEN) loads it.
 */

import request from 'supertest';
import express, { Express } from 'express';

// A structurally-valid JWT (3 segments) so the REAL authenticateToken reaches AuthService.verifyJWT.
const VALID_TOKEN = 'aaa.bbb.ccc';
// The internal service token this backend must present to the mcp-server.
const SERVICE_TOKEN = 'test-internal-mcp-service-token-9f8e7d';

// Mock the middleware's DB internals so the REAL authenticateToken runs end-to-end.
jest.mock('../services/auth', () => ({
  AuthService: {
    verifyJWT: (token: string) =>
      token === VALID_TOKEN ? { userId: 'user-1', tokenId: 'token-1' } : null,
    validateSession: async () => true,
    findUserById: async () => ({
      id: 'user-1',
      username: 'coordinator',
      email: 'coordinator@example.com',
      role: 'admin',
      theme: 'dark',
      is_active: true,
      created_at: new Date(),
      updated_at: new Date(),
    }),
  },
}));

// Capture every outbound fetch to the mcp-server; return a benign 200 so the proxy resolves.
const mockFetch = jest.fn(async () => ({
  status: 200,
  ok: true,
  json: async () => ({ success: true, data: {} }),
}));

// Each proxy route that fetches the mcp-server (NOT /current, which is served by the
// controller and does not proxy). UUID keeps validateUUIDParam (runs AFTER auth) happy.
const UUID = '11111111-1111-4111-8111-111111111111';
const PROXY_ROUTES: Array<{ name: string; method: 'get' | 'post'; path: string; mcpPathPart: string }> = [
  { name: 'GET  /api/v2/sessions (list)', method: 'get', path: '/api/v2/sessions', mcpPathPart: '/api/v2/sessions' },
  { name: 'GET  /api/v2/sessions/active', method: 'get', path: '/api/v2/sessions/active', mcpPathPart: '/api/v2/sessions/active' },
  { name: 'POST /api/v2/sessions/start', method: 'post', path: '/api/v2/sessions/start', mcpPathPart: '/api/v2/sessions/start' },
  { name: 'GET  /api/v2/sessions/:id/files', method: 'get', path: `/api/v2/sessions/${UUID}/files`, mcpPathPart: `/${UUID}/files` },
  { name: 'POST /api/v2/sessions/:id/sync-files', method: 'post', path: `/api/v2/sessions/${UUID}/sync-files`, mcpPathPart: `/${UUID}/sync-files` },
  { name: 'POST /api/v2/sessions/:id/end', method: 'post', path: `/api/v2/sessions/${UUID}/end`, mcpPathPart: `/${UUID}/end` },
];

let app: Express;

beforeAll(() => {
  // MUST precede the require() below: config/environment reads MCP_AUTH_TOKEN at module eval,
  // and McpService.authHeader() reads config.mcp.authToken.
  process.env.MCP_AUTH_TOKEN = SERVICE_TOKEN;
  delete process.env.ALLOW_DEV_AUTH_BYPASS;
  process.env.NODE_ENV = 'test';

  (global as unknown as { fetch: unknown }).fetch = mockFetch;

  // Lazy require so the env above is in place before config/environment evaluates.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const sessionRoutesV2 = require('../routes/sessionsProxy').default;

  app = express();
  app.use(express.json());
  app.use('/api/v2/sessions', sessionRoutesV2);
});

beforeEach(() => mockFetch.mockClear());

describe('sessionsProxy — presents the internal service token to the mcp-server', () => {
  it.each(PROXY_ROUTES)(
    '$name → outbound fetch carries Authorization: Bearer <MCP_AUTH_TOKEN>',
    async ({ method, path, mcpPathPart }) => {
      const res = await request(app)[method](path).set('Authorization', `Bearer ${VALID_TOKEN}`).send({});
      // The user-JWT gate passed (not blocked).
      expect(res.status).not.toBe(401);

      // Exactly one outbound call to the mcp-server, to the right path, WITH the service token.
      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, init] = mockFetch.mock.calls[0] as unknown as [string, RequestInit];
      expect(String(url)).toContain(mcpPathPart);
      const headers = init.headers as Record<string, string>;
      expect(headers.Authorization).toBe(`Bearer ${SERVICE_TOKEN}`);
    },
  );

  it('POST /start ALSO forwards the authenticated user as X-Actor-ID alongside the service token', async () => {
    await request(app).post('/api/v2/sessions/start').set('Authorization', `Bearer ${VALID_TOKEN}`).send({});
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [, init] = mockFetch.mock.calls[0] as unknown as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${SERVICE_TOKEN}`); // service token still present
    expect(headers['X-Actor-ID']).toBe('coordinator'); // and the attributed human
  });
});
