/**
 * watchableRequiresAuthHttp.test.ts — an earlier task, the RUNTIME half.
 *
 * `watchableRequiresAuth.test.ts` asserts the SHAPE of the router (that
 * `authenticateToken` sits in the handler chain for `GET /api/projects/watchable`).
 * This file asserts the BEHAVIOUR that shape is supposed to produce, by driving real
 * HTTP requests through the real app with supertest — status codes, which is what the
 * task's acceptance criterion is written in.
 *
 * Both exist on purpose and neither replaces the other: the shape test explains WHY a
 * failure happened (registration order) and cannot be satisfied by a route that 401s for
 * the wrong reason; this one proves the served behaviour is actually 401/200 and would
 * catch an `authenticateToken` that stopped rejecting.
 *
 * ## Why this needs no database
 *
 * `authenticateToken` (middleware/auth.ts) rejects a request with no `Authorization`
 * header, or a malformed one, BEFORE it validates anything against the DB. So the
 * unauthenticated cases are pure middleware and touch no data tier.
 *
 * The AUTHENTICATED case is the positive control, and it is the reason this file is worth
 * having: a 401 on its own is indistinguishable from a route that was deleted, renamed or
 * broken, and "achieve green by breaking the route" is explicitly what the task forbids.
 * `AuthService` (verifyJWT / validateSession / findUserById) and the project service are
 * mocked so the credentialed path can be exercised without a DB — the assertion is that a
 * VALID credential reaches the controller and gets 200 with the expected body shape, i.e.
 * the route is alive.
 *
 * ## Fail-closed note
 *
 * `ALLOW_DEV_AUTH_BYPASS` + `NODE_ENV=development` would make authenticateToken pass
 * everything through. The last test pins that the bypass is OFF under this suite, so a
 * green run here can never be an artifact of the dev bypass.
 */

import request from 'supertest';

jest.mock('../utils/featureFlags', () => ({
  ensureFeatureFlags: jest.fn(async () => ({
    getMetadata: () => ({ version: 'test', updatedAt: new Date().toISOString() }),
    getAllFlags: () => ({}),
  })),
}));

// Mocked so the CREDENTIALED path can run without a data tier. Note these mocks can only
// make the authenticated case SUCCEED — they cannot manufacture the 401s, which come from
// authenticateToken's own header checks before any of this is consulted.
// Mirrors the REAL sequence in middleware/auth.ts: the token must be JWT-shaped
// (three dot-separated parts), then verifyJWT -> validateSession -> findUserById.
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

jest.mock('../services/project', () => ({
  ProjectService: {
    getWatchableProjects: jest.fn(async () => [
      { id: 'p1', name: 'test-project', root_directory: '/test/path' },
    ]),
  },
}));

import app from '../server';

const ROUTE = '/api/projects/watchable';

describe(`${ROUTE} authz behaviour`, () => {
  it('the dev auth bypass is OFF, so nothing below is an artifact of it', () => {
    const bypassActive =
      process.env.ALLOW_DEV_AUTH_BYPASS === 'true' && process.env.NODE_ENV === 'development';
    expect(bypassActive).toBe(false);
  });

  it('NO credential -> 401 (the leak this task closed)', async () => {
    const res = await request(app).get(ROUTE);
    expect(res.status).toBe(401);
  });

  it('the 401 body carries NO project data — it must not leak while rejecting', async () => {
    // A 401 that still serialises the payload would satisfy a status-code-only check while
    // leaking exactly what the task is about.
    const res = await request(app).get(ROUTE);
    const body = JSON.stringify(res.body);
    expect(body).not.toContain('root_directory');
    expect(body).not.toContain('test-project');
    expect(res.body?.success).toBe(false);
  });

  it.each([
    ['malformed scheme', 'Basic abc123'],
    ['bearer with empty token', 'Bearer '],
    ['garbage', 'nonsense'],
  ])('a %s credential -> 401', async (_label, header) => {
    const res = await request(app).get(ROUTE).set('Authorization', header);
    expect(res.status).toBe(401);
  });

  it('an INVALID bearer token -> 401', async () => {
    // JWT-SHAPED but not verifiable, so it reaches verifyJWT and is rejected there rather
    // than bouncing off the earlier scheme/format checks the cases above already cover.
    const res = await request(app).get(ROUTE).set('Authorization', 'Bearer bad.token.here');
    expect(res.status).toBe(401);
  });

  it('POSITIVE CONTROL: a VALID credential -> 200 with the expected data', async () => {
    // Without this, every 401 above is equally satisfied by a deleted or broken route.
    const res = await request(app).get(ROUTE).set('Authorization', `Bearer ${VALID_TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body?.success).toBe(true);
    const projects = res.body?.data?.projects;
    expect(Array.isArray(projects)).toBe(true);
    expect(projects.length).toBeGreaterThan(0);
    // The shape the live mandrel-watcher consumes. Read from ConfigManager.fetchProjects
    // at /home/user/projects/mandrel-watcher/src/core/ConfigManager.ts ON THE PROD-HOST
    // BOX (that repo is not checked out on the control host control box), which maps each project to
    // { path: p.root_directory, mandrel_project: p.name, project_id: p.id }.
    expect(projects[0]).toEqual(
      expect.objectContaining({ id: expect.any(String), name: expect.any(String), root_directory: expect.any(String) })
    );
  });
});
