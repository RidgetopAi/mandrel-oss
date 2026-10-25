/**
 * pageScopedProjectScope — THE guard for the per-page scope contract
 * (page-scope epic, amendment §A1/§A2 "the guard construction", supersedes §F).
 *
 * ════════════════════════════════════════════════════════════════════════════════════
 *  WHY THIS TEST EXISTS AT ALL
 * ════════════════════════════════════════════════════════════════════════════════════
 * The Command UI used to have ONE project scope: an ambient header that always equalled
 * whatever the page displayed. This change breaks that equality BY DESIGN — the ambient
 * header is pinned to the user's DEFAULT project (A) while each page selects its own (B).
 *
 * That creates a failure mode with no exception and no red anywhere:
 *
 *   • READ  — a page showing B whose request forgets to name B gets A's rows, or, if the
 *             header is missing entirely, EVERY project's rows (several controllers read
 *             "no project" as "all projects").
 *   • WRITE — worse. Writes carry no query param and the resolver's write precedence is
 *             HEADER > body, so a `requireWriteProjectId` controller (`decision_record`,
 *             `decision_update`, `context_store`) files the record in the AMBIENT
 *             project. The user is looking at B, the record lands in A, it never appears
 *             in the list they are watching, and NOTHING errors — both projects
 *             authorize, so the backend guard passes legitimately.
 *
 * ════════════════════════════════════════════════════════════════════════════════════
 *  THE ANCHOR: A ROW PLANTED IN A SECOND PROJECT, IN THE REAL DATABASE
 * ════════════════════════════════════════════════════════════════════════════════════
 * A test that asks the app what it did and believes the answer proves nothing — an msw
 * mock echoing the frontend's own request is self-agreement, not a test. So the anchor
 * here is a uniquely-marked row planted in project B by direct SQL, and the assertions
 * are (a) that a request scoped to A does NOT contain it, and (b) for writes, what the
 * `project_id` column actually holds, read back with this suite's own SQL.
 *
 * ── "ABSENT" IS NOT ENOUGH; THE REQUEST MUST NAME A ──────────────────────────────────
 * A response missing B's row is also what you get from a broken endpoint, an empty
 * result, or a request that named nothing at all. So every case asserts BOTH: B's marker
 * absent AND A's marker present. Present-and-correct, not merely not-wrong.
 *
 * ── RUN AS ADMIN, DELIBERATELY ───────────────────────────────────────────────────────
 * As a NON-admin, "unscoped" already means "the caller's granted projects", which would
 * mask the very failure under test — the deny-by-default grant check would hide a
 * missing scope behind an authorization result. An admin holds every project, so an
 * unscoped admin request returns EVERYTHING, and a leak is visible. This is the same
 * reason `unscopedListProjectScope.db.test.ts` keeps an admin persona: a fix that is
 * really "deny everything" passes every deny-test and is useless.
 *
 * ── THE MUTATION THAT PROVES THE GUARD IS NOT VACUOUS ────────────────────────────────
 * The `describe('MUTATION')` block sends the identical request with the scope REMOVED —
 * the state the frontend lands in when localStorage is cleared or the default is nulled.
 * It asserts the foreign row DOES come back. That is the proof this suite can actually
 * see the defect: without it, "B absent" could be true because the fixture never worked.
 *
 * ════════════════════════════════════════════════════════════════════════════════════
 *  A MEASURED LIMITATION, STATED RATHER THAN PAPERED OVER
 * ════════════════════════════════════════════════════════════════════════════════════
 * The amendment asks the write twin to assert `project_id = B` by DIRECT DB READ. That is
 * not reachable for CONTENT writes in this backend and the reason is structural, not a
 * missing fixture: `POST /api/decisions` and `POST /api/tasks` do not write Postgres at
 * all — they resolve+authorize the project and then delegate to the mcp-server over HTTP
 * (`McpService.callTool`), which is a separate process on a separate box. Driving them
 * without it yields 500, and standing it up would make this a two-service integration
 * test whose failures mostly would not be about project scope.
 *
 * So the write direction is anchored ONE HOP EARLIER, at the last point this service
 * controls: the `projectId` ARGUMENT this backend forwards. That is the value that
 * becomes the row's `project_id`, it is produced by the real middleware chain + the real
 * resolver, and it is exactly where the header-beats-body precedence is decided — which
 * is the thing under test. The READ direction below IS anchored on real planted rows in
 * real Postgres, and the DIRECT-DB-READ form of the write assertion is exercised where a
 * write genuinely does reach Postgres, in `userDefaultProject.db.test.ts`.
 *
 * Local run:
 *   bash scripts/provision-test-db.sh ci_sel_foundation
 *   set -a; eval "$(bash scripts/provision-test-db.sh ci_sel_foundation --print-env)"; set +a
 *   cd mandrel-command/backend && npx jest src/__tests__/pageScopedProjectScope.db.test.ts
 */

import { describeDb, assertDbReachable } from './helpers/dbContractGate';

jest.mock('../utils/featureFlags', () => ({
  ensureFeatureFlags: jest.fn(async () => ({
    getMetadata: () => ({ version: 'test', updatedAt: new Date().toISOString() }),
    getAllFlags: () => ({}),
  })),
}));

/**
 * The mcp-server seam. Stubbed, not because the assertion needs stubbing, but because it
 * is a DIFFERENT PROCESS ON A DIFFERENT BOX — see the limitation note in the header. The
 * scope decision under test happens entirely on THIS side of the seam, and the captured
 * argument below is what carries it across.
 */
jest.mock('../services/mcp', () => ({
  McpService: {
    callTool: jest.fn(async () => ({ success: true, data: { id: 'stubbed' } })),
  },
}));

import request from 'supertest';
import app from '../server';
import { AuthService } from '../services/auth';
import { db } from '../database/connection';
import { McpService } from '../services/mcp';

// Dedicated `e5..` id prefix: this suite shares ONE database with ~75 others, run in
// band, so fixtures must not be able to collide with another suite's by accident.
const P_DEFAULT = 'e5e50000-0000-4000-8000-e5e500000001'; // "A" — the user's default project
const P_PAGE = 'e5e50000-0000-4000-8000-e5e500000002'; // "B" — the project the page selected
const U_ADMIN = 'e5e50000-0000-4000-8000-e5e5000000a1';

const MARK_A = 'PAGESCOPEMARKERALPHA';
const MARK_B = 'PAGESCOPEMARKERBRAVO';

describeDb('per-page project scope — the request names the PAGE\'s project', () => {
  // The app's own pool: this suite imports ../server, which opens it. A private second
  // pool would double this process's client slots against a CONNECTION-LIMITed throwaway
  // role, which is how the DB suites start failing in a set that moves between runs.
  const pool = db;
  let adminToken: string;

  const cleanup = async () => {
    for (const t of ['contexts', 'technical_decisions', 'tasks']) {
      await pool.query(`DELETE FROM ${t} WHERE project_id = ANY($1::uuid[])`, [
        [P_DEFAULT, P_PAGE],
      ]);
    }
    await pool.query('DELETE FROM auth_tokens WHERE user_id = $1', [U_ADMIN]);
    await pool.query('DELETE FROM projects WHERE id = ANY($1::uuid[])', [[P_DEFAULT, P_PAGE]]);
    await pool.query('DELETE FROM admin_users WHERE id = $1', [U_ADMIN]);
  };

  beforeAll(async () => {
    await assertDbReachable(pool);
    await cleanup();

    await pool.query(
      'INSERT INTO projects (id, name, description) VALUES ($1,$2,$3),($4,$5,$6)',
      [
        P_DEFAULT, `pagescope-default-${MARK_A}`, `default project ${MARK_A}`,
        P_PAGE, `pagescope-page-${MARK_B}`, `page project ${MARK_B}`,
      ]
    );

    // THE PLANTED ROWS. One per project, uniquely marked, inserted by SQL — nothing the
    // code under test can move, rename, or filter differently.
    for (const [pid, mark] of [[P_DEFAULT, MARK_A], [P_PAGE, MARK_B]] as const) {
      await pool.query(
        `INSERT INTO contexts (project_id, context_type, content, tags)
         VALUES ($1,'completion',$2,$3)`,
        [pid, `planted context ${mark}`, [mark]]
      );
      await pool.query(
        `INSERT INTO technical_decisions (project_id, decision_type, title, description, rationale)
         VALUES ($1,'architecture',$2,$3,$4)`,
        [pid, `planted decision ${mark}`, `d ${mark}`, `r ${mark}`]
      );
      await pool.query(
        `INSERT INTO tasks (project_id, title, description, type, status, priority)
         VALUES ($1,$2,$3,'general','todo','medium')`,
        [pid, `planted task ${mark}`, `d ${mark}`]
      );
    }

    await pool.query(
      `INSERT INTO admin_users (id, username, email, password_hash, role, is_active)
       VALUES ($1,'pagescopeadmin','pagescopeadmin@x.test',$2,'admin',true)`,
      [U_ADMIN, '$2b$04$notarealhashnotarealhashno']
    );
    // ADMIN ON PURPOSE — see the header. As a non-admin, "unscoped" would silently mean
    // "your granted projects", masking exactly the failure being probed. An admin has
    // ZERO rows in user_project_access; the bypass is by role.
    const { tokenId } = await AuthService.createSession(U_ADMIN);
    adminToken = AuthService.generateJWT(
      { id: U_ADMIN, username: 'pagescopeadmin', email: 'a@x.test', role: 'admin' } as never,
      tokenId
    );
  }, 120000);

  afterAll(async () => {
    await cleanup();
    await pool.end();
  });

  /** Did the response body carry a planted marker? Substring on the raw JSON — no
   *  reliance on the response's shape, which the code under test also owns. */
  const carries = (body: unknown, mark: string): boolean => JSON.stringify(body).includes(mark);

  // ── PRE-CONDITION: the fixture is real and asymmetric ─────────────────────────────
  it('both planted rows exist, one in each project (the fixture is not vacuous)', async () => {
    const rows = await pool.query(
      'SELECT project_id, content FROM contexts WHERE project_id = ANY($1::uuid[]) ORDER BY content',
      [[P_DEFAULT, P_PAGE]]
    );
    expect(rows.rows).toHaveLength(2);
    expect(rows.rows.map((r) => r.project_id).sort()).toEqual([P_DEFAULT, P_PAGE].sort());
  });

  // ══════════════════════════════════════════════════════════════════════════════════
  //  READ DIRECTION
  // ══════════════════════════════════════════════════════════════════════════════════
  describe('READ — a request scoped to A returns A and NOT the row planted in B', () => {
    // DB-BACKED list endpoints only. `/api/decisions` is deliberately NOT here: its GET
    // also delegates to the mcp-server, so it cannot see the planted rows and would fail
    // for a reason that has nothing to do with project scope.
    it.each([['/api/contexts'], ['/api/tasks']])('%s', async (path) => {
      const res = await request(app)
        .get(path)
        .set('Authorization', `Bearer ${adminToken}`)
        // This is exactly what the frontend's `usePageProject().scope()` produces.
        .set('X-Project-ID', P_DEFAULT);

      expect(res.status).toBe(200);
      // The planted foreign record is ABSENT…
      expect(carries(res.body, MARK_B)).toBe(false);
      // …and the request genuinely NAMED A, rather than naming nothing and returning
      // an empty page that would satisfy the assertion above for the wrong reason.
      expect(carries(res.body, MARK_A)).toBe(true);
    });

    it('scoping to B returns B and NOT A — the guard is symmetric, not "A always wins"', async () => {
      const res = await request(app)
        .get('/api/contexts')
        .set('Authorization', `Bearer ${adminToken}`)
        .set('X-Project-ID', P_PAGE);

      expect(res.status).toBe(200);
      expect(carries(res.body, MARK_B)).toBe(true);
      expect(carries(res.body, MARK_A)).toBe(false);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════
  //  THE MUTATION — proof this suite can SEE the defect
  // ══════════════════════════════════════════════════════════════════════════════════
  describe('MUTATION — with the scope removed, the foreign row DOES come back', () => {
    it('an UNSCOPED admin read returns BOTH projects (so "absent" above was earned)', async () => {
      // This is the state the frontend lands in when localStorage is cleared or the
      // default is nulled — the §A2 population. As admin it returns everything, which is
      // precisely why the frontend must never reach it (see the ladder in
      // frontend/src/api/http/projectHeaders.ts) and why `scopedRequestConfig` throws
      // rather than falling back.
      const res = await request(app)
        .get('/api/contexts')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(carries(res.body, MARK_A)).toBe(true);
      expect(carries(res.body, MARK_B)).toBe(true);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════
  //  WRITE DIRECTION (§A1) — the silent-misplacement bug
  // ══════════════════════════════════════════════════════════════════════════════════
  describe('WRITE — a record created from a page scoped to B is filed under B, not the default A', () => {
    const callTool = McpService.callTool as jest.Mock;

    /** The `projectId` this backend forwarded — the value that becomes the row's column. */
    const forwardedProjectId = (): unknown => {
      expect(callTool).toHaveBeenCalledTimes(1);
      const [tool, args] = callTool.mock.calls[0];
      expect(tool).toBe('decision_record');
      return (args as { projectId?: unknown }).projectId;
    };

    beforeEach(() => callTool.mockClear());

    it('POST /api/decisions with X-Project-ID: B files it under B', async () => {
      const res = await request(app)
        .post('/api/decisions')
        .set('Authorization', `Bearer ${adminToken}`)
        // The page is showing B. Its `scope()` pins the header to B even though the
        // user's DEFAULT — and therefore the ambient header — is A.
        .set('X-Project-ID', P_PAGE)
        .send({
          title: `pagescope write twin ${MARK_B}`,
          problem: 'a record must land in the project the page is showing',
          decision: 'scope the request from the page selection',
          rationale: 'write-direction twin for the page-scope epic §A1',
        });

      expect([200, 201]).toContain(res.status);
      expect(forwardedProjectId()).toBe(P_PAGE);
      // …and NOT the default, which is where the un-scoped version of this exact request
      // would have filed it — silently, with a 201 and no error anywhere.
      expect(forwardedProjectId()).not.toBe(P_DEFAULT);
    });

    it('MUTATION — the same POST carrying the ambient A header files it under A (the bug)', async () => {
      // What a page produces when it FORGETS `scope()`: the ambient default wins, because
      // a write has no query param and the resolver's precedence is HEADER > body.
      const res = await request(app)
        .post('/api/decisions')
        .set('Authorization', `Bearer ${adminToken}`)
        .set('X-Project-ID', P_DEFAULT)
        .send({
          title: `pagescope write MISPLACED ${MARK_A}`,
          problem: 'demonstrates the header-wins write precedence',
          decision: 'this is what a page that omits scope() produces',
        });

      expect([200, 201]).toContain(res.status);
      // PINNED ON PURPOSE. This whole design depends on the header deciding a write; if
      // the backend ever changes that precedence, it goes red HERE, loudly, instead of
      // showing up months later as records quietly filed in the wrong project.
      expect(forwardedProjectId()).toBe(P_DEFAULT);
    });

    it('MUTATION — an UNSCOPED write is REFUSED, never filed in a guessed project', async () => {
      const res = await request(app)
        .post('/api/decisions')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          title: `pagescope write UNSCOPED ${MARK_A}`,
          problem: 'no project named at all',
          decision: 'must 400 rather than pick one',
        });

      expect(res.status).toBe(400);
      // The important half: nothing was written ANYWHERE. A write that cannot determine
      // its project must fail, not fall back — a fallback here is the misplacement bug.
      expect(callTool).not.toHaveBeenCalled();
    });
  });
});
