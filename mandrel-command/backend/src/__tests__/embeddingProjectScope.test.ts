/**
 * embeddingProjectScope — the two unauthorized project doors on /api/embedding/*
 * (Reviewer D1).
 *
 * =============================================================================
 * WHY THIS FILE EXISTS AT ALL, AND WHY IT IS BEHAVIOURAL
 * =============================================================================
 * DOOR 1 — a legacy `project` REQUEST HEADER (uuid or NAME), read by the router's own
 * `resolveProjectScope()` and never authorized.
 * DOOR 2 — the `?id=` QUERY PARAM. `getAvailableDatasets` emits `p.id::text AS id`, so a
 * "dataset id" IS a project id, and the services did
 *     targetProjectId = datasetId !== 'contexts' ? datasetId : resolvedScopeId
 * — the caller-supplied `?id=` OVERRODE the authorized scope.
 *
 * **DOOR 2 IS THE REASON THIS SUITE IS BEHAVIOURAL RATHER THAN A SCAN.** It is a project
 * reference named `id`. No name-based lint rule or text scan will ever find it — not the
 * eslint AST rule, not projectScopeRawReadGate — because nothing about the token `id` says
 * "project". The only thing that finds it is exercising the route and looking at what
 * comes back. That is a permanent limitation of every name-matching gate we have, it is
 * now written into that gate's non-coverage list, and this suite is the compensating
 * control.
 *
 * Eight authenticated routes sit behind `router.use(authenticateToken)`:
 *   /list /similarity /projection /cluster /metrics /relationships /knowledge-gaps /usage
 *
 * SEAMS: the two DB doors the middleware uses (AuthService, ProjectAccessService) and the
 * EmbeddingService are stubbed. The REAL projectContextMiddleware, the REAL resolver and
 * the REAL router run — so what is asserted is the shipping request path, and a
 * `REACHED_SERVICE` in a response body means the service layer was genuinely reached with
 * that project.
 */

const VICTIM_PROJECT = 'aaaaaaaa-1111-2222-3333-aaaaaaaaaaaa';
const GRANTED_PROJECT = 'bbbbbbbb-1111-2222-3333-bbbbbbbbbbbb';

const USERS: Record<string, { id: string; username: string; role: string }> = {
  'nobody.a.b': { id: 'nobody', username: 'nobody', role: 'user' },
  // F1: the admin path had NEVER EXECUTED — the authenticateToken mock hardcoded
  // role:'user', so `req.user.role === 'admin' ? null : listAccessibleProjectIds(...)`
  // in routes/embedding.ts only ever took one branch, and the `null` (all projects)
  // behaviour was asserted nowhere.
  'boss.a.b': { id: 'boss', username: 'boss', role: 'admin' },
};

jest.mock('../services/auth', () => ({
  AuthService: {
    verifyJWT: (t: string) => (USERS[t] ? { userId: USERS[t].id, tokenId: 't' } : null),
    findUserById: async (id: string) => {
      const u = Object.values(USERS).find((x) => x.id === id);
      return u ? { id: u.id, role: u.role } : null;
    },
  },
}));

jest.mock('../services/projectAccess', () => ({
  ProjectAccessService: {
    // The zero-grant non-admin: granted EXACTLY ONE project, and never the victim.
    userHasProjectAccess: jest.fn(async (_u: unknown, p: string) => p === GRANTED_PROJECT),
    listAccessibleProjectIds: jest.fn(async () => [GRANTED_PROJECT]),
  },
}));

/** Every service call records the project it was actually asked for. */
/**
 * F1 — WHAT THIS RECORDER USED TO THROW AWAY.
 *
 * It captured only `a[0]` (userId) and `a[1]` (scope). The THIRD argument — the
 * caller's authorized project set, which is the entire fix for the unscoped-/list leak —
 * was discarded, and the only assertion about it was
 * `expect(listAccessibleProjectIds).toHaveBeenCalledWith('nobody')`: proof that the set
 * was COMPUTED, never that it was USED. Coordinator reproduced the consequence — deleting the
 * third argument at the call site left all 38 cases GREEN while a zero-grant non-admin
 * got the every-project listing back. `allArgs` is captured now, and asserted.
 */
const serviceCalls: Array<{ fn: string; projectId?: string }> = [];
/**
 * The THIRD argument of getAvailableDatasets ONLY — the caller's authorized project set.
 * Captured separately because arg 3 means something different on the scoped routes (it is
 * the datasetId there), and a blindly positional capture would assert the wrong thing.
 * `NOT_PASSED` is a distinct sentinel from `null`: `null` is the legitimate admin value
 * meaning "all projects", while a MISSING argument is the F1 defect. Conflating them is
 * exactly how the false green happened.
 */
const NOT_PASSED = Symbol('argument not passed');
let listAllowedArg: unknown = NOT_PASSED;

const record =
  (fn: string) =>
  async (...args: unknown[]) => {
    const scope = args[1] as { projectId?: string } | undefined;
    if (fn === 'list') listAllowedArg = args.length >= 3 ? args[2] : NOT_PASSED;
    serviceCalls.push({ fn, projectId: scope?.projectId });
    return { marker: 'REACHED_SERVICE', scopeSeen: scope?.projectId ?? null };
  };
jest.mock('../services/EmbeddingService', () => ({
  EmbeddingService: {
    getAvailableDatasets: (...a: unknown[]) => record('list')(...a),
    getSimilarityMatrix: (...a: unknown[]) => record('similarity')(...a),
    getProjection: (...a: unknown[]) => record('projection')(...a),
    getClusters: (...a: unknown[]) => record('cluster')(...a),
    getQualityMetrics: (...a: unknown[]) => record('metrics')(...a),
    getProjectRelationships: (...a: unknown[]) => record('relationships')(...a),
    getKnowledgeGapMetrics: (...a: unknown[]) => record('knowledge-gaps')(...a),
    getUsagePatterns: (...a: unknown[]) => record('usage')(...a),
  },
}));

jest.mock('../middleware/auth', () => ({
  // Reads the SAME Authorization header the real one does, so a test can drive the admin
  // branch. Hardcoding role:'user' here is what made that branch dead code (F1).
  authenticateToken: (
    req: { user?: unknown; headers: Record<string, string | undefined> },
    _res: unknown,
    next: () => void
  ) => {
    const token = (req.headers.authorization ?? '').replace('Bearer ', '');
    if (USERS[token]) req.user = { ...USERS[token] };
    next();
  },
}));

import request from 'supertest';
import express, { Express } from 'express';
import { projectContextMiddleware } from '../middleware/project';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { ProjectAccessService } = require('../services/projectAccess');
import embeddingRoutes from '../routes/embedding';

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  // Mounted exactly as server.ts mounts it: app-level on /api, before the routers.
  app.use('/api', projectContextMiddleware);
  app.use('/api/embedding', embeddingRoutes);
  return app;
}

const AUTH = 'Bearer nobody.a.b';
const ADMIN_AUTH = 'Bearer boss.a.b';

/** The eight authenticated routes, and whether each takes a `?id=` dataset param. */
const ROUTES: ReadonlyArray<{ path: string; takesId: boolean }> = [
  { path: '/list', takesId: false },
  { path: '/similarity', takesId: true },
  { path: '/projection', takesId: true },
  { path: '/cluster', takesId: true },
  { path: '/metrics', takesId: true },
  { path: '/relationships', takesId: false },
  { path: '/knowledge-gaps', takesId: false },
  { path: '/usage', takesId: false },
];

describe('/api/embedding/* — the two unauthorized project doors are closed (D1)', () => {
  let app: Express;
  beforeEach(() => {
    serviceCalls.length = 0;
    listAllowedArg = NOT_PASSED;
    jest.clearAllMocks();
    app = buildApp();
  });

  it('CONTROL: X-Project-ID naming the victim is refused — the door already closed', async () => {
    const res = await request(app)
      .get('/api/embedding/similarity')
      .query({ id: 'contexts' })
      .set('Authorization', AUTH)
      .set('X-Project-ID', VICTIM_PROJECT);
    expect(res.status).toBe(403);
    expect(serviceCalls).toEqual([]);
  });

  describe.each(ROUTES.map((r) => [r.path, r] as const))('%s', (_p, route) => {
    it('DOOR 1 — a legacy `project` HEADER naming the victim must NOT reach the service', async () => {
      // Pre-fix this returned 200 REACHED_SERVICE on all eight routes.
      const res = await request(app)
        .get(`/api/embedding${route.path}`)
        .query(route.takesId ? { id: 'contexts' } : {})
        .set('Authorization', AUTH)
        .set('project', VICTIM_PROJECT);

      if (route.takesId || route.path !== '/list') {
        expect(res.status).not.toBe(200);
        expect(serviceCalls).toEqual([]);
      } else {
        // /list is the ONE route that may be unscoped (the UI builds its picker from it),
        // so the door-1 proof for it is different: the legacy header must select NOTHING,
        // and the caller must be confined to its own authorized projects rather than
        // landing on an every-project listing.
        // F1: assert the set was USED, not merely computed. `toHaveBeenCalledWith` alone
        // proved only that we asked for it — the value could be, and was, discarded.
        expect(serviceCalls).toEqual([{ fn: 'list', projectId: undefined }]);
        // F1: assert the set was USED, not merely computed. `toHaveBeenCalledWith` alone
        // proved only that we asked for it — the value could be, and was, discarded.
        expect(listAllowedArg).toEqual([GRANTED_PROJECT]);
        expect(ProjectAccessService.listAccessibleProjectIds).toHaveBeenCalledWith('nobody');
      }
    });

    it('DOOR 1b — a legacy `project` header carrying a project NAME must NOT reach the service', async () => {
      // The nastier half: name-based selection meant an attacker needed no uuid at all.
      const res = await request(app)
        .get(`/api/embedding${route.path}`)
        .query(route.takesId ? { id: 'contexts' } : {})
        .set('Authorization', AUTH)
        .set('project', 'some-victim-project-name');

      if (route.takesId || route.path !== '/list') {
        expect(res.status).not.toBe(200);
        expect(serviceCalls).toEqual([]);
      } else {
        // F1: assert the set was USED, not merely computed. `toHaveBeenCalledWith` alone
        // proved only that we asked for it — the value could be, and was, discarded.
        expect(serviceCalls).toEqual([{ fn: 'list', projectId: undefined }]);
        // F1: assert the set was USED, not merely computed. `toHaveBeenCalledWith` alone
        // proved only that we asked for it — the value could be, and was, discarded.
        expect(listAllowedArg).toEqual([GRANTED_PROJECT]);
        expect(ProjectAccessService.listAccessibleProjectIds).toHaveBeenCalledWith('nobody');
      }
    });

    it('the caller CAN still reach its OWN granted project (allow control — not a blanket deny)', async () => {
      const res = await request(app)
        .get(`/api/embedding${route.path}`)
        .query(route.takesId ? { id: GRANTED_PROJECT } : {})
        .set('Authorization', AUTH)
        .set('X-Project-ID', GRANTED_PROJECT);

      expect(res.status).toBe(200);
      expect(res.body.marker).toBe('REACHED_SERVICE');
      expect(serviceCalls).toEqual([
        { fn: route.path.replace('/', ''), projectId: GRANTED_PROJECT },
      ]);
    });
  });

  describe.each(ROUTES.filter((r) => r.takesId).map((r) => [r.path, r] as const))(
    '%s — DOOR 2 (`?id=` IS a project id)',
    (_p, route) => {
      it('?id=<victim uuid> with NO scope header is 403, and reaches no service', async () => {
        // Pre-fix: 200, and getSimilarityMatrix returned `content` from every context in
        // the victim project.
        //
        // ASSERTS 403 EXACTLY, not `not.toBe(200)` (Reviewer item 6). The loose form
        // stayed GREEN under the DOOR-2 mutation for the wrong reason: an unscoped request
        // 400s on the missing-scope check before the dataset param is ever consulted, so
        // the assertion passed while the door was open. A test that cannot fail for the
        // reason it names is decoration.
        const res = await request(app)
          .get(`/api/embedding${route.path}`)
          .query({ id: VICTIM_PROJECT })
          .set('Authorization', AUTH);

        expect(res.status).toBe(403);
        expect(serviceCalls).toEqual([]);
      });

      it('?id=<victim uuid> while SCOPED to the granted project is 403 — not a silent substitution', async () => {
        // The subtle one: the caller is legitimately scoped, and tries to read ACROSS with
        // the dataset param. It must be refused loudly, not quietly served its own data.
        const res = await request(app)
          .get(`/api/embedding${route.path}`)
          .query({ id: VICTIM_PROJECT })
          .set('Authorization', AUTH)
          .set('X-Project-ID', GRANTED_PROJECT);

        expect(res.status).toBe(403);
        expect(serviceCalls).toEqual([]);
      });

      it('the service NEVER receives a project it was not authorized for', async () => {
        // The invariant, stated directly: whatever the caller puts in `?id=`, the project
        // handed to the service layer is the AUTHORIZED one or nothing at all.
        await request(app)
          .get(`/api/embedding${route.path}`)
          .query({ id: VICTIM_PROJECT })
          .set('Authorization', AUTH)
          .set('X-Project-ID', GRANTED_PROJECT);
        await request(app)
          .get(`/api/embedding${route.path}`)
          .query({ id: 'contexts' })
          .set('Authorization', AUTH)
          .set('X-Project-ID', GRANTED_PROJECT);

        // The cross-project attempt is refused before the service, so the ONLY call that
        // can appear here is the legitimate one — asserted by exact equality rather than
        // by `.some(...) === false`, which was unreachable (the 403 empties serviceCalls,
        // so it was trivially true and proved nothing — Reviewer item 6).
        expect(serviceCalls).toEqual([
          { fn: route.path.replace('/', ''), projectId: GRANTED_PROJECT },
        ]);
      });
    }
  );

  // ===========================================================================
  // J1 — a NON-STRING ?id= is DENIED, not waved through
  // ===========================================================================
  describe.each(ROUTES.filter((r) => r.takesId).map((r) => [r.path, r] as const))(
    '%s — J1: an unknown-shaped ?id=',
    (_p, route) => {
      it('a REPEATED ?id=&id= (an array to Express) is refused, and reaches no service', async () => {
        // `datasetIsInScope` returned `true` (ALLOW) for any non-string. Express produces
        // an ARRAY for a repeated param, so this shape is what a caller sends deliberately.
        // It measured 200 at the real surface. The defence was "the services ignore the
        // value" — a claim about today's callers standing in for a property of the
        // implementation, inside the authorization primitive itself.
        const res = await request(app)
          .get(`/api/embedding${route.path}?id=${VICTIM_PROJECT}&id=${GRANTED_PROJECT}`)
          .set('Authorization', AUTH)
          .set('X-Project-ID', GRANTED_PROJECT);

        expect(res.status).toBe(400);
        expect(serviceCalls).toEqual([]);
      });

      it('a BRACKETED ?id[x]= (an object to Express) is refused', async () => {
        const res = await request(app)
          .get(`/api/embedding${route.path}?id[x]=${VICTIM_PROJECT}`)
          .set('Authorization', AUTH)
          .set('X-Project-ID', GRANTED_PROJECT);

        expect(res.status).toBe(400);
        expect(serviceCalls).toEqual([]);
      });

      it('an ABSENT ?id= is still fine — deny-unknown must not become deny-everything', async () => {
        // The control that keeps the two cases above meaningful: `undefined` is absence,
        // not an unknown shape, and the route\'s own missing-id 400 still governs.
        const res = await request(app)
          .get(`/api/embedding${route.path}`)
          .set('Authorization', AUTH)
          .set('X-Project-ID', GRANTED_PROJECT);
        expect(res.status).toBe(400);
        expect(String(JSON.stringify(res.body))).toContain('Dataset ID is required');
      });
    }
  );

  // ===========================================================================
  // F1 — the authorized set must be PASSED, not merely computed
  // ===========================================================================
  // Coordinator reproduced the hole before this suite was fixed: deleting the third argument at
  // routes/embedding.ts (keeping `void allowed;` so tsc stayed clean) left all 38 cases
  // GREEN while a zero-grant non-admin got the every-project listing back. These four
  // cases are the ones that now go red for that mutation.
  describe('/list — the authorized project set reaches the service', () => {
    it('NON-ADMIN: the set is passed, and it is the caller\'s granted projects', async () => {
      const res = await request(app).get('/api/embedding/list').set('Authorization', AUTH);
      expect(res.status).toBe(200);
      expect(listAllowedArg).toEqual([GRANTED_PROJECT]);
    });

    it('NON-ADMIN: the argument is PRESENT — a dropped one is not the same as null', async () => {
      await request(app).get('/api/embedding/list').set('Authorization', AUTH);
      // The exact false-green: with the argument deleted this is NOT_PASSED, and every
      // other assertion in the file still passed.
      expect(listAllowedArg).not.toBe(NOT_PASSED);
      expect(listAllowedArg).not.toBeUndefined();
    });

    it('ADMIN: the set is the explicit ALL_PROJECTS sentinel — and this branch had NEVER executed', async () => {
      // The authenticateToken mock used to hardcode role:'user', so
      // `req.user.role === 'admin' ? null : listAccessibleProjectIds(...)` only ever took
      // one side. A rewrite of that ternary could not have been caught.
      const res = await request(app).get('/api/embedding/list').set('Authorization', ADMIN_AUTH);
      expect(res.status).toBe(200);
      // J3: a WORD, not null. The unrestricted mode has to be spelled at the call site
      // and cannot be reached by omitting the argument.
      expect(listAllowedArg).toBe('ALL_PROJECTS');
      expect(ProjectAccessService.listAccessibleProjectIds).not.toHaveBeenCalled();
    });

    it('NON-ADMIN WITH ZERO GRANTS: the set is EMPTY, not absent — sees nothing, not everything', async () => {
      ProjectAccessService.listAccessibleProjectIds.mockResolvedValueOnce([]);
      const res = await request(app).get('/api/embedding/list').set('Authorization', AUTH);
      expect(res.status).toBe(200);
      expect(listAllowedArg).toEqual([]);
      expect(listAllowedArg).not.toBe('all-projects'); // that sentinel would mean ALL projects
    });
  });

  it('a request naming NO project at all still gets the pre-existing 400, not a 500', async () => {
    const res = await request(app)
      .get('/api/embedding/similarity')
      .query({ id: 'contexts' })
      .set('Authorization', AUTH);
    expect(res.status).toBe(400);
    expect(serviceCalls).toEqual([]);
  });
});
