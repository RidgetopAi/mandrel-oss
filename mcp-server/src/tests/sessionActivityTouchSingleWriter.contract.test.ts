/**
 * an earlier Task — SESSION LIVENESS HAS ONE WRITER, OR IT HAS NO POLICY.
 *
 * =============================================================================
 * THE BUG THIS FILE EXISTS TO KEEP CLOSED
 * =============================================================================
 * Batch 5 / an earlier task made READS advance `sessions.last_activity_at`, hooked once
 * in `runWithProjectScope` and THROTTLED to at most one UPDATE per session per
 * `SESSION_CONFIG.activityTouchMinIntervalSec` (services/session/activityTouch.ts).
 *
 * It left the other half standing. The WRITE-side paths — handlers/context.ts,
 * handlers/tasks.ts, handlers/decisions.ts (via `SessionTracker.updateSessionActivity`)
 * and `OperationTracker.recordOperation` — called `SessionRepo.touchActivity` DIRECTLY.
 * They shared none of the helper's throttle and none of its bounded cache. One column,
 * two independent writers, two policies:
 *
 *   the read path : "UPDATE volume is a function of wall clock"     (throttled)
 *   the write path: "UPDATE volume is a function of traffic"        (unthrottled)
 *
 * The first sentence was the column's DOCUMENTED contract after 38cfeb72, and it was
 * false of the system. `writeBurst` below is the measurement that shows it: pre-fix,
 * N writes cost N+1 UPDATEs; post-fix they cost 1.
 *
 * =============================================================================
 * WHY THE STATIC GUARD AT THE BOTTOM IS THE VALUABLE HALF
 * =============================================================================
 * A behavioural test proves the throttle works for the writers that exist TODAY. It
 * cannot fail when a THIRD writer appears next quarter, because that writer's call site
 * is not in the population the behavioural test drives — which is exactly how this defect
 * was born: 38cfeb72's suite was green the whole time the write path was bypassing it.
 *
 * So the anti-regression artifact is the SOURCE-LEVEL guard: `SessionRepo.touchActivity`
 * has exactly ONE caller in runtime source, and it is the helper. A future direct caller
 * cannot satisfy it by being correct, by being throttled, or by passing every behavioural
 * test — the guard's predicate is "who calls it", not "does it behave" — so the only way
 * to go green is to route through the one helper. That makes the bad state unreachable
 * rather than merely currently-absent (C3).
 *
 * DB target: an isolated throwaway test database (scripts/provision-test-db.sh). NEVER prod.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { db } from '../config/database.js';
import { routeExecutor } from '../routes/index.js';
import { ActiveSessionStore } from '../services/session/state/ActiveSessionStore.js';
import { SESSION_CONFIG } from '../config/sessionConfig.js';
import { SessionTracker } from '../services/session/SessionTracker.js';
import { OperationTracker } from '../services/session/domain/tracking/OperationTracker.js';
import {
  activityTouchStats,
  awaitPendingActivityTouches,
  resetActivityTouchState,
} from '../services/session/activityTouch.js';

const STAMP = Date.now();
const CONN_PREFIX = `atsw-${STAMP}`;
const conn = (label: string) => `${CONN_PREFIX}-${label}`;

/** Big enough that "1" versus "N" is unmistakably a throttle and not a coincidence. */
const BURST = 20;

/**
 * The ONE statement whose volume this task governs. Deliberately anchored on
 * `SET last_activity_at` immediately after `UPDATE sessions`, which is
 * `SessionRepo.touchActivity` and nothing else: `reactivate()` writes
 * `SET status = 'active', last_activity_at = ...` and is a DIFFERENT policy (the
 * resolver's re-attach), correctly outside this throttle.
 */
const TOUCH_SQL = /UPDATE\s+sessions\s+SET\s+last_activity_at/i;

let projectId: string;

/** Plant an OPEN session for `connectionId`, staler than the throttle window. */
async function plantSession(connectionId: string, status: string, backdateSec: number): Promise<string> {
  const r = await db.query(
    `INSERT INTO sessions (project_id, connection_id, agent_type, status, started_at, last_activity_at)
     VALUES ($1, $2, 'test', $3,
             CURRENT_TIMESTAMP - ($4 || ' seconds')::interval,
             CURRENT_TIMESTAMP - ($4 || ' seconds')::interval)
     RETURNING id`,
    [projectId, connectionId, status, String(backdateSec)]
  );
  const id: string = r.rows[0].id;
  ActiveSessionStore.set(id, connectionId);
  return id;
}

async function lastActivityMs(sessionId: string): Promise<number> {
  const r = await db.query(
    `SELECT EXTRACT(EPOCH FROM last_activity_at) * 1000 AS ms FROM sessions WHERE id = $1`,
    [sessionId]
  );
  return Number(r.rows[0].ms);
}

async function statusOf(sessionId: string): Promise<string> {
  const r = await db.query(`SELECT status::text AS s FROM sessions WHERE id = $1`, [sessionId]);
  return r.rows[0].s;
}

/**
 * Count the touch UPDATEs issued while `body` runs, at the `db.query` seam — the place
 * the cost is actually paid. The spy is bound to the REAL query first, so it is a
 * pass-through counter and never a stub: every statement still reaches Postgres and the
 * workload measured is the real one.
 */
async function countTouchUpdates(body: () => Promise<void>): Promise<number> {
  const originalQuery = db.query.bind(db);
  let touches = 0;
  const spy = vi.spyOn(db, 'query').mockImplementation(((...args: any[]) => {
    const sql = typeof args[0] === 'string' ? args[0] : (args[0]?.text ?? '');
    if (TOUCH_SQL.test(sql)) touches++;
    return (originalQuery as any)(...args);
  }) as any);
  try {
    await body();
    await awaitPendingActivityTouches();
  } finally {
    spy.mockRestore();
  }
  return touches;
}

describe('5401b89f: session liveness has ONE writer and ONE throttle', () => {
  beforeAll(async () => {
    projectId = (
      await db.query(
        `INSERT INTO projects (name, description) VALUES ($1, '5401b89f single-writer activity touch')
         RETURNING id`,
        [`atsw-proj-${STAMP}`]
      )
    ).rows[0].id;
  });

  afterAll(async () => {
    ActiveSessionStore.clearAll();
    try {
      await db.query(
        `DELETE FROM contexts WHERE session_id IN (SELECT id FROM sessions WHERE connection_id LIKE $1)`,
        [`${CONN_PREFIX}-%`]
      );
      await db.query(
        `DELETE FROM analytics_events WHERE session_id IN (SELECT id FROM sessions WHERE connection_id LIKE $1)`,
        [`${CONN_PREFIX}-%`]
      );
      await db.query(`DELETE FROM sessions WHERE connection_id LIKE $1`, [`${CONN_PREFIX}-%`]);
      await db.query(`DELETE FROM projects WHERE id = $1`, [projectId]);
    } catch {
      /* ignore */
    }
    await db.end();
  });

  beforeEach(() => {
    resetActivityTouchState();
    ActiveSessionStore.clearAll();
  });

  // ───────────────────────────────────────────────────────────────────────────────────
  // THE DEFECT, MEASURED AT THE db.query SEAM
  // ───────────────────────────────────────────────────────────────────────────────────
  test(`${BURST} context_store WRITES through the shipped surface cost ONE UPDATE, not ${BURST + 1}`, async () => {
    const c = conn('ctx-burst');
    const sessionId = await plantSession(c, 'active', SESSION_CONFIG.activityTouchMinIntervalSec + 300);
    await routeExecutor('project_switch', { project: projectId }, { connectionId: c, actor: 'builder' } as any);
    resetActivityTouchState();
    ActiveSessionStore.set(sessionId, c);

    const touches = await countTouchUpdates(async () => {
      for (let i = 0; i < BURST; i++) {
        const r = await routeExecutor(
          'context_store',
          { content: `5401b89f write burst ${i}`, type: 'completion', tags: ['atsw'] },
          { connectionId: c, actor: 'builder' } as any
        );
        expect(r.isError, 'the write itself must succeed — a failed write proves nothing').not.toBe(true);
      }
    });

    // PRE-FIX this was BURST (one unthrottled write-path UPDATE per call) + 1 (the read
    // hook's throttled one). The whole point of the task is that it is now 1.
    expect(
      touches,
      `${BURST} writes in one throttle window must issue ONE UPDATE; ${BURST + 1} means the write path bypasses the helper`
    ).toBe(1);
    expect(await lastActivityMs(sessionId), 'the one UPDATE must still have landed').toBeGreaterThan(0);
  });

  test('SessionTracker.updateSessionActivity — the write-handler seam — is itself throttled', async () => {
    const c = conn('tracker');
    const sessionId = await plantSession(c, 'active', SESSION_CONFIG.activityTouchMinIntervalSec + 300);

    const touches = await countTouchUpdates(async () => {
      for (let i = 0; i < BURST; i++) await SessionTracker.updateSessionActivity(sessionId);
    });

    expect(touches, 'the seam every write handler calls must share the one throttle').toBe(1);
    expect(activityTouchStats().issued).toBe(1);
    expect(activityTouchStats().suppressedByThrottle).toBe(BURST - 1);
  });

  test('OperationTracker.recordOperation is throttled too (and still records every analytics event)', async () => {
    const c = conn('optracker');
    const sessionId = await plantSession(c, 'active', SESSION_CONFIG.activityTouchMinIntervalSec + 300);

    const eventsBefore = (
      await db.query(`SELECT count(*)::int n FROM analytics_events WHERE session_id = $1`, [sessionId])
    ).rows[0].n;

    const touches = await countTouchUpdates(async () => {
      for (let i = 0; i < BURST; i++) await OperationTracker.recordOperation(sessionId, 'atsw_op');
    });

    expect(touches, 'recordOperation must not be a second unthrottled writer').toBe(1);
    // Throttling LIVENESS must not throttle the analytics event — they are different facts.
    const eventsAfter = (
      await db.query(`SELECT count(*)::int n FROM analytics_events WHERE session_id = $1`, [sessionId])
    ).rows[0].n;
    expect(eventsAfter - eventsBefore, 'every operation must still be recorded as an event').toBe(BURST);
  });

  test('the two writers share ONE throttle window — a read cannot be followed by an unthrottled write', async () => {
    const c = conn('shared');
    const sessionId = await plantSession(c, 'active', SESSION_CONFIG.activityTouchMinIntervalSec + 300);

    const touches = await countTouchUpdates(async () => {
      // A read first: claims the window on the read path.
      await routeExecutor('mandrel_ping', {}, { connectionId: c } as any);
      await awaitPendingActivityTouches();
      // Then a write for the SAME session. Two throttles would let this straight through.
      await SessionTracker.updateSessionActivity(sessionId);
      await OperationTracker.recordOperation(sessionId, 'atsw_after_read');
    });

    expect(touches, 'one session, one window, one UPDATE — regardless of which path got there first').toBe(1);
  });

  // ───────────────────────────────────────────────────────────────────────────────────
  // EDGE CASES — the smallest inputs where the behaviours DIVERGE
  // ───────────────────────────────────────────────────────────────────────────────────
  test('FIRST touch of a session (empty throttle map) is never suppressed', async () => {
    const c = conn('first');
    const sessionId = await plantSession(c, 'active', SESSION_CONFIG.activityTouchMinIntervalSec + 300);
    const before = await lastActivityMs(sessionId);

    const touches = await countTouchUpdates(async () => {
      await SessionTracker.updateSessionActivity(sessionId);
    });

    expect(touches, 'an empty throttle map must not suppress — that would silently kill liveness').toBe(1);
    expect(activityTouchStats().suppressedByThrottle).toBe(0);
    expect(await lastActivityMs(sessionId)).toBeGreaterThan(before);
  });

  test('concurrent writes for one session collapse to ONE UPDATE (window claimed before the await)', async () => {
    const c = conn('concurrent');
    const sessionId = await plantSession(c, 'active', SESSION_CONFIG.activityTouchMinIntervalSec + 300);

    const touches = await countTouchUpdates(async () => {
      await Promise.all(Array.from({ length: BURST }, () => SessionTracker.updateSessionActivity(sessionId)));
    });

    expect(touches, 'a concurrent write burst must not race past the throttle').toBe(1);
  });

  test('distinct sessions are throttled INDEPENDENTLY (the throttle is per session, not global)', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push(await plantSession(conn(`multi-${i}`), 'active', 3600));

    const touches = await countTouchUpdates(async () => {
      for (const id of ids) await SessionTracker.updateSessionActivity(id);
      for (const id of ids) await SessionTracker.updateSessionActivity(id); // second pass: all suppressed
    });

    expect(touches, 'five sessions ⇒ five UPDATEs; the second pass is fully suppressed').toBe(5);
  });

  test('the throttle map sweep at maxEntries never suppresses a LIVE window (reclamation only)', async () => {
    const c = conn('sweep');
    const hot = await plantSession(c, 'active', 3600);

    const savedMax = SESSION_CONFIG.activityTouchThrottleMaxEntries;
    SESSION_CONFIG.activityTouchThrottleMaxEntries = 1; // force the sweep on every touch
    try {
      const touches = await countTouchUpdates(async () => {
        await SessionTracker.updateSessionActivity(hot);
        // Add other sessions so size > maxEntries and the sweep runs. `hot`'s entry is
        // INSIDE its window, so the sweep must leave it alone.
        for (let i = 0; i < 5; i++) {
          await SessionTracker.updateSessionActivity(await plantSession(conn(`sweep-${i}`), 'active', 3600));
        }
        await SessionTracker.updateSessionActivity(hot); // must still be suppressed
      });
      expect(touches, 'the sweep must reclaim only DEAD entries — 6 sessions, 6 UPDATEs, no re-touch').toBe(6);
    } finally {
      SESSION_CONFIG.activityTouchThrottleMaxEntries = savedMax;
    }
  });

  test('an expired window lets the next WRITE touch again', async () => {
    const c = conn('expiry');
    const sessionId = await plantSession(c, 'active', SESSION_CONFIG.activityTouchMinIntervalSec + 300);

    const saved = SESSION_CONFIG.activityTouchMinIntervalSec;
    try {
      const touches = await countTouchUpdates(async () => {
        await SessionTracker.updateSessionActivity(sessionId);
        SESSION_CONFIG.activityTouchMinIntervalSec = 0; // collapse the window
        await SessionTracker.updateSessionActivity(sessionId);
      });
      expect(touches, 'throttling must be a delay, not a drop').toBe(2);
    } finally {
      SESSION_CONFIG.activityTouchMinIntervalSec = saved;
    }
  });

  // ───────────────────────────────────────────────────────────────────────────────────
  // THE INVARIANT 38cfeb72 DOCUMENTED, NOW ENFORCED FOR THE WRITE PATH TOO
  // A touch can make a live session look live. It can NEVER revive a parked one.
  // ───────────────────────────────────────────────────────────────────────────────────
  for (const parked of ['dormant', 'interrupted', 'ended', 'inactive', 'disconnected']) {
    test(`a WRITE does not advance liveness for a '${parked}' session, and does not revive it`, async () => {
      const c = conn(`parked-${parked}`);
      const sessionId = await plantSession(c, parked, SESSION_CONFIG.activityTouchMinIntervalSec + 300);
      const before = await lastActivityMs(sessionId);

      const touches = await countTouchUpdates(async () => {
        await SessionTracker.updateSessionActivity(sessionId);
        await OperationTracker.recordOperation(sessionId, 'atsw_parked');
      });

      // NON-VACUOUS: the helper ATTEMPTED the UPDATE (one statement reached the db), and
      // it is the SQL predicate `AND status = 'active'` that declined. A test that only
      // asserted "the timestamp did not move" would also pass if nothing ran at all.
      expect(touches, 'the hook must have ATTEMPTED the UPDATE — else this assertion is vacuous').toBe(1);
      expect(activityTouchStats().issued).toBe(1);
      expect(await lastActivityMs(sessionId), `'${parked}' must not be bumped by a write`).toBe(before);
      expect(await statusOf(sessionId), `'${parked}' must not be revived by a write`).toBe(parked);
    });
  }

  test('the read-path KILL SWITCH does not disable WRITE-path liveness (it is not a global off)', async () => {
    const c = conn('killswitch');
    const sessionId = await plantSession(c, 'active', SESSION_CONFIG.activityTouchMinIntervalSec + 300);
    const before = await lastActivityMs(sessionId);

    const saved = SESSION_CONFIG.activityTouchOnRead;
    SESSION_CONFIG.activityTouchOnRead = false;
    try {
      const touches = await countTouchUpdates(async () => {
        await SessionTracker.updateSessionActivity(sessionId);
      });
      // activityTouchOnRead is documented as "turning it OFF restores the PRE-TASK
      // behaviour exactly: writes still touch, reads stop touching". Converging the two
      // writers must not quietly turn it into a switch that kills liveness entirely.
      expect(touches, 'the read kill switch must leave write-path liveness intact').toBe(1);
      expect(await lastActivityMs(sessionId)).toBeGreaterThan(before);
    } finally {
      SESSION_CONFIG.activityTouchOnRead = saved;
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════
// THE ANTI-REGRESSION GUARD: ONE WRITER, ENFORCED AT THE SOURCE
// ═════════════════════════════════════════════════════════════════════════════════════
/**
 * POPULATION, STATED (C3): every `.ts` file under `mcp-server/src`, EXCLUDING `src/tests`.
 * That is the whole of the runtime source of the process that owns the sessions table's
 * liveness policy. Tests are excluded because a test may legitimately reach past the
 * helper to build a fixture or to mutate-probe this very guard (a past incident — a guard that
 * blocks correct work gets deleted). SQL migrations are excluded for the same reason and
 * a different one: they are one-shot DDL/backfill, not the running policy.
 *
 * WHY A FUTURE DIRECT CALLER CANNOT SATISFY THIS GUARD: the predicate is WHO CALLS the
 * repo method, not whether the caller behaves. A new call site cannot pass by being
 * throttled, by being correct, or by being covered by its own tests — the only green
 * state is routing through `activityTouch`. That is the difference between "the second
 * writer is currently absent" and "a second writer is unreachable".
 */
describe('5401b89f guard: SessionRepo.touchActivity has exactly ONE caller in runtime source', () => {
  const HERE = path.dirname(fileURLToPath(import.meta.url));
  const SRC_ROOT = path.resolve(HERE, '..');           // mcp-server/src
  const TESTS_DIR = path.join(SRC_ROOT, 'tests');

  /** The single legitimate caller, relative to SRC_ROOT. */
  const SOLE_CALLER = 'services/session/activityTouch.ts';
  /** Where the statement itself lives (the definition, not a call). */
  const REPO_FILE = 'services/session/infra/db/SessionRepo.ts';

  function walk(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (full === TESTS_DIR) continue;
      const st = statSync(full);
      if (st.isDirectory()) walk(full, out);
      else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) out.push(full);
    }
    return out;
  }

  const files = walk(SRC_ROOT);
  const rel = (f: string) => path.relative(SRC_ROOT, f);
  const read = (f: string) => readFileSync(f, 'utf8');

  /**
   * Read a file with COMMENTS REMOVED. Necessary because this guard's whole subject —
   * `SessionRepo.touchActivity`, `last_activity_at` — is discussed at length in the doc
   * comments of the very modules it governs, and a scanner that counted prose would be
   * RED for describing the rule (which is how a guard gets deleted for being wrong,
   * A past incident). Deliberately crude and NOT a TypeScript parser: it strips /*…*\/ and
   * //… only. The `scan itself is not broken` control below is what stops that crudeness
   * from failing OPEN — it asserts the stripped text still contains the real statements.
   */
  const readCode = (f: string) =>
    read(f)
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1');

  test('the scan itself is not broken (fail-closed positive control)', () => {
    // A source scanner that silently matches nothing is a guard that passes forever.
    // These three assertions are what make its GREEN mean something.
    expect(files.length, 'the walk must find runtime source at all').toBeGreaterThan(200);
    expect(files.map(rel), 'the walk must reach the helper').toContain(SOLE_CALLER);
    expect(files.map(rel), 'the walk must reach the repo').toContain(REPO_FILE);
    expect(read(path.join(SRC_ROOT, REPO_FILE)), 'the statement under governance must exist').toMatch(
      /UPDATE sessions SET last_activity_at/
    );
    // The comment stripper must not eat the code. If it did, every scan below would find
    // nothing and this guard would pass forever — the fail-OPEN shape (C3 subclass B).
    expect(
      readCode(path.join(SRC_ROOT, REPO_FILE)),
      'the comment stripper must leave real SQL intact'
    ).toMatch(/UPDATE sessions SET last_activity_at/);
    expect(
      readCode(path.join(SRC_ROOT, SOLE_CALLER)),
      'the comment stripper must leave the real call intact'
    ).toMatch(/SessionRepo\.touchActivity\s*\(/);
  });

  test('exactly one runtime file CALLS SessionRepo.touchActivity, and it is activityTouch.ts', () => {
    const callers = files
      .filter((f) => rel(f) !== REPO_FILE)                    // the definition is not a call
      .filter((f) => /SessionRepo\.touchActivity\s*\(/.test(readCode(f)))
      .map(rel)
      .sort();

    expect(
      callers,
      [
        'session liveness must have ONE writer.',
        'A new caller of SessionRepo.touchActivity bypasses the throttle, the bounded',
        'cache and the status invariant that live in services/session/activityTouch.ts.',
        `Call noteSessionActivity(sessionId) instead. Found: ${callers.join(', ')}`,
      ].join(' ')
    ).toEqual([SOLE_CALLER]);
  });

  test('no runtime file outside SessionRepo.ts writes last_activity_at in SQL', () => {
    // The column has exactly one owning module. This catches the OTHER shape of the same
    // defect: not a second CALLER of the helper's repo method, but a second STATEMENT
    // written somewhere else that advances the same column under no policy at all.
    const writers = files
      .filter((f) => /last_activity_at\s*=/.test(readCode(f)))
      .map(rel)
      .sort();

    expect(
      writers,
      `only ${REPO_FILE} may write sessions.last_activity_at. Found: ${writers.join(', ')}`
    ).toEqual([REPO_FILE]);
  });

  test('inside SessionRepo.ts every SQL writer of last_activity_at is one of the FOUR named, intended ones', () => {
    const sql = readCode(path.join(SRC_ROOT, REPO_FILE));
    const occurrences = (sql.match(/last_activity_at\s*=/g) ?? []).length;

    // The four, each named with the fact it writes and why it is not the heartbeat:
    //   1. touchActivity()      — THE LIVENESS HEARTBEAT. The one this task governs:
    //                             throttled via activityTouch, `WHERE status='active'`.
    //   2. reactivate()         — the resolver's RE-ATTACH. Flips status AND refreshes
    //                             the timestamp under the re-attach-window policy;
    //                             deliberately outside the throttle, a different fact.
    //   3. updateActivityCount()— recomputes activity_count from session_activities
    //                             (REST analytics path).                    ← see FINDING
    //   4. applyCounterDelta()  — the 30s counter flush / endSession finalize.
    //                                                                        ← see FINDING
    // FINDING (an earlier task report, raised to Coordinator, NOT fixed here): 3 and 4 also
    // advance last_activity_at, unthrottled and with NO `status = 'active'` predicate,
    // so they can freshen a dormant/ended row. They are counter-persistence statements,
    // not heartbeats; splitting the liveness bump out of them changes REST analytics and
    // finalize semantics and belongs in its own scoped change. This guard pins them so
    // the population stays four and a FIFTH writer cannot appear unnoticed.
    expect(
      occurrences,
      'a fifth SQL writer of sessions.last_activity_at is a fifth policy for one fact — ' +
        'route it through activityTouch.noteSessionActivity or name it here with a reason'
    ).toBe(4);

    // Anchor each of the two policy-bearing ones by its actual statement, so the count
    // above cannot be satisfied by four copies of something else.
    expect(sql, '1. the throttled heartbeat, status-guarded').toMatch(
      /UPDATE sessions SET last_activity_at = CURRENT_TIMESTAMP WHERE id = \$1 AND status = 'active'/
    );
    expect(sql, '2. the re-attach, which alone may change status').toMatch(
      /SET status = 'active', last_activity_at = CURRENT_TIMESTAMP/
    );
  });
});
