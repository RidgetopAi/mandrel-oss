/**
 * insightPagesProjectScope — the DB-backed guard for the four INSIGHT pages' project scope
 * (amendment "the guard construction", which supersedes §F).
 *
 * ════════════════════════════════════════════════════════════════════════════════════
 *  WHY THESE FOUR PAGES SPECIFICALLY
 * ════════════════════════════════════════════════════════════════════════════════════
 * Dashboard, TreeWalker and Embedding are the surfaces that had NO project
 * control at all. They silently rode the global switcher this epic deletes, which is the
 * whole reason the rework exists: the same screen could change which project it described
 * with nothing visible moving. Now each owns a selector — and this file is the half of that
 * claim the browser cannot prove.
 *
 * ════════════════════════════════════════════════════════════════════════════════════
 *  THE ANCHOR: ROWS PLANTED IN A SECOND PROJECT, IN THE REAL DATABASE
 * ════════════════════════════════════════════════════════════════════════════════════
 * A frontend test that reads back what the frontend sent is the app agreeing with itself.
 * So the anchors here are uniquely-marked rows written into project B by direct SQL, and
 * the assertions are that a request scoped to A does not contain them.
 *
 * ── "ABSENT" IS NEVER ASSERTED ALONE ─────────────────────────────────────────────────
 * A response missing B's marker is also what a broken endpoint, an empty result, or a
 * request that named nothing produces. Every case therefore asserts BOTH halves: B's
 * marker ABSENT and A's marker PRESENT. Present-and-correct, not merely not-wrong.
 *
 * ── RUN AS ADMIN, DELIBERATELY ───────────────────────────────────────────────────────
 * For a NON-admin, "unscoped" already means "the caller's granted projects"
 * (services/projectListScope.ts), which would MASK the failure under test behind an
 * authorization result — the test would pass on a page that names no project at all. An
 * admin holds everything, so an unscoped request returns EVERYTHING and a leak is visible.
 *
 * ── THE MUTATION THAT PROVES IT IS NOT VACUOUS ───────────────────────────────────────
 * Each read has a twin that sends the SAME request with the scope REMOVED — the state the
 * frontend reaches when localStorage is cleared or the default is nulled (§A2) — and
 * asserts the foreign row DOES come back. Without that, "B absent" could be true because
 * the fixture never worked.
 *
 * ════════════════════════════════════════════════════════════════════════════════════
 *  THE POPULATION, AND WHY IT IS THE RIGHT ONE (C3)
 * ════════════════════════════════════════════════════════════════════════════════════
 * The endpoints these four pages read that are (a) served from THIS backend's Postgres and
 * (b) capable of returning another project's data:
 *
 *   Dashboard  → GET /api/dashboard/stats          (counts, so asserted by VALUE)
 *   TreeWalker → GET /api/treewalker/thread        (header-scoped; no path/query alternative)
 *   Embedding  → GET /api/embedding/list           (header-scoped)
 *   Projects   → GET  /api/projects/:id                       (PATH-scoped)
 *
 * Deliberately NOT here, with reasons rather than silence:
 *   • `/api/sessions`, `/api/sessions/trends`, `/api/tasks/throughput`, `/api/projects` —
 *     also read by the Dashboard, but they are already swept for exactly this class by
 *     `unscopedListProjectScope.db.test.ts`, which walks EVERY registered GET route off the
 *     live Express app rather than a hand list. Restating four of them here would add a
 *     second, narrower copy of that guard (C5) without adding coverage.
 *   • `/api/embedding/{similarity,projection,cluster,metrics,…}` — same resolver, same
 *     header, and each needs a dataset fixture whose failures would mostly not be about
 *     project scope. `/list` is the one that feeds every panel and the one that may legally
 *     run unscoped, which makes it the load-bearing member.
 *
 * ════════════════════════════════════════════════════════════════════════════════════
 *  ONE THING THIS FILE DOES NOT ASSERT, AND SHOULD
 * ════════════════════════════════════════════════════════════════════════════════════
 * `GET /api/projects` is itself project-scoped, so a request carrying the pinned ambient
 * header returns exactly ONE project — which collapses the option list every selector on
 * every page is built from. That was MEASURED on this database (see the report for the
 * probe), but it is a defect in the shared foundation, not in these pages, and asserting
 * the correct behaviour here would leave a permanently RED test in someone else's lane.
 * It is reported to the coordinator instead. If it is still open when this lands, that is the reason.
 *
 * Local run:
 *   bash scripts/provision-test-db.sh ci_sel_insight
 *   set -a; eval "$(bash scripts/provision-test-db.sh ci_sel_insight --print-env)"; set +a
 *   cd mandrel-command/backend && npx jest src/__tests__/insightPagesProjectScope.db.test.ts
 */

import { describeDb, assertDbReachable } from './helpers/dbContractGate';

jest.mock('../utils/featureFlags', () => ({
  ensureFeatureFlags: jest.fn(async () => ({
    getMetadata: () => ({ version: 'test', updatedAt: new Date().toISOString() }),
    getAllFlags: () => ({}),
  })),
}));

import request from 'supertest';
import app from '../server';
import { AuthService } from '../services/auth';
import { db } from '../database/connection';
import { activeEmbeddingColumn, vectorLiteral } from './helpers/embedGeometry';

// Dedicated `e6..` id prefix: this suite shares ONE database with ~75 others, run in band,
// so fixtures must not be able to collide with another suite's by accident.
const P_A = 'e6e60000-0000-4000-8000-e6e600000001'; // the project the PAGE selected
const P_B = 'e6e60000-0000-4000-8000-e6e600000002'; // the foreign project
const U_ADMIN = 'e6e60000-0000-4000-8000-e6e6000000a1';

const MARK_A = 'INSIGHTSCOPEALPHA';
const MARK_B = 'INSIGHTSCOPEBRAVO';

const EMBEDDING_PAD_TAG = 'embedding-pad-fixture';

describeDb('insight pages — the request names the PAGE\'s project', () => {
  // The app's own pool: this suite imports ../server, which opens it. A private second pool
  // would double this process's client slots against a CONNECTION-LIMITed throwaway role.
  const pool = db;
  let adminToken: string;

  const cleanup = async () => {
    for (const t of ['contexts', 'technical_decisions', 'tasks']) {
      await pool.query(`DELETE FROM ${t} WHERE project_id = ANY($1::uuid[])`, [[P_A, P_B]]);
    }
    await pool.query('DELETE FROM auth_tokens WHERE user_id = $1', [U_ADMIN]);
    await pool.query('DELETE FROM projects WHERE id = ANY($1::uuid[])', [[P_A, P_B]]);
    await pool.query('DELETE FROM admin_users WHERE id = $1', [U_ADMIN]);
  };

  beforeAll(async () => {
    await assertDbReachable(pool);
    await cleanup();

    await pool.query(
      'INSERT INTO projects (id, name, description) VALUES ($1,$2,$3),($4,$5,$6)',
      [
        P_A, `insightscope-a-${MARK_A}`, `page project ${MARK_A}`,
        P_B, `insightscope-b-${MARK_B}`, `foreign project ${MARK_B}`,
      ]
    );

    const embeddingCol = activeEmbeddingColumn();
    // A non-null embedding is what makes a project appear as an embedding DATASET at all.
    // Its geometry comes from helpers/embedGeometry — never a length written by hand
    //.
    const embedding = vectorLiteral();

    for (const [pid, mark] of [[P_A, MARK_A], [P_B, MARK_B]] as const) {
      // THE TREEWALKER ANCHOR. `ref:resume` is what the resume-thread endpoint resolves, and
      // the content becomes a node title in the response — so the marker is visible in the
      // shaped payload, not just in the row.
      await pool.query(
        `INSERT INTO contexts (project_id, context_type, content, tags, ${embeddingCol})
         VALUES ($1,'handoff',$2,$3,$4::vector)`,
        [pid, `★ Handoff planted ${mark}`, ['ref:resume'], embedding]
      );
      // A second context, so the dashboard COUNT for each project is a distinct number
      // (A=2, B=1) and "scoped to A" cannot be confused with "scoped to B".
      if (pid === P_A) {
        await pool.query(
          `INSERT INTO contexts (project_id, context_type, content, tags)
           VALUES ($1,'completion',$2,$3)`,
          [pid, `planted completion ${mark}`, [mark]]
        );
      }
    }

    await pool.query(
      `INSERT INTO admin_users (id, username, email, password_hash, role, is_active)
       VALUES ($1,'insightscopeadmin','insightscopeadmin@x.test',$2,'admin',true)`,
      [U_ADMIN, '$2b$04$notarealhashnotarealhashno']
    );
    // ADMIN ON PURPOSE — see the header.
    const { tokenId } = await AuthService.createSession(U_ADMIN);
    adminToken = AuthService.generateJWT(
      { id: U_ADMIN, username: 'insightscopeadmin', email: 'a@x.test', role: 'admin' } as never,
      tokenId
    );
  }, 120000);

  afterAll(async () => {
    await cleanup();
    await pool.end();
  });

  /** Did the response body carry a planted marker? Substring on the raw JSON — no reliance
   *  on the response's SHAPE, which the code under test also owns. */
  const carries = (body: unknown, mark: string): boolean => JSON.stringify(body).includes(mark);

  const get = (path: string, projectId?: string) => {
    const req = request(app).get(path).set('Authorization', `Bearer ${adminToken}`);
    // Exactly what the frontend's `usePageProject().scope()` produces.
    return projectId ? req.set('X-Project-ID', projectId) : req;
  };

  // ── PRE-CONDITION: the fixture is real and asymmetric ─────────────────────────────
  it('the planted rows exist, in both projects (the fixture is not vacuous)', async () => {
    const ctx = await pool.query(
      'SELECT project_id FROM contexts WHERE project_id = ANY($1::uuid[])',
      [[P_A, P_B]]
    );
    expect(ctx.rows.filter((r) => r.project_id === P_A)).toHaveLength(2);
    expect(ctx.rows.filter((r) => r.project_id === P_B)).toHaveLength(1);
  });

  // ══════════════════════════════════════════════════════════════════════════════════
  //  TREEWALKER — header-scoped, no path or query alternative
  // ══════════════════════════════════════════════════════════════════════════════════
  describe('TreeWalker — GET /api/treewalker/thread', () => {
    it('scoped to A: walks A\'s resume anchor and NOT the one planted in B', async () => {
      const res = await get('/api/treewalker/thread', P_A);
      expect(res.status).toBe(200);
      expect(carries(res.body, MARK_A)).toBe(true);
      expect(carries(res.body, MARK_B)).toBe(false);
    });

    it('scoped to B: symmetric — B\'s anchor, not A\'s ("A always wins" would pass the above)', async () => {
      const res = await get('/api/treewalker/thread', P_B);
      expect(res.status).toBe(200);
      expect(carries(res.body, MARK_B)).toBe(true);
      expect(carries(res.body, MARK_A)).toBe(false);
    });

    it('MUTATION — UNSCOPED, an admin walks across BOTH projects (so "absent" was earned)', async () => {
      // The state the frontend reaches when the ambient header is gone. Note it does not
      // fail: it silently answers from a wider corpus, which is why the page must never
      // reach it and why `scopedRequestConfig` throws instead of falling back.
      const res = await get('/api/treewalker/thread');
      expect(res.status).toBe(200);
      const reachedBoth = carries(res.body, MARK_A) && carries(res.body, MARK_B);
      const reachedForeign = carries(res.body, MARK_B);
      // The anchor an unscoped walk resolves is whichever `ref:resume` context is newest
      // across every project, so the precise body varies. What must be true is that the
      // scope no longer confines it to A — B is reachable.
      expect(reachedBoth || reachedForeign).toBe(true);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════
  //  EMBEDDING — the feed behind all seven panels
  // ══════════════════════════════════════════════════════════════════════════════════
  describe('Embedding — GET /api/embedding/list', () => {
    it('scoped to A: returns A\'s dataset and NOT the one planted in B', async () => {
      const res = await get('/api/embedding/list', P_A);
      expect(res.status).toBe(200);
      const ids = (res.body as Array<{ id: string }>).map((d) => d.id);
      expect(ids).toContain(P_A);
      expect(ids).not.toContain(P_B);
    });

    it('MUTATION — UNSCOPED, the admin sees BOTH datasets', async () => {
      // The route ranks datasets by embedded-context count and returns only the top
      // 25 (datasets.ts LIMIT), so on a database that already holds many projects the
      // fixture's one- and two-row datasets fall off the page. Pad BOTH planted projects
      // past the largest dataset in the database so the cap cannot evict them, then assert
      // as before — the route is untouched and still has to return both when unscoped.
      const embeddingCol = activeEmbeddingColumn();
      const { rows } = await pool.query(
        `SELECT COALESCE(MAX(n), 0)::int AS max FROM (
           SELECT COUNT(*) AS n FROM contexts
           WHERE ${embeddingCol} IS NOT NULL AND archived_at IS NULL
           GROUP BY project_id
         ) t`
      );
      const pad = rows[0].max + 1;
      try {
        for (const pid of [P_A, P_B]) {
          await pool.query(
            `INSERT INTO contexts (project_id, context_type, content, tags, ${embeddingCol})
             SELECT $1, 'note', 'embedding pad ' || g, $2, $3::vector
             FROM generate_series(1, $4) g`,
            [pid, [EMBEDDING_PAD_TAG], vectorLiteral(), pad]
          );
        }
        const res = await get('/api/embedding/list');
        expect(res.status).toBe(200);
        const ids = (res.body as Array<{ id: string }>).map((d) => d.id);
        expect(ids).toEqual(expect.arrayContaining([P_A, P_B]));
      } finally {
        await pool.query(`DELETE FROM contexts WHERE project_id = ANY($1::uuid[]) AND $2 = ANY(tags)`, [
          [P_A, P_B],
          EMBEDDING_PAD_TAG,
        ]);
      }
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════
  //  DASHBOARD — counts, so asserted by VALUE rather than by marker
  // ══════════════════════════════════════════════════════════════════════════════════
  describe('Dashboard — GET /api/dashboard/stats', () => {
    it('scoped to A counts A\'s two contexts; scoped to B counts B\'s one', async () => {
      const a = await get('/api/dashboard/stats', P_A);
      const b = await get('/api/dashboard/stats', P_B);
      expect(a.status).toBe(200);
      expect(b.status).toBe(200);
      // Only this suite writes to these two projects, so the counts are exact — which is
      // the point: a KPI that changes when the scope changes is a KPI that IS scoped, and
      // the page must therefore say which project it is describing.
      expect(a.body.data.contexts).toBe(2);
      expect(b.body.data.contexts).toBe(1);
    });

    it('MUTATION — UNSCOPED, the admin count spans both projects (and every other)', async () => {
      const scoped = await get('/api/dashboard/stats', P_A);
      const unscoped = await get('/api/dashboard/stats');
      expect(unscoped.status).toBe(200);
      // This is the assertion that makes the whole "Mandrel-wide" label a lie worth
      // deleting: the SAME endpoint returns a different number depending on a header the
      // user never saw, and the page rendered it under a fixed workspace-wide heading.
      expect(unscoped.body.data.contexts).toBeGreaterThan(scoped.body.data.contexts);
    });

    it('the `all` SENTINEL on a query source reaches the unscoped count deliberately', async () => {
      // The Dashboard's "All projects" option. It must be distinguishable from an
      // omission — the same result, reached on purpose and visible in the URL.
      const sentinel = await get('/api/dashboard/stats?project_id=all', P_A);
      const scoped = await get('/api/dashboard/stats', P_A);
      expect(sentinel.status).toBe(200);
      expect(sentinel.body.data.contexts).toBeGreaterThan(scoped.body.data.contexts);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════
  //  PROJECT DETAIL — PATH-scoped, authorized by routes/projects.ts's router.param
  // ══════════════════════════════════════════════════════════════════════════════════
  describe('Project detail — the project is in the PATH, and the path wins', () => {
    it('GET /api/projects/:id for A returns A and not B', async () => {
      const res = await get(`/api/projects/${P_A}`, P_A);
      expect(res.status).toBe(200);
      expect(carries(res.body, MARK_A)).toBe(true);
      expect(carries(res.body, MARK_B)).toBe(false);
    });

    it('THE PATH BEATS THE HEADER — path B with an ambient header naming A returns B', async () => {
      // No ambient header can move a read whose project is a path segment the router
      // itself authorizes. Measured here rather than assumed, because "no scope() needed"
      // is exactly the kind of claim that is true until someone changes the controller.
      const res = await get(`/api/projects/${P_B}`, P_A);
      expect(res.status).toBe(200);
      expect(carries(res.body, MARK_B)).toBe(true);
      expect(carries(res.body, MARK_A)).toBe(false);
    });
  });
});
