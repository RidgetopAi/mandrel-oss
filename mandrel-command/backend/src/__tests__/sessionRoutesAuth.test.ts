/**
 * sessionRoutesAuth.test.ts — SECURITY gate for the session read/lifecycle surface
 *.
 *
 * Regression guard for the exposure: `GET /api/v2/sessions*` (and the legacy
 * `/api/sessions/current`) returned real session data (id, display_id, project_name,
 * timestamps, modified files) to UNAUTHENTICATED callers from the public internet,
 * because those routes were mounted with NO auth middleware. This proves EVERY
 * `/api/v2/sessions/*` sub-route — plus the legacy `/api/sessions/current` hole —
 * now:
 *   • returns 401 with NO / a malformed Authorization header, and
 *   • passes the gate (reaches its handler) with a valid credential.
 *
 * It exercises the REAL `authenticateToken` middleware and the REAL production routers
 * (`routes/sessionsProxy.ts` for the `/v2/sessions/*` family + `routes/sessions.ts` for
 * the legacy surface), mounted exactly as routes/index.ts mounts them. So the guard the
 * test actually depends on is `router.use(authenticateToken)` at the top of
 * sessionsProxy.ts (and the `authenticateToken` arg on the legacy `/current` route).
 * MUTATION-PROBE: delete either and the 401 cases below MUST fail — that is what proves
 * they can catch a regression.
 *
 * DB-free by design: `AuthService` (the middleware's DB calls), `SessionController` (the
 * handlers), and global `fetch` (the mcp-server proxies) are mocked so this is a pure
 * route-auth contract test — deterministic, no live Postgres / mcp-server needed.
 */

import request from 'supertest';
import express, { Express, Request, Response } from 'express';

// A structurally-valid JWT string (3 dot-separated segments) so the middleware's
// format checks pass and it reaches AuthService.verifyJWT (which we mock below).
const VALID_TOKEN = 'aaa.bbb.ccc';

// --- Mock the middleware's DB-touching internals so the REAL authenticateToken runs
//     end-to-end but resolves deterministically. verifyJWT accepts only VALID_TOKEN. ---
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

// --- Mock the controllers so the authorized path returns 200 without a DB. Every
//     handler referenced by routes/index.ts + routes/sessions.ts is a 200 stub. ---
const okHandler = (_req: Request, res: Response) => res.status(200).json({ success: true });
jest.mock('../controllers/session', () => ({
  SessionController: {
    getCurrentSession: okHandler,
    getSessionStats: okHandler,
    getSessionsList: okHandler,
    getSessionAnalytics: okHandler,
    getSessionTrends: okHandler,
    getContextsByActor: okHandler,
    getProductiveSessions: okHandler,
    getTokenUsagePatterns: okHandler,
    getSessionSummaries: okHandler,
    getSessionStatsByPeriod: okHandler,
    assignCurrentSession: okHandler,
    updateSession: okHandler,
    getSessionDetail: okHandler,
  },
}));

// The REAL production routers. Mounted below exactly as routes/index.ts mounts them
// (`/v2/sessions` → sessionsProxy, `/sessions` → sessions), both under `/api`. These
// two modules are light (controller + auth + validation) and jest-resolvable, unlike
// the full routes/index.ts aggregator (which pulls the embedding tree).
import sessionRoutesV2 from '../routes/sessionsProxy';
import sessionRoutes from '../routes/sessions';

// A valid UUID for the parameterized :sessionId routes (so validateUUIDParam — which
// runs AFTER auth — does not 400 before the handler on the authorized path).
const UUID = '11111111-1111-4111-8111-111111111111';

// The v2 proxy handlers call global fetch() to the mcp-server; stub a 200 so the
// authorized path returns 200 instead of a 503 (mcp-server absent in the test env).
const mockFetch = jest.fn(async () => ({
  status: 200,
  ok: true,
  json: async () => ({ success: true, data: {} }),
}));

let app: Express;

beforeAll(() => {
  // Belt-and-suspenders: the middleware's dev bypass needs BOTH of these; make sure
  // neither is set so "no token → 401" is the behavior under test.
  delete process.env.ALLOW_DEV_AUTH_BYPASS;
  process.env.NODE_ENV = 'test';

  (global as unknown as { fetch: unknown }).fetch = mockFetch;

  app = express();
  app.use(express.json());
  app.use('/api/v2/sessions', sessionRoutesV2);
  app.use('/api/sessions', sessionRoutes);
});

beforeEach(() => mockFetch.mockClear());

// Every session sub-route that returns real session data. `authed` is the header set
// used to prove the gate is passable; the SAME route with no header must be 401.
const routes: Array<{ name: string; method: 'get' | 'post'; path: string }> = [
  // --- /api/v2/sessions/* family (routes/index.ts) ---
  { name: 'GET  /api/v2/sessions/current', method: 'get', path: '/api/v2/sessions/current' },
  { name: 'GET  /api/v2/sessions (list)', method: 'get', path: '/api/v2/sessions' },
  { name: 'GET  /api/v2/sessions/active', method: 'get', path: '/api/v2/sessions/active' },
  { name: 'POST /api/v2/sessions/start', method: 'post', path: '/api/v2/sessions/start' },
  { name: `GET  /api/v2/sessions/:id/files`, method: 'get', path: `/api/v2/sessions/${UUID}/files` },
  { name: `POST /api/v2/sessions/:id/sync-files`, method: 'post', path: `/api/v2/sessions/${UUID}/sync-files` },
  { name: `POST /api/v2/sessions/:id/end`, method: 'post', path: `/api/v2/sessions/${UUID}/end` },
  // --- legacy surface that had the same hole (routes/sessions.ts) ---
  { name: 'GET  /api/sessions/current (legacy)', method: 'get', path: '/api/sessions/current' },
  // --- legacy routes that were ALREADY authed — assert they stay closed ---
  { name: 'GET  /api/sessions (list, legacy)', method: 'get', path: '/api/sessions' },
  { name: 'GET  /api/sessions/stats (legacy)', method: 'get', path: '/api/sessions/stats' },
  { name: `GET  /api/sessions/:id (legacy detail)`, method: 'get', path: `/api/sessions/${UUID}` },
];

describe('Session routes — auth is REQUIRED', () => {
  describe('UNAUTHENTICATED callers get 401 (the exposure is closed)', () => {
    it.each(routes)('$name → 401 with no Authorization header', async ({ method, path }) => {
      const res = await request(app)[method](path);
      expect(res.status).toBe(401);
    });

    it.each(routes)('$name → 401 with a malformed (non-Bearer) header', async ({ method, path }) => {
      const res = await request(app)[method](path).set('Authorization', 'Basic Zm9vOmJhcg==');
      expect(res.status).toBe(401);
    });

    it.each(routes)('$name → 401 with a Bearer token that fails verification', async ({ method, path }) => {
      const res = await request(app)[method](path).set('Authorization', 'Bearer not.a.validtoken');
      expect(res.status).toBe(401);
    });
  });

  describe('AUTHENTICATED callers pass the gate (200 — not blocked)', () => {
    it.each(routes)('$name → 200 with a valid Bearer token', async ({ method, path }) => {
      const res = await request(app)[method](path).set('Authorization', `Bearer ${VALID_TOKEN}`);
      expect(res.status).toBe(200);
      expect(res.status).not.toBe(401);
    });
  });
});
