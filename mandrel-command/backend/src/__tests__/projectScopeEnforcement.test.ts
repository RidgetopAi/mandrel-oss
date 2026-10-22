/**
 * projectScopeEnforcement.test.ts — behavioural proof of the F-04 closure
 *: the X-Project-ID header is AUTHORIZED, not just format-checked.
 *
 * Before this change, middleware/project.ts attached req.projectId after only a UUID
 * regex — the explicit TODO ("trust the authenticated user has access") that let any
 * authenticated caller scope any request to ANY project. This suite drives the REAL
 * projectContextMiddleware, mounted exactly as server.ts mounts it (app-level, BEFORE
 * route auth), with only the two DB doors stubbed (AuthService, ProjectAccessService).
 * The probe route echoes req.projectId — attachment IS the privilege, so asserting what
 * got attached is stronger than asserting a status code.
 *
 * ── POPULATION, WIDENED BY an earlier TASK ────────────────────────────────────────────
 * THE BLIND SPOT THIS HEADER USED TO DESCRIBE: it enumerated one DOOR — the
 * `X-Project-ID` header — and was thorough on it. `req.projectId` was never the only way
 * a controller learned its project scope. `?project_id=`, `?project=`, `?projectId=` and
 * `body.projectId` all reached the same scope with NO authorization, because the check
 * was written `if (headerPresent)`. A `grep -c` here for a query or body variant returned
 * 0. The surface was right; the population was one door wide.
 *
 * The population is now DERIVED, not hand-listed: every entry of
 * services/projectScopeResolver.ts:PROJECT_SCOPE_SOURCES gets its own deny / allow /
 * malformed case, so a NEW source added there with no enforcement fails this suite
 * instead of quietly widening the door (the three-part shape:
 * derive → snapshot the derivation → trap the empty population).
 *
 * PER-SOURCE (derived): non-admin no grant → 403 and NOT attached · non-admin with grant
 * → attached · malformed value → 400 · empty/whitespace value → treated as absent.
 * CROSS-SOURCE: documented precedence (query > header > body) · EVERY candidate is
 * authorized, not just the winning one · a repeated param with disagreeing values → 400 ·
 * a non-string (bracketed/object) param → 400 · the `all` sentinel → explicitly unscoped.
 * CALLER (unchanged, header door): absent · malformed · valid-but-no-caller (401) ·
 * admin bypass · role missing/empty/unknown (must fall to the grant check, never bypass) ·
 * inactive/unknown user (401) · access check THROWS (500, never attach).
 *
 * NOT COVERED HERE (stated, per C3): nested body refs on the /api/mcp passthrough
 * (routes/mcp.ts, its own tests), project references by NAME, and the mcp-server process.
 */
import request from 'supertest';
import express, { Express, Response } from 'express';

const TOKEN_BY_KIND: Record<string, string> = {
  admin: 'admin.aaa.bbb',
  user: 'user.aaa.bbb',
  norole: 'norole.aaa.bbb',
  emptyrole: 'emptyrole.aaa.bbb',
  weirdrole: 'weirdrole.aaa.bbb',
  ghost: 'ghost.aaa.bbb',
};

jest.mock('../services/auth', () => ({
  AuthService: {
    verifyJWT: (token: string) => {
      const kind = Object.keys(TOKEN_BY_KIND).find((k) => TOKEN_BY_KIND[k] === token);
      return kind ? { userId: kind, tokenId: `t-${kind}` } : null;
    },
    validateSession: async () => true,
    findUserById: async (userId: string) => {
      if (userId === 'ghost') return null; // unknown or is_active=false → the same null
      const roles: Record<string, unknown> = {
        admin: 'admin',
        user: 'user',
        norole: undefined,
        emptyrole: '',
        weirdrole: 'superadmin',
      };
      return { id: userId, username: userId, role: roles[userId], is_active: true };
    },
  },
}));

jest.mock('../services/project', () => ({
  ProjectService: { getProjectById: jest.fn() },
}));

jest.mock('../services/projectAccess', () => {
  const actual = jest.requireActual('../services/projectAccess');
  return {
    ProjectAccessService: {
      ...actual.ProjectAccessService,
      userHasProjectAccess: jest.fn(),
    },
  };
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { ProjectAccessService } = require('../services/projectAccess');

import { projectContextMiddleware } from '../middleware/project';
import { AuthenticatedRequest } from '../types/auth';
import {
  PROJECT_SCOPE_SOURCES,
  UNSCOPED_SENTINEL,
  getRequestProjectId,
  type ProjectSourceSpec,
} from '../services/projectScopeResolver';

const PROJECT_A = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  // Mounted the way server.ts mounts it: app-level on /api, before any route auth.
  app.use('/api', projectContextMiddleware);
  const echo = (req: express.Request, res: Response) => {
    const r = req as AuthenticatedRequest;
    res.json({
      attached: r.projectId ?? null,
      scope: r.projectScope ?? null,
      // getRequestProjectId is the ONLY supported accessor — assert what handlers see.
      viaAccessor: r.projectScope ? getRequestProjectId(r) ?? null : 'THREW',
    });
  };
  app.get('/api/probe', echo);
  app.post('/api/probe', echo);
  return app;
}

describe('projectContextMiddleware — X-Project-ID is authorized, not trusted (F-04)', () => {
  let app: Express;

  beforeEach(() => {
    jest.clearAllMocks();
    app = buildApp();
  });

  it('no header → passes through unscoped (the pre-existing contract, unchanged)', async () => {
    const res = await request(app).get('/api/probe');
    expect(res.status).toBe(200);
    expect(res.body.attached).toBeNull();
    expect(ProjectAccessService.userHasProjectAccess).not.toHaveBeenCalled();
  });

  it('malformed project id → 400 (unchanged)', async () => {
    const res = await request(app)
      .get('/api/probe')
      .set('Authorization', `Bearer ${TOKEN_BY_KIND.admin}`)
      .set('X-Project-ID', 'not-a-uuid');
    expect(res.status).toBe(400);
  });

  it('scoped request with NO verifiable caller → 401 (used to sail through and attach)', async () => {
    const res = await request(app).get('/api/probe').set('X-Project-ID', PROJECT_A);
    expect(res.status).toBe(401);
  });

  it('scoped request from an unknown/inactive user → 401', async () => {
    const res = await request(app)
      .get('/api/probe')
      .set('Authorization', `Bearer ${TOKEN_BY_KIND.ghost}`)
      .set('X-Project-ID', PROJECT_A);
    expect(res.status).toBe(401);
  });

  it('non-admin WITHOUT a grant → 403 and req.projectId is NEVER attached', async () => {
    ProjectAccessService.userHasProjectAccess.mockResolvedValue(false);
    const res = await request(app)
      .get('/api/probe')
      .set('Authorization', `Bearer ${TOKEN_BY_KIND.user}`)
      .set('X-Project-ID', PROJECT_A);
    expect(res.status).toBe(403);
    expect(ProjectAccessService.userHasProjectAccess).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'user', role: 'user' }),
      PROJECT_A
    );
  });

  it('non-admin WITH a grant → attached (positive control — the RED above means something)', async () => {
    ProjectAccessService.userHasProjectAccess.mockResolvedValue(true);
    const res = await request(app)
      .get('/api/probe')
      .set('Authorization', `Bearer ${TOKEN_BY_KIND.user}`)
      .set('X-Project-ID', PROJECT_A);
    expect(res.status).toBe(200);
    expect(res.body.attached).toBe(PROJECT_A);
  });

  it('admin → attached (the role bypass reaches the service, which answers true)', async () => {
    // The bypass lives INSIDE userHasProjectAccess (real implementation); here the
    // mocked service just proves the middleware consults it with the admin identity.
    ProjectAccessService.userHasProjectAccess.mockResolvedValue(true);
    const res = await request(app)
      .get('/api/probe')
      .set('Authorization', `Bearer ${TOKEN_BY_KIND.admin}`)
      .set('X-Project-ID', PROJECT_A);
    expect(res.status).toBe(200);
    expect(res.body.attached).toBe(PROJECT_A);
    expect(ProjectAccessService.userHasProjectAccess).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'admin', role: 'admin' }),
      PROJECT_A
    );
  });

  it.each([['norole'], ['emptyrole'], ['weirdrole']])(
    '%s falls to the grant check and is DENIED without a row (never a truthiness bypass)',
    async (kind) => {
      ProjectAccessService.userHasProjectAccess.mockResolvedValue(false);
      const res = await request(app)
        .get('/api/probe')
        .set('Authorization', `Bearer ${TOKEN_BY_KIND[kind]}`)
        .set('X-Project-ID', PROJECT_A);
      expect(res.status).toBe(403);
      expect(ProjectAccessService.userHasProjectAccess).toHaveBeenCalledTimes(1);
    }
  );

  it('access check THROWS → 500, never attach (C1: could-not-measure ≠ allow ≠ deny)', async () => {
    ProjectAccessService.userHasProjectAccess.mockRejectedValue(new Error('db down'));
    const res = await request(app)
      .get('/api/probe')
      .set('Authorization', `Bearer ${TOKEN_BY_KIND.user}`)
      .set('X-Project-ID', PROJECT_A);
    expect(res.status).toBe(500);
  });
});

// =============================================================================
// an earlier TASK — the population is DERIVED from the resolver, not hand-listed
// =============================================================================
// The three-part shape. Part 1 derives; part 2 snapshots the
// derivation by hand (looks redundant, and is the ONLY thing that catches a WRONG
// derivation — e.g. a mis-typed accessor returning [] or the wrong array); part 3 traps
// the empty population so a derivation that silently collapses cannot sail through green.

/** Part 1 — DERIVE from the source of truth. */
const DERIVED_SOURCE_KEYS = PROJECT_SCOPE_SOURCES.map((s) => s.key);

/**
 * Part 2 — the HAND-WRITTEN snapshot. If you add a project source, this list must be
 * updated deliberately, and the per-source cases below will then demand enforcement for
 * it. Order is PRECEDENCE order and is asserted: it is the documented contract, not an
 * accident of array literal order.
 */
const EXPECTED_SOURCE_KEYS = [
  'query.project_id',
  'query.project',
  'query.projectId',
  'header.x-project-id',
  'body.projectId',
  // Added deliberately after a live probe found `POST /api/tasks` scopes on the SNAKE-case
  // spelling (controllers/task.ts:124) and validation/schemas.ts declares `project_id` on
  // seven request bodies. This snapshot is what forced that to be a decision instead of a
  // silent widening — it went RED the moment the source list grew.
  'body.project_id',
];

/** Put `value` on a supertest request through exactly `spec`'s door. */
function withSource(req: request.Test, spec: ProjectSourceSpec, value: unknown): request.Test {
  switch (spec.location) {
    case 'header':
      return req.set(spec.name, String(value));
    case 'query':
      return req.query({ [spec.name]: value as string });
    case 'body':
      return req.send({ [spec.name]: value });
  }
}

/** A POST for the body door (a body on a GET is not a shape any client sends). */
function probe(app: Express, spec: ProjectSourceSpec): request.Test {
  return spec.location === 'body' ? request(app).post('/api/probe') : request(app).get('/api/probe');
}

describe('project scope sources — the derived population', () => {
  let app: Express;
  beforeEach(() => {
    jest.clearAllMocks();
    app = buildApp();
  });

  it('part 2 — the derived source list matches the hand-written snapshot, in order', () => {
    expect(DERIVED_SOURCE_KEYS).toEqual(EXPECTED_SOURCE_KEYS);
  });

  it('part 3 — the derived population is NON-EMPTY (an empty one must not pass green)', () => {
    expect(DERIVED_SOURCE_KEYS.length).toBeGreaterThanOrEqual(6);
    expect(PROJECT_SCOPE_SOURCES.every((s) => s.key && s.name && s.location)).toBe(true);
  });

  describe.each(PROJECT_SCOPE_SOURCES.map((s) => [s.key, s] as const))(
    'source %s',
    (_key, spec) => {
      it('non-admin WITHOUT a grant → 403, and NOTHING is attached', async () => {
        ProjectAccessService.userHasProjectAccess.mockResolvedValue(false);
        const res = await withSource(probe(app, spec), spec, PROJECT_A).set(
          'Authorization',
          `Bearer ${TOKEN_BY_KIND.user}`
        );
        expect(res.status).toBe(403);
        expect(ProjectAccessService.userHasProjectAccess).toHaveBeenCalledWith(
          expect.objectContaining({ id: 'user', role: 'user' }),
          PROJECT_A
        );
      });

      it('non-admin WITH a grant → 200 and attached (positive control)', async () => {
        ProjectAccessService.userHasProjectAccess.mockResolvedValue(true);
        const res = await withSource(probe(app, spec), spec, PROJECT_A).set(
          'Authorization',
          `Bearer ${TOKEN_BY_KIND.user}`
        );
        expect(res.status).toBe(200);
        expect(res.body.attached).toBe(PROJECT_A);
        expect(res.body.viaAccessor).toBe(PROJECT_A);
      });

      it('a project named here with NO verifiable caller → 401', async () => {
        const res = await withSource(probe(app, spec), spec, PROJECT_A);
        expect(res.status).toBe(401);
      });

      it('the access check THROWS → 500, never attached', async () => {
        ProjectAccessService.userHasProjectAccess.mockRejectedValue(new Error('db down'));
        const res = await withSource(probe(app, spec), spec, PROJECT_A).set(
          'Authorization',
          `Bearer ${TOKEN_BY_KIND.user}`
        );
        expect(res.status).toBe(500);
      });

      it('a malformed value → 400 before any authorization runs', async () => {
        ProjectAccessService.userHasProjectAccess.mockResolvedValue(true);
        const res = await withSource(probe(app, spec), spec, 'not-a-uuid').set(
          'Authorization',
          `Bearer ${TOKEN_BY_KIND.admin}`
        );
        expect(res.status).toBe(400);
        expect(ProjectAccessService.userHasProjectAccess).not.toHaveBeenCalled();
      });

      it.each(['', '   '])(
        'an empty/whitespace value (%j) is ABSENT, not a scope — unscoped, no check',
        async (blank) => {
          ProjectAccessService.userHasProjectAccess.mockResolvedValue(true);
          const res = await withSource(probe(app, spec), spec, blank).set(
            'Authorization',
            `Bearer ${TOKEN_BY_KIND.admin}`
          );
          expect(res.status).toBe(200);
          expect(res.body.attached).toBeNull();
          expect(ProjectAccessService.userHasProjectAccess).not.toHaveBeenCalled();
        }
      );

      it('a MIXED-CASE uuid is the same grant, normalized (no case-split doors)', async () => {
        ProjectAccessService.userHasProjectAccess.mockResolvedValue(true);
        const res = await withSource(probe(app, spec), spec, PROJECT_A.toUpperCase()).set(
          'Authorization',
          `Bearer ${TOKEN_BY_KIND.user}`
        );
        expect(res.status).toBe(200);
        expect(ProjectAccessService.userHasProjectAccess).toHaveBeenCalledWith(
          expect.anything(),
          PROJECT_A
        );
        expect(res.body.attached).toBe(PROJECT_A);
      });

      it(`the '${UNSCOPED_SENTINEL}' sentinel is ${'accepted only on query sources'}`, async () => {
        ProjectAccessService.userHasProjectAccess.mockResolvedValue(true);
        const res = await withSource(probe(app, spec), spec, UNSCOPED_SENTINEL).set(
          'Authorization',
          `Bearer ${TOKEN_BY_KIND.admin}`
        );
        if (spec.acceptsUnscopedSentinel) {
          expect(res.status).toBe(200);
          expect(res.body.attached).toBeNull();
          expect(res.body.scope.explicitlyUnscoped).toBe(true);
        } else {
          // 'all' is not a uuid and this source never meant it → malformed.
          expect(res.status).toBe(400);
        }
      });
    }
  );
});

describe('project scope — cross-source behaviour', () => {
  let app: Express;
  beforeEach(() => {
    jest.clearAllMocks();
    app = buildApp();
  });

  const PROJECT_B = 'bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee';

  it('PRECEDENCE: the query param WINS over the header (the live frontend contract)', async () => {
    ProjectAccessService.userHasProjectAccess.mockResolvedValue(true);
    const res = await request(app)
      .get('/api/probe')
      .query({ project_id: PROJECT_B })
      .set('Authorization', `Bearer ${TOKEN_BY_KIND.admin}`)
      .set('X-Project-ID', PROJECT_A);
    expect(res.status).toBe(200);
    expect(res.body.attached).toBe(PROJECT_B);
    expect(res.body.scope.sourceKey).toBe('query.project_id');
  });

  it("PRECEDENCE: `project=all` beats a header project → explicitly unscoped", async () => {
    ProjectAccessService.userHasProjectAccess.mockResolvedValue(true);
    const res = await request(app)
      .get('/api/probe')
      .query({ project: UNSCOPED_SENTINEL })
      .set('Authorization', `Bearer ${TOKEN_BY_KIND.admin}`)
      .set('X-Project-ID', PROJECT_A);
    expect(res.status).toBe(200);
    expect(res.body.attached).toBeNull();
    expect(res.body.scope.explicitlyUnscoped).toBe(true);
  });

  it('PRECEDENCE: the header WINS over the body (preserves requireWriteProjectId)', async () => {
    ProjectAccessService.userHasProjectAccess.mockResolvedValue(true);
    const res = await request(app)
      .post('/api/probe')
      .set('Authorization', `Bearer ${TOKEN_BY_KIND.admin}`)
      .set('X-Project-ID', PROJECT_A)
      .send({ projectId: PROJECT_B });
    expect(res.status).toBe(200);
    expect(res.body.attached).toBe(PROJECT_A);
  });

  it('EVERY candidate is authorized, not just the winner — a LOSING source that is denied still 403s', async () => {
    // The bug this pins: "authorize the winner" is the same defect one layer in, because
    // the caller chooses which source wins. Here the winning query param is granted and
    // the LOSING body project is not; the request must still be refused.
    ProjectAccessService.userHasProjectAccess.mockImplementation(
      async (_u: unknown, p: string) => p === PROJECT_A
    );
    const res = await request(app)
      .post('/api/probe')
      .query({ project_id: PROJECT_A })
      .set('Authorization', `Bearer ${TOKEN_BY_KIND.user}`)
      .send({ projectId: PROJECT_B });
    expect(res.status).toBe(403);
  });

  it("EVERY candidate is authorized even when `all` wins — 'all' cannot launder an ungranted id", async () => {
    ProjectAccessService.userHasProjectAccess.mockResolvedValue(false);
    const res = await request(app)
      .get('/api/probe')
      .query({ project_id: UNSCOPED_SENTINEL })
      .set('Authorization', `Bearer ${TOKEN_BY_KIND.user}`)
      .set('X-Project-ID', PROJECT_A);
    expect(res.status).toBe(403);
  });

  it('a REPEATED param with disagreeing values → 400, never a silent pick', async () => {
    ProjectAccessService.userHasProjectAccess.mockResolvedValue(true);
    const res = await request(app)
      .get(`/api/probe?project_id=${PROJECT_A}&project_id=${PROJECT_B}`)
      .set('Authorization', `Bearer ${TOKEN_BY_KIND.admin}`);
    expect(res.status).toBe(400);
    expect(ProjectAccessService.userHasProjectAccess).not.toHaveBeenCalled();
  });

  it('a REPEATED param with IDENTICAL values collapses to one candidate (not a 400)', async () => {
    ProjectAccessService.userHasProjectAccess.mockResolvedValue(true);
    const res = await request(app)
      .get(`/api/probe?project_id=${PROJECT_A}&project_id=${PROJECT_A}`)
      .set('Authorization', `Bearer ${TOKEN_BY_KIND.admin}`);
    expect(res.status).toBe(200);
    expect(res.body.attached).toBe(PROJECT_A);
    expect(ProjectAccessService.userHasProjectAccess).toHaveBeenCalledTimes(1);
  });

  it('a BRACKETED param (`?project_id[x]=y`, an object to Express) → 400', async () => {
    ProjectAccessService.userHasProjectAccess.mockResolvedValue(true);
    const res = await request(app)
      .get(`/api/probe?project_id[x]=${PROJECT_A}`)
      .set('Authorization', `Bearer ${TOKEN_BY_KIND.admin}`);
    expect(res.status).toBe(400);
  });

  it('a NON-STRING body projectId (a number) → 400', async () => {
    ProjectAccessService.userHasProjectAccess.mockResolvedValue(true);
    const res = await request(app)
      .post('/api/probe')
      .set('Authorization', `Bearer ${TOKEN_BY_KIND.admin}`)
      .send({ projectId: 12345 });
    expect(res.status).toBe(400);
  });

  it('getRequestProjectId THROWS on a request the middleware never touched (loud, not "unscoped")', () => {
    expect(() => getRequestProjectId({} as never)).toThrow(/never resolved/i);
  });

  it('an unscoped request still gets a resolved scope object (resolved ≠ absent)', async () => {
    const res = await request(app).get('/api/probe');
    expect(res.status).toBe(200);
    expect(res.body.scope).toEqual({
      explicitlyUnscoped: false,
      authorizedProjectIds: [],
    });
    expect(res.body.viaAccessor).toBeNull();
  });
});

// =============================================================================
// PATH PARAMS — the door an app-level middleware structurally cannot see
// =============================================================================
// `req.params` does not exist until Express has ROUTED, so projectContextMiddleware runs
// too early to see `/projects/:id`. A path param carrying a project id had only a uuid
// SHAPE check, so any authenticated user could read any project. authorizeProjectPathParam
// is the router-level choke point that closes it, delegating to the SAME
// ProjectAccessService. The router under test is the REAL routes/projects.ts
// (`router.param('id', …)`), mounted as server.ts mounts it; only the controller's
// service is stubbed, and `getProjectById` being called IS "the handler ran".
describe('authorizeProjectPathParam — the router-level door', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { ProjectService } = require('../services/project');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const projectsRouter = require('../routes/projects').default;
  const BEARER = { admin: 'Bearer admin.aaa.bbb', user: 'Bearer user.aaa.bbb' };

  function buildParamApp(): Express {
    const app = express();
    app.use(express.json());
    app.use('/api/projects', projectsRouter);
    return app;
  }

  let app: Express;
  beforeEach(() => {
    jest.clearAllMocks();
    ProjectService.getProjectById.mockResolvedValue({ id: PROJECT_A, name: 'p' });
    app = buildParamApp();
  });

  it('non-admin WITHOUT a grant → 403, and the handler NEVER runs', async () => {
    ProjectAccessService.userHasProjectAccess.mockResolvedValue(false);
    const res = await request(app).get(`/api/projects/${PROJECT_A}`).set('Authorization', BEARER.user);
    expect(res.status).toBe(403);
    expect(ProjectService.getProjectById).not.toHaveBeenCalled();
  });

  it('non-admin WITH a grant → 200 (positive control — not a blanket deny)', async () => {
    ProjectAccessService.userHasProjectAccess.mockResolvedValue(true);
    const res = await request(app).get(`/api/projects/${PROJECT_A}`).set('Authorization', BEARER.user);
    expect(res.status).toBe(200);
    expect(ProjectService.getProjectById).toHaveBeenCalled();
  });

  it('admin → consulted with the admin identity and allowed', async () => {
    ProjectAccessService.userHasProjectAccess.mockResolvedValue(true);
    const res = await request(app).get(`/api/projects/${PROJECT_A}`).set('Authorization', BEARER.admin);
    expect(res.status).toBe(200);
    expect(ProjectAccessService.userHasProjectAccess).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'admin', role: 'admin' }),
      PROJECT_A
    );
  });

  it('no caller → 401', async () => {
    const res = await request(app).get(`/api/projects/${PROJECT_A}`);
    expect(res.status).toBe(401);
    expect(ProjectService.getProjectById).not.toHaveBeenCalled();
  });

  it('malformed uuid → 400 before any authorization runs', async () => {
    const res = await request(app).get('/api/projects/not-a-uuid').set('Authorization', BEARER.user);
    expect(res.status).toBe(400);
    expect(ProjectAccessService.userHasProjectAccess).not.toHaveBeenCalled();
  });

  it('the access check THROWS → 500, never allowed through', async () => {
    ProjectAccessService.userHasProjectAccess.mockRejectedValue(new Error('db down'));
    const res = await request(app).get(`/api/projects/${PROJECT_A}`).set('Authorization', BEARER.user);
    expect(res.status).toBe(500);
    expect(ProjectService.getProjectById).not.toHaveBeenCalled();
  });

  it('a MIXED-CASE uuid normalizes to the same grant (no case-split door)', async () => {
    ProjectAccessService.userHasProjectAccess.mockResolvedValue(true);
    await request(app).get(`/api/projects/${PROJECT_A.toUpperCase()}`).set('Authorization', BEARER.user);
    expect(ProjectAccessService.userHasProjectAccess).toHaveBeenCalledWith(expect.anything(), PROJECT_A);
  });

  it('the sub-resources /:id/insights and /:id/sessions are behind the same guard', async () => {
    ProjectAccessService.userHasProjectAccess.mockResolvedValue(false);
    for (const sub of ['insights', 'sessions']) {
      const res = await request(app).get(`/api/projects/${PROJECT_A}/${sub}`).set('Authorization', BEARER.user);
      expect(res.status).toBe(403);
    }
  });

  it('EVERY projects route carrying :id is covered by the guard (population, not sample)', () => {
    // Derived from the shipping route file, so the guard being unwired cannot pass
    // unnoticed: it is registered once with router.param, and this asserts the file still
    // registers it alongside every `/:id` path.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('fs');
    const src = fs.readFileSync(require('path').resolve(__dirname, '../routes/projects.ts'), 'utf8');
    const idRoutes = src.match(/['"]\/:id[^'"]*['"]/g) ?? [];
    expect(idRoutes.length).toBeGreaterThanOrEqual(5);
    // Asserted STRUCTURALLY, not as one literal: the param must be wired, and the wiring
    // must reach authorizeProjectPathParam.
    expect(src).toMatch(/router\.param\(\s*['"]id['"]\s*,/);
    expect(src).toContain('authorizeProjectPathParam(');
  });
});
