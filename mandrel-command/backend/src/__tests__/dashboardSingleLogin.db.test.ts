/**
 * ONE LOGIN — the Command backend half (option A), through
 * the REAL app against the REAL migrated schema (migrations 052 better-auth, 108 api_tokens,
 * 109 the link).
 *
 * The better-auth password check lives in the mcp-server and is reached over HTTP; here it is
 * replaced at that ONE seam (services/betterAuthSignIn) so each of its four answers can be
 * driven. Everything on this side of the seam is real: the login route, AuthService, the JWT,
 * auth_tokens, the session check on every request, the API-token routes. The seam's HTTP
 * classifier is betterAuthSignIn.test.ts.
 *
 * POPULATION
 *   legacy     a dashboard username + password still signs in (nobody is locked out), and the
 *              session is NOT bound to better-auth.
 *   one login  email + the better-auth password → 200, the session works, it is bound to the
 *              better-auth session, and the customer can create an API token (Settings → API
 *              tokens is reachable).
 *   authz      better-auth says yes but no linked row → 403; linked row deactivated → 403;
 *              linked row role=user → signs in, but API tokens are 403; the role comes from
 *              admin_users, never from better-auth. Unauthenticated → 401. An `mdl_` API
 *              token is not a dashboard credential → 401.
 *   states     no-match → 401; rate-limited → 429; could-not-check → 503 (never 401). A
 *              non-email identifier never reaches better-auth.
 *   binding    better-auth session deleted → the dashboard session is 401 on the next request;
 *              better-auth session expired → 401; refresh keeps the binding.
 *   no hash    a password-less linked row: a username sign-in with any password is 401 (not a
 *              500), change-password is 409 and leaves no hash behind, identity edits are 409.
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
    authHeader: () => ({}),
    resolveMcpTarget: () => ({ hostname: '127.0.0.1', port: 1 }),
  },
}));

jest.mock('../services/betterAuthSignIn', () => ({
  signInThroughBetterAuth: jest.fn(),
}));

import request from 'supertest';
import { randomBytes } from 'crypto';
import app from '../server';
import { AuthService } from '../services/auth';
import { db } from '../database/connection';
import { signInThroughBetterAuth } from '../services/betterAuthSignIn';

const signIn = signInThroughBetterAuth as jest.MockedFunction<typeof signInThroughBetterAuth>;

// Dedicated `8aca` prefix: this suite shares ONE database with the others.
const U_LEGACY = '8aca0000-0000-4000-8000-8aca00000001';
const U_OWNER = '8aca0000-0000-4000-8000-8aca00000002';
const U_GONE = '8aca0000-0000-4000-8000-8aca00000003';
const U_PLAIN = '8aca0000-0000-4000-8000-8aca00000004';
const USERS = [U_LEGACY, U_OWNER, U_GONE, U_PLAIN];
const BA_OWNER = `8aca-ba-owner-${randomBytes(4).toString('hex')}`;
const BA_GONE = `8aca-ba-gone-${randomBytes(4).toString('hex')}`;
const BA_PLAIN = `8aca-ba-plain-${randomBytes(4).toString('hex')}`;
const BA_STRAY = `8aca-ba-stray-${randomBytes(4).toString('hex')}`;
const BA_USERS = [BA_OWNER, BA_GONE, BA_PLAIN, BA_STRAY];
const LEGACY_PW = 'Legacy-Passw0rd!';
const OWNER_EMAIL = `owner-${BA_OWNER}@customer.test`;

describeDb('ONE LOGIN: the dashboard signs in through better-auth', () => {
  const pool = db;

  const cleanup = async () => {
    await pool.query('DELETE FROM api_tokens WHERE user_id = ANY($1::uuid[])', [USERS]);
    await pool.query('DELETE FROM auth_tokens WHERE user_id = ANY($1::uuid[])', [USERS]);
    await pool.query('DELETE FROM admin_users WHERE id = ANY($1::uuid[])', [USERS]);
    await pool.query('DELETE FROM "user" WHERE id = ANY($1::text[])', [BA_USERS]);
  };

  /** A live better-auth session row, as better-auth's signInEmail would have created it. */
  const baSession = async (userId: string, expiresSql = "now() + interval '7 days'"): Promise<string> => {
    const id = `8aca-sess-${randomBytes(8).toString('hex')}`;
    await pool.query(
      `INSERT INTO "session" (id, "expiresAt", token, "createdAt", "updatedAt", "userId")
       VALUES ($1, ${expiresSql}, $2, now(), now(), $3)`,
      [id, randomBytes(16).toString('hex'), userId]
    );
    return id;
  };

  const login = (username: string, password: string) =>
    request(app).post('/api/auth/login').send({ username, password });
  const profile = (jwt: string) => request(app).get('/api/auth/profile').set('Authorization', `Bearer ${jwt}`);

  beforeAll(async () => {
    await assertDbReachable(pool);
    await cleanup();
    for (const id of [BA_OWNER, BA_GONE, BA_PLAIN, BA_STRAY]) {
      await pool.query(
        `INSERT INTO "user" (id, name, email, "emailVerified") VALUES ($1, $1, $2, true)`,
        [id, `${id}@customer.test`]
      );
    }
    const legacyHash = await AuthService.hashPassword(LEGACY_PW);
    await pool.query(
      `INSERT INTO admin_users (id, username, email, password_hash, role, is_active, auth_user_id) VALUES
         ($1, '8aca-legacy', '8aca-legacy@x.test', $2,   'admin', true,  NULL),
         ($3, '8aca-owner',  $4,                   NULL, 'admin', true,  $5),
         ($6, '8aca-gone',   '8aca-gone@x.test',   NULL, 'admin', false, $7),
         ($8, '8aca-plain',  '8aca-plain@x.test',  NULL, 'user',  true,  $9)`,
      [U_LEGACY, legacyHash, U_OWNER, OWNER_EMAIL, BA_OWNER, U_GONE, BA_GONE, U_PLAIN, BA_PLAIN]
    );
  }, 120000);

  afterAll(async () => {
    await cleanup();
    await pool.end();
  });

  beforeEach(() => signIn.mockReset());

  describe('legacy: a dashboard username + password still works (nobody is locked out)', () => {
    it('200, a working session, not bound to better-auth, and better-auth is never asked', async () => {
      const r = await login('8aca-legacy', LEGACY_PW);
      expect(r.status).toBe(200);
      expect(r.body.user.username).toBe('8aca-legacy');
      expect(r.body.user.password_hash).toBeUndefined();
      expect((await profile(r.body.token)).status).toBe(200);
      const rows = (await pool.query('SELECT auth_session_id FROM auth_tokens WHERE user_id = $1', [U_LEGACY])).rows;
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((x) => x.auth_session_id === null)).toBe(true);
      expect(signIn).not.toHaveBeenCalled();
    });

    it('a wrong password for a NON-email identifier is 401 and never reaches better-auth', async () => {
      expect((await login('8aca-legacy', 'nope')).status).toBe(401);
      expect(signIn).not.toHaveBeenCalled();
    });
  });

  describe('one login: the better-auth email + password opens the dashboard', () => {
    it('200 → session bound to the better-auth session → Settings → API tokens works', async () => {
      const sess = await baSession(BA_OWNER);
      signIn.mockResolvedValueOnce({ kind: 'ok', authUserId: BA_OWNER, email: OWNER_EMAIL, authSessionId: sess });

      const r = await login(OWNER_EMAIL, 'Customer-Chosen-1');
      expect(r.status).toBe(200);
      expect(signIn).toHaveBeenCalledWith(OWNER_EMAIL, 'Customer-Chosen-1', expect.any(String)); // + the client address
      expect(r.body.user).toMatchObject({ id: U_OWNER, username: '8aca-owner', role: 'admin' });
      expect(r.body.user.password_hash).toBeUndefined();

      const bound = (await pool.query('SELECT auth_session_id FROM auth_tokens WHERE user_id = $1', [U_OWNER])).rows;
      expect(bound.map((x) => x.auth_session_id)).toContain(sess);

      expect((await profile(r.body.token)).status).toBe(200);
      const created = await request(app)
        .post('/api/api-tokens')
        .set('Authorization', `Bearer ${r.body.token}`)
        .send({ name: 'punch-list loop' });
      expect(created.status).toBe(201);
      expect(created.body.data.plaintext).toMatch(/^mdl_/);
      const owned = await pool.query('SELECT count(*)::int AS n FROM api_tokens WHERE user_id = $1', [U_OWNER]);
      expect(owned.rows[0].n).toBe(1);
    });

    it('better-auth accepts but no dashboard row is linked → 403, no session minted', async () => {
      const sess = await baSession(BA_STRAY);
      signIn.mockResolvedValueOnce({ kind: 'ok', authUserId: BA_STRAY, email: `${BA_STRAY}@customer.test`, authSessionId: sess });
      const before = (await pool.query('SELECT count(*)::int AS n FROM auth_tokens')).rows[0].n;
      const r = await login(`${BA_STRAY}@customer.test`, 'right');
      expect(r.status).toBe(403);
      expect(r.body.token).toBeUndefined();
      expect((await pool.query('SELECT count(*)::int AS n FROM auth_tokens')).rows[0].n).toBe(before);
    });

    it('a linked but DEACTIVATED dashboard row → 403', async () => {
      const sess = await baSession(BA_GONE);
      signIn.mockResolvedValueOnce({ kind: 'ok', authUserId: BA_GONE, email: `${BA_GONE}@customer.test`, authSessionId: sess });
      expect((await login(`${BA_GONE}@customer.test`, 'right')).status).toBe(403);
    });

    it('the ROLE comes from admin_users: a linked role=user row signs in but cannot hold tokens', async () => {
      const sess = await baSession(BA_PLAIN);
      signIn.mockResolvedValueOnce({ kind: 'ok', authUserId: BA_PLAIN, email: `${BA_PLAIN}@customer.test`, authSessionId: sess });
      const r = await login(`${BA_PLAIN}@customer.test`, 'right');
      expect(r.status).toBe(200);
      expect(r.body.user.role).toBe('user');
      const t = await request(app).post('/api/api-tokens').set('Authorization', `Bearer ${r.body.token}`).send({ name: 'x' });
      expect(t.status).toBe(403);
    });
  });

  describe('the four answers of the better-auth check stay four', () => {
    it.each([
      ['no-match', 401],
      ['rate-limited', 429],
      ['unavailable', 503],
    ] as const)('%s → %i', async (kind, status) => {
      signIn.mockResolvedValueOnce({ kind } as never);
      const r = await login(OWNER_EMAIL, 'whatever');
      expect(r.status).toBe(status);
      expect(r.body.token).toBeUndefined();
    });
  });

  describe('authz at the dashboard surface', () => {
    it('unauthenticated → 401 on the token routes and the profile', async () => {
      expect((await request(app).get('/api/api-tokens')).status).toBe(401);
      expect((await request(app).post('/api/api-tokens').send({ name: 'x' })).status).toBe(401);
      expect((await request(app).get('/api/auth/profile')).status).toBe(401);
    });

    it('an API token is not a dashboard credential: an mdl_ bearer cannot mint more tokens', async () => {
      const sess = await baSession(BA_OWNER);
      signIn.mockResolvedValueOnce({ kind: 'ok', authUserId: BA_OWNER, email: OWNER_EMAIL, authSessionId: sess });
      const jwt = (await login(OWNER_EMAIL, 'right')).body.token as string;
      const created = await request(app).post('/api/api-tokens').set('Authorization', `Bearer ${jwt}`).send({ name: 'loop-2' });
      const mdl = created.body.data.plaintext as string;
      expect(mdl).toMatch(/^mdl_/);
      for (const call of [
        request(app).get('/api/api-tokens'),
        request(app).post('/api/api-tokens').send({ name: 'escalate' }),
        request(app).get('/api/auth/profile'),
        request(app).post('/api/auth/refresh'),
      ]) {
        expect((await call.set('Authorization', `Bearer ${mdl}`)).status).toBe(401);
      }
    });
  });

  describe('binding: the dashboard session lives only as long as its better-auth session', () => {
    const signInFresh = async (expiresSql?: string) => {
      const sess = await baSession(BA_OWNER, expiresSql);
      signIn.mockResolvedValueOnce({ kind: 'ok', authUserId: BA_OWNER, email: OWNER_EMAIL, authSessionId: sess });
      const r = await login(OWNER_EMAIL, 'right');
      return { sess, jwt: r.body.token as string, status: r.status };
    };

    it('better-auth deletes the session (password reset / sign-out) → next request 401', async () => {
      const { sess, jwt } = await signInFresh();
      expect((await profile(jwt)).status).toBe(200);
      await pool.query('DELETE FROM "session" WHERE id = $1', [sess]);
      expect((await profile(jwt)).status).toBe(401);
    });

    it('the better-auth session expires → 401 (the dashboard row alone is not enough)', async () => {
      const { sess, jwt } = await signInFresh();
      expect((await profile(jwt)).status).toBe(200);
      await pool.query(`UPDATE "session" SET "expiresAt" = now() - interval '1 second' WHERE id = $1`, [sess]);
      expect((await profile(jwt)).status).toBe(401);
    });

    it('refresh keeps the binding: the refreshed session dies with the better-auth session too', async () => {
      const { sess, jwt } = await signInFresh();
      const refreshed = await request(app).post('/api/auth/refresh').set('Authorization', `Bearer ${jwt}`);
      expect(refreshed.status).toBe(200);
      const next = refreshed.body.data.token as string;
      expect((await profile(next)).status).toBe(200);
      await pool.query('DELETE FROM "session" WHERE id = $1', [sess]);
      expect((await profile(next)).status).toBe(401);
    });
  });

  describe('a password-less (sign-in managed) dashboard row', () => {
    const ownerJwt = async () => {
      const sess = await baSession(BA_OWNER);
      signIn.mockResolvedValueOnce({ kind: 'ok', authUserId: BA_OWNER, email: OWNER_EMAIL, authSessionId: sess });
      return (await login(OWNER_EMAIL, 'right')).body.token as string;
    };

    it('a username sign-in with any password is 401, not a 500', async () => {
      expect((await login('8aca-owner', '')).status).toBe(400);
      expect((await login('8aca-owner', 'anything-at-all')).status).toBe(401);
    });

    it('change-password is 409 SIGN_IN_MANAGED and leaves no dashboard password behind', async () => {
      const jwt = await ownerJwt();
      const r = await request(app)
        .post('/api/users/change-password')
        .set('Authorization', `Bearer ${jwt}`)
        .send({ currentPassword: 'anything', newPassword: 'New-Passw0rd!x' });
      expect(r.status).toBe(409);
      expect(r.body.code).toBe('SIGN_IN_MANAGED');
      const row = (await pool.query('SELECT password_hash FROM admin_users WHERE id = $1', [U_OWNER])).rows[0];
      expect(row.password_hash).toBeNull();
    });

    it('identity edits (username / email) are 409 SIGN_IN_MANAGED, and nothing changes', async () => {
      const jwt = await ownerJwt();
      const r = await request(app)
        .put('/api/users/profile')
        .set('Authorization', `Bearer ${jwt}`)
        .send({ email: 'elsewhere@x.test', currentPassword: 'anything' });
      expect(r.status).toBe(409);
      expect(r.body.code).toBe('SIGN_IN_MANAGED');
      const row = (await pool.query('SELECT email FROM admin_users WHERE id = $1', [U_OWNER])).rows[0];
      expect(row.email).toBe(OWNER_EMAIL);
    });
  });
});
