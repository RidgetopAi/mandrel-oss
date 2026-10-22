/**
 * DB + HTTP integration test for the navigation JSON resolve route
 * (routes/resolveJson.ts → GET /api/resolve/:id). Drives the FULL stack — real
 * Express route, real resolver, real parameterized SQL — and asserts the
 * SPA-facing JSON contract that the /r/:id interlinking landing depends on:
 *   200 { type,id,title,url } on a unique match,
 *   409 { candidates } on ambiguity (NEVER a silent pick),
 *   404 on a well-formed miss,
 *   400 on a malformed id,
 * plus project scoping — the JSON MIRROR of resolveNav.route.db.test.ts (proving
 * the two response shapes ride the SAME resolveNavId, no drift).
 *
 * ALWAYS-ON: this suite used to run only under a bespoke opt-in env
 * flag of its own —
 * a flag NO gate ever set, so it was dark in the CI gate AND in GitHub Actions from
 * the day it was written, and it rotted there (its fixtures no longer satisfied the
 * real NOT NULL columns). It is now gated by describeDb (helpers/dbContractGate) like
 * every other DB suite: it RUNS wherever Postgres is reachable and FAILS LOUDLY when
 * it is not. Point the shared pool at a disposable migrated DB, e.g.:
 *
 *   bash scripts/provision-test-db.sh ci_spine
 *   eval "$(bash scripts/provision-test-db.sh ci_spine --print-env)"
 *     npm test -- resolveJson.route.db
 */

import request from 'supertest';
import { projectContextMiddleware } from '../middleware/project';
import express from 'express';

// Bypass auth for routing/resolution tests (auth is covered by its own suite).
jest.mock('../middleware/auth', () => ({
  // A NAV RESOLVE NOW NEEDS A CALLER. `resolveNavId` takes a required
  // ProjectListScope, and the only supported way to build one from a request is
  // `resolveListScope(req)`, which reads `req.user` and THROWS when there is none —
  // fail-loud on purpose, because answering "no caller, so no scope" is how a
  // cross-project resolve used to happen silently. This mock previously called `next()`
  // with no user at all, so every case here 500'd.
  //
  // ADMIN, deliberately: this suite is about RESOLUTION SEMANTICS (302 / 409 / 404 /
  // short-prefix / ambiguity), not authorization. The authorization of these same routes
  // is exercised against real personas in entityDetailProjectScope.db.test.ts.
  authenticateToken: (req: { user?: unknown }, _res: unknown, next: () => void) => {
    req.user = { id: '00000000-0000-4000-8000-000000000001', role: 'admin' };
    next();
  },
}));

// a request that NAMES A PROJECT is now AUTHORIZED, so it needs an
// identifiable caller — in production that is always the Authorization header these
// routes already require. The two DB doors the middleware uses are stubbed here (the
// authorization decision has its own population in projectScopeEnforcement.test.ts);
// `scoped()` below attaches the header the real client always sends.
jest.mock('../services/auth', () => ({
  AuthService: {
    verifyJWT: () => ({ userId: 'resolve-suite-user', tokenId: 't' }),
    findUserById: async () => ({ id: 'resolve-suite-user', role: 'admin' }),
  },
}));
jest.mock('../services/projectAccess', () => ({
  ProjectAccessService: { userHasProjectAccess: async () => true },
}));

import { db } from '../database/connection';
import resolveJsonRoutes from '../routes/resolveJson';
import { RESOLVABLE_TYPES } from '../utils/idResolver';
import { describeDb } from './helpers/dbContractGate';


// Crafted ids so we can force an 8-hex prefix COLLISION across two types.
// SUITE-UNIQUE PREFIX NAMESPACE (a5/c1/d0/e5/facef00d): these DB suites share ONE
// physical test DB (mandrel_spine_test) and run in PARALLEL jest workers, so every
// suite MUST own a distinct 8-hex fixture prefix — a shared prefix cross-contaminates
// the OTHER suite's ambiguity/short-id assertions (silent flake). resolveNav.route.db
// owns a*/b*/c*/f*; this suite owns a5*/c1*/d0*/e5*. Keep them disjoint.
const PROJECT_ID = 'e5e5e5e5-0000-4000-8000-000000000011';
const OTHER_PROJECT_ID = 'e5e5e5e5-0000-4000-8000-000000000012';
const DEC_UNIQUE = 'd0d0d0d0-1000-4000-8000-000000000001'; // decision, unique prefix
const CTX_UNIQUE = 'c1c1c1c1-1000-4000-8000-000000000001'; // context, unique prefix
const TASK_AMB = 'a5a5a5a5-3111-4111-8111-111111111111'; // task,     shares 'a5a5a5a5'
const DEC_AMB = 'a5a5a5a5-4222-4222-8222-222222222222'; // decision, shares 'a5a5a5a5'
const MISSING_UUID = 'facef00d-1000-4000-8000-000000000009'; // well-formed, absent
// --- types added by an earlier task (prefixes disjoint from every other suite) --------
const SESSION_UNIQUE = 'd5d5d5d5-1000-4000-8000-000000000001'; // session, titled
const SESSION_UNTITLED = 'd6d6d6d6-1000-4000-8000-000000000001'; // session, title NULL
const SESSION_DISPLAY_ID = 'SES-JSON-FIXTURE-2'; // the untitled session's fallback label
const PROJECT_UNIQUE = 'd7d7d7d7-1000-4000-8000-000000000001'; // project, unique prefix
// Collision between the TWO NEW types (session + project) on one 8-hex prefix.
const SESS_AMB = 'a7a7a7a7-1000-4000-8000-000000000001';
const PROJ_AMB = 'a7a7a7a7-2000-4000-8000-000000000002';

const app = express();
app.use(express.json());
// server.ts mounts projectContextMiddleware app-wide BEFORE the routers,
// and the handlers below now read their project scope through getRequestProjectId(), which
// FAILS LOUD when that middleware never ran. A test app that omits it is not a smaller
// version of production — it is a different app. Mounting it here is what makes this suite
// exercise the real request path.
app.use('/api', projectContextMiddleware);
app.use('/api/resolve', resolveJsonRoutes);

/** Attach the Authorization header a real project-scoped client always carries. */
const scoped = <T extends { set: (k: string, v: string) => T }>(r: T): T =>
  r.set('Authorization', 'Bearer aaa.bbb.ccc');

describeDb('GET /api/resolve/:id — navigation JSON resolve (DB integration)', () => {
  beforeAll(async () => {
    // NO hand-made CREATE TABLE here — see the sibling
    // resolveNav.route.db.test.ts for the full reasoning: an `IF NOT EXISTS` fake
    // schema is inert against the migrated DB the gate now guarantees, but against an
    // unmigrated one it manufactures a laxer shape and lets the suite pass green
    // against something production does not have. Seed the REAL schema or fail loudly.

    // Seed the parent projects FIRST: technical_decisions/tasks/contexts all carry a
    // project_id FK. The removed hand-made `CREATE TABLE` had no FKs, which is exactly
    // how a fixture drifts away from the real schema while nobody is running it.
    await db.query(
      `INSERT INTO projects (id, name) VALUES ($1,$2), ($3,$4) ON CONFLICT (id) DO NOTHING`,
      [PROJECT_ID, 'resolve-fixture-project', OTHER_PROJECT_ID, 'resolve-fixture-other'],
    );

    await db.query('DELETE FROM technical_decisions WHERE id = ANY($1)', [[DEC_UNIQUE, DEC_AMB]]);
    await db.query('DELETE FROM tasks WHERE id = ANY($1)', [[TASK_AMB]]);
    await db.query('DELETE FROM contexts WHERE id = ANY($1)', [[CTX_UNIQUE]]);
    await db.query('DELETE FROM sessions WHERE id = ANY($1)', [
      [SESSION_UNIQUE, SESSION_UNTITLED, SESS_AMB],
    ]);

    await db.query(
      `INSERT INTO technical_decisions (id, project_id, decision_type, title, description, rationale)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [DEC_UNIQUE, PROJECT_ID, 'architecture', 'The unique decision', 'fixture', 'fixture'],
    );
    await db.query(
      `INSERT INTO technical_decisions (id, project_id, decision_type, title, description, rationale)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [DEC_AMB, PROJECT_ID, 'pattern', 'Ambiguous decision', 'fixture', 'fixture'],
    );
    await db.query(
      `INSERT INTO tasks (id, project_id, title, type, status) VALUES ($1,$2,$3,$4,$5)`,
      [TASK_AMB, PROJECT_ID, 'Ambiguous task', 'general', 'todo'],
    );
    await db.query(
      `INSERT INTO contexts (id, project_id, context_type, content) VALUES ($1,$2,$3,$4)`,
      [CTX_UNIQUE, PROJECT_ID, 'milestone', 'CANONICAL   anchor   body'],
    );

    // Sessions (agent_type + display_id are NOT NULL; title is NULLABLE).
    await db.query(
      `INSERT INTO sessions (id, project_id, agent_type, display_id, title)
       VALUES ($1,$2,$3,$4,$5)`,
      [SESSION_UNIQUE, PROJECT_ID, 'claude-code', 'SES-JSON-FIXTURE-1', 'The unique session'],
    );
    await db.query(
      `INSERT INTO sessions (id, project_id, agent_type, display_id, title)
       VALUES ($1,$2,$3,$4,$5)`,
      [SESSION_UNTITLED, PROJECT_ID, 'claude-code', SESSION_DISPLAY_ID, null],
    );
    await db.query(
      `INSERT INTO sessions (id, project_id, agent_type, display_id, title)
       VALUES ($1,$2,$3,$4,$5)`,
      [SESS_AMB, PROJECT_ID, 'claude-code', 'SES-JSON-FIXTURE-3', 'Colliding session'],
    );

    // Projects that exist to be RESOLVED (PROJECT_ID/OTHER_PROJECT_ID are scopes).
    await db.query(
      `INSERT INTO projects (id, name) VALUES ($1,$2), ($3,$4) ON CONFLICT (id) DO NOTHING`,
      [PROJECT_UNIQUE, 'json-fixture-resolvable-project', PROJ_AMB, 'json-fixture-colliding-project'],
    );
  });

  afterAll(async () => {
    await db.query('DELETE FROM technical_decisions WHERE id = ANY($1)', [[DEC_UNIQUE, DEC_AMB]]);
    await db.query('DELETE FROM tasks WHERE id = ANY($1)', [[TASK_AMB]]);
    await db.query('DELETE FROM contexts WHERE id = ANY($1)', [[CTX_UNIQUE]]);
    await db.query('DELETE FROM sessions WHERE id = ANY($1)', [
      [SESSION_UNIQUE, SESSION_UNTITLED, SESS_AMB],
    ]);
    await db.query('DELETE FROM projects WHERE id = ANY($1)', [
      [PROJECT_ID, OTHER_PROJECT_ID, PROJECT_UNIQUE, PROJ_AMB],
    ]);
    await db.end();
  });

  it('full UUID of a decision → 200 { type, id, url }', async () => {
    const res = await request(app).get(`/api/resolve/${DEC_UNIQUE}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.type).toBe('decision');
    expect(res.body.id).toBe(DEC_UNIQUE);
    expect(res.body.url).toBe(`/decisions/${DEC_UNIQUE}`);
  });

  it('short id of a context → 200 resolving to the full context record', async () => {
    const res = await request(app).get(`/api/resolve/${CTX_UNIQUE.slice(0, 8)}`);
    expect(res.status).toBe(200);
    expect(res.body.type).toBe('context');
    expect(res.body.id).toBe(CTX_UNIQUE);
    expect(res.body.url).toBe(`/contexts/${CTX_UNIQUE}`);
  });

  it('ambiguous short prefix → 409 with ALL candidates and NO pick', async () => {
    const res = await request(app).get('/api/resolve/a5a5a5a5');
    expect(res.status).toBe(409);
    expect(res.body.ambiguous).toBe(true);
    expect(res.body.candidates).toHaveLength(2);
    const ids = res.body.candidates.map((c: { id: string }) => c.id).sort();
    expect(ids).toEqual([TASK_AMB, DEC_AMB].sort());
    for (const c of res.body.candidates) {
      expect(c.url).toBe(`/${c.type}s/${c.id}`);
    }
  });

  // --- session + project resolution --------------------------------

  it('short id of a SESSION → 200 { type: session, url: /sessions/<uuid> }', async () => {
    const res = await request(app).get(`/api/resolve/${SESSION_UNIQUE.slice(0, 8)}`);
    expect(res.status).toBe(200);
    expect(res.body.type).toBe('session');
    expect(res.body.id).toBe(SESSION_UNIQUE);
    expect(res.body.title).toBe('The unique session');
    expect(res.body.url).toBe(`/sessions/${SESSION_UNIQUE}`);
  });

  it('short id of a PROJECT → 200 { type: project, url: /projects/<uuid> }', async () => {
    const res = await request(app).get(`/api/resolve/${PROJECT_UNIQUE.slice(0, 8)}`);
    expect(res.status).toBe(200);
    expect(res.body.type).toBe('project');
    expect(res.body.id).toBe(PROJECT_UNIQUE);
    expect(res.body.title).toBe('json-fixture-resolvable-project');
    expect(res.body.url).toBe(`/projects/${PROJECT_UNIQUE}`);
  });

  it('an UNTITLED session labels with display_id, never an empty/null title', async () => {
    // The empty-value probe: `sessions.title` is NULLABLE, so a naive `title AS title`
    // would return null here and render an unclickable blank in a disambiguation list.
    const res = await request(app).get(`/api/resolve/${SESSION_UNTITLED.slice(0, 8)}`);
    expect(res.status).toBe(200);
    expect(res.body.type).toBe('session');
    expect(res.body.title).toBe(SESSION_DISPLAY_ID);
  });

  it('collision between the two NEW types (session + project) → 409, never a pick', async () => {
    const res = await request(app).get('/api/resolve/a7a7a7a7');
    expect(res.status).toBe(409);
    expect(res.body.ambiguous).toBe(true);
    const byType = Object.fromEntries(
      res.body.candidates.map((c: { type: string; id: string }) => [c.type, c.id]),
    );
    expect(byType).toEqual({ session: SESS_AMB, project: PROJ_AMB });
    for (const c of res.body.candidates) {
      expect(c.url).toBe(`/${c.type}s/${c.id}`);
      expect(c.title).toBeTruthy();
    }
  });

  it('project scoping works for a PROJECT (scoped on its OWN id, not project_id)', async () => {
    const ok = await scoped(request(app).get(`/api/resolve/${PROJECT_UNIQUE.slice(0, 8)}`))
      .query({ project_id: PROJECT_UNIQUE });
    expect(ok.status).toBe(200);
    expect(ok.body.url).toBe(`/projects/${PROJECT_UNIQUE}`);

    const miss = await scoped(request(app).get(`/api/resolve/${PROJECT_UNIQUE.slice(0, 8)}`))
      .query({ project_id: OTHER_PROJECT_ID });
    expect(miss.status).toBe(404);
  });

  it('well-formed but absent uuid → 404 (no fail-open guess)', async () => {
    const res = await request(app).get(`/api/resolve/${MISSING_UUID}`);
    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
  });

  it('the 404 body explains itself — names every searched type + the scope flag', async () => {
    const res = await request(app).get(`/api/resolve/${MISSING_UUID}`);
    expect([...res.body.searchedTypes].sort()).toEqual([...RESOLVABLE_TYPES].sort());
    for (const t of RESOLVABLE_TYPES) {
      expect(res.body.message).toContain(t);
    }
    expect(res.body.projectScoped).toBe(false);
  });

  it('the two routes return the SAME explanation (one resolver, no drift)', async () => {
    // Both failure bodies are built from the same error object's `detail`; asserting
    // they agree is what keeps the JSON route from growing its own stale copy.
    const res = await request(app).get(`/api/resolve/${MISSING_UUID}`);
    expect(res.body.message).toContain('Searched every');
    expect(res.body.message).toContain('in any project');
  });

  it('a 400 names the shape rule that was broken', async () => {
    const tooShort = await request(app).get('/api/resolve/bbbb');
    expect(tooShort.body.reason).toBe('too-short');
    const notHex = await request(app).get('/api/resolve/zzzzzzzz');
    expect(notHex.body.reason).toBe('not-hex');
  });

  it('malformed id (non-hex) → 400', async () => {
    const res = await request(app).get('/api/resolve/zzzzzzzz');
    expect(res.status).toBe(400);
  });

  it('too-short prefix (< 8 hex) → 400', async () => {
    const res = await request(app).get('/api/resolve/bbbb');
    expect(res.status).toBe(400);
  });

  it('project scoping: correct project → 200, wrong project → 404', async () => {
    const ok = await scoped(request(app).get(`/api/resolve/${DEC_UNIQUE}`)).query({ project_id: PROJECT_ID });
    expect(ok.status).toBe(200);
    expect(ok.body.url).toBe(`/decisions/${DEC_UNIQUE}`);

    const miss = await scoped(request(app).get(`/api/resolve/${DEC_UNIQUE}`)).query({ project_id: OTHER_PROJECT_ID });
    expect(miss.status).toBe(404);
  });
});
