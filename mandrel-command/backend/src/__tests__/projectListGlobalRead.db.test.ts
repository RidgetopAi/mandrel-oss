/**
 * THE PROJECT LIST MUST BE GLOBAL — `GET /api/projects` (Reviewer B4).
 *
 * ════════════════════════════════════════════════════════════════════════════════════
 *  THE DEFECT THIS EXISTS TO CATCH
 * ════════════════════════════════════════════════════════════════════════════════════
 * `GET /api/projects` is ITSELF project-scoped: `ProjectService.getAllProjects` takes a
 * `ProjectListScope`, and `resolveListScope` narrows to exactly the project the request
 * NAMED. The selector rework pins the ambient `X-Project-ID` to the user's default, so
 * that request names the default — and this endpoint fills `allProjects`, which fills
 * every `<ProjectSelect>` on all ten pages.
 *
 * Result: a ONE-ELEMENT option list containing only the project you are already on. The
 * user can never switch, and nothing errors, renders blank, or looks broken. The whole
 * feature is inert while every existing test stays green — this endpoint had no test
 * asserting a SECOND project comes back.
 *
 * ════════════════════════════════════════════════════════════════════════════════════
 *  THE ANCHOR
 * ════════════════════════════════════════════════════════════════════════════════════
 * Two projects planted by direct SQL with unique markers, one of which (B) is NOT the
 * pinned default. The assertion is that the list handed to the client CONTAINS B — a
 * thing the code under test cannot move, rename, or filter differently. "The response
 * had some projects" would pass on the broken build; "the response contains B" does not.
 *
 * RUN AS ADMIN, DELIBERATELY: for a non-admin, an unscoped list already means "your
 * granted projects", which would mask the failure behind an authorization result. An
 * admin holds everything, so a narrowed list is unambiguous. The non-admin case is
 * asserted separately, because the fix must NOT become "return every project to
 * everybody" — the sentinel controls the FILTER, never the AUTHORIZATION (F-04).
 *
 * ── THE MUTATION THAT PROVES IT ──────────────────────────────────────────────────────
 * Drop `project_id=all` from the frontend's global read (`api/http/projectScope.ts`
 * `globalReadConfig`) and the pinned-header case below is exactly what the browser then
 * sends: the first test IS the mutation, run permanently.
 *
 * ── LOCAL RUN ────────────────────────────────────────────────────────────────────────
 *   bash scripts/provision-test-db.sh ci_selfix_b1b2b3
 *   eval "$(bash scripts/provision-test-db.sh ci_selfix_b1b2b3 --print-env)"
 *   cd mandrel-command/backend && npx jest src/__tests__/projectListGlobalRead.db.test.ts
 */

import { describeDb, assertDbReachable } from './helpers/dbContractGate';

jest.mock('../utils/featureFlags', () => ({
  ensureFeatureFlags: jest.fn(async () => ({
    getMetadata: () => ({ version: 'test', updatedAt: new Date().toISOString() }),
    getAllFlags: () => ({}),
  })),
}));

jest.mock('../services/mcp', () => ({
  McpService: {
    callTool: jest.fn(async () => ({ success: true, data: { id: 'stubbed' } })),
  },
}));

import request from 'supertest';
import app from '../server';
import { AuthService } from '../services/auth';
import { db } from '../database/connection';

// Dedicated `e8..` id prefix — this suite shares ONE database with ~76 others, run in band.
const P_DEFAULT = 'e8e80000-0000-4000-8000-e8e800000001'; // "A" — the pinned default
const P_OTHER = 'e8e80000-0000-4000-8000-e8e800000002'; // "B" — must still be offered
const U_ADMIN = 'e8e80000-0000-4000-8000-e8e8000000a1';
const U_USER = 'e8e80000-0000-4000-8000-e8e8000000a2'; // non-admin, granted A only

const MARK_A = 'PROJLISTMARKERALPHA';
const MARK_B = 'PROJLISTMARKERBRAVO';

describeDb('GET /api/projects — the option list every ProjectSelect reads', () => {
  const pool = db;
  let adminToken: string;
  let userToken: string;

  const cleanup = async () => {
    await pool.query('DELETE FROM user_project_access WHERE user_id = ANY($1::uuid[])', [
      [U_ADMIN, U_USER],
    ]);
    await pool.query('DELETE FROM auth_tokens WHERE user_id = ANY($1::uuid[])', [
      [U_ADMIN, U_USER],
    ]);
    await pool.query('DELETE FROM admin_users WHERE id = ANY($1::uuid[])', [[U_ADMIN, U_USER]]);
    await pool.query('DELETE FROM projects WHERE id = ANY($1::uuid[])', [[P_DEFAULT, P_OTHER]]);
  };

  beforeAll(async () => {
    await assertDbReachable(pool);
    await cleanup();

    await pool.query(
      `INSERT INTO projects (id, name, description, status)
       VALUES ($1,$2,'the pinned default','active'),($3,$4,'the OTHER project','active')`,
      [P_DEFAULT, `projlist-${MARK_A}`, P_OTHER, `projlist-${MARK_B}`]
    );
    await pool.query(
      `INSERT INTO admin_users (id, username, email, password_hash, role, is_active)
       VALUES ($1,'projlistadmin','projlistadmin@x.test','$2b$04$notarealhashnotarealhashno','admin',true),
              ($2,'projlistuser','projlistuser@x.test','$2b$04$notarealhashnotarealhashno','user',true)`,
      [U_ADMIN, U_USER]
    );
    await pool.query(
      'INSERT INTO user_project_access (user_id, project_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
      [U_USER, P_DEFAULT]
    );

    const a = await AuthService.createSession(U_ADMIN);
    adminToken = AuthService.generateJWT(
      { id: U_ADMIN, username: 'projlistadmin', email: 'a@x.test', role: 'admin' } as never,
      a.tokenId
    );
    const u = await AuthService.createSession(U_USER);
    userToken = AuthService.generateJWT(
      { id: U_USER, username: 'projlistuser', email: 'u@x.test', role: 'user' } as never,
      u.tokenId
    );
  }, 120000);

  afterAll(async () => {
    await cleanup();
    await pool.end();
  });

  /** Substring on the raw JSON — no reliance on a response shape the code under test owns. */
  const carries = (body: unknown, mark: string): boolean => JSON.stringify(body).includes(mark);

  it('both projects exist (the fixture is not vacuous)', async () => {
    const rows = await pool.query('SELECT id FROM projects WHERE id = ANY($1::uuid[])', [
      [P_DEFAULT, P_OTHER],
    ]);
    expect(rows.rows).toHaveLength(2);
  });

  // ══════════════════════════════════════════════════════════════════════════════════
  //  THE DEFECT, RUN PERMANENTLY AS A CONTRAST CASE
  // ══════════════════════════════════════════════════════════════════════════════════
  it('a PINNED-HEADER read returns ONLY the pinned project — this is the bug, pinned in place', async () => {
    // Exactly what the browser sent before the fix: the ambient header, nothing else.
    // Kept as an assertion rather than a comment so that if `resolveListScope` ever stops
    // narrowing on the header, the reason the frontend sends the sentinel disappears and
    // somebody is told about it here.
    const res = await request(app)
      .get('/api/projects')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Project-ID', P_DEFAULT);

    expect(res.status).toBe(200);
    expect(carries(res.body, MARK_A)).toBe(true);
    expect(carries(res.body, MARK_B)).toBe(false); // ← the one-option selector
  });

  // ══════════════════════════════════════════════════════════════════════════════════
  //  THE FIX
  // ══════════════════════════════════════════════════════════════════════════════════
  it('the GLOBAL read (project_id=all) offers the OTHER project even with the header pinned', async () => {
    // This is what `globalReadConfig()` produces: the sentinel in the query AND the
    // ambient header still present, because the browser always sends the header.
    const res = await request(app)
      .get('/api/projects?project_id=all')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Project-ID', P_DEFAULT);

    expect(res.status).toBe(200);
    expect(carries(res.body, MARK_A)).toBe(true);
    // THE ASSERTION WHOSE ABSENCE LET A ONE-OPTION SELECTOR LOOK CORRECT.
    expect(carries(res.body, MARK_B)).toBe(true);
  });

  it('the sentinel widens the FILTER, never the AUTHORIZATION (F-04 intact)', async () => {
    // The non-admin holds a grant on A only. `project_id=all` must NOT hand them B.
    // Without this, the fix for a UX bug would be a data-disclosure regression.
    const res = await request(app)
      .get('/api/projects?project_id=all')
      .set('Authorization', `Bearer ${userToken}`)
      .set('X-Project-ID', P_DEFAULT);

    expect(res.status).toBe(200);
    expect(carries(res.body, MARK_A)).toBe(true);
    expect(carries(res.body, MARK_B)).toBe(false);
  });

  it('an unauthenticated global read is refused', async () => {
    const res = await request(app).get('/api/projects?project_id=all');
    expect(res.status).toBe(401);
  });

  // ══════════════════════════════════════════════════════════════════════════════════
  //  THE SECOND INSTANCE OF THE CLASS — the /r/<id8> short-link NAVIGATION surface
  // ══════════════════════════════════════════════════════════════════════════════════
  describe('/api/resolve/:id — a navigation surface must reach outside the default project', () => {
    // A DISTINCT id prefix, not the suite's `e8e8…` family. The first run of this block
    // used `e8e80000…` and the resolver correctly answered 200/409 — it was matching the
    // PROJECT rows, which share that prefix. A short-id fixture must not collide with its
    // own siblings or the test measures prefix collision instead of project scope.
    const CTX_IN_B = 'd3f1a700-0000-4000-8000-d3f1a7000001';
    const SHORT_ID = CTX_IN_B.slice(0, 8);

    beforeAll(async () => {
      await pool.query(
        `INSERT INTO contexts (id, project_id, context_type, content)
         VALUES ($1,$2,'completion',$3)
         ON CONFLICT (id) DO NOTHING`,
        [CTX_IN_B, P_OTHER, `planted resolve target ${MARK_B}`]
      );
    });

    afterAll(async () => {
      await pool.query('DELETE FROM contexts WHERE id = $1', [CTX_IN_B]);
    });

    it('a PINNED-HEADER resolve MISSES a record in another project (spec §A4: the wedge)', async () => {
      const res = await request(app)
        .get(`/api/resolve/${SHORT_ID}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .set('X-Project-ID', P_DEFAULT);
      expect(res.status).toBe(404);
    });

    it('the GLOBAL read finds it — and that is why resolveClient sends the sentinel', async () => {
      const res = await request(app)
        .get(`/api/resolve/${SHORT_ID}?project_id=all`)
        .set('Authorization', `Bearer ${adminToken}`)
        .set('X-Project-ID', P_DEFAULT);
      expect(res.status).toBe(200);
      expect(res.body.id).toBe(CTX_IN_B);
    });

    it('…but still MISSES for a caller with no grant on that project (F-04 intact)', async () => {
      const res = await request(app)
        .get(`/api/resolve/${SHORT_ID}?project_id=all`)
        .set('Authorization', `Bearer ${userToken}`)
        .set('X-Project-ID', P_DEFAULT);
      expect(res.status).toBe(404);
    });
  });
});
