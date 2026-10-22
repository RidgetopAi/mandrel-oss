/**
 * an earlier task — the HTTP contract of the gated `DELETE /api/projects/:id`.
 *
 * The companion `projectDeleteDelegation.db.test.ts` proves the SERVICE cannot destroy a
 * project by itself. This one proves the ROUTE a browser (or a `curl`) actually hits
 * behaves like a gate: it mounts the REAL `routes/projects.ts` router and the REAL
 * `ProjectController`, so the thing under test is the shipped request path — not a
 * re-description of it.
 *
 * WHAT IS MOCKED AND WHY: `ProjectService.deleteProject` / `.getProjectById` (the DB +
 * delegation, covered by the db test) and the auth middleware's internals. Everything
 * between the URL and the controller — routing, `validateUUIDParam`, query parsing, the
 * status code, the response body — is real. The `?confirm=true` plumbing in particular is
 * asserted from the OUTSIDE, at the URL, because that is where a caller expresses it: a
 * test that called the controller directly could not catch the route dropping the query.
 *
 * DB-free and MCP-free by design; runs in the default `npm test`.
 */

import request from 'supertest';
import express, { Express } from 'express';

const VALID_TOKEN = 'aaa.bbb.ccc';

// Real `authenticateToken` runs; only its DB-touching internals are stubbed.
jest.mock('../services/auth', () => ({
  AuthService: {
    verifyJWT: (token: string) => (token === VALID_TOKEN ? { userId: 'u1', tokenId: 't1' } : null),
    validateSession: async () => true,
    findUserById: async () => ({
      id: 'u1',
      username: 'operator',
      email: 'operator@example.com',
      role: 'admin',
      theme: 'dark',
      is_active: true,
      created_at: new Date(),
      updated_at: new Date(),
    }),
  },
}));

jest.mock('../services/project', () => ({
  ProjectService: {
    getProjectById: jest.fn(),
    deleteProject: jest.fn(),
  },
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { ProjectService } = require('../services/project');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const projectsRouter = require('../routes/projects').default;

const PROJECT_ID = '11111111-2222-3333-4444-555555555555';

/** The gate's real refusal shape (mcp-server project_delete → delete_refused). */
const REFUSAL = {
  deleted: false,
  reason: 'needs_confirmation' as const,
  message:
    '⚠️  Refusing to delete project "victim" without confirmation.\n' +
    'Deleting it will CASCADE-DELETE 7 owned rows (3 contexts, 4 tasks) across 24 ' +
    'project-owned cascading tables.',
  impact: { byTable: { contexts: 3, tasks: 4 }, total: 7, unmeasurable: [] },
};

/**
 * The OTHER refusal, and the reason `requiresConfirmation` cannot be a constant.
 *
 * The route checks the session's active project BEFORE the confirm gate, so `?confirm=true`
 * returns this SAME refusal — telling the caller to confirm would send them round a loop
 * that cannot terminate. A machine field that says "retry with X" when X changes nothing is
 * the same defect class as a delete reporting a blast radius it never measured.
 */
const ACTIVE_PROJECT_REFUSAL = {
  deleted: false,
  reason: 'active_project' as const,
  message:
    '❌ Refusing to delete "victim": it is the active project for this session.\n\n' +
    'Owned data: 7 owned rows (3 contexts, 4 tasks) across 24 project-owned cascading tables.\n' +
    '💡 Switch to another project first: project_switch <other-project>',
  impact: { byTable: { contexts: 3, tasks: 4 }, total: 7, unmeasurable: [] },
};

describe('DELETE /api/projects/:id is a gate, not a bare delete', () => {
  let app: Express;

  beforeEach(() => {
    jest.clearAllMocks();
    ProjectService.getProjectById.mockResolvedValue({ id: PROJECT_ID, name: 'victim' });
    app = express();
    app.use(express.json());
    app.use('/api/projects', projectsRouter);
  });

  const del = (query = '') =>
    request(app)
      .delete(`/api/projects/${PROJECT_ID}${query}`)
      .set('Authorization', `Bearer ${VALID_TOKEN}`);

  it('POSITIVE CONTROL: a CONFIRMED delete reaches the service and returns 200', async () => {
    // Baseline. Without a case that is expected to SUCCEED, every 409 assertion below
    // could be produced by a route that is simply broken, and the suite would look like a
    // working gate while gating nothing (a past incident — refuse to read probes with no
    // positive control).
    ProjectService.deleteProject.mockResolvedValue({
      deleted: true,
      message: 'Project deleted successfully',
    });

    const res = await del('?confirm=true');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(ProjectService.deleteProject).toHaveBeenCalledWith(PROJECT_ID, true, 'operator');
  });

  it('refuses an UNCONFIRMED delete with 409, the blast-radius sentence, and the counts', async () => {
    ProjectService.deleteProject.mockResolvedValue(REFUSAL);

    const res = await del();

    expect(res.status).toBe(409);
    expect(res.body.success).toBe(false);
    expect(res.body.data.requiresConfirmation).toBe(true);
    expect(res.body.data.reason).toBe('needs_confirmation');
    expect(res.body.data.impact).toEqual(REFUSAL.impact);
    // The sentence must reach the caller under BOTH keys: `error` is this backend's
    // envelope convention, `message` is what the frontend's shared axios interceptor
    // reads. An `error`-only body renders as "Request failed with status code 409" and
    // the user never sees what they would have destroyed.
    expect(res.body.error).toContain('CASCADE-DELETE 7 owned rows');
    expect(res.body.message).toContain('CASCADE-DELETE 7 owned rows');
    // A refusal is NOT a success dressed in a 409.
    expect(res.body.data.message).toBeUndefined();
  });

  it('treats only the exact string "true" as confirmation — `?confirm=false` does NOT confirm', async () => {
    // A truthiness check on req.query.confirm makes the string 'false' confirm, which
    // would destroy a project on a request that literally says not to.
    ProjectService.deleteProject.mockResolvedValue(REFUSAL);

    for (const q of ['?confirm=false', '?confirm=1', '?confirm=yes', '?confirm=', '?confirm=TRUE']) {
      ProjectService.deleteProject.mockClear();
      const res = await del(q);
      expect(res.status).toBe(409);
      expect(ProjectService.deleteProject).toHaveBeenCalledWith(PROJECT_ID, false, 'operator');
    }
  });

  it('a REPEATED confirm param (express hands back an ARRAY) does not confirm', async () => {
    // `?confirm=true&confirm=true` makes req.query.confirm `['true','true']`. An array is
    // truthy, and `[...].includes('true')` would be a tempting "fix" — both would let a
    // caller confirm without ever writing a confirming request. Strict equality refuses.
    ProjectService.deleteProject.mockResolvedValue(REFUSAL);

    const res = await del('?confirm=true&confirm=true');

    expect(res.status).toBe(409);
    expect(ProjectService.deleteProject).toHaveBeenCalledWith(PROJECT_ID, false, 'operator');
  });

  it('does NOT claim requiresConfirmation on the ACTIVE-PROJECT refusal — confirming cannot help', async () => {
    // `requiresConfirmation` used to be a hardcoded `true` for every refusal. That was a
    // lie for this one: the caller would confirm, get the identical 409, and have no way
    // to learn that the fix is to switch project. Asserted on BOTH the unconfirmed and the
    // confirmed request, because it is the CONFIRMED one that exposes the lie.
    ProjectService.deleteProject.mockResolvedValue(ACTIVE_PROJECT_REFUSAL);

    for (const q of ['', '?confirm=true']) {
      const res = await del(q);
      expect(res.status).toBe(409);
      expect(res.body.data.requiresConfirmation).toBe(false);
      expect(res.body.data.reason).toBe('active_project');
      // The user still gets the actionable sentence — refusing legibly is the whole point.
      expect(res.body.message).toContain('active project for this session');
      expect(res.body.message).toContain('project_switch');
    }
  });

  it.each([
    ['last_project', 'it is the last remaining project'],
    ['unknown', 'refused'],
  ])('does NOT claim requiresConfirmation for a %s refusal either', async (reason, fragment) => {
    // The active-project case was the one I fixed first; these are its SIBLINGS, and the
    // 'last_project' one was a LIVE defect — the handler sent no reason at all, the old
    // whitelist defaulted it to 'needs_confirmation', and the API told the caller to retry
    // with confirm while `confirm=true` returned the identical refusal.
    //
    // 'unknown' is here because deny-by-default is the property that makes this class
    // closed rather than patched: a refusal reason invented upstream tomorrow lands on
    // FALSE without anyone editing this file.
    ProjectService.deleteProject.mockResolvedValue({
      deleted: false,
      reason,
      message: `❌ Refusing to delete "victim": ${fragment}.`,
      impact: { byTable: {}, total: 0, unmeasurable: [] },
    });

    for (const q of ['', '?confirm=true']) {
      const res = await del(q);
      expect(res.status).toBe(409);
      expect(res.body.data.requiresConfirmation).toBe(false);
      expect(res.body.data.reason).toBe(reason);
      expect(res.body.message).toContain(fragment);
    }
  });

  it('404s an unknown project WITHOUT delegating a destructive call', async () => {
    ProjectService.getProjectById.mockResolvedValue(null);

    const res = await del('?confirm=true');

    expect(res.status).toBe(404);
    expect(ProjectService.deleteProject).not.toHaveBeenCalled();
  });

  it('requires authentication — an unauthenticated DELETE never reaches the service', async () => {
    const res = await request(app).delete(`/api/projects/${PROJECT_ID}?confirm=true`);

    expect(res.status).toBe(401);
    expect(ProjectService.deleteProject).not.toHaveBeenCalled();
  });

  it('surfaces a delegation failure as 500 and never as a success', async () => {
    ProjectService.deleteProject.mockRejectedValue(new Error('Failed to delete project'));

    const res = await del('?confirm=true');

    expect(res.status).toBe(500);
    expect(res.body.success).toBe(false);
  });
});
