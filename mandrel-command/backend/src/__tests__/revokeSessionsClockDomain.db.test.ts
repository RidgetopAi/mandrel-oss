/**
 * revokeSessionsClockDomain.db.test.ts — CLOCK-DOMAIN gate for
 * `POST /api/users/revoke-sessions`.
 *
 * THE DEFECT THIS GUARDS
 *   The route used to close sessions with a Postgres-clock `NOW()`:
 *
 *       UPDATE sessions SET status='inactive', ended_at = NOW()
 *        WHERE user_id = $1 AND status='active'
 *
 *   but `sessions.started_at` is written from the NODE clock (SessionRepo.create
 *   binds `params.startTime`; callers pass `new Date()`). The DB then enforces
 *
 *       CONSTRAINT reasonable_session_duration
 *         CHECK (ended_at IS NULL OR ended_at >= started_at)
 *
 *   Two clock domains compared by a DB constraint, with NO time gate.
 *   Nothing stopped this route firing on a session minted milliseconds earlier, so
 *   the moment the Postgres clock lagged the app clock the route 500'd on the CHECK.
 *
 *   The idle reaper `timeout_inactive_sessions()` has the SAME defect. Its 1-2h idle
 *   gate is NOT a safety property — it only holds while the Node-ahead skew is SMALLER
 *   than the idle threshold. Beyond that the gate selects a row whose started_at is
 *   still in the DB's future (measured: `timeout_inactive_sessions('2 hours')` raises
 *   the identical violation). Fixed separately by migration 072, which floors that
 *   function's ended_at. A gated sweep is not "safe", it is "fails later".
 *   Latent only because app + Postgres currently share one host clock; it becomes
 *   real when the DB moves off-box, a tenant container's clock drifts, or NTP
 *   corrects the unlucky way mid-window.
 *
 * THE FIX BEING GUARDED
 *   Close the session at a time the session ITSELF already recorded, floored at its
 *   own start — never a second clock's NOW():
 *
 *       ended_at = GREATEST(started_at, COALESCE(last_activity_at, started_at))
 *
 *   This is migration 051:40's pattern ("honest close time, not now()") plus the
 *   GREATEST floor. The floor is NOT decoration — see the third test below:
 *   `last_activity_at` is a MIXED-domain column (app clock at SessionRepo.create,
 *   Postgres clock on every later touch — the `update_session_activity` trigger and
 *   SessionRepo lines 482/663/683/938 all use CURRENT_TIMESTAMP/NOW()), so bare
 *   COALESCE can still land BELOW started_at and violate the same CHECK.
 *
 *   The CHECK is correct and is the thing that surfaced the class — the fix must
 *   never be to widen or drop it. Test 4 asserts the constraint is still installed.
 *
 * HOW SKEW IS REPRODUCED (two independent ways, both real)
 *   1. DATA-manufactured (always runs): seed `started_at` at an explicit offset from
 *      the Postgres clock. A session whose app-clock start is AHEAD of the DB clock is
 *      exactly the row state a Node-ahead skew produces, and needs no special runner —
 *      so this keeps its teeth in ordinary CI.
 *   2. PROCESS-clock (opt-in): the clock-skew harness at
 *      riverbend/tools/clock-skew-harness/ shifts the Node process clock via a
 *      preload while leaving Postgres alone. Set CLOCK_SKEW_MS and the last block runs
 *      with `new Date()` genuinely offset, binding started_at the way SessionRepo does.
 *
 *      MEASURED MARGINS — read these before quoting a number:
 *        • Pre-fix, THROUGH THIS ROUTE, the 500 appears at >= +50ms of Node-ahead skew and
 *          NOT at <= +20ms. That 50ms is NOT the constraint's margin. It is this test's own
 *          seed->revoke round-trip: by the time the UPDATE runs, the Postgres clock has
 *          advanced past a started_at that was only a few ms ahead. The CONSTRAINT's true
 *          margin is ~2ms (measured on the sibling fixture, where the insert and the update
 *          are adjacent). Quote the 2ms as the class margin; quote 50ms only as "through
 *          this route, in this harness".
 *        • Direction matters, and ONLY for the process-clock case. Pre-fix, the
 *          process-clock test reproduces at +1h ONLY: at -1h the Node clock is BEHIND, so
 *          NOW() > started_at and the one-directional CHECK (ended_at >= started_at) is
 *          satisfied. Measured both ways. So the -1h run is a CONTROL, not a second
 *          reproduction — do not quote it as "fails at ±1h".
 *          The DATA-manufactured cases are a different matter, but count them exactly:
 *          TWO of the three place started_at ahead IN THE ROW ("start is AHEAD" and
 *          "last_activity_at is BELOW started_at"), so those two are RED pre-fix at ANY
 *          process skew, including -1h. The third ("start is BEHIND the Postgres clock")
 *          places started_at BEHIND and is green pre-fix at any skew — it is a CONTROL,
 *          same as the -1h process run. Measured at CLOCK_SKEW_MS=-3600000: two RED, one
 *          green. Post-fix everything is green in both directions, which is the
 *          claim that actually matters.
 *
 *      PROBE THE PROBE: jest's `node` test environment builds its own VM realm, so the
 *      harness's `--import` preload does NOT reach the test's `Date` (measured: the
 *      patched class is absent inside jest). A harness that skews nothing reports a
 *      perfect pass, so when CLOCK_SKEW_MS is set this test MEASURES the real
 *      Node-vs-Postgres delta and FAILS LOUD if the requested skew did not actually
 *      apply. It never silently skips.
 *
 * RUN (throwaway DB — provision FIRST; --print-env alone does not migrate):
 *   bash scripts/provision-test-db.sh ci_skew_bc8e4c7e
 *   eval "$(bash scripts/provision-test-db.sh ci_skew_bc8e4c7e --print-env)"
 *   npx jest revokeSessionsClockDomain --runInBand --forceExit
 *   bash scripts/provision-test-db.sh ci_skew_bc8e4c7e --drop
 */

import request from 'supertest';
import express, { Express } from 'express';
import { v4 as uuidv4 } from 'uuid';

// --- Test knobs (named, not magic numbers scattered through the assertions) ---
// How far apart we place the two clocks in the data-manufactured cases. The
// acceptance bar for this task is +/- 1h, which is also a realistic NTP-correction
// / container-drift magnitude.
const SKEW_INTERVAL = process.env.SKEW_TEST_INTERVAL || '1 hour';
// Tolerance when verifying a REQUESTED process-clock skew actually applied: query
// round-trip + scheduling noise, well under any skew worth testing.
const SKEW_APPLIED_TOLERANCE_MS = Number(process.env.SKEW_TEST_TOLERANCE_MS || 5000); // reserved-port-ok: skew tolerance in ms, not a port


// The authenticated user id. Read at REQUEST time by the auth mock below, so it can
// be assigned in beforeAll (jest.mock factories are hoisted above module scope).
const g = globalThis as unknown as { __skewTestUserId?: string; __skewRevokedUserIds?: string[] };

const VALID_TOKEN = 'aaa.bbb.ccc';

// Mock ONLY auth resolution: the REAL `authenticateToken` middleware and the REAL
// users router run, and the sessions UPDATE hits the REAL Postgres with the REAL
// CHECK constraint. That is the whole point — the constraint must be live.
//
// `invalidateAllUserSessions` is the route's PRIMARY (security) action — the write to
// `auth_tokens.invalidated_at` that actually revokes credentials.
// It is stubbed here because THIS suite is about clock domains in the
// analytics `sessions` UPDATE, not about credentials; the real behaviour is guarded
// end-to-end (real login, real JWT, real 401) by revokeSessionsInvalidatesTokens.db.test.ts.
// The stub RECORDS its calls and the suite asserts the route invoked it, so this mock
// can never become the reason a dropped security action looks green here.
jest.mock('../services/auth', () => ({
  AuthService: {
    invalidateAllUserSessions: async (userId: string) => {
      const gg = globalThis as unknown as { __skewRevokedUserIds?: string[] };
      (gg.__skewRevokedUserIds ??= []).push(userId);
    },
    verifyJWT: (token: string) =>
      token === VALID_TOKEN
        ? {
            userId: (globalThis as unknown as { __skewTestUserId?: string }).__skewTestUserId,
            tokenId: 'token-1',
          }
        : null,
    validateSession: async () => true,
    findUserById: async () => ({
      id: (globalThis as unknown as { __skewTestUserId?: string }).__skewTestUserId,
      username: 'skewtest',
      email: 'skewtest@example.com',
      role: 'admin',
      theme: 'dark',
      is_active: true,
      created_at: new Date(),
      updated_at: new Date(),
    }),
  },
}));

import { db } from '../database/connection';
import usersRouter from '../routes/users';
import { describeDb } from './helpers/dbContractGate';

/** Node-clock minus Postgres-clock, in ms. Positive => the Node process is AHEAD. */
async function measureNodeMinusPgMs(): Promise<number> {
  const before = Date.now();
  const r = await db.query(
    "SELECT (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint AS pg_ms"
  );
  const after = Date.now();
  // Midpoint of the Node readings cancels most of the round-trip.
  return (before + after) / 2 - Number(r.rows[0].pg_ms);
}

describeDb('POST /api/users/revoke-sessions — clock-domain safety (DB integration)', () => {
  let app: Express;
  let userId: string;
  const seededSessionIds: string[] = [];
  const seededUserIds: string[] = [];

  /**
   * Seed one active session. `startedAtSql` is a SQL expression for started_at, so a
   * caller can place the app-clock start relative to the Postgres clock; when
   * `startedAtValue` is given we bind a real JS Date instead — exactly how
   * SessionRepo.create binds params.startTime.
   */
  async function seedSession(opts: {
    startedAtSql?: string;
    startedAtValue?: Date;
    lastActivitySql?: string;
  }): Promise<string> {
    const id = uuidv4();
    // Every VALUE is a bound parameter. Only the clock EXPRESSIONS are interpolated, and
    // they are test-local literals chosen by the cases below — never caller data. This
    // file models the production query, so it should not demonstrate a habit (a
    // locally-minted uuid is unexploitable, but the pattern is what gets copied).
    const startedExpr = opts.startedAtValue ? '$3' : opts.startedAtSql;
    const params: unknown[] = [id, userId];
    if (opts.startedAtValue) params.push(opts.startedAtValue);

    // ONE evaluation of the started_at expression, reused for BOTH columns when no
    // separate lastActivitySql is given. The old form repeated the EXPRESSION TEXT, so a
    // `clock_timestamp()`-based case evaluated the clock TWICE, microseconds apart —
    // last_activity_at landed a few µs above started_at, and whenever that gap crossed a
    // millisecond boundary the route's GREATEST(started_at, last_activity_at) close time
    // read back 1ms above started_at, failing the exact-equality assertion below
    // (measured in the 2026-08-13 clean-gate run: expected …522, received …523; 431 of
    // 10,000 paired clock_timestamp() evaluations differ on this box). "These two columns
    // are the same instant" must be true by CONSTRUCTION, not by racing the clock.
    await db.query(
      `INSERT INTO sessions (id, agent_type, user_id, status, started_at, last_activity_at)
       SELECT $1, 'skew-test', $2, 'active', t.started, ${opts.lastActivitySql ?? 't.started'}
         FROM (SELECT (${startedExpr})::timestamptz AS started) t`,
      params
    );
    seededSessionIds.push(id);
    return id;
  }

  async function readSession(id: string) {
    const r = await db.query(
      `SELECT status, started_at, ended_at, last_activity_at FROM sessions WHERE id = $1`,
      [id]
    );
    return r.rows[0];
  }

  beforeAll(async () => {
    app = express();
    app.use(express.json());
    app.use('/api/users', usersRouter);
  });

  // A FRESH user per test. The route revokes EVERY active session for the caller, so a
  // shared user would let one case's row decide another case's status code — each test
  // must own its rows or the pre/post evidence is not attributable.
  beforeEach(async () => {
    userId = uuidv4();
    g.__skewTestUserId = userId;
    g.__skewRevokedUserIds = [];
    seededUserIds.push(userId);

    await db.query(
      `INSERT INTO admin_users (id, username, email, password_hash, role, is_active, must_change_password)
       VALUES ($1, $2, $3, 'x', 'admin', true, false)`,
      [userId, `skewtest_${userId.slice(0, 8)}`, `skewtest_${userId.slice(0, 8)}@example.com`]
    );
  });

  afterAll(async () => {
    if (seededSessionIds.length) {
      await db.query(`DELETE FROM sessions WHERE id = ANY($1::uuid[])`, [seededSessionIds]);
    }
    if (seededUserIds.length) {
      await db.query(`DELETE FROM admin_users WHERE id = ANY($1::uuid[])`, [seededUserIds]);
    }
    await db.end();
  });

  const revoke = () =>
    request(app).post('/api/users/revoke-sessions').set('Authorization', `Bearer ${VALID_TOKEN}`);

  it('closes a session whose app-clock start is AHEAD of the Postgres clock (the 500 this fixes)', async () => {
    // The row a Node-ahead skew produces: started_at (app clock) in the DB's future.
    // Pre-fix, ended_at = NOW() < started_at -> reasonable_session_duration violation
    // -> the route's catch-all returns 500.
    const sid = await seedSession({
      startedAtSql: `clock_timestamp() + INTERVAL '${SKEW_INTERVAL}'`,
    });

    const res = await revoke();
    expect(res.status).toBe(200);

    const row = await readSession(sid);
    expect(row.status).toBe('inactive');
    expect(row.ended_at).not.toBeNull();
    // The honest close time: never before the session's own start.
    expect(new Date(row.ended_at).getTime()).toBeGreaterThanOrEqual(
      new Date(row.started_at).getTime()
    );
    // And it must NOT be a second clock's "now" — NOW() would be ~1h BELOW started_at.
    expect(new Date(row.ended_at).getTime()).toBe(new Date(row.started_at).getTime());
  });

  it('still performs the credential revocation while doing the clock-safe close', async () => {
    // This suite stubs the credential write (see the mock above), so without this
    // assertion the stub would let a route that DROPPED the security action stay
    // green here. The end-to-end proof lives in revokeSessionsInvalidatesTokens;
    // this just refuses to be an accomplice.
    await seedSession({ startedAtSql: `clock_timestamp()` });

    const res = await revoke();
    expect(res.status).toBe(200);
    expect(g.__skewRevokedUserIds).toEqual([userId]);
  });

  it('closes a session whose app-clock start is BEHIND the Postgres clock', async () => {
    const sid = await seedSession({
      startedAtSql: `clock_timestamp() - INTERVAL '${SKEW_INTERVAL}'`,
    });

    const res = await revoke();
    expect(res.status).toBe(200);

    const row = await readSession(sid);
    expect(row.status).toBe('inactive');
    expect(new Date(row.ended_at).getTime()).toBeGreaterThanOrEqual(
      new Date(row.started_at).getTime()
    );
  });

  it('closes a session whose last_activity_at is BELOW started_at (bare COALESCE is not enough)', async () => {
    // `last_activity_at` is MIXED-domain: SessionRepo.create writes it from the app
    // clock, but the update_session_activity trigger and SessionRepo's later touches
    // write CURRENT_TIMESTAMP / NOW() (Postgres clock). Under a Node-ahead skew a live
    // session therefore ends up with last_activity_at BELOW its own started_at.
    // Migration 051's bare `COALESCE(last_activity_at, started_at)` would pick that
    // lower value and violate the CHECK all over again; the GREATEST floor is what
    // makes the fix total rather than partial.
    const sid = await seedSession({
      startedAtSql: `clock_timestamp() + INTERVAL '${SKEW_INTERVAL}'`,
      lastActivitySql: `clock_timestamp()`,
    });

    const before = await readSession(sid);
    expect(new Date(before.last_activity_at).getTime()).toBeLessThan(
      new Date(before.started_at).getTime()
    );

    const res = await revoke();
    expect(res.status).toBe(200);

    const row = await readSession(sid);
    expect(new Date(row.ended_at).getTime()).toBeGreaterThanOrEqual(
      new Date(row.started_at).getTime()
    );
  });

  it('still relies on the reasonable_session_duration CHECK (the fix must not widen it)', async () => {
    // The constraint is correct and is what surfaced this class. If a future "fix"
    // drops or widens it, this goes RED.
    const r = await db.query(
      `SELECT pg_get_constraintdef(oid) AS def
         FROM pg_constraint
        WHERE conrelid = 'sessions'::regclass AND conname = 'reasonable_session_duration'`
    );
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].def.replace(/[()\s]/g, '')).toContain('ended_atISNULLORended_at>=started_at');
  });

  // --- Process-clock skew: real `new Date()` offset, Postgres untouched -----------
  // Opt-in via CLOCK_SKEW_MS. NOT a silent skip: if the variable is set we PROVE the
  // skew actually reached this realm before trusting any result.
  const skewRequested = Number(process.env.CLOCK_SKEW_MS || 0);
  // db-gate-exempt: not a DB gate — this opts INTO an extra harness (a genuinely
  // skewed process clock via CLOCK_SKEW_MS). The suite's DB gating is describeDb
  // above; this only adds cases when the harness is present, and the block itself
  // fails loud if a requested skew did not apply.
  const processSkew = skewRequested ? describe : describe.skip; // db-gate-exempt: harness opt-in

  processSkew(`process-clock skew (CLOCK_SKEW_MS=${skewRequested})`, () => {
    it('the requested skew actually applied to this realm (probe the probe)', async () => {
      const measured = await measureNodeMinusPgMs();
      // A harness that skews nothing reports a perfect pass. Fail loud instead.
      expect(Math.abs(measured - skewRequested)).toBeLessThan(SKEW_APPLIED_TOLERANCE_MS);
    });

    it('closes a session started from the (skewed) app clock', async () => {
      // Bind a real JS Date, exactly as SessionRepo.create binds params.startTime.
      const sid = await seedSession({ startedAtValue: new Date() });

      const res = await revoke();
      expect(res.status).toBe(200);

      const row = await readSession(sid);
      expect(row.status).toBe('inactive');
      expect(new Date(row.ended_at).getTime()).toBeGreaterThanOrEqual(
        new Date(row.started_at).getTime()
      );
    });
  });
});
