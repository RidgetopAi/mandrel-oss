/**
 * unauthenticatedRoutesHttp.test.ts — the RUNTIME half of an earlier task and an earlier change.
 *
 * `unauthenticatedRouteCoverage.test.ts` asserts the SHAPE of the served router (that an
 * enforcing classification is in each route's chain). This file asserts the BEHAVIOUR that
 * shape is supposed to produce, by driving real HTTP through the real app — status codes,
 * which is what both tasks' acceptance criteria are written in. Neither replaces the
 * other: the shape guard explains WHY a failure happened and covers all 167 routes; this
 * one proves the seven that were actually open are actually closed.
 *
 * ## EVERY closure here has a POSITIVE CONTROL, because a 401 alone proves nothing
 *
 * A 401 is indistinguishable from a route that was deleted, renamed, or broken — and
 * "achieve green by breaking the route" is what both tasks explicitly forbid. So each
 * closed route is probed twice: no credential → 401, valid credential → the route is ALIVE.
 *
 * ## Why `POST /api/git/push-stats`'s positive control is a 400 and not a 200
 *
 * an earlier Task carries a verification constraint: do NOT send a POST that would succeed,
 * because a successful probe WRITES git statistics into an instance. So the credentialed
 * probe sends an EMPTY body and asserts **400 `session_id is required`** — a response only
 * `GitController.pushStats` can produce, so it proves the credential got past the guard and
 * reached the live handler, while writing nothing and touching no database. That is the
 * "request shaped so a success is inert" option the task offers, and it is the one used.
 *
 * ## Why this needs no database
 *
 * `authenticateToken` and `authenticateAgentOrUser` reject a credential-free request from
 * the header alone, before any data tier. `AuthService` is mocked so the CREDENTIALED path
 * can run without a DB — note those mocks can only make an authenticated case SUCCEED;
 * they cannot manufacture the 401s, which happen before AuthService is consulted.
 */

import request from 'supertest';
import express, { Request, Response } from 'express';

// Set BEFORE the app (and therefore config/environment) is imported.
const AGENT_TOKEN = 'test-agent-token-4f2a9c';
process.env.MANDREL_AGENT_TOKEN = AGENT_TOKEN;

jest.mock('../utils/featureFlags', () => ({
  ensureFeatureFlags: jest.fn(async () => ({
    getMetadata: () => ({ version: 'test', updatedAt: new Date().toISOString() }),
    getAllFlags: () => ({}),
  })),
}));

const VALID_TOKEN = 'header.payload.signature';
jest.mock('../services/auth', () => ({
  AuthService: {
    verifyJWT: jest.fn((token: string) =>
      token === 'header.payload.signature'
        ? { userId: 'test-user-id', tokenId: 'test-token-id' }
        : null
    ),
    validateSession: jest.fn(async (tokenId: string) => tokenId === 'test-token-id'),
    findUserById: jest.fn(async (userId: string) =>
      userId === 'test-user-id'
        ? {
            id: 'test-user-id',
            username: 'tester',
            email: 'tester@example.com',
            role: 'admin',
            is_active: true,
          }
        : null
    ),
  },
}));

/**
 * Reached only by the CREDENTIALED probes. `db.connect` hands back a client whose `query`
 * THROWS: the push-stats positive control is asserted at the 400 that
 * `GitController.pushStats` returns for a missing `session_id`, which happens BEFORE any
 * query — so a client that cannot query is the strongest possible statement that this test
 * writes nothing. If validation were ever removed and the probe started reaching the
 * database, this mock turns the test RED rather than letting it write.
 */
jest.mock('../database/connection', () => ({
  db: {
    connect: jest.fn(async () => ({
      query: jest.fn(async () => {
        throw new Error('TEST GUARD: this probe must never reach the database');
      }),
      release: jest.fn(),
    })),
  },
  checkDatabaseHealth: jest.fn(async () => ({ connected: true, healthy: true })),
  getDatabaseStats: jest.fn(async () => ({ tables: 0 })),
  initializeDatabase: jest.fn(async () => undefined),
}));

import app from '../server';

const auth = (r: request.Test) => r.set('Authorization', `Bearer ${VALID_TOKEN}`);

describe('the dev auth bypass is OFF, so nothing below is an artifact of it', () => {
  it('ALLOW_DEV_AUTH_BYPASS is not active', () => {
    expect(
      process.env.ALLOW_DEV_AUTH_BYPASS === 'true' && process.env.NODE_ENV === 'development'
    ).toBe(false);
  });
});

describe('POST /api/git/push-stats — the unauthenticated WRITE', () => {
  const ROUTE = '/api/git/push-stats';

  it('NO credential → 401 (before the fix this returned 2xx and wrote rows)', async () => {
    const res = await request(app).post(ROUTE).send({});
    expect(res.status).toBe(401);
  });

  it('a garbage bearer token → 401', async () => {
    const res = await request(app).post(ROUTE).set('Authorization', 'Bearer nope').send({});
    expect(res.status).toBe(401);
  });

  it('a token that is a PREFIX of the real agent token → 401 (no truncated compare)', async () => {
    const res = await request(app)
      .post(ROUTE)
      .set('Authorization', `Bearer ${AGENT_TOKEN.slice(0, -1)}`)
      .send({});
    expect(res.status).toBe(401);
  });

  it('POSITIVE CONTROL — the AGENT token reaches the live handler (inert 400, writes nothing)', async () => {
    const res = await request(app)
      .post(ROUTE)
      .set('Authorization', `Bearer ${AGENT_TOKEN}`)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('session_id is required');
  });

  it('POSITIVE CONTROL — a user JWT also reaches the live handler (inert 400)', async () => {
    const res = await auth(request(app).post(ROUTE)).send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('session_id is required');
  });
});

describe('the infra-metadata leaks', () => {
  it.each([
    '/api/db-status',
    '/api/version',
    '/api/openapi',
    '/api/openapi/openapi.json',
    '/api/openapi/postman.json',
    '/api/openapi/docs',
  ])('%s — NO credential → 401 (was 200 on prod and all 7 tenants)', async (route) => {
    const res = await request(app).get(route);
    expect(res.status).toBe(401);
  });

  it('POSITIVE CONTROL — /api/version with a credential is ALIVE', async () => {
    const res = await auth(request(app).get('/api/version'));
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveProperty('node_version');
  });

  it('POSITIVE CONTROL — /api/db-status with a credential is ALIVE', async () => {
    const res = await auth(request(app).get('/api/db-status'));
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveProperty('database');
  });

  it('POSITIVE CONTROL — /api/openapi/openapi.json with a credential is ALIVE', async () => {
    const res = await auth(request(app).get('/api/openapi/openapi.json'));
    expect(res.status).toBe(200);
    expect(Object.keys(res.body.paths ?? {}).length).toBeGreaterThan(10);
  });
});

describe('the DELIBERATELY public surface still works, and no longer leaks', () => {
  it('GET /api/health is 200 with NO credential — the container healthcheck depends on it', async () => {
    // the command-backend healthcheck in docker-compose.yml (wget --spider) and the deploy
    // smoke checks retry until 200.
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('healthy');
  });

  it('GET /api/health no longer serves memory or environment', async () => {
    const res = await request(app).get('/api/health');
    expect(res.body.data).not.toHaveProperty('memory');
    expect(res.body.data).not.toHaveProperty('environment');
    expect(res.body.data).not.toHaveProperty('uptime');
  });

  it('GET /api/livez and /api/readyz stay reachable with no credential', async () => {
    expect((await request(app).get('/api/livez')).status).toBe(200);
    expect([200, 503]).toContain((await request(app).get('/api/readyz')).status);
  });

  it('GET /api/readyz never returns a raw error string', async () => {
    const res = await request(app).get('/api/readyz');
    expect(res.body).not.toHaveProperty('error');
  });

  it('GET /api/feature-flags is 200 with NO credential — an edge probe expects exactly this', async () => {
    const res = await request(app).get('/api/feature-flags');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('flags');
  });

  it('GET / is 200 with NO credential and no longer serves a version', async () => {
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(res.body.data).not.toHaveProperty('version');
  });

  it('POST /api/auth/login stays reachable — you cannot authenticate to the login route', async () => {
    const res = await request(app).post('/api/auth/login').send({});
    expect(res.status).not.toBe(401);
  });
});

describe('GET /api/healthz keeps its 200/503 semantics and drops the internals', () => {
  it('reachable with no credential, and carries no pool stats or heap figures', async () => {
    const res = await request(app).get('/api/healthz');
    expect([200, 503]).toContain(res.status);
    expect(res.body.checks.database).not.toHaveProperty('pool');
    expect(res.body.checks.database).not.toHaveProperty('error');
    expect(res.body.checks.memory).not.toHaveProperty('heapUsed');
    expect(res.body.checks.memory).not.toHaveProperty('heapLimit');
    expect(res.body.checks.memory).not.toHaveProperty('utilization');
    // still a real verdict, not an empty object
    expect(['up', 'down']).toContain(res.body.checks.memory.status);
  });
});

/**
 * The FAIL-CLOSED probe. Kept last and in its own module registry so nothing above sees
 * the reset.
 *
 * The value that slips through (CLASSES.md C3: probe the empty/absent population): what
 * does `authenticateAgentOrUser` do when NOBODY CONFIGURED a credential? An `||''` default
 * plus a naive `presented === expected` would let `Authorization: Bearer ` — or a caller
 * who sends the empty string — straight through. It must refuse.
 */
describe('with MANDREL_AGENT_TOKEN UNSET, the agent path is CLOSED, not open', () => {
  const drive = async (mw: any, header?: string) => {
    const probe = express();
    const r = request(probe.get('/probe', mw, (_q: Request, s: Response) =>
      s.status(200).json({ reached: true })
    )).get('/probe');
    return header === undefined ? r : r.set('Authorization', header);
  };

  let unconfigured: any;
  beforeAll(() => {
    delete process.env.MANDREL_AGENT_TOKEN;
    jest.isolateModules(() => {
      unconfigured = require('../middleware/agentAuth').authenticateAgentOrUser;
    });
  });
  afterAll(() => {
    process.env.MANDREL_AGENT_TOKEN = AGENT_TOKEN;
  });

  it.each([
    ['no Authorization header', undefined],
    ['an EMPTY bearer token', 'Bearer '],
    ['the token that would have worked if configured', `Bearer ${AGENT_TOKEN}`],
  ])('%s → 401', async (_name, header) => {
    const res = await drive(unconfigured, header as string | undefined);
    expect(res.status).toBe(401);
    expect(res.body?.reached).toBeUndefined();
  });
});
