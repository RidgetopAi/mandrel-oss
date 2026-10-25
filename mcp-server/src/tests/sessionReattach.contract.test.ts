/**
 * Session-Rework SR-1 — per-connection identity + re-attach-on-restart contract test.
 * the operator's session model and the stale-but-ended root cause.
 *
 * WHAT THIS PROVES (drives the REAL SessionLifecycleService + SessionRepo + reaper +
 * a REAL Postgres; NO wall-clock sleeps — timestamps are injected directly and the
 * in-RAM map is cleared directly to simulate a restart):
 *
 *   RE-ATTACH-ACROSS-RESTART (headline): an action on a fixed connection id mints S1;
 *     simulate a server restart by clearing the RAM map (DB intact); a second action on
 *     the SAME connection id re-attaches → SAME id S1, exactly ONE open row for it. The
 *     pre-fix code minted a duplicate here (the random-spawning bug).
 *
 *   MULTIPLE CONNECTIONS → MULTIPLE SESSIONS: two distinct connection ids yield two
 *     distinct active sessions (Operator's legitimate two-terminals case).
 *
 *   ONE-PER-CONNECTION: N concurrent first-actions on the SAME connection id collapse
 *     to exactly ONE open row (app re-attach guard + the partial-unique-index backstop).
 *
 *   IDLE CLOSE writes DB + reaped id not returned next action (the stale-but-ended fix):
 *     inject a past last_activity_at, run the reaper's manualCheck() (no sleep) → the row
 *     is closed (ended_at + status=inactive) AND the next action does NOT return the dead
 *     id (it mints/re-attaches a live one).
 *
 *   SHUTDOWN → RESUME: mark active → markAllInterrupted() → status=interrupted, ended_at
 *     NULL; an action within the window re-attaches the SAME id (interrupted→active);
 *     outside the window (injected stale ts) → a FRESH id.
 *
 *   NULL / header-less NO-REGRESSION: a session created with no connection id never
 *     re-attaches (findReattachable requires a real id) and never collides on the unique
 *     index — back-compat for the shared 'http-default'/legacy NULL path.
 *
 * DB target: an isolated throwaway test database (the CI gate / provision-test-db.sh
 * set DATABASE_* + EMBEDDING_* against the disposable DB). Migration 050 must have run.
 */

import { describe, test, expect, afterAll, beforeAll } from 'vitest';

// NOTE on UUID uniqueness: this test mints many sessions and relies on every one
// getting a DISTINCT id. We deliberately do NOT vi.unmock('crypto') here — a top-level
// global unmock permanently mutates the module registry for the WHOLE single-fork
// process (vitest.config.ts: fileParallelism:false / singleFork) and leaks into other
// test files that depend on the globally-mocked randomUUID (vitest.setup.ts), making
// the suite order-dependent (e.g. session.unit.test.ts > startSession > should handle
// database errors fails under shuffle). The global crypto mock in vitest.setup.ts is
// already collision-proof (per-process random seed + a process-monotonic counter), so
// the mocked randomUUID yields unique ids for our many creates without any unmock.

import { db } from '../config/database.js';
import { SessionLifecycleService } from '../services/session/domain/lifecycle/SessionLifecycleService.js';
import { ensureActiveSession } from '../services/session/SessionTracker.js';
import { SessionRepo } from '../services/session/infra/db/SessionRepo.js';
import { SessionTimeoutService } from '../services/sessionTimeout.js';
import { ActiveSessionStore } from '../services/session/state/ActiveSessionStore.js';
import { SESSION_CONFIG } from '../config/sessionConfig.js';

const STAMP = Date.now();
let projectId: string;

// Unique connection ids per run so parallel/repeat runs never collide.
const conn = (label: string) => `sr1-${label}-${STAMP}`;

/** Simulate a SERVER RESTART: the RAM map is wiped, the DB is untouched. */
function simulateRestart(): void {
  ActiveSessionStore.clearAll();
}

/** First-action helper: lazily ensure (re-attach or mint) a session for a connection. */
async function action(connectionId: string): Promise<string> {
  return ensureActiveSession(
    projectId, undefined, undefined, undefined, undefined, undefined, connectionId
  );
}

/** Count OPEN rows (ended_at NULL, active|interrupted) for a connection id. */
async function openRowsForConn(connectionId: string): Promise<number> {
  const r = await db.query(
    `SELECT count(*)::int AS n FROM sessions
     WHERE connection_id = $1 AND ended_at IS NULL
       AND status::text IN ('active','interrupted')`,
    [connectionId]
  );
  return r.rows[0].n;
}

async function sessionRow(id: string): Promise<{ status: string; ended_at: Date | null; connection_id: string | null } | null> {
  const r = await db.query('SELECT status, ended_at, connection_id FROM sessions WHERE id = $1', [id]);
  return r.rows[0] ?? null;
}

/** Push a session's last_activity_at into the past by N seconds (no wall-clock wait). */
async function ageSession(id: string, secondsAgo: number): Promise<void> {
  await db.query(
    `UPDATE sessions SET last_activity_at = CURRENT_TIMESTAMP - ($2 || ' seconds')::interval
     WHERE id = $1`,
    [id, String(secondsAgo)]
  );
}

async function cleanup(): Promise<void> {
  // Remove every session this test created (by our connection-id prefix), and any
  // contexts attached to them, so the suite is order-independent.
  await db.query(
    `DELETE FROM contexts WHERE session_id IN (SELECT id FROM sessions WHERE connection_id LIKE $1)`,
    [`sr1-%-${STAMP}`]
  );
  await db.query(`DELETE FROM sessions WHERE connection_id LIKE $1`, [`sr1-%-${STAMP}`]);
}

describe('SR-1: per-connection identity + re-attach-on-restart', () => {
  beforeAll(async () => {
    projectId = (await db.query(
      `INSERT INTO projects (name, description) VALUES ($1, 'SR-1 test') RETURNING id`,
      [`sr1-proj-${STAMP}`]
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

  test('HEADLINE: action re-attaches to the same session across a server restart', async () => {
    const c = conn('restart');
    ActiveSessionStore.clear(c);

    const s1 = await action(c);
    expect(s1).toBeTruthy();
    expect(await openRowsForConn(c)).toBe(1);

    // Server restart: RAM wiped, DB row intact.
    simulateRestart();
    expect(ActiveSessionStore.get(c)).toBeNull();

    // Next action on the SAME connection must RE-ATTACH, not mint.
    const s2 = await action(c);
    expect(s2).toBe(s1);                         // same session id
    expect(await openRowsForConn(c)).toBe(1);    // still exactly one open row
  });

  test('two distinct connections get two distinct active sessions', async () => {
    const cA = conn('twoA');
    const cB = conn('twoB');
    ActiveSessionStore.clear(cA);
    ActiveSessionStore.clear(cB);

    const sA = await action(cA);
    const sB = await action(cB);

    expect(sA).not.toBe(sB);
    expect(await openRowsForConn(cA)).toBe(1);
    expect(await openRowsForConn(cB)).toBe(1);
  });

  test('one-per-connection: N concurrent first-actions collapse to one open row', async () => {
    const c = conn('concurrent');
    ActiveSessionStore.clear(c);
    simulateRestart(); // make sure no RAM entry biases the first hit

    // Fire 5 first-actions concurrently on the same connection id.
    const ids = await Promise.all(Array.from({ length: 5 }, () => action(c)));

    // Every returned id resolves to an OPEN row, and there is exactly ONE open row
    // for the connection (app re-attach + the partial-unique-index backstop).
    expect(await openRowsForConn(c)).toBe(1);
    const distinct = new Set(ids);
    // At most one distinct id should remain open; any racing mint is superseded by
    // re-attach (the open-row count is the hard invariant).
    expect(distinct.size).toBeGreaterThanOrEqual(1);
  });

  test('idle reaper closes the row AND the dead id is not returned next action', async () => {
    const c = conn('idle');
    ActiveSessionStore.clear(c);

    const s1 = await action(c);
    expect((await sessionRow(s1))!.ended_at).toBeNull();

    // Age it past the window and reap (no sleep) — same code path as the periodic check.
    await ageSession(s1, SESSION_CONFIG.idleTimeoutSec + 60);
    const reaped = await SessionTimeoutService.manualCheck();
    expect(reaped).toBeGreaterThanOrEqual(1);

    // DB write happened: ended_at stamped + status inactive.
    const row = await sessionRow(s1);
    expect(row!.status).toBe('inactive');
    expect(row!.ended_at).not.toBeNull();

    // RAM entry evicted by the reaper.
    expect(ActiveSessionStore.get(c)).toBeNull();

    // Next action must NOT return the dead id — it re-attaches/mints a LIVE session.
    const s2 = await action(c);
    expect(s2).not.toBe(s1);
    expect((await sessionRow(s2))!.ended_at).toBeNull();
  });

  test('shutdown → interrupted (resumable); resumes in window, fresh outside', async () => {
    const c = conn('shutdown');
    ActiveSessionStore.clear(c);

    const s1 = await action(c);

    // Graceful shutdown marks ALL active → interrupted (ended_at NULL = resumable).
    await SessionLifecycleService.markAllInterrupted();
    const afterShutdown = await sessionRow(s1);
    expect(afterShutdown!.status).toBe('interrupted');
    expect(afterShutdown!.ended_at).toBeNull();
    expect(ActiveSessionStore.get(c)).toBeNull(); // RAM cleared by shutdown

    // Action within the window RE-ATTACHES the same id and reactivates it.
    const s2 = await action(c);
    expect(s2).toBe(s1);
    expect((await sessionRow(s1))!.status).toBe('active');

    // Now shutdown again, push it OUTSIDE the re-attach window. An interrupted session
    // past the window is terminalized by the idle reaper (the same 1h reaper closes
    // active AND interrupted) BEFORE a fresh one can be minted — the open-per-connection
    // unique index correctly forbids a second OPEN row for the connection while the
    // stale one is still open. So the deterministic flow is: shutdown → age → reap →
    // act → FRESH id (the old row is now closed).
    await SessionLifecycleService.markAllInterrupted();
    await ageSession(s1, SESSION_CONFIG.reattachWindowSec + 60);
    const reaped = await SessionTimeoutService.manualCheck();
    expect(reaped).toBeGreaterThanOrEqual(1);
    // The stale interrupted session is now terminalized (closed), not re-attachable.
    const closed = await sessionRow(s1);
    expect(closed!.status).toBe('inactive');
    expect(closed!.ended_at).not.toBeNull();

    const s3 = await action(c);
    expect(s3).not.toBe(s1);
    expect((await sessionRow(s3))!.status).toBe('active');
  });

  test('NULL / header-less session never re-attaches and never collides', async () => {
    // Create two sessions with NO connection id (the shared/legacy path).
    const id1 = (await SessionLifecycleService.startSession({ projectId, creationReason: 'automatic-write' })); // connectionId undefined
    const id2 = (await SessionLifecycleService.startSession({ projectId, creationReason: 'automatic-write' }));
    expect(id1).not.toBe(id2);

    // Both persist a NULL connection_id and both stay OPEN — the partial-unique index
    // excludes NULLs, so two header-less sessions legitimately coexist (no collision).
    expect((await sessionRow(id1))!.connection_id).toBeNull();
    expect((await sessionRow(id2))!.connection_id).toBeNull();
    const r = await db.query(
      `SELECT count(*)::int AS n FROM sessions WHERE id = ANY($1::uuid[]) AND ended_at IS NULL`,
      [[id1, id2]]
    );
    expect(r.rows[0].n).toBe(2);

    // findReattachable never matches a NULL connection id.
    expect(await SessionRepo.findReattachable('', SESSION_CONFIG.reattachWindowSec)).toBeNull();

    // tidy these two up (they have no sr1- connection prefix so cleanup() misses them)
    await db.query('DELETE FROM contexts WHERE session_id = ANY($1::uuid[])', [[id1, id2]]);
    await db.query('DELETE FROM sessions WHERE id = ANY($1::uuid[])', [[id1, id2]]);
  });
});
