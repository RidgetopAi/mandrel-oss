/**
 * projectDeleteRequiresAdmin.test.ts — the BEHAVIOURAL half of an earlier task.
 *
 * `mutatingRouteAuthzCoverage.test.ts` proves every state-changing route is *classified*.
 * That is a statement about shape. This file proves the shape actually refuses a request:
 * a real HTTP DELETE from a non-admin gets 403 and NEVER reaches the service.
 *
 * ## What is real, and why that matters
 *
 * The app under test mounts the REAL `src/routes/index.ts` at `/api` — the same aggregator
 * `server.ts` mounts — so routing, mount prefixes, `router.use(authenticateToken)`, the
 * `contractEnforcementMiddleware`, `validateUUIDParam`, middleware ORDER and the real
 * `requireAdmin` are all the shipped objects. Nothing about authorization is mocked or
 * re-declared: if `requireAdmin` is removed from routes/projects.ts, these tests go RED.
 *
 * Only the two DB doors are stubbed — `AuthService` (which `authenticateToken` calls to
 * verify a session and load the user) and `ProjectService` (the destructive call itself).
 * `ProjectService.deleteProject` doubles as the probe: asserting it was NEVER CALLED is
 * stronger than asserting a status code, because a 403 produced by an unrelated failure
 * would still let a delete through in some other refactor. Status + non-delegation together
 * are what "the delete did not happen" means.
 *
 * ## The populations probed
 *
 * admin (positive control) · 'user' · role missing · role empty string · unknown role.
 * The last three are the values that slip through a check written as `role !== 'admin'`
 * somewhere, or a truthiness test (CLASSES.md C3: probe empty / absent).
 *
 * DB-free and MCP-free; runs in the default `npm test`.
 */

import request from 'supertest';
import express, { Express } from 'express';

const TOKEN_BY_ROLE: Record<string, string> = {
  admin: 'admin.aaa.bbb',
  user: 'user.aaa.bbb',
  missing: 'missing.aaa.bbb',
  empty: 'empty.aaa.bbb',
  weird: 'weird.aaa.bbb',
};

const baseUser = {
  id: 'u1',
  username: 'someone',
  email: 'someone@example.com',
  theme: 'dark',
  is_active: true,
  created_at: new Date(),
  updated_at: new Date(),
};

/** The REAL authenticateToken runs; only its DB calls are stubbed. */
jest.mock('../services/auth', () => ({
  AuthService: {
    verifyJWT: (token: string) => {
      const kind = Object.keys(TOKEN_BY_ROLE).find((k) => TOKEN_BY_ROLE[k] === token);
      return kind ? { userId: kind, tokenId: `t-${kind}` } : null;
    },
    validateSession: async () => true,
    findUserById: async (userId: string) => {
      const roles: Record<string, unknown> = {
        admin: 'admin',
        user: 'user',
        missing: undefined,
        empty: '',
        weird: 'superadmin',
      };
      return { ...baseUser, id: userId, role: roles[userId] };
    },
  },
}));

/**
 * The project path param is now AUTHORIZED per-caller (an earlier task item 7:
 * `router.param('id', authorizeProjectPathParam)` in routes/projects.ts), so this suite
 * has to say whether its non-admin holds a grant. It does — deliberately. This suite is
 * about the ADMIN bar on the destructive verb; a caller who fails the GRANT check would
 * be refused for a different reason and the admin question would go untested.
 */
jest.mock('../services/projectAccess', () => ({
  ProjectAccessService: {
    userHasProjectAccess: jest.fn(async () => true),
    listAccessibleProjectIds: jest.fn(async () => []),
  },
}));

jest.mock('../services/project', () => ({
  ProjectService: {
    getProjectById: jest.fn(),
    deleteProject: jest.fn(),
    getAllProjects: jest.fn(),
  },
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { ProjectService } = require('../services/project');

// The REAL /api aggregator — not routes/projects.ts in isolation.
import apiRoutes from '../routes/index';

const PROJECT_ID = '11111111-2222-3333-4444-555555555555';

let app: Express;

beforeAll(() => {
  // The dev bypass would hand every caller a hardcoded ADMIN user and make every 403
  // assertion below a false green. Neither condition may hold.
  delete process.env.ALLOW_DEV_AUTH_BYPASS;
  process.env.NODE_ENV = 'test';

  app = express();
  app.use(express.json());
  app.use('/api', apiRoutes);
});

beforeEach(() => {
  jest.clearAllMocks();
  ProjectService.getProjectById.mockResolvedValue({ id: PROJECT_ID, name: 'victim' });
  ProjectService.deleteProject.mockResolvedValue({
    deleted: true,
    message: 'Project deleted successfully',
  });
});

const del = (token?: string, query = '?confirm=true') => {
  const r = request(app).delete(`/api/projects/${PROJECT_ID}${query}`);
  return token ? r.set('Authorization', `Bearer ${token}`) : r;
};

describe('DELETE /api/projects/:id requires ADMIN', () => {
  it('POSITIVE CONTROL: an ADMIN still deletes successfully — 200, service called', async () => {
    // Without this, every 403 below could be produced by a route that is simply broken and
    // the suite would look like a working gate while gating everything.
    const res = await del(TOKEN_BY_ROLE.admin);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(ProjectService.deleteProject).toHaveBeenCalledTimes(1);
    expect(ProjectService.deleteProject).toHaveBeenCalledWith(PROJECT_ID, true, 'someone');
  });

  it.each([
    ['a non-admin role ("user")', 'user'],
    ['NO role at all (undefined)', 'missing'],
    ['an EMPTY-STRING role', 'empty'],
    ['an unrecognised role ("superadmin")', 'weird'],
  ])('%s → 403 and the service is NEVER called', async (_label, kind) => {
    const res = await del(TOKEN_BY_ROLE[kind]);

    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
    // The load-bearing assertion: nothing was destroyed. A status code alone does not
    // prove the cascade did not run.
    expect(ProjectService.deleteProject).not.toHaveBeenCalled();
  });

  it('a non-admin is refused for the same reason WITHOUT ?confirm=true', async () => {
    // The two gates are independent. `?confirm` gates accident; requireAdmin gates
    // authority. Neither may stand in for the other.
    const res = await del(TOKEN_BY_ROLE.user, '');
    expect(res.status).toBe(403);
    expect(ProjectService.deleteProject).not.toHaveBeenCalled();
  });

  it('a malformed id is refused by the authorization layer, never routed to the handler', async () => {
    // WAS: "a non-admin is refused BEFORE uuid validation — still 403, not 400".
    //
    // `router.param('id', authorizeProjectPathParam)` (an earlier task item 7) runs during
    // ROUTING, ahead of every route-level handler including requireAdmin, and it rejects a
    // non-uuid with 400 before any grant lookup. So the status for a malformed id is now
    // 400 rather than 403.
    //
    // The PROPERTY the original test protected is intact and is what is asserted here: the
    // refusal is not usable to probe which ids are well-formed, because a WELL-FORMED id
    // this caller may not delete is refused too (the 403 cases above), and the service is
    // never reached either way. What changed is which of two fail-closed layers answers
    // first, not whether it fails closed.
    const res = await request(app)
      .delete('/api/projects/not-a-uuid?confirm=true')
      .set('Authorization', `Bearer ${TOKEN_BY_ROLE.user}`);

    expect(res.status).toBe(400);
    expect(ProjectService.deleteProject).not.toHaveBeenCalled();
  });

  it('an UNAUTHENTICATED delete is still 401 (the pre-existing gate is intact)', async () => {
    const res = await del(undefined);
    expect(res.status).toBe(401);
    expect(ProjectService.deleteProject).not.toHaveBeenCalled();
  });

  it('NOT BROKEN FOR EVERYONE: a GRANTED non-admin can still READ the project they cannot delete', async () => {
    // Guards against "achieve green by breaking the route for everyone". The admin bar
    // belongs on the destructive verb, not on the resource. The caller holds a grant (see
    // the ProjectAccessService mock at the top) — an UNGRANTED non-admin now gets a 403
    // here on purpose, which is the hole an earlier task item 7 closed and is asserted at
    // the real surface in unscopedListProjectScope.db.test.ts.
    const res = await request(app)
      .get(`/api/projects/${PROJECT_ID}`)
      .set('Authorization', `Bearer ${TOKEN_BY_ROLE.user}`);

    expect(res.status).toBe(200);
    expect(ProjectService.getProjectById).toHaveBeenCalled();
  });
});
