/**
 * projectCreationGrantsCreator — creating a project grants its CREATOR access to it
 * (scope addition).
 *
 * =============================================================================
 * THE GAP
 * =============================================================================
 * `user_project_access` had exactly ONE writer in the backend — the admin-only endpoint
 * at routes/users.ts:418 — and no UI drives it. So every project ever created was
 * invisible to every non-admin, permanently, until somebody hand-issued a grant. Masked
 * today because every human in the fleet is role=admin; it inverts the moment a real
 * non-admin exists, which is exactly when the F-04 closure in this same change makes the
 * deny bite on all four doors.
 *
 * =============================================================================
 * THE ASSERTION THAT MATTERS
 * =============================================================================
 * The deny-side of F-04 is already proven in projectScopeEnforcement.test.ts. A fix that
 * denies EVERYBODY passes every deny-test and is useless. So the load-bearing case here is
 * the ALLOW side: a non-admin creates a project and can then READ and WRITE it THROUGH THE
 * DOORS THAT WERE JUST CLOSED (`?project_id=`, `X-Project-ID`, `body.projectId`). That is
 * one end-to-end assertion that the grant is written AND that the resolver honours it.
 *
 * SEAMS: the DB (`database/connection`) and the MCP proxy are stubbed; the real
 * ProjectService, the real ProjectAccessService, the real projectContextMiddleware and the
 * real resolver all run. The stub is a tiny in-memory `user_project_access` + `projects`
 * so the TRANSACTION and the ON CONFLICT are observable without a live Postgres (the DB
 * suites in this repo require one and are skipped here).
 */

const grantRows: Array<{ user_id: string; project_id: string; granted_by: string | null }> = [];
let transactionLog: string[] = [];
let failGrantInsert = false;
const projectRows: Array<{ id: string; name: string }> = [];

const fakeClient = {
  query: jest.fn(async (sql: string, params?: unknown[]) => {
    const text = String(sql).trim();
    if (/^(BEGIN|COMMIT|ROLLBACK)$/i.test(text)) {
      transactionLog.push(text.toUpperCase());
      return { rows: [], rowCount: 0 };
    }
    if (/INSERT INTO projects/i.test(text)) {
      if (transactionLog[transactionLog.length - 1] !== 'BEGIN') {
        throw new Error('project INSERT ran OUTSIDE a transaction');
      }
      const row = {
        id: NEW_PROJECT_ID,
        name: (params as string[])[0],
        description: null,
        status: 'active',
        git_repo_url: null,
        root_directory: null,
        metadata: {},
        created_at: new Date(),
        updated_at: new Date(),
      };
      projectRows.push({ id: row.id, name: row.name });
      return { rows: [row], rowCount: 1 };
    }
    if (/INSERT INTO user_project_access/i.test(text)) {
      if (failGrantInsert) {
        const e: Error & { code?: string } = new Error('grant insert exploded');
        e.code = 'XXTEST';
        throw e;
      }
      const [userId, projectId] = params as string[];
      // ON CONFLICT (user_id, project_id) DO NOTHING
      if (!grantRows.some((r) => r.user_id === userId && r.project_id === projectId)) {
        grantRows.push({ user_id: userId, project_id: projectId, granted_by: userId });
      }
      return { rows: [], rowCount: 1 };
    }
    if (/FROM user_project_access/i.test(text)) {
      const [userId, projectId] = params as string[];
      const rows = grantRows.filter(
        (r) => r.user_id === userId && (projectId === undefined || r.project_id === projectId)
      );
      return { rows: rows.map((r) => ({ project_id: r.project_id })), rowCount: rows.length };
    }
    return { rows: [], rowCount: 0 };
  }),
  release: jest.fn(),
};

jest.mock('../database/connection', () => ({
  db: {
    connect: async () => fakeClient,
    query: (sql: string, params?: unknown[]) => fakeClient.query(sql, params),
  },
}));

jest.mock('../services/mcp', () => ({
  McpService: { callTool: jest.fn(async () => ({ success: true, data: {} })) },
}));

const NON_ADMIN = { id: 'user-non-admin', username: 'nonadmin', role: 'user' };
const ADMIN = { id: 'user-admin', username: 'admin', role: 'admin' };
const NEW_PROJECT_ID = 'aaaaaaaa-1111-2222-3333-aaaaaaaaaaaa';
const OTHER_PROJECT_ID = 'bbbbbbbb-1111-2222-3333-bbbbbbbbbbbb';

jest.mock('../services/auth', () => ({
  AuthService: {
    verifyJWT: (token: string) =>
      token === 'nonadmin.a.b'
        ? { userId: 'user-non-admin', tokenId: 't1' }
        : token === 'admin.a.b'
          ? { userId: 'user-admin', tokenId: 't2' }
          : null,
    findUserById: async (id: string) =>
      id === 'user-non-admin' ? NON_ADMIN : id === 'user-admin' ? ADMIN : null,
  },
}));

import request from 'supertest';
import express, { Express, Response } from 'express';
import { ProjectController } from '../controllers/project';
import { ProjectService } from '../services/project';
import { projectContextMiddleware } from '../middleware/project';
import { AuthenticatedRequest } from '../types/auth';
import { getRequestProjectId } from '../services/projectScopeResolver';

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  // Mounted exactly as server.ts mounts it: app-level on /api, BEFORE route auth.
  app.use('/api', projectContextMiddleware);
  // A probe route standing in for the ~20 real controllers: it reports the AUTHORIZED
  // project. Reaching it at all is the privilege — the middleware 403s before it runs.
  const echo = (req: express.Request, res: Response) =>
    res.json({ projectId: getRequestProjectId(req as AuthenticatedRequest) ?? null });
  app.get('/api/probe', echo);
  app.post('/api/probe', echo);
  // The real create endpoint, with the caller attached the way authenticateToken does.
  app.post('/api/projects', (req, _res, next) => {
    const token = (req.headers.authorization ?? '').replace('Bearer ', '');
    (req as AuthenticatedRequest).user =
      token === 'nonadmin.a.b' ? (NON_ADMIN as never) : token === 'admin.a.b' ? (ADMIN as never) : undefined;
    next();
  }, ProjectController.createProject);
  return app;
}

beforeEach(() => {
  grantRows.length = 0;
  projectRows.length = 0;
  transactionLog = [];
  failGrantInsert = false;
  jest.clearAllMocks();
});

describe('creating a project grants its creator access', () => {
  it('THE END-TO-END CASE: a non-admin creates a project, then READS and WRITES it through every door F-04 closed', async () => {
    const app = buildApp();

    const created = await request(app)
      .post('/api/projects')
      .set('Authorization', 'Bearer nonadmin.a.b')
      .send({ name: 'made-by-a-non-admin' });
    expect(created.status).toBe(201);
    const projectId = created.body.data.project.id;

    // READ through the query-param door (the ~20 controller sites).
    const viaQuery = await request(app)
      .get('/api/probe')
      .query({ project_id: projectId })
      .set('Authorization', 'Bearer nonadmin.a.b');
    expect(viaQuery.status).toBe(200);
    expect(viaQuery.body.projectId).toBe(projectId);

    // READ through the header door (the one closed).
    const viaHeader = await request(app)
      .get('/api/probe')
      .set('Authorization', 'Bearer nonadmin.a.b')
      .set('X-Project-ID', projectId);
    expect(viaHeader.status).toBe(200);
    expect(viaHeader.body.projectId).toBe(projectId);

    // WRITE through the body door (services/requestProjectScope.ts's old blind spot).
    const viaBody = await request(app)
      .post('/api/probe')
      .set('Authorization', 'Bearer nonadmin.a.b')
      .send({ projectId });
    expect(viaBody.status).toBe(200);
    expect(viaBody.body.projectId).toBe(projectId);
  });

  it('the SAME non-admin is still DENIED a project it did not create (the grant is not blanket)', async () => {
    const app = buildApp();
    await request(app)
      .post('/api/projects')
      .set('Authorization', 'Bearer nonadmin.a.b')
      .send({ name: 'mine' });

    const res = await request(app)
      .get('/api/probe')
      .query({ project_id: OTHER_PROJECT_ID })
      .set('Authorization', 'Bearer nonadmin.a.b');
    expect(res.status).toBe(403);
  });

  it('writes the grant row with the AUTHENTICATED creator, and ignores a body-supplied one', async () => {
    const app = buildApp();
    await request(app)
      .post('/api/projects')
      .set('Authorization', 'Bearer nonadmin.a.b')
      // A client trying to attribute the project (and thus the grant) to someone else.
      .send({ name: 'x', createdBy: 'user-admin', user_id: 'user-admin', granted_by: 'user-admin' });

    expect(grantRows).toEqual([
      { user_id: 'user-non-admin', project_id: NEW_PROJECT_ID, granted_by: 'user-non-admin' },
    ]);
  });

  it('the grant is written in the SAME TRANSACTION as the project insert', async () => {
    const app = buildApp();
    await request(app)
      .post('/api/projects')
      .set('Authorization', 'Bearer nonadmin.a.b')
      .send({ name: 'x' });

    // BEGIN … COMMIT with both inserts inside. The fake client throws if the project
    // INSERT runs outside a transaction, so this is enforced, not merely observed.
    expect(transactionLog).toEqual(['BEGIN', 'COMMIT']);
    const order = fakeClient.query.mock.calls.map(([sql]) => String(sql).trim().split('\n')[0]);
    const iProject = order.findIndex((q) => /INSERT INTO projects/i.test(q));
    const iGrant = order.findIndex((q) => /INSERT INTO user_project_access/i.test(q));
    const iCommit = order.findIndex((q) => /^COMMIT$/i.test(q));
    expect(iProject).toBeGreaterThan(-1);
    expect(iGrant).toBeGreaterThan(iProject);
    expect(iCommit).toBeGreaterThan(iGrant);
  });

  it('a FAILED grant ROLLS BACK the project — "a project with no grant" must be unreachable', async () => {
    failGrantInsert = true;
    const app = buildApp();
    const res = await request(app)
      .post('/api/projects')
      .set('Authorization', 'Bearer nonadmin.a.b')
      .send({ name: 'x' });

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(transactionLog).toEqual(['BEGIN', 'ROLLBACK']);
    expect(grantRows).toEqual([]);
  });

  it('an ADMIN creator ALSO gets a row (the grant table is the honest record, not the role column)', async () => {
    // Decided deliberately: admins short-circuit userHasProjectAccess and do not need this
    // row, but writing it means a later DEMOTION does not silently strip them of every
    // project they built.
    const app = buildApp();
    await request(app)
      .post('/api/projects')
      .set('Authorization', 'Bearer admin.a.b')
      .send({ name: 'admin-made' });

    expect(grantRows).toEqual([
      { user_id: 'user-admin', project_id: NEW_PROJECT_ID, granted_by: 'user-admin' },
    ]);
  });

  it('the grant insert is IDEMPOTENT — a pre-existing row is not an error and is not duplicated', async () => {
    grantRows.push({ user_id: 'user-non-admin', project_id: NEW_PROJECT_ID, granted_by: null });
    const app = buildApp();
    const res = await request(app)
      .post('/api/projects')
      .set('Authorization', 'Bearer nonadmin.a.b')
      .send({ name: 'x' });

    expect(res.status).toBe(201);
    expect(grantRows).toHaveLength(1);
  });

  it('a creation with NO identifiable caller is REFUSED (401), never a grantless project', async () => {
    // The state being eliminated is "a project exists that no non-admin can ever reach".
    // Creating one anyway would be that state, produced by the very change meant to
    // prevent it.
    const app = buildApp();
    const res = await request(app).post('/api/projects').send({ name: 'orphan' });
    expect(res.status).toBe(401);
    expect(projectRows).toEqual([]);
    expect(grantRows).toEqual([]);
  });

  it('ProjectService.createProject writes NO grant when given no creator (the service contract)', async () => {
    // Pinned so the service half is honest on its own: the refusal above lives in the
    // controller, and this documents what the service does if a future caller omits it.
    await ProjectService.createProject({ name: 'no-creator' } as never);
    expect(grantRows).toEqual([]);
    expect(transactionLog).toEqual(['BEGIN', 'COMMIT']);
  });
});
