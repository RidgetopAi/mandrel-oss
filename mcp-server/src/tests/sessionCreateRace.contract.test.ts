/**
 * an earlier Task — the connection-keyed session CREATE race.
 *
 * WHAT THIS PROVES (real SessionLifecycleService + SessionRepo + a real Postgres):
 *
 *   THE GUARANTEE: "exactly one OPEN session per connection". The partial unique index
 *   `uq_sessions_open_per_connection` is the only thing enforcing it. `ensureActiveSession`
 *   was a check-then-insert (getActiveSession → null → startSession → unconditional INSERT),
 *   so N concurrent first-actions on one connection all read null and all inserted; one won
 *   and the index correctly refused the rest, which surfaced as a raw
 *   `duplicate key value violates unique constraint` thrown at the caller.
 *
 *   Measured before the fix, hammering this exact path: 25/50 rounds RED at concurrency 5 on
 *   an idle box (and per-round detail showed 4 of 5 racers losing whenever the round genuinely
 *   ran in parallel). The pre-existing SR-1 contract test fires ONE round, so it only sampled
 *   that coin flip once — which is why it passed in isolation and went RED under load.
 *
 * WHY THIS FILE IS ROUND-BASED, NOT SINGLE-SHOT
 *   A single concurrent round is a ~50% detector. It is not a weaker assertion that made the
 *   flake go away — it is a STRONGER one: RACE_ROUNDS independent rounds, each asserting all
 *   three halves of the guarantee (nobody throws · exactly one open row · every racer got the
 *   SAME id). Nothing here is retried, relaxed, or serialised.
 *
 * THE THIRD ASSERTION IS THE LOAD-BEARING ONE. "No throw" + "one open row" can both be
 * satisfied by a losing racer silently returning a DIFFERENT session; the fix's actual
 * contract is that the loser READS THE WINNER'S ROW, so the ids must collapse to one.
 *
 * DB target: an isolated throwaway test database (the CI gate / provision-test-db.sh).
 * Migration 065 (the current index definition) must have run.
 */

import { describe, test, expect, afterAll, beforeAll } from 'vitest';

import { db } from '../config/database.js';
import { ensureActiveSession } from '../services/session/SessionTracker.js';
import { SessionLifecycleService } from '../services/session/domain/lifecycle/SessionLifecycleService.js';
import { ActiveSessionStore } from '../services/session/state/ActiveSessionStore.js';
import { SESSION_CONFIG } from '../config/sessionConfig.js';
import { SESSION_OPEN_STATES } from '../config/sessionIdentityConfig.js';

const STAMP = Date.now();
let projectId: string;

/** Independent concurrent rounds. Pre-fix, ~half go RED — 8 rounds ⇒ P(miss) < 0.5%. */
const RACE_ROUNDS = 8;
/** Racers per round. Deliberately > the CI pool max (5) so client contention is exercised. */
const RACERS = 8;

const conn = (label: string) => `scr-${label}-${STAMP}`;

async function openRowsForConn(connectionId: string): Promise<number> {
  const r = await db.query(
    `SELECT count(*)::int AS n FROM sessions
      WHERE connection_id = $1 AND ended_at IS NULL AND status::text = ANY($2::text[])`,
    [connectionId, SESSION_OPEN_STATES as readonly string[]]
  );
  return r.rows[0].n;
}

async function action(connectionId: string): Promise<string> {
  return ensureActiveSession(
    projectId, undefined, undefined, undefined, undefined, undefined, connectionId
  );
}

async function cleanup(): Promise<void> {
  await db.query(
    `DELETE FROM contexts WHERE session_id IN (SELECT id FROM sessions WHERE connection_id LIKE $1)`,
    [`scr-%-${STAMP}`]
  );
  await db.query(`DELETE FROM sessions WHERE connection_id LIKE $1`, [`scr-%-${STAMP}`]);
}

describe('an earlier change: connection-keyed session create is race-free', () => {
  beforeAll(async () => {
    projectId = (await db.query(
      `INSERT INTO projects (name, description) VALUES ($1, 'an earlier change test') RETURNING id`,
      [`scr-proj-${STAMP}`]
    )).rows[0].id;
  });

  afterAll(async () => {
    ActiveSessionStore.clearAll();
    try {
      await cleanup();
      await db.query('DELETE FROM projects WHERE id = $1', [projectId]);
    } catch { /* ignore */ }
    await db.end();
  });

  test('N concurrent first-actions: nobody throws, one open row, all racers get the SAME id', async () => {
    // Positive control: a round must actually be capable of producing a session at all.
    // If this is 0 the rest of the loop would be asserting over an empty population.
    expect(RACE_ROUNDS).toBeGreaterThan(0);
    expect(RACERS).toBeGreaterThan(1);

    for (let round = 0; round < RACE_ROUNDS; round++) {
      const c = conn(`race${round}`);
      ActiveSessionStore.clearAll();

      const settled = await Promise.allSettled(
        Array.from({ length: RACERS }, () => action(c))
      );

      const rejected = settled.filter((s) => s.status === 'rejected') as PromiseRejectedResult[];
      // Report the ACTUAL reason on failure — a bare count would hide a duplicate-key
      // regression behind the same number as any other throw.
      expect(
        rejected.map((r) => String(r.reason?.message ?? r.reason)),
        `round ${round}: no racer may throw (the loser must read the winner's row)`
      ).toEqual([]);

      const ids = new Set(
        (settled as PromiseFulfilledResult<string>[]).map((s) => s.value)
      );
      expect(ids.size, `round ${round}: every racer must resolve to the winner's session`).toBe(1);
      expect(await openRowsForConn(c), `round ${round}: exactly one open row`).toBe(1);
    }
  });

  // The double-check that resolves the race must cover EXACTLY the set the index refuses.
  // `findReattachable` is strictly narrower (it also requires activity inside the re-attach
  // window), so an open-but-stale row is invisible to it while still being forbidden by the
  // index — using that narrower predicate would leave the identical duplicate-key exception
  // reachable. One case per open status, so widening the index without widening the code (or
  // vice-versa) shows up here behaviourally, not just as a text comparison.
  //
  // ⚠️ THIS LOOP DOES NOT ANCHOR THE STATUS SET — DO NOT DELETE THE pg_indexes TEST BELOW.
  // It iterates SESSION_OPEN_STATES, the product's OWN constant, so it silently widens and
  // NARROWS in lockstep with the thing it is covering: drop a status from that constant and
  // this loop just generates one case fewer and stays green (measured — under that exact
  // mutation the case count went 3 → 2 with every remaining case passing). The independent
  // anchor is the LIVE-`pg_indexes` lockstep test below, which is what actually goes RED.
  // These two are a PAIR; this loop alone proves nothing about which statuses are covered.
  for (const status of SESSION_OPEN_STATES) {
    test(`an open-but-stale '${status}' row for the connection is ADOPTED, never collided with`, async () => {
      const c = conn(`stale-${status}`);
      ActiveSessionStore.clearAll();

      // Plant an OPEN row whose last activity is far outside the re-attach window, so
      // findReattachable cannot see it but the partial unique index still forbids a sibling.
      const planted = (await db.query(
        `INSERT INTO sessions (id, project_id, agent_type, started_at, last_activity_at,
                               connection_id, status, creation_reason)
         VALUES (gen_random_uuid(), $1, 'AI Model',
                 CURRENT_TIMESTAMP - ($3 || ' seconds')::interval,
                 CURRENT_TIMESTAMP - ($3 || ' seconds')::interval,
                 $2, $4, 'automatic-write')
         RETURNING id`,
        [projectId, c, String(SESSION_CONFIG.reattachWindowSec + 3600), status]
      )).rows[0].id;

      expect(await openRowsForConn(c)).toBe(1);

      const got = await action(c);

      expect(got, 'must adopt the planted open row, not mint a colliding sibling').toBe(planted);
      expect(await openRowsForConn(c)).toBe(1);
    });
  }

  // An adopt SKIPS the INSERT, and the INSERT is the only thing that ever wrote the caller's
  // title/description/goal/tags. Without an explicit apply they are dropped while the caller is
  // told "✅ New session started" — silent data loss replacing what used to be a loud
  // duplicate-key error. The actor route already solved this with updateDetails after a resolve;
  // this asserts the connection path does the same. Note what must NOT change: an adopt is a
  // re-attach, and re-attach has never re-stamped identity, so the winner keeps its project.
  test('an adopt applies the caller-supplied details to the winner\'s row (and re-stamps no identity)', async () => {
    const c = conn('details');
    ActiveSessionStore.clearAll();

    const otherProjectId = (await db.query(
      `INSERT INTO projects (name, description) VALUES ($1, 'an earlier change winner project') RETURNING id`,
      [`scr-proj-winner-${STAMP}`]
    )).rows[0].id;

    // The WINNER: an open-but-stale row owned by `otherProjectId`, carrying no details.
    const planted = (await db.query(
      `INSERT INTO sessions (id, project_id, agent_type, started_at, last_activity_at,
                             connection_id, status, creation_reason)
       VALUES (gen_random_uuid(), $1, 'AI Model',
               CURRENT_TIMESTAMP - ($3 || ' seconds')::interval,
               CURRENT_TIMESTAMP - ($3 || ' seconds')::interval,
               $2, 'active', 'automatic-write')
       RETURNING id`,
      [otherProjectId, c, String(SESSION_CONFIG.reattachWindowSec + 3600)]
    )).rows[0].id;

    const before = (await db.query(
      `SELECT count(*)::int AS n FROM analytics_events WHERE session_id = $1 AND event_type = 'session_start'`,
      [planted]
    )).rows[0].n;

    // The explicit session_start shape: details supplied, a DIFFERENT project requested.
    const got = await SessionLifecycleService.startSession({
      projectId,
      connectionId: c,
      title: 'adopted-title',
      description: 'adopted-description',
      sessionGoal: 'adopted-goal',
      tags: ['adopted-tag'],
      creationReason: 'explicit'
    });

    expect(got, 'must adopt the winner, not mint a sibling').toBe(planted);

    const row = (await db.query(
      `SELECT title, description, session_goal, tags, project_id, status FROM sessions WHERE id = $1`,
      [planted]
    )).rows[0];

    // Each asserted separately: a single combined check could pass on one field landing.
    expect(row.title, 'title must reach the adopted row').toBe('adopted-title');
    expect(row.description, 'description must reach the adopted row').toBe('adopted-description');
    expect(row.session_goal, 'goal must reach the adopted row').toBe('adopted-goal');
    expect(row.tags, 'tags must reach the adopted row').toEqual(['adopted-tag']);

    // Identity is the winner's, NOT the caller's — an adopt re-attaches, it does not rebrand.
    expect(row.project_id, 'an adopt must not re-stamp the project').toBe(otherProjectId);
    // Reactivated so touchActivity (WHERE status='active') is not a silent no-op.
    expect(row.status).toBe('active');

    // And still no 'session_start' event: nothing started, so the timeline must not say it did.
    const after = (await db.query(
      `SELECT count(*)::int AS n FROM analytics_events WHERE session_id = $1 AND event_type = 'session_start'`,
      [planted]
    )).rows[0].n;
    expect(after, 'an adopt must not log a second session_start').toBe(before);

    await db.query('DELETE FROM sessions WHERE id = $1', [planted]);
    await db.query('DELETE FROM projects WHERE id = $1', [otherProjectId]);
  });

  // the openness rule now has two copies — SESSION_OPEN_STATES (TypeScript) and
  // the migration-065 index predicate (SQL). They agree today; this asks the DB itself, so a
  // one-sided edit to EITHER copy goes RED and widening becomes a deliberate two-file diff.
  test('SESSION_OPEN_STATES matches the LIVE uq_sessions_open_per_connection predicate', async () => {
    const r = await db.query(
      `SELECT indexdef FROM pg_indexes WHERE indexname = 'uq_sessions_open_per_connection'`
    );
    expect(r.rows.length, 'the index must exist — it IS the guarantee').toBe(1);

    const indexdef: string = r.rows[0].indexdef;
    const predicate = indexdef.slice(indexdef.indexOf(' WHERE '));
    const statuses = [...predicate.matchAll(/'([a-z_]+)'::text/g)].map((m) => m[1]);

    // Anti-vacuous: an empty match set would make the comparison below pass by accident on a
    // predicate this regex simply failed to read (a past incident — the empty-population trap).
    expect(statuses.length, `parsed no status literals out of: ${predicate}`).toBeGreaterThan(0);

    expect([...statuses].sort()).toEqual([...SESSION_OPEN_STATES].sort());
    // The other two conjuncts are what make the index connection-scoped and open-scoped;
    // losing either silently changes what "one open session per connection" means.
    expect(predicate).toContain('connection_id IS NOT NULL');
    expect(predicate).toContain('ended_at IS NULL');
  });
});
