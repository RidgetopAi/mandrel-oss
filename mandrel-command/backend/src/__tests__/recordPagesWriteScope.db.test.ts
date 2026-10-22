/**
 * recordPagesWriteScope — the WRITE surfaces of the three RECORD pages (Contexts, Tasks,
 * Decisions) under the per-page project scope (epic 41293984 §A1).
 *
 * ════════════════════════════════════════════════════════════════════════════════════
 *  WHY THIS EXISTS ALONGSIDE pageScopedProjectScope.db.test.ts
 * ════════════════════════════════════════════════════════════════════════════════════
 * That file (the foundation stream's) covers the READ direction for `/api/contexts` and
 * `/api/tasks` against planted rows, and ONE write — `POST /api/decisions`
 * (`decision_record`). It does not cover the write surface the Decisions PAGE actually
 * has, which is `PUT /api/decisions/:id` (`decision_update`), nor the create path the
 * Tasks page has.
 *
 * That distinction is not bookkeeping. `decision_update` is a different failure: the
 * resolved project is used to SCOPE THE decisionId LOOKUP, so a mis-scoped update does not
 * merely file a record in the wrong place — it looks for the record in a project that does
 * not contain it. And it is the one write on these pages where the correct project is
 * neither the page's nor the ambient default: it is THE RECORD'S OWN, because a decision
 * reached by a `/r/<id8>` short link lives elsewhere.
 *
 * ════════════════════════════════════════════════════════════════════════════════════
 *  GUARD SCOPE — the population this file enumerates, and why it is the whole one (C3)
 * ════════════════════════════════════════════════════════════════════════════════════
 * EVERY write surface reachable from the three record pages, derived by walking the
 * mutation hooks in `frontend/src/pages/{contexts,decisions,tasks}/hooks.ts` plus
 * `TaskDrawer`'s create path. That is:
 *
 *   requireWriteProjectId (the resolved winner — the header — decides):
 *     • PUT  /api/decisions/:id   decision_update   ← covered here
 *   subject-of-write (the controller reads the BODY or the path id, header irrelevant):
 *     • POST /api/tasks           task_create       ← covered here (the body/header agree)
 *     • PUT  /api/tasks/:id, DELETE /api/tasks/:id, POST /api/tasks/:id/restore
 *     • PUT  /api/contexts/:id, DELETE /api/contexts/:id
 *
 * The by-id task/context writes are deliberately NOT scoped by the frontend and so have
 * nothing to assert here: they address a row by id, the controller never reads the
 * request's project, and the route is authorized against the RECORD's project by
 * `authorizeEntityPathParam` — which is guarded, as a whole class, in
 * `entityDetailProjectScope.db.test.ts`. Stating that here rather than leaving the
 * absence to be inferred: a guard should say what it does not cover.
 *
 * `context_store` (POST /api/contexts) is the third `requireWriteProjectId` controller and
 * is NOT in this population — the Contexts screen has no create surface. If one is added,
 * it belongs here.
 *
 * ════════════════════════════════════════════════════════════════════════════════════
 *  A MEASURED LIMITATION, STATED RATHER THAN PAPERED OVER
 * ════════════════════════════════════════════════════════════════════════════════════
 * The amendment asks the write twin to assert `project_id = B` by DIRECT DB READ. Neither
 * write here reaches Postgres from this process: `POST /api/tasks` and both decision
 * writes resolve + authorize the project and then delegate to the mcp-server over HTTP
 * (`McpService.callTool`), a separate process on a separate box. So the anchor is one hop
 * earlier, at the last value this service controls — the `projectId` ARGUMENT it forwards,
 * which is what becomes the row's column and is exactly where the header-beats-body
 * precedence is decided. The READ assertions below ARE anchored on rows planted in real
 * Postgres by direct SQL.
 *
 * Run as ADMIN on purpose: for a non-admin an unscoped list already means "your granted
 * projects", which would mask the failure behind an authorization result.
 *
 * Local run:
 *   bash scripts/provision-test-db.sh ci_sel_records
 *   set -a; eval "$(bash scripts/provision-test-db.sh ci_sel_records --print-env)"; set +a
 *   cd mandrel-command/backend && npx jest src/__tests__/recordPagesWriteScope.db.test.ts
 */

import { describeDb, assertDbReachable } from './helpers/dbContractGate';

jest.mock('../utils/featureFlags', () => ({
  ensureFeatureFlags: jest.fn(async () => ({
    getMetadata: () => ({ version: 'test', updatedAt: new Date().toISOString() }),
    getAllFlags: () => ({}),
  })),
}));

/**
 * The mcp-server seam. Stubbed because it is a DIFFERENT PROCESS ON A DIFFERENT BOX — see
 * the limitation note above. The scope decision under test happens entirely on THIS side
 * of the seam; the captured argument is what carries it across.
 */
jest.mock('../services/mcp', () => ({
  McpService: {
    // The stub answers in each tool's REAL structured shape — `task_create` returns
    // `{ action:'created', task:{...} }` and the service reads `data.task.id`. A stub that
    // returns a shape the caller cannot read produces a 500 that looks like a scope
    // failure, which is the third state (C1): "could not measure" wearing "no" as a mask.
    callTool: jest.fn(async (tool: string) =>
      tool === 'task_create'
        ? {
            success: true,
            data: {
              action: 'created',
              task: {
                id: 'e7e70000-0000-4000-8000-e7e7000000f1',
                title: 'stubbed',
                type: 'general',
                status: 'todo',
                priority: 'medium',
                tags: [],
                dependencies: [],
                createdAt: new Date().toISOString(),
              },
            },
          }
        : { success: true, data: { id: 'stubbed' } }
    ),
  },
}));

import request from 'supertest';
import app from '../server';
import { AuthService } from '../services/auth';
import { db } from '../database/connection';
import { McpService } from '../services/mcp';

// Dedicated `e7..` id prefix: this suite shares ONE database with ~75 others, run in band,
// so fixtures must not be able to collide with another suite's by accident.
const P_DEFAULT = 'e7e70000-0000-4000-8000-e7e700000001'; // "A" — the user's default
const P_PAGE = 'e7e70000-0000-4000-8000-e7e700000002'; // "B" — what the page selected
const P_OTHER = 'e7e70000-0000-4000-8000-e7e700000003'; // "C" — where a short-linked record lives
const U_ADMIN = 'e7e70000-0000-4000-8000-e7e7000000a1';

const D_IN_OTHER = 'e7e70000-0000-4000-8000-e7e7000000d1';

const MARK_A = 'RECPAGEMARKERALPHA';
const MARK_B = 'RECPAGEMARKERBRAVO';
const MARK_C = 'RECPAGEMARKERCHARLIE';

describeDb('record pages — the WRITE names the project the UI is acting on', () => {
  // The app's own pool: this suite imports ../server, which opens it. A private second
  // pool would double this process's client slots against a CONNECTION-LIMITed throwaway
  // role, which is how the DB suites start failing in a set that moves between runs.
  const pool = db;
  let adminToken: string;
  const callTool = McpService.callTool as jest.Mock;

  const cleanup = async () => {
    for (const t of ['contexts', 'technical_decisions', 'tasks']) {
      await pool.query(`DELETE FROM ${t} WHERE project_id = ANY($1::uuid[])`, [
        [P_DEFAULT, P_PAGE, P_OTHER],
      ]);
    }
    await pool.query('DELETE FROM auth_tokens WHERE user_id = $1', [U_ADMIN]);
    await pool.query('DELETE FROM projects WHERE id = ANY($1::uuid[])', [
      [P_DEFAULT, P_PAGE, P_OTHER],
    ]);
    await pool.query('DELETE FROM admin_users WHERE id = $1', [U_ADMIN]);
  };

  beforeAll(async () => {
    await assertDbReachable(pool);
    await cleanup();

    await pool.query(
      'INSERT INTO projects (id, name, description) VALUES ($1,$2,$3),($4,$5,$6),($7,$8,$9)',
      [
        P_DEFAULT, `recpage-default-${MARK_A}`, `default ${MARK_A}`,
        P_PAGE, `recpage-page-${MARK_B}`, `page ${MARK_B}`,
        P_OTHER, `recpage-other-${MARK_C}`, `other ${MARK_C}`,
      ]
    );

    // A REAL decision row in C. `PUT /api/decisions/:id` runs `authorizeEntityPathParam`
    // during routing, which looks the id up in Postgres — so this row is what makes the
    // cross-project case reach the controller at all rather than 403 as a phantom id.
    await pool.query(
      `INSERT INTO technical_decisions (id, project_id, decision_type, title, description, rationale)
       VALUES ($1,$2,'architecture',$3,$4,$5)`,
      [D_IN_OTHER, P_OTHER, `planted decision ${MARK_C}`, `d ${MARK_C}`, `r ${MARK_C}`]
    );

    await pool.query(
      `INSERT INTO admin_users (id, username, email, password_hash, role, is_active)
       VALUES ($1,'recpageadmin','recpageadmin@x.test',$2,'admin',true)`,
      [U_ADMIN, '$2b$04$notarealhashnotarealhashno']
    );
    const { tokenId } = await AuthService.createSession(U_ADMIN);
    adminToken = AuthService.generateJWT(
      { id: U_ADMIN, username: 'recpageadmin', email: 'a@x.test', role: 'admin' } as never,
      tokenId
    );
  }, 120000);

  afterAll(async () => {
    await cleanup();
    await pool.end();
  });

  beforeEach(() => callTool.mockClear());

  /** The `projectId` this backend forwarded to the tool — the value that scopes the write. */
  const forwarded = (expectedTool: string): unknown => {
    expect(callTool).toHaveBeenCalledTimes(1);
    const [tool, args] = callTool.mock.calls[0];
    expect(tool).toBe(expectedTool);
    return (args as { projectId?: unknown }).projectId;
  };

  // ── PRE-CONDITION: the fixture is real ────────────────────────────────────────────
  it('the planted decision exists, in project C (the fixture is not vacuous)', async () => {
    const rows = await pool.query(
      'SELECT project_id::text AS project_id FROM technical_decisions WHERE id = $1',
      [D_IN_OTHER]
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].project_id).toBe(P_OTHER);
  });

  // ══════════════════════════════════════════════════════════════════════════════════
  //  PUT /api/decisions/:id — decision_update, a requireWriteProjectId controller
  // ══════════════════════════════════════════════════════════════════════════════════
  describe('PUT /api/decisions/:id — the outcome drawer', () => {
    const body = { outcomeStatus: 'successful', outcomeNotes: 'it worked' };

    it('scoped to the record\'s project C, it forwards C — not the default', async () => {
      // What the Decisions page produces for a decision reached by short link: the drawer
      // scopes the request to `decision.project_id`, which is C, while the user's default
      // (and therefore the ambient header) is A.
      const res = await request(app)
        .put(`/api/decisions/${D_IN_OTHER}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .set('X-Project-ID', P_OTHER)
        .send(body);

      expect(res.status).toBe(200);
      expect(forwarded('decision_update')).toBe(P_OTHER);
      expect(forwarded('decision_update')).not.toBe(P_DEFAULT);
    });

    it('MUTATION — carrying the ambient default instead forwards the DEFAULT (the bug)', async () => {
      // This is what a page that omits `scope()` produces. `decision_update` would then
      // look for this decision in A, where it does not exist. PINNED ON PURPOSE: if the
      // backend ever stops resolving a write from the header, it goes red HERE, loudly,
      // rather than months later as updates that quietly do nothing.
      const res = await request(app)
        .put(`/api/decisions/${D_IN_OTHER}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .set('X-Project-ID', P_DEFAULT)
        .send(body);

      expect(res.status).toBe(200);
      expect(forwarded('decision_update')).toBe(P_DEFAULT);
    });

    it('MUTATION — an UNSCOPED update is REFUSED, never resolved to a guessed project', async () => {
      const res = await request(app)
        .put(`/api/decisions/${D_IN_OTHER}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send(body);

      expect(res.status).toBe(400);
      // The important half: nothing was attempted. A write that cannot determine its
      // project must fail, not fall back — a fallback here is the misplacement bug.
      expect(callTool).not.toHaveBeenCalled();
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════
  //  POST /api/tasks — task_create, a subject-of-write controller
  // ══════════════════════════════════════════════════════════════════════════════════
  describe('POST /api/tasks — the TaskDrawer create path', () => {
    it('files under the project the FORM named, with the header agreeing', async () => {
      // The drawer sends `project_id` in the body AND scopes the request to the same value.
      // Both must name B; the user's default is A.
      const res = await request(app)
        .post('/api/tasks')
        .set('Authorization', `Bearer ${adminToken}`)
        .set('X-Project-ID', P_PAGE)
        .send({ project_id: P_PAGE, title: `recpage create ${MARK_B}`, priority: 'medium' });

      expect([200, 201]).toContain(res.status);
      expect(forwarded('task_create')).toBe(P_PAGE);
      expect(forwarded('task_create')).not.toBe(P_DEFAULT);
    });

    it('the BODY wins for this controller — a disagreeing header does not move the row', async () => {
      /**
       * Documenting the ACTUAL contract rather than the one it would be convenient to
       * assume. `controllers/task.ts` reads `project_id` from the body, so a header naming
       * a different project does NOT misfile the task — which is why the frontend's
       * create scope is derived from the form's own `project_id` rather than the page's.
       *
       * The reason to scope it at all is not misfiling: it is that the resolver AUTHORIZES
       * every project a request names, so a request naming two projects can 403 on the one
       * that has nothing to do with the write.
       */
      const res = await request(app)
        .post('/api/tasks')
        .set('Authorization', `Bearer ${adminToken}`)
        .set('X-Project-ID', P_DEFAULT)
        .send({ project_id: P_PAGE, title: `recpage body-wins ${MARK_B}`, priority: 'medium' });

      expect([200, 201]).toContain(res.status);
      expect(forwarded('task_create')).toBe(P_PAGE);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════
  //  THE READ SIDE OF THESE PAGES, on planted rows — proof "absent" can be earned
  // ══════════════════════════════════════════════════════════════════════════════════
  describe('READ — a page scoped to B does not see the row planted in C', () => {
    beforeAll(async () => {
      for (const [pid, mark] of [[P_PAGE, MARK_B], [P_OTHER, MARK_C]] as const) {
        await pool.query(
          `INSERT INTO contexts (project_id, context_type, content, tags)
           VALUES ($1,'completion',$2,$3)`,
          [pid, `recpage planted context ${mark}`, [mark]]
        );
      }
    });

    const carries = (body: unknown, mark: string): boolean =>
      JSON.stringify(body).includes(mark);

    it('GET /api/contexts scoped to B: B present, C absent', async () => {
      const res = await request(app)
        .get('/api/contexts')
        .set('Authorization', `Bearer ${adminToken}`)
        .set('X-Project-ID', P_PAGE);

      expect(res.status).toBe(200);
      expect(carries(res.body, MARK_C)).toBe(false);
      // Present-and-correct: a request that named nothing and returned an empty page would
      // satisfy the line above for entirely the wrong reason.
      expect(carries(res.body, MARK_B)).toBe(true);
    });

    it('MUTATION — the same read UNSCOPED returns BOTH, so "absent" above was earned', async () => {
      const res = await request(app)
        .get('/api/contexts')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(carries(res.body, MARK_B)).toBe(true);
      expect(carries(res.body, MARK_C)).toBe(true);
    });
  });
});
