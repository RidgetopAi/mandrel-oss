/**
 * reaperClockDomainFloor.contract.test.ts — CLOCK-DOMAIN gate for the idle reaper
 * `timeout_inactive_sessions()` (migration 072).
 *
 * THE DEFECT THIS GUARDS
 *   The reaper wrote a Postgres-clock `ended_at = CURRENT_TIMESTAMP` while
 *   `sessions.started_at` is written from the NODE clock (SessionRepo.create binds
 *   `params.startTime`). The DB compares them:
 *
 *       CONSTRAINT reasonable_session_duration
 *         CHECK (ended_at IS NULL OR ended_at >= started_at)
 *
 *   This was originally written off as "safe by MARGIN" because the reaper only touches
 *   rows idle >= 1-2h. THAT IS FALSE, and this file is the proof. The margin holds only
 *   while the Node-ahead skew is SMALLER than the idle threshold. Beyond it, a row is
 *   selected (its last_activity_at really is old) while its started_at is still in the
 *   DB's future, and `CURRENT_TIMESTAMP` lands below it.
 *
 *   Worse than the sibling route defect (users.ts) on all three axes:
 *     1. LIVE      — every sweep, from SessionTimeoutService.
 *     2. WIDE      — ONE whole-table UPDATE, so a SINGLE poisoned row aborts the ENTIRE
 *                    sweep and NO session is reaped at all, indefinitely.
 *     3. SILENT    — the callers swallow it into logger.error and setInterval keeps firing.
 *
 * WHAT THIS ASSERTS
 *   - the poisoned fixture is GENUINELY poisoned (the unfloored statement still rejects it);
 *   - a sweep containing one poisoned row SUCCEEDS and reaps BOTH rows (blast radius closed);
 *   - the poisoned row is closed at its own started_at (floor engaged);
 *   - a NORMAL row is still closed at CURRENT_TIMESTAMP (no behaviour change where it was
 *     already correct);
 *   - the CHECK is still installed (the fix must never be to widen or drop it).
 *
 *   The first assertion is what gives the rest teeth: without it, someone could "fix" a
 *   failure by making the fixture un-poisoned and every remaining expectation would pass
 *   vacuously.
 *
 * Requires a migrated disposable Postgres (migration 072 applied).
 */

import { describe, test, expect, beforeAll, afterAll, afterEach } from 'vitest';

import { db } from '../config/database.js';
import { SessionTimeoutService } from '../services/sessionTimeout.js';
import { SESSION_CONFIG } from '../config/sessionConfig.js';
import { rawDatastoreMessage } from '../utils/datastoreError.js';

const AGENT = `reaper-floor-${Date.now()}`;
const createdSessionIds: string[] = [];

/**
 * Idle window used by the sweeps under test, and the age of this file's fixture rows.
 *
 * SHARED-DB BLAST RADIUS: `timeout_inactive_sessions` is a WHOLE-TABLE UPDATE — that is
 * the very property under test, so it cannot be scoped away without testing something
 * else. It will reap ANY session idle past the window, including other suites' rows.
 * We therefore push the window far out (29 days) and age this file's fixtures past it
 * (30 days), so the set of collateral rows is "sessions idle for over a month" — which no
 * other suite creates. At the original 2h, any backdated fixture elsewhere in the suite
 * was fair game the moment CI ran suites in parallel against one database.
 */
const IDLE_DAYS = 29;
const FIXTURE_AGE_DAYS = 30;
const IDLE_SEC = IDLE_DAYS * 24 * 60 * 60;
const savedIdleTimeout = SESSION_CONFIG.idleTimeoutSec;

/**
 * Seed one active session directly, placing started_at and last_activity_at at explicit
 * offsets from the POSTGRES clock. `startedOffset` > 0 models a session minted while the
 * Node clock ran ahead of Postgres by that much.
 */
async function seed(opts: { startedOffset: string; lastActivityOffset: string }): Promise<string> {
  const r = await db.query(
    `INSERT INTO sessions (id, agent_type, status, started_at, last_activity_at)
     VALUES (gen_random_uuid(), $1, 'active',
             clock_timestamp() + $2::interval,
             clock_timestamp() + $3::interval)
     RETURNING id`,
    [AGENT, opts.startedOffset, opts.lastActivityOffset]
  );
  const id = r.rows[0].id as string;
  createdSessionIds.push(id);
  return id;
}

async function rowOf(id: string) {
  const r = await db.query(
    `SELECT status, started_at, ended_at,
            (ended_at = started_at) AS ended_eq_started,
            (ended_at >= started_at) AS constraint_holds
       FROM sessions WHERE id = $1`,
    [id]
  );
  return r.rows[0];
}

describe('idle reaper — clock-domain floor (migration 072)', () => {
  beforeAll(() => {
    SESSION_CONFIG.idleTimeoutSec = IDLE_SEC;
  });

  afterEach(async () => {
    if (createdSessionIds.length) {
      await db.query(`DELETE FROM sessions WHERE id = ANY($1::uuid[])`, [createdSessionIds]);
      createdSessionIds.length = 0;
    }
  });

  afterAll(async () => {
    SESSION_CONFIG.idleTimeoutSec = savedIdleTimeout;
    await db.query(`DELETE FROM sessions WHERE agent_type = $1`, [AGENT]);
  });

  test('the poisoned fixture is genuinely poisoned (unfloored CURRENT_TIMESTAMP still rejects)', async () => {
    // Node ahead by 1h; idle past the window. Selected by the sweep, but
    // CURRENT_TIMESTAMP < started_at.
    const poisoned = await seed({
      startedOffset: '1 hour',
      lastActivityOffset: `-${FIXTURE_AGE_DAYS} days`,
    });

    // The PRE-FIX expression, run verbatim against the same row. If this ever stops
    // throwing, the fixture no longer models the defect and every other test here is
    // vacuous — so this failing loudly is the point.
    // Reads the RAW driver text through the named accessor: the datastore error boundary
    // redacts the caller-facing message, and this assertion is about what
    // POSTGRES did, not about what a caller is told. Same fact, same strength, right instrument.
    let poisonErr: unknown;
    try {
      await db.query(
        `UPDATE sessions SET status = 'inactive', ended_at = CURRENT_TIMESTAMP WHERE id = $1`,
        [poisoned]
      );
    } catch (e) {
      poisonErr = e;
    }
    expect(poisonErr, 'the pre-fix expression no longer throws — the fixture is not poisoned').toBeTruthy();
    expect(rawDatastoreMessage(poisonErr)).toMatch(/reasonable_session_duration/);
  });

  test('one poisoned row does not abort the sweep — both rows are reaped', async () => {
    const poisoned = await seed({
      startedOffset: '1 hour',
      lastActivityOffset: `-${FIXTURE_AGE_DAYS} days`,
    });
    // A perfectly ordinary idle session that MUST still get reaped alongside it.
    const bystander = await seed({
      startedOffset: `-${FIXTURE_AGE_DAYS + 1} days`,
      lastActivityOffset: `-${FIXTURE_AGE_DAYS} days`,
    });

    // Drive the REAL service path, not hand-written SQL. The return value is a WHOLE-TABLE
    // count, so it is not a sound assertion target on a shared DB (another suite's aged row
    // would inflate it, and it tells us nothing about OUR rows). The per-row assertions
    // below are the actual contract; we only require that the sweep did not throw.
    await expect(SessionTimeoutService.manualCheck()).resolves.toBeGreaterThanOrEqual(2);

    const p = await rowOf(poisoned);
    const b = await rowOf(bystander);

    // Blast radius closed: the innocent bystander was reaped despite the poisoned row.
    expect(b.status).toBe('inactive');
    expect(b.ended_at).not.toBeNull();
    expect(b.constraint_holds).toBe(true);
    // ...and it kept the ORIGINAL semantics: closed at ~now, not at its own start.
    expect(b.ended_eq_started).toBe(false);

    // The poisoned row is closed at its own (app-clock) start — the floor engaged.
    expect(p.status).toBe('inactive');
    expect(p.constraint_holds).toBe(true);
    expect(p.ended_eq_started).toBe(true);
  });

  test('the reasonable_session_duration CHECK is still installed (never widen it)', async () => {
    const r = await db.query(
      `SELECT pg_get_constraintdef(oid) AS def
         FROM pg_constraint
        WHERE conrelid = 'sessions'::regclass AND conname = 'reasonable_session_duration'`
    );
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].def.replace(/[()\s]/g, '')).toContain('ended_atISNULLORended_at>=started_at');
  });
});
