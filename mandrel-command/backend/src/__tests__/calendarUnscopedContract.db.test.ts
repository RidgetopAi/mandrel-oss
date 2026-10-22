/**
 * calendarUnscopedContract — THE `project=all` CONTRACT, end to end, against real rows
 * (epic 41293984 §E; the frontend half is `frontend/src/pages/Calendar.allContract.test.tsx`).
 *
 * ════════════════════════════════════════════════════════════════════════════════════
 *  WHAT IS BEING GUARDED, AND WHY NOTHING ELSE GUARDS IT
 * ════════════════════════════════════════════════════════════════════════════════════
 * The Calendar sends its project selection RAW on the query string — the literal `all`
 * included — and the backend treats `all` FROM A QUERY SOURCE as EXPLICITLY UNSCOPED,
 * beating the `X-Project-ID` header (services/projectScopeResolver.ts, "THE `all`
 * SENTINEL"). That is a three-part claim, and until now only the first part was guarded:
 *
 *   1. the RESOLVER resolves `all` to unscoped and lets it beat the header
 *      → `projectScopeEnforcement.test.ts` proves this, against a synthetic probe route
 *        with a MOCKED access service. It says nothing about real endpoints or real rows.
 *   2. the CALENDAR'S OWN ENDPOINTS honour that resolution in their SQL
 *      → guarded HERE, on `/api/momentum-series` and `/api/day-summary`, the two reads
 *        that actually carry the sentinel.
 *   3. the frontend still SENDS the literal
 *      → guarded in `Calendar.allContract.test.tsx`, at the axios adapter.
 *
 * Part 2 was the gap. The endpoints could quietly start ignoring the sentinel — or the
 * resolver could keep resolving it correctly while a controller re-derived scope its own
 * way — and every existing suite would stay green. This change set makes the gap live:
 * before it, the header always equalled what the Calendar displayed, so `all` beating the
 * header was a distinction without a difference. Now the header is PINNED to the user's
 * default project, so "the sentinel wins" is the only thing standing between an
 * All-projects calendar and a silently single-project one.
 *
 * ════════════════════════════════════════════════════════════════════════════════════
 *  THE ANCHOR: ROWS PLANTED IN A SECOND PROJECT, BY SQL
 * ════════════════════════════════════════════════════════════════════════════════════
 * These endpoints return AGGREGATES, not records, so there is no marker string to grep in
 * the response. The anchor is therefore arithmetic and just as unfakeable: a KNOWN,
 * DELIBERATELY UNEQUAL number of contexts planted in project A and project B on one fixed
 * day, inserted by direct SQL. The counts are distinct primes-ish values (3 and 5) so that
 * every wrong answer is a different number from every right one — an off-by-scope bug
 * cannot land on the correct total by coincidence, and 3, 5 and 8 are three distinguishable
 * verdicts rather than "some rows came back".
 *
 *   ?project=all   + header A   → 8   (A + B: the sentinel BEAT the header)
 *   ?project=<A>   + header B   → 3   (the query beat the header, the ordinary case)
 *   header A only, no query     → 3   (header-scoped: what "omit the param" would mean)
 *
 * The second and third lines are what make the first one mean something. A test that only
 * asserted "all returns 8" would also pass against an endpoint that ignored project scope
 * entirely — which is the failure mode most worth catching here.
 *
 * ── RUN AS ADMIN, DELIBERATELY ───────────────────────────────────────────────────────
 * For a NON-admin, "unscoped" already means "the caller's granted projects", which would
 * mask the difference under an authorization result instead of a scoping one. An admin
 * holds everything, so an unscoped read genuinely returns everything and a scoping bug is
 * visible as a number.
 *
 * Local run:
 *   bash scripts/provision-test-db.sh ci_sel_timeviews
 *   set -a; eval "$(bash scripts/provision-test-db.sh ci_sel_timeviews --print-env)"; set +a
 *   cd mandrel-command/backend && npx jest src/__tests__/calendarUnscopedContract.db.test.ts
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
import { UNSCOPED_SENTINEL } from '../services/projectScopeResolver';

// Dedicated `c1..` id prefix: this suite shares ONE database with ~75 others run in band,
// so its fixtures must not be able to collide with another suite's by accident.
const P_A = 'c1c10000-0000-4000-8000-c1c100000001'; // the project the page would select
const P_B = 'c1c10000-0000-4000-8000-c1c100000002'; // the OTHER project — the anchor
const U_ADMIN = 'c1c10000-0000-4000-8000-c1c1000000a1';

/**
 * DELIBERATELY UNEQUAL, and deliberately not 1. Equal counts would make "returned A only",
 * "returned B only" and "summed them wrong" indistinguishable; 3 / 5 / 8 are three
 * different verdicts.
 */
const N_A = 3;
const N_B = 5;

/** A fixed past day, far from "now", so nothing else in the DB lands on it. */
const DAY = '2026-03-11';
const TZ = 'UTC';

describeDb("Calendar `project=all` — explicitly unscoped, and it BEATS the header", () => {
  // The app's own pool: this suite imports ../server, which opens it. A private second
  // pool would double this process's client slots against a CONNECTION-LIMITed throwaway
  // role, which is how DB suites start failing in a set that moves between runs.
  const pool = db;
  let adminToken: string;

  const cleanup = async () => {
    await pool.query('DELETE FROM contexts WHERE project_id = ANY($1::uuid[])', [[P_A, P_B]]);
    await pool.query('DELETE FROM auth_tokens WHERE user_id = $1', [U_ADMIN]);
    await pool.query('DELETE FROM projects WHERE id = ANY($1::uuid[])', [[P_A, P_B]]);
    await pool.query('DELETE FROM admin_users WHERE id = $1', [U_ADMIN]);
  };

  beforeAll(async () => {
    await assertDbReachable(pool);
    await cleanup();

    await pool.query('INSERT INTO projects (id, name, description) VALUES ($1,$2,$3),($4,$5,$6)', [
      P_A, 'calunscoped-a', 'the selected project',
      P_B, 'calunscoped-b', 'the OTHER project — the anchor',
    ]);

    // THE PLANTED ROWS. Direct SQL, on ONE fixed local day, in two projects, in unequal
    // numbers. Nothing the code under test can move, rename, or filter differently.
    for (const [pid, n] of [[P_A, N_A], [P_B, N_B]] as const) {
      for (let i = 0; i < n; i += 1) {
        // 12:00Z on the target day: comfortably inside the day in UTC, which is the tz
        // every request below asks for, so the day-bucketing logic cannot
        // be the reason a count differs.
        // eslint-disable-next-line no-await-in-loop
        await pool.query(
          `INSERT INTO contexts (project_id, context_type, content, created_at)
           VALUES ($1,'completion',$2,$3::timestamptz)`,
          [pid, `calunscoped ${pid} ${i}`, `${DAY} 12:00:00+00`]
        );
      }
    }

    await pool.query(
      `INSERT INTO admin_users (id, username, email, password_hash, role, is_active)
       VALUES ($1,'calunscopedadmin','calunscopedadmin@x.test',$2,'admin',true)`,
      [U_ADMIN, '$2b$04$notarealhashnotarealhashno']
    );
    const { tokenId } = await AuthService.createSession(U_ADMIN);
    adminToken = AuthService.generateJWT(
      { id: U_ADMIN, username: 'calunscopedadmin', email: 'a@x.test', role: 'admin' } as never,
      tokenId
    );
  }, 120000);

  afterAll(async () => {
    await cleanup();
    await pool.end();
  });

  // ── PRE-CONDITION: the fixture is real, and ASYMMETRIC ─────────────────────────────
  it('the planted rows exist, unequally split across two projects (not a vacuous fixture)', async () => {
    const { rows } = await pool.query(
      `SELECT project_id, COUNT(*)::int AS n FROM contexts
        WHERE project_id = ANY($1::uuid[]) GROUP BY project_id ORDER BY project_id`,
      [[P_A, P_B]]
    );
    const byProject = Object.fromEntries(rows.map((r) => [r.project_id, r.n]));
    expect(byProject[P_A]).toBe(N_A);
    expect(byProject[P_B]).toBe(N_B);
    // If these were ever equal, every assertion below would still "pass" while proving
    // strictly less. Stated as an assertion rather than a comment.
    expect(N_A).not.toBe(N_B);
  });

  /** The momentum series' context count for the target day. */
  const seriesContexts = async (qs: Record<string, string>, header?: string): Promise<number> => {
    let req = request(app)
      .get('/api/momentum-series')
      .query({ from: DAY, to: DAY, tz: TZ, ...qs })
      .set('Authorization', `Bearer ${adminToken}`);
    if (header) req = req.set('X-Project-ID', header);
    const res = await req;
    expect(res.status).toBe(200);
    const series = res.body?.data as Array<{ date: string; contexts: number }>;
    expect(Array.isArray(series)).toBe(true);
    const day = series.find((d) => d.date === DAY);
    if (!day) throw new Error(`the momentum series should contain ${DAY}`);
    return day.contexts;
  };

  /** The day-summary card's context count for the target day. */
  const summaryContexts = async (qs: Record<string, string>, header?: string): Promise<number> => {
    let req = request(app)
      .get('/api/day-summary')
      .query({ date: DAY, tz: TZ, ...qs })
      .set('Authorization', `Bearer ${adminToken}`);
    if (header) req = req.set('X-Project-ID', header);
    const res = await req;
    expect(res.status).toBe(200);
    return (res.body?.data?.kpis?.contexts?.value ?? -1) as number;
  };

  // ══════════════════════════════════════════════════════════════════════════════════
  //  THE CONTRACT
  // ══════════════════════════════════════════════════════════════════════════════════
  describe('the momentum series behind the grid', () => {
    it("`project=all` WITH a header returns BOTH projects — the sentinel beats the header", async () => {
      // The exact request an All-projects Calendar makes while the ambient header is
      // pinned to the user's default project. If the sentinel ever stopped beating the
      // header this returns N_A and the screen silently shows one project.
      expect(await seriesContexts({ project: UNSCOPED_SENTINEL }, P_A)).toBe(N_A + N_B);
    });

    it('a NAMED project returns only that project — the query beats the header too', async () => {
      // Header says B, query says A: the answer must be A's count, not B's and not both.
      expect(await seriesContexts({ project: P_A }, P_B)).toBe(N_A);
    });

    it('MUTATION — dropping the param instead of sending `all` scopes it to the HEADER', async () => {
      // This is the "equivalent-looking" refactor the frontend guard also pins:
      // `...(project !== 'all' ? { project } : {})`. It is NOT equivalent — the same
      // user action now returns 3 instead of 8, with no error anywhere. Asserted so the
      // difference is a measured fact in this repo rather than a claim in a comment.
      expect(await seriesContexts({}, P_A)).toBe(N_A);
    });

    it('MUTATION — `all` in the HEADER is refused, not honoured', async () => {
      // The sentinel is accepted from a query source ONLY; the header never meant it. A
      // future "helpful" change that accepted it there would make the header able to
      // widen scope, which is the opposite of what a pinned ambient header is for.
      const res = await request(app)
        .get('/api/momentum-series')
        .query({ from: DAY, to: DAY, tz: TZ })
        .set('Authorization', `Bearer ${adminToken}`)
        .set('X-Project-ID', UNSCOPED_SENTINEL);
      expect(res.status).toBe(400);
    });
  });

  describe('the day-summary card, which inherits the same selection', () => {
    it("`project=all` WITH a header returns BOTH projects", async () => {
      expect(await summaryContexts({ project: UNSCOPED_SENTINEL }, P_A)).toBe(N_A + N_B);
    });

    it('a NAMED project returns only that project', async () => {
      expect(await summaryContexts({ project: P_A }, P_B)).toBe(N_A);
    });

    it('MUTATION — dropping the param scopes it to the HEADER instead', async () => {
      expect(await summaryContexts({}, P_A)).toBe(N_A);
    });

    it('the card and the grid AGREE for the same selection (they are one screen)', async () => {
      // The card opens on top of the grid. If they ever answered differently for the same
      // request, the user would see two numbers for one day and neither would be wrong in
      // a way anything could detect. Both directions, so an agreement that is really
      // "both are broken the same way" is still caught by the absolute values above.
      expect(await summaryContexts({ project: UNSCOPED_SENTINEL }, P_A)).toBe(
        await seriesContexts({ project: UNSCOPED_SENTINEL }, P_A)
      );
      expect(await summaryContexts({ project: P_A }, P_B)).toBe(
        await seriesContexts({ project: P_A }, P_B)
      );
    });
  });
});
