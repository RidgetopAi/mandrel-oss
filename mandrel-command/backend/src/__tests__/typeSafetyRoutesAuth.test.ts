/**
 * typeSafetyRoutesAuth.test.ts — SECURITY gate for the `/api/type-safety/*` family
 * (an earlier task — Lesson-011 sibling of the 4eaf055c session-routes fix).
 *
 * Regression guard for the exposure: every `/api/type-safety/*` route was mounted with
 * NO auth middleware, so all six returned 200 to UNAUTHENTICATED callers on the public
 * internet (edge-verified on command.example.com). The worst was `GET /schema-sync`,
 * which dumps the ENTIRE internal SchemaRegistry (every schema/operation name) to an
 * anonymous caller — a full internal data-model map. This proves EVERY route in the
 * family now:
 *   • returns 401 with NO / a malformed / an invalid Authorization header, and
 *   • passes the gate (reaches its handler → 200) with a valid credential.
 *
 * It exercises the REAL `authenticateToken` middleware and the REAL production router
 * (`routes/typeSafety.ts`), mounted exactly as routes/index.ts mounts it (`/type-safety`
 * under `/api`). So the guard the test actually depends on is `router.use(authenticateToken)`
 * at the top of typeSafety.ts. MUTATION-PROBE: delete that line and every 401 case below
 * MUST fail — that is what proves the tests catch a regression.
 *
 * DB-free by design: `AuthService` (the middleware's DB calls) is mocked so this is a
 * pure route-auth contract test. The handlers themselves touch no DB / no network.
 */

import request from 'supertest';
import express, { Express } from 'express';

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

// The REAL production router, mounted exactly as routes/index.ts mounts it.
import typeSafetyRoutes from '../routes/typeSafety';

const UUID = '11111111-1111-4111-8111-111111111111';

// Every route in the family. `body` (POST only) is a schema-valid payload so the
// authorized path reaches 200 (validateBody runs AFTER auth, so it never affects the
// 401 cases). GET routes need no body.
const routes: Array<{
  name: string;
  method: 'get' | 'post';
  path: string;
  body?: Record<string, unknown>;
}> = [
  { name: 'GET  /api/type-safety/demo', method: 'get', path: '/api/type-safety/demo' },
  {
    name: 'POST /api/type-safety/validate-project',
    method: 'post',
    path: '/api/type-safety/validate-project',
    body: { name: 'Auth Test Project' },
  },
  {
    name: 'POST /api/type-safety/validate-task',
    method: 'post',
    path: '/api/type-safety/validate-task',
    body: { title: 'Auth Test Task', priority: 'medium', project_id: UUID },
  },
  { name: 'GET  /api/type-safety/consistency', method: 'get', path: '/api/type-safety/consistency' },
  { name: 'GET  /api/type-safety/schema-sync', method: 'get', path: '/api/type-safety/schema-sync' },
  { name: 'GET  /api/type-safety/health', method: 'get', path: '/api/type-safety/health' },
];

let app: Express;

beforeAll(() => {
  // Belt-and-suspenders: the middleware's dev bypass needs BOTH of these; make sure
  // neither is set so "no token → 401" is the behavior under test.
  delete process.env.ALLOW_DEV_AUTH_BYPASS;
  process.env.NODE_ENV = 'test';

  app = express();
  app.use(express.json());
  // correlationId is normally set by upstream middleware; the handlers read it but
  // tolerate undefined, so no shim is needed here.
  app.use('/api/type-safety', typeSafetyRoutes);
});

describe('type-safety routes — auth is REQUIRED', () => {
  describe('UNAUTHENTICATED callers get 401 (the exposure is closed)', () => {
    it.each(routes)('$name → 401 with no Authorization header', async ({ method, path, body }) => {
      const res = await request(app)[method](path).send(body ?? {});
      expect(res.status).toBe(401);
    });

    it.each(routes)('$name → 401 with a malformed (non-Bearer) header', async ({ method, path, body }) => {
      const res = await request(app)[method](path).set('Authorization', 'Basic Zm9vOmJhcg==').send(body ?? {});
      expect(res.status).toBe(401);
    });

    it.each(routes)('$name → 401 with a Bearer token that fails verification', async ({ method, path, body }) => {
      const res = await request(app)[method](path).set('Authorization', 'Bearer not.a.validtoken').send(body ?? {});
      expect(res.status).toBe(401);
    });
  });

  describe('AUTHENTICATED callers pass the gate (200 — not blocked)', () => {
    it.each(routes)('$name → 200 with a valid Bearer token', async ({ method, path, body }) => {
      const res = await request(app)[method](path).set('Authorization', `Bearer ${VALID_TOKEN}`).send(body ?? {});
      expect(res.status).toBe(200);
      expect(res.status).not.toBe(401);
    });
  });
});
