/**
 * revokeSessionsInvalidatesTokens.db.test.ts — SECURITY gate for
 * `POST /api/users/revoke-sessions`.
 *
 * THE DEFECT THIS GUARDS
 *   The route used to perform ONLY an analytics write:
 *
 *       UPDATE sessions SET status='inactive', ended_at=… WHERE user_id=$1 AND status='active'
 *
 *   `sessions` is the WORK/ANALYTICS table. Nothing in the authentication path reads
 *   it: `authenticateToken` -> `AuthService.validateSession(tokenId)` gates on
 *   `auth_tokens` (`expires_at > NOW() AND invalidated_at IS NULL`). So the route
 *   closed some analytics rows and answered
 *
 *       "All sessions revoked successfully. Please log in again."
 *
 *   while every issued JWT stayed ACCEPTED for the rest of its 24h TTL. The UI
 *   affordance is "Revoke all sessions… / Sign out everywhere — useful if a device
 *   was lost", and the frontend then clears only the LOCAL token and redirects to
 *   /login — so the user SEES a logout and believes the lost device was cut off.
 *   A stolen token kept full access. Live on all 7 tenant containers.
 *
 * THE FIX BEING GUARDED
 *   `AuthService.invalidateAllUserSessions(userId)` (the write to
 *   `auth_tokens.invalidated_at`) is the PRIMARY action and runs FIRST; if it throws,
 *   the response must NOT claim success. The analytics `sessions` UPDATE stays, but
 *   as clearly-labelled bookkeeping that can never stand in for the security action.
 *
 * WHY THESE TESTS HAVE TEETH
 *   - Nothing here re-implements the rule. The observable is a SIDE EFFECT measured
 *     through the REAL auth middleware: the same captured JWT is replayed against a
 *     REAL authenticated route (`GET /api/auth/profile`) and must be REJECTED.
 *   - POSITIVE CONTROL first: the captured token is proven ACCEPTED (200) BEFORE the
 *     revoke call. Without that baseline a post-revoke 401 proves nothing.
 *   - ANTI-VACUOUS: the post-revoke 401 is pinned to the revocation cause — the JWT
 *     itself must still verify cryptographically (`verifyJWT` returns a payload) and
 *     the middleware's reason must be the session gate, not "malformed"/"expired"/
 *     "user missing". A 401 obtained by breaking the token would be a false green.
 *   - The fail-closed test forces the PRIMARY action to reject and asserts the
 *     response never carries the reassuring message — the exact shape of the bug.
 *
 * RUN (throwaway DB — provision FIRST):
 *   bash scripts/provision-test-db.sh ci_revoke_e6c30326
 *   eval "$(bash scripts/provision-test-db.sh ci_revoke_e6c30326 --print-env)"
 *   npx jest revokeSessionsInvalidatesTokens --runInBand --forceExit
 *   bash scripts/provision-test-db.sh ci_revoke_e6c30326 --drop
 */

import request from 'supertest';
import express, { Express } from 'express';
import { v4 as uuidv4 } from 'uuid';

import { db } from '../database/connection';
import { AuthService } from '../services/auth';
import authRouter from '../routes/auth';
import usersRouter from '../routes/users';
import { describeDb } from './helpers/dbContractGate';


// The exact user-facing claim the route makes. Asserted as a literal so a future
// edit that SOFTENS the message to match weak behaviour shows up as a diff here.
const SUCCESS_CLAIM = 'All sessions revoked successfully. Please log in again.';

describeDb('POST /api/users/revoke-sessions — really revokes credentials (DB integration)', () => {
  let app: Express;
  let userId: string;
  let username: string;
  const password = 'ProbePassw0rd!e6c30326';
  const seededUserIds: string[] = [];

  beforeAll(async () => {
    app = express();
    app.use(express.json());
    app.use('/api/auth', authRouter);
    app.use('/api/users', usersRouter);
  });

  // A FRESH user per test: the route revokes EVERY credential for the caller, so a
  // shared user would let one case decide another case's result.
  beforeEach(async () => {
    userId = uuidv4();
    username = `revoketest_${userId.slice(0, 8)}`;
    seededUserIds.push(userId);

    const hash = await AuthService.hashPassword(password);
    await db.query(
      `INSERT INTO admin_users (id, username, email, password_hash, role, is_active, must_change_password)
       VALUES ($1, $2, $3, $4, 'admin', true, false)`,
      [userId, username, `${username}@example.com`, hash]
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    if (seededUserIds.length) {
      await db.query(`DELETE FROM auth_tokens WHERE user_id = ANY($1::uuid[])`, [seededUserIds]);
      await db.query(`DELETE FROM sessions WHERE user_id = ANY($1::uuid[])`, [seededUserIds]);
      await db.query(`DELETE FROM admin_users WHERE id = ANY($1::uuid[])`, [seededUserIds]);
    }
    await db.end();
  });

  /** Log in for real and hand back the JWT the product would hand a browser. */
  async function login(): Promise<string> {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ username, password });
    expect(res.status).toBe(200);
    // POST /api/auth/login answers { user, token, expires } (not envelope-wrapped).
    expect(typeof res.body?.token).toBe('string');
    return res.body.token as string;
  }

  const profile = (token: string) =>
    request(app).get('/api/auth/profile').set('Authorization', `Bearer ${token}`);

  const revoke = (token: string) =>
    request(app).post('/api/users/revoke-sessions').set('Authorization', `Bearer ${token}`);

  it('a JWT captured before the revoke is REJECTED after it (the whole point)', async () => {
    const token = await login();

    // --- POSITIVE CONTROL -----------------------------------------------------
    // Prove the captured token is genuinely accepted BEFORE revoking. Without this
    // baseline a later 401 could be 401 for any reason at all.
    const before = await profile(token);
    expect(before.status).toBe(200);
    expect(before.body?.data?.user?.id).toBe(userId);

    // --- THE ACTION -----------------------------------------------------------
    const revoked = await revoke(token);
    expect(revoked.status).toBe(200);
    expect(revoked.body.success).toBe(true);
    expect(revoked.body.message).toBe(SUCCESS_CLAIM);

    // --- THE MEASUREMENT ------------------------------------------------------
    // Same token, same route. This is the customer-visible security outcome.
    const after = await profile(token);
    expect(after.status).toBe(401);

    // ANTI-VACUOUS: the 401 must come from the SESSION gate, not from a token that
    // stopped being a token. The JWT must still verify cryptographically and still
    // be unexpired — i.e. the only thing that changed is revocation.
    expect(AuthService.verifyJWT(token)).not.toBeNull();
    expect(after.body.error).toBe('Session expired');
  });

  it('writes auth_tokens.invalidated_at — the column the auth gate actually reads', async () => {
    const token = await login();
    expect((await profile(token)).status).toBe(200); // positive control

    const live = await db.query(
      `SELECT count(*)::int AS n FROM auth_tokens WHERE user_id = $1 AND invalidated_at IS NULL`,
      [userId]
    );
    expect(live.rows[0].n).toBeGreaterThan(0);

    expect((await revoke(token)).status).toBe(200);

    const after = await db.query(
      `SELECT count(*)::int AS n FROM auth_tokens WHERE user_id = $1 AND invalidated_at IS NULL`,
      [userId]
    );
    expect(after.rows[0].n).toBe(0);
  });

  it('revokes OTHER devices, not just the caller (the lost-device case)', async () => {
    // Two independent logins = two auth_tokens rows = two "devices".
    const lostDeviceToken = await login();
    const thisDeviceToken = await login();
    expect(lostDeviceToken).not.toBe(thisDeviceToken);

    // Positive control on BOTH.
    expect((await profile(lostDeviceToken)).status).toBe(200);
    expect((await profile(thisDeviceToken)).status).toBe(200);

    expect((await revoke(thisDeviceToken)).status).toBe(200);

    expect((await profile(lostDeviceToken)).status).toBe(401);
    expect((await profile(thisDeviceToken)).status).toBe(401);
  });

  it('FAILS CLOSED: never claims success when credential invalidation fails', async () => {
    const token = await login();
    expect((await profile(token)).status).toBe(200); // positive control

    const boom = jest
      .spyOn(AuthService, 'invalidateAllUserSessions')
      .mockRejectedValue(new Error('simulated auth_tokens write failure'));

    const res = await revoke(token);

    // The failure path was actually taken — otherwise this test proves nothing.
    expect(boom).toHaveBeenCalledWith(userId);
    // Pin the SHAPE, not merely "not 200": `not.toBe(200)` is satisfied by a 404, a
    // 302, or a crash, so it would pass for reasons that are not this behaviour.
    expect(res.status).toBe(500);
    expect(res.body.success).toBe(false);
    // And the message must exist AND be the honest one. `String(undefined)` is
    // "undefined", which sails through a /revoked successfully/ regex — an absent
    // message would have passed the weaker form of this assertion.
    expect(typeof res.body.message).toBe('string');
    expect(res.body.message).not.toBe(SUCCESS_CLAIM);
    expect(res.body.message).not.toMatch(/revoked successfully/i);

    // And the honest state matches the honest answer: nothing was revoked.
    const still = await db.query(
      `SELECT count(*)::int AS n FROM auth_tokens WHERE user_id = $1 AND invalidated_at IS NULL`,
      [userId]
    );
    expect(still.rows[0].n).toBeGreaterThan(0);
    expect((await profile(token)).status).toBe(200);
  });

  it('still closes the analytics sessions rows (the pre-existing consumer keeps working)', async () => {
    const token = await login();
    const sid = uuidv4();
    await db.query(
      `INSERT INTO sessions (id, agent_type, user_id, status, started_at, last_activity_at)
       VALUES ($1, 'revoke-test', $2, 'active', NOW(), NOW())`,
      [sid, userId]
    );

    expect((await revoke(token)).status).toBe(200);

    const row = await db.query(
      `SELECT status, ended_at FROM sessions WHERE id = $1`,
      [sid]
    );
    expect(row.rows[0].status).toBe('inactive');
    expect(row.rows[0].ended_at).not.toBeNull();
  });
});
