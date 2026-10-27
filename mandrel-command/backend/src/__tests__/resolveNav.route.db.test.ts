/**
 * DB + HTTP integration test for the navigation SPINE route (routes/resolve.ts →
 * GET /r/:id). This drives the FULL stack — real Express route, real resolver, real
 * parameterized SQL against a real Postgres — and asserts the browser-facing
 * behavior: 302 redirect to the correct detail page, 409 disambiguation (never a
 * silent pick), 404 miss, 400 malformed, and project scoping.
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
 *     npm test -- resolveNav.route.db
 *
 * Auth is bypassed here (the auth middleware has its own suite); this pins routing,
 * resolution, redirect target, and the fail-closed cases.
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

// The route resolves via the SHARED db pool (connection.ts), which reads DATABASE_*
// at import time — set on the command line to point at the throwaway test DB.
import { db } from '../database/connection';
import resolveRoutes from '../routes/resolve';
import { RESOLVABLE_TYPES } from '../utils/idResolver';
import { describeDb } from './helpers/dbContractGate';


// Crafted ids so we can force an 8-hex prefix COLLISION across two types.
const PROJECT_ID = 'ffffffff-0000-4000-8000-000000000001';
const OTHER_PROJECT_ID = 'ffffffff-0000-4000-8000-000000000002';
const DEC_UNIQUE = 'bbbbbbbb-0000-4000-8000-000000000001'; // decision, unique prefix, in PROJECT_ID
const CTX_UNIQUE = 'cccccccc-0000-4000-8000-000000000001'; // context, unique prefix
const TASK_AMB = 'aaaaaaaa-1111-4111-8111-111111111111'; // task,     shares 'aaaaaaaa'
const DEC_AMB = 'aaaaaaaa-2222-4222-8222-222222222222'; // decision, shares 'aaaaaaaa'
const MISSING_UUID = 'deadbeef-0000-4000-8000-000000000009'; // well-formed, absent
// --- types added by an earlier task -------------------------------------------------
const SESSION_UNIQUE = 'dddddddd-0000-4000-8000-000000000001'; // session, titled, in PROJECT_ID
const SESSION_UNTITLED = 'eeeeeeee-0000-4000-8000-000000000001'; // session, title NULL → display_id label
const PROJECT_UNIQUE = '11111111-0000-4000-8000-000000000001'; // project, unique prefix
// Cross-type prefix collision between a NEW type and an OLD one: a session and a task
// sharing an 8-hex prefix must be ambiguous, never a coin flip. The pre-existing
// 'aaaaaaaa' collision only ever exercised two of the original three types.
const SESS_AMB = '99999999-1111-4111-8111-111111111111';
const TASK_AMB2 = '99999999-2222-4222-8222-222222222222';
// --- punch routing -----------------------------
const PUNCH_TASK = '77777777-0000-4000-8000-000000000001'; // task carrying metadata.punch
const PLAIN_TASK = '88888888-0000-4000-8000-000000000001'; // task WITHOUT metadata.punch — control

const app = express();
app.use(express.json());
// server.ts mounts projectContextMiddleware app-wide BEFORE the routers,
// and the handlers below now read their project scope through getRequestProjectId(), which
// FAILS LOUD when that middleware never ran. A test app that omits it is not a smaller
// version of production — it is a different app. Mounting it here is what makes this suite
// exercise the real request path.
app.use('/r', projectContextMiddleware);
app.use('/r', resolveRoutes);

/** Attach the Authorization header a real project-scoped client always carries. */
const scoped = <T extends { set: (k: string, v: string) => T }>(r: T): T =>
  r.set('Authorization', 'Bearer aaa.bbb.ccc');

describeDb('GET /r/:id — navigation spine (DB integration)', () => {
  beforeAll(async () => {
    // NO hand-made CREATE TABLE here. This suite used to declare its
    // own minimal `IF NOT EXISTS` tables. Against the migrated DB the gate now
    // guarantees, those statements are inert no-ops; against an UNMIGRATED DB they
    // silently manufactured a fake, laxer schema and let the suite pass green against
    // a shape production does not have — which is how this suite rotted unnoticed
    // while it was dark (its INSERTs omit `description`/`rationale`, NOT NULL in the
    // real schema, so it 500s the moment it meets the real table). Seed against the
    // REAL migrated schema or fail loudly.

    // Clean any prior fixtures, then insert fresh.
    // Seed the parent projects FIRST: technical_decisions/tasks/contexts all carry a
    // project_id FK. The removed hand-made `CREATE TABLE` had no FKs, which is exactly
    // how a fixture drifts away from the real schema while nobody is running it.
    await db.query(
      `INSERT INTO projects (id, name) VALUES ($1,$2), ($3,$4) ON CONFLICT (id) DO NOTHING`,
      [PROJECT_ID, 'resolve-fixture-project', OTHER_PROJECT_ID, 'resolve-fixture-other'],
    );
    // A THIRD project that exists purely to be resolved as a record in its own right
    // (PROJECT_ID/OTHER_PROJECT_ID share the 'ffffffff' prefix and are used as scopes).
    await db.query(
      `INSERT INTO projects (id, name) VALUES ($1,$2) ON CONFLICT (id) DO NOTHING`,
      [PROJECT_UNIQUE, 'resolve-fixture-resolvable-project'],
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

    // Sessions: agent_type and display_id are NOT NULL in the real schema. `title` is
    // NULLABLE, which is why the label expression must fall back to display_id — the
    // untitled fixture below is that empty-population probe, not a decorative extra.
    await db.query(
      `INSERT INTO sessions (id, project_id, agent_type, display_id, title)
       VALUES ($1,$2,$3,$4,$5)`,
      [SESSION_UNIQUE, PROJECT_ID, 'claude-code', 'SES-FIXTURE-1', 'The unique session'],
    );
    await db.query(
      `INSERT INTO sessions (id, project_id, agent_type, display_id, title)
       VALUES ($1,$2,$3,$4,$5)`,
      [SESSION_UNTITLED, PROJECT_ID, 'claude-code', 'SES-FIXTURE-2', null],
    );

    // The cross-type collision pair (session + task on the same 8-hex prefix).
    await db.query('DELETE FROM tasks WHERE id = ANY($1)', [[TASK_AMB2]]);
    await db.query(
      `INSERT INTO sessions (id, project_id, agent_type, display_id, title)
       VALUES ($1,$2,$3,$4,$5)`,
      [SESS_AMB, PROJECT_ID, 'claude-code', 'SES-FIXTURE-3', 'Colliding session'],
    );
    await db.query(
      `INSERT INTO tasks (id, project_id, title, type, status) VALUES ($1,$2,$3,$4,$5)`,
      [TASK_AMB2, PROJECT_ID, 'Colliding task', 'general', 'todo'],
    );

    // Punch routing fixtures: one task carrying a real `metadata.punch`
    // contract (the shallow-merged object shape punchMergeSql actually writes), one
    // plain task with none — the DONE WHEN's own "control" requirement.
    await db.query('DELETE FROM tasks WHERE id = ANY($1)', [[PUNCH_TASK, PLAIN_TASK]]);
    await db.query(
      `INSERT INTO tasks (id, project_id, title, type, status, metadata) VALUES ($1,$2,$3,$4,$5,$6)`,
      [
        PUNCH_TASK,
        PROJECT_ID,
        'A punch task',
        'general',
        'todo',
        JSON.stringify({ punch: { doneWhen: 'evidence visible', proofKind: 'browser' } }),
      ],
    );
    await db.query(
      `INSERT INTO tasks (id, project_id, title, type, status) VALUES ($1,$2,$3,$4,$5)`,
      [PLAIN_TASK, PROJECT_ID, 'A plain task', 'general', 'todo'],
    );
  });

  afterAll(async () => {
    await db.query('DELETE FROM technical_decisions WHERE id = ANY($1)', [[DEC_UNIQUE, DEC_AMB]]);
    await db.query('DELETE FROM tasks WHERE id = ANY($1)', [
      [TASK_AMB, TASK_AMB2, PUNCH_TASK, PLAIN_TASK],
    ]);
    await db.query('DELETE FROM contexts WHERE id = ANY($1)', [[CTX_UNIQUE]]);
    await db.query('DELETE FROM sessions WHERE id = ANY($1)', [
      [SESSION_UNIQUE, SESSION_UNTITLED, SESS_AMB],
    ]);
    await db.query('DELETE FROM projects WHERE id = ANY($1)', [
      [PROJECT_ID, OTHER_PROJECT_ID, PROJECT_UNIQUE],
    ]);
    await db.end();
  });

  it('full UUID of a decision → 302 to /decisions/<uuid>', async () => {
    const res = await request(app).get(`/r/${DEC_UNIQUE}`);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`/decisions/${DEC_UNIQUE}`);
  });

  it('short id of a context → 302 to /contexts/<uuid>', async () => {
    const res = await request(app).get(`/r/${CTX_UNIQUE.slice(0, 8)}`);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`/contexts/${CTX_UNIQUE}`);
  });

  it('ambiguous short prefix → 409 with ALL candidates and NO redirect (never picks)', async () => {
    const res = await request(app).get('/r/aaaaaaaa');
    expect(res.status).toBe(409);
    expect(res.headers.location).toBeUndefined(); // proves it did NOT redirect/pick
    expect(res.body.ambiguous).toBe(true);
    expect(res.body.candidates).toHaveLength(2);
    const ids = res.body.candidates.map((c: { id: string }) => c.id).sort();
    expect(ids).toEqual([TASK_AMB, DEC_AMB].sort());
    // Each candidate carries a correct per-type url.
    for (const c of res.body.candidates) {
      expect(c.url).toBe(`/${c.type}s/${c.id}`);
    }
  });

  // --- session + project resolution --------------------------------

  it('short id of a SESSION → 302 to /sessions/<uuid>', async () => {
    const res = await request(app).get(`/r/${SESSION_UNIQUE.slice(0, 8)}`);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`/sessions/${SESSION_UNIQUE}`);
  });

  it('full UUID of a SESSION → 302 to /sessions/<uuid>', async () => {
    const res = await request(app).get(`/r/${SESSION_UNIQUE}`);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`/sessions/${SESSION_UNIQUE}`);
  });

  it('short id of a PROJECT → 302 to /projects/<uuid>', async () => {
    const res = await request(app).get(`/r/${PROJECT_UNIQUE.slice(0, 8)}`);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`/projects/${PROJECT_UNIQUE}`);
  });

  it('full UUID of a PROJECT → 302 to /projects/<uuid>', async () => {
    const res = await request(app).get(`/r/${PROJECT_UNIQUE}`);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`/projects/${PROJECT_UNIQUE}`);
  });

  it('an UNTITLED session still resolves (title is NULLABLE — the empty-value probe)', async () => {
    const res = await request(app).get(`/r/${SESSION_UNTITLED.slice(0, 8)}`);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`/sessions/${SESSION_UNTITLED}`);
  });

  it('prefix collision ACROSS a new and an old type (session + task) → 409, never a pick', async () => {
    const res = await request(app).get('/r/99999999');
    expect(res.status).toBe(409);
    expect(res.headers.location).toBeUndefined(); // proves it did NOT pick one
    expect(res.body.ambiguous).toBe(true);
    const byType = Object.fromEntries(
      res.body.candidates.map((c: { type: string; id: string }) => [c.type, c.id]),
    );
    expect(byType).toEqual({ session: SESS_AMB, task: TASK_AMB2 });
    for (const c of res.body.candidates) {
      expect(c.url).toBe(`/${c.type}s/${c.id}`);
      expect(c.title).toBeTruthy(); // every candidate must be human-pickable
    }
  });

  it('project scoping applies to a PROJECT via its OWN id column (not a project_id column)', async () => {
    // REGRESSION GUARD: `projects` has no project_id column. Appending the generic
    // `AND project_id = $2` to every UNION branch makes this a 500, not a 404 — and a
    // 500 is indistinguishable from an outage. Both directions asserted.
    const ok = await scoped(request(app).get(`/r/${PROJECT_UNIQUE.slice(0, 8)}`))
      .query({ project_id: PROJECT_UNIQUE });
    expect(ok.status).toBe(302);
    expect(ok.headers.location).toBe(`/projects/${PROJECT_UNIQUE}`);

    const miss = await scoped(request(app).get(`/r/${PROJECT_UNIQUE.slice(0, 8)}`))
      .query({ project_id: OTHER_PROJECT_ID });
    expect(miss.status).toBe(404);
  });

  it('project scoping applies to a SESSION', async () => {
    const ok = await scoped(request(app).get(`/r/${SESSION_UNIQUE.slice(0, 8)}`))
      .query({ project_id: PROJECT_ID });
    expect(ok.status).toBe(302);

    const miss = await scoped(request(app).get(`/r/${SESSION_UNIQUE.slice(0, 8)}`))
      .query({ project_id: OTHER_PROJECT_ID });
    expect(miss.status).toBe(404);
  });

  // --- the not-found case TELLS the user what happened ------------------------------

  it('well-formed but absent uuid → 404 (no fail-open guess)', async () => {
    const res = await request(app).get(`/r/${MISSING_UUID}`);
    expect(res.status).toBe(404);
    expect(res.headers.location).toBeUndefined();
  });

  it('the 404 body NAMES every type searched — not a bare 404', async () => {
    const res = await request(app).get(`/r/${MISSING_UUID}`);
    expect(res.status).toBe(404);
    // The population is asserted as a SET against the resolver's own enumeration, so
    // this test cannot pass while the message names a type the query never searched.
    expect([...res.body.searchedTypes].sort()).toEqual([...RESOLVABLE_TYPES].sort());
    for (const t of RESOLVABLE_TYPES) {
      expect(res.body.message).toContain(t);
    }
    expect(res.body.projectScoped).toBe(false);
    expect(res.body.message).toContain('in any project');
  });

  it('a scoped 404 says the scope narrowed it (so "wrong project" is distinguishable)', async () => {
    const res = await scoped(request(app).get(`/r/${DEC_UNIQUE}`))
      .query({ project_id: OTHER_PROJECT_ID });
    expect(res.status).toBe(404);
    expect(res.body.projectScoped).toBe(true);
    expect(res.body.message).toContain('project you scoped to');
    // The unscoped control resolves — proving the 404 above really is a scope effect
    // and not a missing record.
    const control = await request(app).get(`/r/${DEC_UNIQUE}`);
    expect(control.status).toBe(302);
  });

  it('a 400 names WHICH shape rule was broken (too-short vs not-hex vs empty)', async () => {
    const tooShort = await request(app).get('/r/bbbb');
    expect(tooShort.status).toBe(400);
    expect(tooShort.body.reason).toBe('too-short');
    expect(tooShort.body.message).toContain('at least');

    const notHex = await request(app).get('/r/zzzzzzzz');
    expect(notHex.status).toBe(400);
    expect(notHex.body.reason).toBe('not-hex');
    expect(notHex.body.message).toContain('hexadecimal');
  });

  it('malformed id (non-hex) → 400', async () => {
    const res = await request(app).get('/r/zzzzzzzz');
    expect(res.status).toBe(400);
  });

  it('too-short prefix (< 8 hex) → 400', async () => {
    const res = await request(app).get('/r/bbbb');
    expect(res.status).toBe(400);
  });

  // --- punch routing -----------------------------
  // The operator's report: the /r/ link for a punch landed on /tasks/:id, which renders no
  // attachments — the evidence was there, just on the wrong page. This is the exact
  // browser-facing regression guard: full UUID and short-id both routed through the
  // real HTTP stack against a real punch-carrying row in Postgres.

  it('a task carrying metadata.punch → 302 to /punch/<uuid>, NOT /tasks/<uuid>', async () => {
    const res = await request(app).get(`/r/${PUNCH_TASK}`);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`/punch/${PUNCH_TASK}`);
  });

  it('short id of a punch task → 302 to /punch/<uuid>', async () => {
    const res = await request(app).get(`/r/${PUNCH_TASK.slice(0, 8)}`);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`/punch/${PUNCH_TASK}`);
  });

  it('a task WITHOUT metadata.punch → 302 to /tasks/<uuid> — the control (unchanged behavior)', async () => {
    const res = await request(app).get(`/r/${PLAIN_TASK}`);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`/tasks/${PLAIN_TASK}`);
  });

  it('project scoping: correct project → 302, wrong project → 404', async () => {
    const ok = await scoped(request(app).get(`/r/${DEC_UNIQUE}`)).query({ project_id: PROJECT_ID });
    expect(ok.status).toBe(302);
    expect(ok.headers.location).toBe(`/decisions/${DEC_UNIQUE}`);

    const miss = await scoped(request(app).get(`/r/${DEC_UNIQUE}`)).query({ project_id: OTHER_PROJECT_ID });
    expect(miss.status).toBe(404);
  });
});
