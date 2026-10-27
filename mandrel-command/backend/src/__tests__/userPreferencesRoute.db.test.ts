/**
 * ROUTE-LEVEL guard for `GET` / `PATCH /api/users/preferences`
 * (an earlier epic §A / §A5, migration 076 `admin_users.default_project_id`).
 *
 * ════════════════════════════════════════════════════════════════════════════════════
 *  THE DEFECT THIS EXISTS TO CATCH (Reviewer B2, reject round 1)
 * ════════════════════════════════════════════════════════════════════════════════════
 * `userDefaultProject.db.test.ts` tests `UserPreferencesService` thoroughly — but the
 * service is NOT the surface a user reaches. The endpoint itself had ZERO coverage:
 *
 *     grep -rn "users/preferences" mandrel-command/backend/src
 *       → routes/users.ts:180, routes/users.ts:222   (and nothing else)
 *
 * Reviewer replaced the `mayUseAsDefault` call in the PATCH handler with
 * `const check = { ok: true }`, ran `tsc` clean, ran the full backend suite, and got
 * 1137 passed. The AUTHORIZATION on this endpoint was DELETABLE without a single test
 * noticing. A guard whose population stops at the service layer does not guard the route.
 *
 * ════════════════════════════════════════════════════════════════════════════════════
 *  THE ANCHOR
 * ════════════════════════════════════════════════════════════════════════════════════
 * Every scoping assertion reads `admin_users.default_project_id` with THIS suite's own
 * SQL, through the shared app pool, against the REAL migrated schema. The route is never
 * asked to report on itself: a 403 body is not proof that nothing was written, so each
 * refusal case asserts BOTH the status AND that the raw column still holds exactly what
 * it held before. The planted anchor is `P_DENIED` — a real project the non-admin user
 * has no grant for — asserted ABSENT from the column after every attempt.
 *
 * ── THE POPULATION THIS GUARD ENUMERATES ─────────────────────────────────────────────
 * Every status the PATCH handler can produce plus the whole GET:
 *   401 (no token) · 400 (non-string / bad theme) · 403 (denied project, non-admin) ·
 *   404 (ghost id, ADMIN — a non-admin gets 403 first, by design: no existence oracle) ·
 *   200 happy path · 200 explicit-null clear (the EMPTY member) · 200 theme-only PATCH
 *   leaving the default INTACT (the ABSENT member — §A5's null-clobber) · GET before any
 *   default is set (the ZERO member) · GET after · GET unauthenticated.
 *
 * ── THE MUTATION THAT PROVES IT ──────────────────────────────────────────────────────
 * Replace the `mayUseAsDefault` call in `routes/users.ts` with `const check = { ok: true }`
 * — Reviewer's exact mutation. `denies a project the user has no grant for (403)` and
 * `an ADMIN gets 404 for a project id that does not exist` must both go RED. Measured in
 * the fix report for reject round 1.
 *
 * ── LOCAL RUN ────────────────────────────────────────────────────────────────────────
 *   bash scripts/provision-test-db.sh ci_selfix_b1b2b3
 *   eval "$(bash scripts/provision-test-db.sh ci_selfix_b1b2b3 --print-env)"
 *   cd mandrel-command/backend && npx jest src/__tests__/userPreferencesRoute.db.test.ts
 */

import { describeDb, assertDbReachable } from './helpers/dbContractGate';

jest.mock('../utils/featureFlags', () => ({
  ensureFeatureFlags: jest.fn(async () => ({
    getMetadata: () => ({ version: 'test', updatedAt: new Date().toISOString() }),
    getAllFlags: () => ({}),
  })),
}));

// The mcp-server seam — a different process on a different box. Nothing under test here
// crosses it, but importing ../server wires the routes that would.
jest.mock('../services/mcp', () => ({
  McpService: {
    callTool: jest.fn(async () => ({ success: true, data: { id: 'stubbed' } })),
  },
}));

import request from 'supertest';
import app from '../server';
import { AuthService } from '../services/auth';
import { db } from '../database/connection';

// Dedicated `e7..` id prefix: this suite shares ONE database with ~75 others, run in
// band, so fixtures cannot collide with another suite's by accident.
const P_GRANTED = 'e7e70000-0000-4000-8000-e7e700000001';
const P_DENIED = 'e7e70000-0000-4000-8000-e7e700000002'; // THE PLANTED PROJECT — never grantable
const P_GHOST = 'e7e70000-0000-4000-8000-e7e7000000ff'; // valid UUID, no such row
const U_USER = 'e7e70000-0000-4000-8000-e7e7000000a1'; // non-admin, one grant
const U_ADMIN = 'e7e70000-0000-4000-8000-e7e7000000a2'; // admin, bypasses the grant table

describeDb('GET/PATCH /api/users/preferences — the ROUTE, not the service', () => {
  const pool = db;
  let userToken: string;
  let adminToken: string;

  /**
   * Read the stored default STRAIGHT OUT OF POSTGRES. Deliberately NOT via the GET
   * endpoint or UserPreferencesService: the code under test must not be the instrument
   * that reports on the code under test.
   */
  const rawStoredDefault = async (id: string): Promise<string | null> => {
    const r = await pool.query('SELECT default_project_id FROM admin_users WHERE id = $1', [id]);
    return r.rows[0]?.default_project_id ?? null;
  };

  const rawStoredTheme = async (id: string): Promise<string | null> => {
    const r = await pool.query('SELECT theme FROM admin_users WHERE id = $1', [id]);
    return r.rows[0]?.theme ?? null;
  };

  const cleanup = async () => {
    await pool.query('DELETE FROM user_project_access WHERE user_id = ANY($1::uuid[])', [
      [U_USER, U_ADMIN],
    ]);
    await pool.query('DELETE FROM auth_tokens WHERE user_id = ANY($1::uuid[])', [
      [U_USER, U_ADMIN],
    ]);
    await pool.query('DELETE FROM admin_users WHERE id = ANY($1::uuid[])', [[U_USER, U_ADMIN]]);
    await pool.query('DELETE FROM projects WHERE id = ANY($1::uuid[])', [[P_GRANTED, P_DENIED]]);
  };

  beforeAll(async () => {
    await assertDbReachable(pool);
    await cleanup();

    await pool.query(
      `INSERT INTO projects (id, name, description, status)
       VALUES ($1,'prefroute-granted','41293984 granted','active'),
              ($2,'prefroute-denied','41293984 PLANTED denied','active')`,
      [P_GRANTED, P_DENIED]
    );
    await pool.query(
      `INSERT INTO admin_users (id, username, email, password_hash, role, is_active)
       VALUES ($1,'prefrouteuser','prefrouteuser@x.test','$2b$04$notarealhashnotarealhashno','user',true),
              ($2,'prefrouteadmin','prefrouteadmin@x.test','$2b$04$notarealhashnotarealhashno','admin',true)`,
      [U_USER, U_ADMIN]
    );
    // ONE grant, deliberately. Migration 075 seeds existing non-admins against existing
    // projects, but both users and both projects are created after that seed ran, so the
    // non-admin starts with zero grants and gets exactly one here.
    await pool.query(
      'INSERT INTO user_project_access (user_id, project_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
      [U_USER, P_GRANTED]
    );

    const userSession = await AuthService.createSession(U_USER);
    userToken = AuthService.generateJWT(
      { id: U_USER, username: 'prefrouteuser', email: 'prefrouteuser@x.test', role: 'user' } as never,
      userSession.tokenId
    );
    const adminSession = await AuthService.createSession(U_ADMIN);
    adminToken = AuthService.generateJWT(
      { id: U_ADMIN, username: 'prefrouteadmin', email: 'prefrouteadmin@x.test', role: 'admin' } as never,
      adminSession.tokenId
    );
  }, 120000);

  afterAll(async () => {
    await cleanup();
    await pool.end();
  });

  const patch = (token: string | null, body: unknown) => {
    const r = request(app).patch('/api/users/preferences').send(body as object);
    return token ? r.set('Authorization', `Bearer ${token}`) : r;
  };

  // ── PRE-CONDITION: the fixture really is asymmetric ────────────────────────────────
  it('the fixture is asymmetric: the non-admin holds exactly ONE grant', async () => {
    const rows = await pool.query(
      'SELECT project_id FROM user_project_access WHERE user_id = $1',
      [U_USER]
    );
    expect(rows.rows.map((r) => r.project_id)).toEqual([P_GRANTED]);
    const ghost = await pool.query('SELECT id FROM projects WHERE id = $1', [P_GHOST]);
    expect(ghost.rows).toHaveLength(0);
  });

  // ══════════════════════════════════════════════════════════════════════════════════
  //  AUTHENTICATION — the outermost rung
  // ══════════════════════════════════════════════════════════════════════════════════
  describe('401 — no token reaches neither handler', () => {
    it('PATCH without a token is 401 and writes nothing', async () => {
      const before = await rawStoredDefault(U_USER);
      const res = await patch(null, { defaultProjectId: P_DENIED });
      expect(res.status).toBe(401);
      expect(await rawStoredDefault(U_USER)).toBe(before);
    });

    it('GET without a token is 401', async () => {
      const res = await request(app).get('/api/users/preferences');
      expect(res.status).toBe(401);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════
  //  GET — the entire new read half
  // ══════════════════════════════════════════════════════════════════════════════════
  describe('GET /api/users/preferences', () => {
    it('returns a null default BEFORE one is set (the ZERO member, not an error)', async () => {
      // The column starts NULL. A read path that 404s or 500s on "no preference yet" is
      // the state every brand-new user is in, so it is the member most likely to break.
      expect(await rawStoredDefault(U_ADMIN)).toBeNull();
      const res = await request(app)
        .get('/api/users/preferences')
        .set('Authorization', `Bearer ${adminToken}`);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.preferences).toHaveProperty('defaultProjectId', null);
      expect(res.body.data.preferences).toHaveProperty('theme');
    });

    it('returns the value the RAW COLUMN holds after one is set', async () => {
      await pool.query('UPDATE admin_users SET default_project_id = $1 WHERE id = $2', [
        P_GRANTED,
        U_USER,
      ]);
      const res = await request(app)
        .get('/api/users/preferences')
        .set('Authorization', `Bearer ${userToken}`);
      expect(res.status).toBe(200);
      expect(res.body.data.preferences.defaultProjectId).toBe(P_GRANTED);
      // …and it is not merely echoing the request: the column says the same thing.
      expect(await rawStoredDefault(U_USER)).toBe(P_GRANTED);
    });

    it('is scoped to the CALLER — the admin does not see the user default', async () => {
      const res = await request(app)
        .get('/api/users/preferences')
        .set('Authorization', `Bearer ${adminToken}`);
      expect(res.status).toBe(200);
      expect(res.body.data.preferences.defaultProjectId).not.toBe(P_GRANTED);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════
  //  PATCH — the authorization Reviewer deleted
  // ══════════════════════════════════════════════════════════════════════════════════
  describe('PATCH — the default project is an AUTHORIZATION decision', () => {
    beforeEach(async () => {
      // A KNOWN prior value, so "nothing was written" is a positive assertion and not
      // "the column was null and stayed null" (which a no-op handler also satisfies).
      await pool.query('UPDATE admin_users SET default_project_id = $1 WHERE id = $2', [
        P_GRANTED,
        U_USER,
      ]);
    });

    it('accepts a project the user IS granted (200, lands in the raw column)', async () => {
      await pool.query('UPDATE admin_users SET default_project_id = NULL WHERE id = $1', [U_USER]);
      const res = await patch(userToken, { defaultProjectId: P_GRANTED });
      expect(res.status).toBe(200);
      expect(await rawStoredDefault(U_USER)).toBe(P_GRANTED);
    });

    it('denies a project the user has no grant for (403) and the column is UNCHANGED', async () => {
      const res = await patch(userToken, { defaultProjectId: P_DENIED });
      expect(res.status).toBe(403);
      // THE PLANTED ANCHOR: this id must never appear in the column.
      expect(await rawStoredDefault(U_USER)).toBe(P_GRANTED);
      expect(await rawStoredDefault(U_USER)).not.toBe(P_DENIED);
    });

    it('an ADMIN gets 404 for a project id that does not exist', async () => {
      // Access-before-existence: a non-admin is 403'd first (no enumeration oracle), so
      // 404 is only reachable for an admin. Asserting it here pins that ordering.
      const res = await patch(adminToken, { defaultProjectId: P_GHOST });
      expect(res.status).toBe(404);
      expect(await rawStoredDefault(U_ADMIN)).not.toBe(P_GHOST);
    });

    it('a NON-admin gets 403 (not 404) for a ghost id — no existence oracle', async () => {
      const res = await patch(userToken, { defaultProjectId: P_GHOST });
      expect(res.status).toBe(403);
      expect(await rawStoredDefault(U_USER)).toBe(P_GRANTED);
    });

    it.each([
      ['a number', 42],
      ['a boolean', true],
      ['an object', { id: P_GRANTED }],
      ['an array', [P_GRANTED]],
    ])('rejects a non-string defaultProjectId (%s) with 400', async (_label, value) => {
      const res = await patch(userToken, { defaultProjectId: value });
      expect(res.status).toBe(400);
      expect(await rawStoredDefault(U_USER)).toBe(P_GRANTED);
    });

    it('rejects a malformed UUID string with 400', async () => {
      const res = await patch(userToken, { defaultProjectId: 'not-a-uuid' });
      expect(res.status).toBe(400);
      expect(await rawStoredDefault(U_USER)).toBe(P_GRANTED);
    });

    it('rejects an invalid theme with 400 and writes NEITHER field', async () => {
      const themeBefore = await rawStoredTheme(U_USER);
      const res = await patch(userToken, { theme: 'chartreuse', defaultProjectId: P_GRANTED });
      expect(res.status).toBe(400);
      expect(await rawStoredTheme(U_USER)).toBe(themeBefore);
      expect(await rawStoredDefault(U_USER)).toBe(P_GRANTED);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════
  //  PARTIAL UPDATE (§A5) — the null-clobber, asserted THROUGH HTTP
  // ══════════════════════════════════════════════════════════════════════════════════
  describe('PATCH — omitted key != null (the ABSENT member)', () => {
    it('a theme-only PATCH does NOT null the stored default project', async () => {
      await pool.query('UPDATE admin_users SET default_project_id = $1 WHERE id = $2', [
        P_GRANTED,
        U_USER,
      ]);
      const res = await patch(userToken, { theme: 'dark' });
      expect(res.status).toBe(200);
      expect(await rawStoredTheme(U_USER)).toBe('dark');
      // THE §A5 ASSERTION. Naively extending the old unconditional
      // `UPDATE admin_users SET theme = $1` writes NULL here.
      expect(await rawStoredDefault(U_USER)).toBe(P_GRANTED);
    });

    it('a defaultProjectId-only PATCH does NOT null the stored theme', async () => {
      await pool.query('UPDATE admin_users SET theme = $1 WHERE id = $2', ['dark', U_USER]);
      const res = await patch(userToken, { defaultProjectId: P_GRANTED });
      expect(res.status).toBe(200);
      expect(await rawStoredTheme(U_USER)).toBe('dark');
    });

    it('an explicit null CLEARS the default (the EMPTY member, always allowed)', async () => {
      await pool.query('UPDATE admin_users SET default_project_id = $1 WHERE id = $2', [
        P_GRANTED,
        U_USER,
      ]);
      const res = await patch(userToken, { defaultProjectId: null });
      expect(res.status).toBe(200);
      expect(await rawStoredDefault(U_USER)).toBeNull();
    });

    it('an empty-string defaultProjectId clears rather than 400s or stores ""', async () => {
      await pool.query('UPDATE admin_users SET default_project_id = $1 WHERE id = $2', [
        P_GRANTED,
        U_USER,
      ]);
      const res = await patch(userToken, { defaultProjectId: '' });
      expect(res.status).toBe(200);
      expect(await rawStoredDefault(U_USER)).toBeNull();
    });

    it('theme: null leaves the stored theme alone (no 400, no wipe)', async () => {
      await pool.query('UPDATE admin_users SET theme = $1 WHERE id = $2', ['dark', U_USER]);
      const res = await patch(userToken, { theme: null });
      expect(res.status).toBe(200);
      expect(await rawStoredTheme(U_USER)).toBe('dark');
    });

    it('theme: null alongside a defaultProjectId still only writes the project', async () => {
      await pool.query(
        'UPDATE admin_users SET theme = $1, default_project_id = NULL WHERE id = $2',
        ['dark', U_USER]
      );
      const res = await patch(userToken, { theme: null, defaultProjectId: P_GRANTED });
      expect(res.status).toBe(200);
      expect(await rawStoredTheme(U_USER)).toBe('dark');
      expect(await rawStoredDefault(U_USER)).toBe(P_GRANTED);
    });

    it('an EMPTY body is a no-op, not a wipe', async () => {
      await pool.query(
        'UPDATE admin_users SET default_project_id = $1, theme = $2 WHERE id = $3',
        [P_GRANTED, 'dark', U_USER]
      );
      const res = await patch(userToken, {});
      expect(res.status).toBe(200);
      expect(await rawStoredDefault(U_USER)).toBe(P_GRANTED);
      expect(await rawStoredTheme(U_USER)).toBe('dark');
    });
  });
});
