/**
 * an earlier Task (minor bug #3) — getAllSessions honors its query params.
 *
 * THE BUG:
 *   The controller took `_req` and called `ProjectService.getAllSessions()`
 *   with no arguments, ignoring the `limit` and `project_id` the dashboard
 *   widget sends. The UI believed it was filtering but received every session.
 *
 * THE FIX:
 *   The controller parses `project_id` (must be a valid UUID) and `limit`
 *   (positive int) and forwards them to the service.
 *
 * This test mocks the service layer (no DB) and asserts the controller forwards
 * exactly the right, validated options.
 *
 * ── UPDATED BY an earlier TASK ─────────────────────────────────────────────────────────
 * `project_id` is no longer parsed by this controller. It is resolved AND AUTHORIZED once,
 * upstream, by projectContextMiddleware → services/projectScopeResolver.ts, and the
 * controller reads the answer with getRequestProjectId(). Two consequences pinned below:
 *   - the app must carry a scope-resolving middleware (`resolveScopeForTest`), because the
 *     accessor THROWS rather than answering "no project" for an unresolved request;
 *   - a MALFORMED project_id is now a 400, where it used to be silently DROPPED. Dropping
 *     it widened the query from one project to ALL of them — a scope failure answering as
 *     a success. `limit` parsing is unchanged and still ignores garbage.
 */
import request from 'supertest';
import express from 'express';

// Mock the service so we can assert what the controller passes it.
const getAllSessionsMock = jest.fn().mockResolvedValue([]);
jest.mock('../services/project', () => ({
  ProjectService: {
    getAllSessions: (...args: unknown[]) => getAllSessionsMock(...args),
  },
}));

// Avoid pulling the DB/logger config chain unnecessarily.
jest.mock('../config/logger', () => ({
  logger: { error: jest.fn(), info: jest.fn(), warn: jest.fn() },
}));

import { ProjectController } from '../controllers/project';
import { attachResolvedScope } from './helpers/projectScope';
import { extractProjectCandidates } from '../services/projectScopeResolver';

const app = express();
// Stands in for projectContextMiddleware's RESOLUTION half (its AUTHORIZATION half is
// exercised against the real middleware in projectScopeEnforcement.test.ts). It uses the
// real extractor, so the 400-on-malformed behaviour asserted below is the shipping rule.
app.use((req, res, next) => {
  // A LIST READ NOW NEEDS A CALLER (an earlier task item 7): "unscoped" resolves to the
  // caller's authorized projects, so there has to be one. Admin here keeps this suite
  // about PARAM HANDLING; the authorization itself is exercised in
  // projectScopeEnforcement.test.ts and unscopedListProjectScope.db.test.ts.
  (req as never as { user: unknown }).user = { id: 'admin-user', role: 'admin' };
  const extracted = extractProjectCandidates(req);
  if (!extracted.ok) {
    res.status(extracted.failure.status).json({ success: false, error: extracted.failure.error });
    return;
  }
  attachResolvedScope(req as never);
  next();
});
app.get('/projects/sessions/all', ProjectController.getAllSessions);

const VALID_UUID = 'c875b2af-9020-41b7-9595-d70221603464';

beforeEach(() => {
  getAllSessionsMock.mockClear();
});

describe('GET /projects/sessions/all — param handling', () => {
  test('forwards a valid project_id and limit', async () => {
    await request(app)
      .get(`/projects/sessions/all?project_id=${VALID_UUID}&limit=10`)
      .expect(200);

    expect(getAllSessionsMock).toHaveBeenCalledWith({
      scope: { mode: 'projects', projectIds: [VALID_UUID] },
      limit: 10,
    });
  });

  test('REFUSES an INVALID (non-UUID) project_id with a 400 — never silently unscoped', async () => {
    // WAS: 200 with projectId dropped to undefined. That answer widened a one-project
    // query to every project and told the caller it had succeeded.
    await request(app)
      .get('/projects/sessions/all?project_id=session_voiceitt-bridge&limit=5')
      .expect(400);

    expect(getAllSessionsMock).not.toHaveBeenCalled();
  });

  test('ignores a non-positive / non-numeric limit', async () => {
    await request(app)
      .get('/projects/sessions/all?limit=-3')
      .expect(200);
    // NO PROJECT NAMED IS NOT "NO FILTER" ANY MORE (an earlier task item 7). The caller
    // above is an admin, so the resolved scope is the explicit ALL_PROJECTS word; a
    // non-admin would get its grant set here, and a grantless one the empty set.
    expect(getAllSessionsMock).toHaveBeenCalledWith({
      scope: { mode: 'ALL_PROJECTS' },
      limit: undefined,
    });

    getAllSessionsMock.mockClear();
    await request(app).get('/projects/sessions/all?limit=abc').expect(200);
    // NO PROJECT NAMED IS NOT "NO FILTER" ANY MORE (an earlier task item 7). The caller
    // above is an admin, so the resolved scope is the explicit ALL_PROJECTS word; a
    // non-admin would get its grant set here, and a grantless one the empty set.
    expect(getAllSessionsMock).toHaveBeenCalledWith({
      scope: { mode: 'ALL_PROJECTS' },
      limit: undefined,
    });
  });

  test('no params → no filters', async () => {
    await request(app).get('/projects/sessions/all').expect(200);
    // NO PROJECT NAMED IS NOT "NO FILTER" ANY MORE (an earlier task item 7). The caller
    // above is an admin, so the resolved scope is the explicit ALL_PROJECTS word; a
    // non-admin would get its grant set here, and a grantless one the empty set.
    expect(getAllSessionsMock).toHaveBeenCalledWith({
      scope: { mode: 'ALL_PROJECTS' },
      limit: undefined,
    });
  });
});
