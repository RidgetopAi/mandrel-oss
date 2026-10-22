/**
 * an earlier Task bug 2 — SESSION LIVENESS MUST MEAN "ARE YOU WORKING", NOT "DID YOU WRITE".
 *
 * BEFORE THIS CHANGE: `sessions.last_activity_at` advanced only from write handlers
 * (handlers/context.ts, handlers/tasks.ts, handlers/decisions.ts →
 * SessionTracker.updateSessionActivity, and OperationTracker.recordOperation). An agent
 * could read context, search and walk threads for an hour and its session still reported
 * DORMANT, because nothing on the read path touched the column. Every consumer of session
 * liveness — the Sessions UI, the LIVE NOW grouping, the actor-mode dormanter/closer
 * windows — is defined off that one column, so all of them inherited the lie.
 *
 * WHAT THIS FILE DRIVES: the SHIPPED entry point. Every assertion below goes through
 * `routeExecutor`, the seam both tool surfaces (flat `/mcp/tools/*` and the gateway) call,
 * with `mandrel_ping` — an op classified `effect:'read'` in config/opRegistry.ts and NOT in
 * routes/index.ts's ACTION_TOOLS, i.e. a call that persists nothing and creates no session.
 * Nothing here re-builds the pipeline the product performs: if the hook were
 * removed from `runWithProjectScope`, these go RED — which is the mutation probe recorded
 * in the task report.
 *
 * DB target: an isolated throwaway test database (scripts/provision-test-db.sh).
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

import { db } from '../config/database.js';
import { routeExecutor } from '../routes/index.js';
import { ActiveSessionStore } from '../services/session/state/ActiveSessionStore.js';
import { SESSION_CONFIG } from '../config/sessionConfig.js';
import {
  activityTouchStats,
  awaitPendingActivityTouches,
  resetActivityTouchState,
} from '../services/session/activityTouch.js';

const STAMP = Date.now();
const CONN_PREFIX = `rat-${STAMP}`;

/** How many reads a "burst" is. Big enough that 1 UPDATE is unmistakably a throttle. */
const BURST_READS = 50;

let projectId: string;

const conn = (label: string) => `${CONN_PREFIX}-${label}`;

/**
 * Plant an OPEN session for `connectionId` with a known-stale last_activity_at, and put it
 * in the RAM store the way a prior action would have. Returns its id.
 *
 * `backdateSec` is the age of the planted activity. It must exceed the throttle interval,
 * or a suppressed touch would be indistinguishable from a missing one.
 */
async function plantSession(
  connectionId: string,
  status: string,
  backdateSec: number
): Promise<string> {
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

/** Wall-clock "now" as Postgres sees it, so the comparison never straddles two clocks. */
async function dbNowMs(): Promise<number> {
  const r = await db.query(`SELECT EXTRACT(EPOCH FROM CURRENT_TIMESTAMP) * 1000 AS ms`);
  return Number(r.rows[0].ms);
}

/** One read call through the shipped seam. */
async function read(connectionId: string): Promise<void> {
  await routeExecutor('mandrel_ping', {}, { connectionId } as any);
}

describe('38cfeb72 bug 2: a READ advances session liveness', () => {
  beforeAll(async () => {
    projectId = (
      await db.query(
        `INSERT INTO projects (name, description) VALUES ($1, '38cfeb72 read-activity-touch test')
         RETURNING id`,
        [`rat-proj-${STAMP}`]
      )
    ).rows[0].id;
  });

  afterAll(async () => {
    ActiveSessionStore.clearAll();
    try {
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
  // THE BUG ITSELF
  // ───────────────────────────────────────────────────────────────────────────────────
  test('a session that ONLY reads has last_activity_at advanced (pre-fix: it did not)', async () => {
    const c = conn('readonly');
    const backdateSec = SESSION_CONFIG.activityTouchMinIntervalSec + 300;
    const sessionId = await plantSession(c, 'active', backdateSec);

    const before = await lastActivityMs(sessionId);
    const nowBefore = await dbNowMs();
    // Positive control on the FIXTURE: the planted row must genuinely be stale, or
    // "it advanced" would be unfalsifiable.
    expect(
      nowBefore - before,
      'fixture must be older than the throttle window, else a suppressed touch looks like a missing one'
    ).toBeGreaterThan(SESSION_CONFIG.activityTouchMinIntervalSec * 1000);

    await read(c);
    await awaitPendingActivityTouches();

    const after = await lastActivityMs(sessionId);
    expect(after, 'a pure read must advance last_activity_at').toBeGreaterThan(before);
    // And it must be genuinely fresh, not merely "a bigger number".
    expect(
      (await dbNowMs()) - after,
      'the advanced value must be ~now, not a partial bump'
    ).toBeLessThan(SESSION_CONFIG.activityTouchMinIntervalSec * 1000);
  });

  test('the read did NOT create a session row and did NOT change the status', async () => {
    const c = conn('nocreate');
    const sessionId = await plantSession(c, 'active', SESSION_CONFIG.activityTouchMinIntervalSec + 300);

    const rowsBefore = (
      await db.query(`SELECT count(*)::int n FROM sessions WHERE connection_id = $1`, [c])
    ).rows[0].n;

    await read(c);
    await awaitPendingActivityTouches();

    const rowsAfter = (
      await db.query(`SELECT count(*)::int n FROM sessions WHERE connection_id = $1`, [c])
    ).rows[0].n;
    expect(rowsAfter, 'a read must never spawn a session row').toBe(rowsBefore);
    expect(await statusOf(sessionId), 'the touch must be status-preserving').toBe('active');
  });

  // ───────────────────────────────────────────────────────────────────────────────────
  // THE COST CONTROL — the throttle, measured
  // ───────────────────────────────────────────────────────────────────────────────────
  test(`${BURST_READS} reads in one throttle window issue exactly ONE UPDATE`, async () => {
    const c = conn('throttle');
    const sessionId = await plantSession(c, 'active', SESSION_CONFIG.activityTouchMinIntervalSec + 300);

    const observed: number[] = [await lastActivityMs(sessionId)];
    for (let i = 0; i < BURST_READS; i++) {
      await read(c);
      await awaitPendingActivityTouches();
      observed.push(await lastActivityMs(sessionId));
    }

    const s = activityTouchStats();
    expect(s.considered, 'every call must reach the hook').toBe(BURST_READS);
    expect(s.issued, `${BURST_READS} reads must collapse to ONE UPDATE`).toBe(1);
    expect(s.suppressedByThrottle).toBe(BURST_READS - 1);

    // Ground truth, independent of the hook's own counters: the column changed value
    // exactly once (2 distinct values = the planted one and the touched one).
    // GROUND TRUTH, independent of the hook's own counters: sample the column after every
    // single read and count DISTINCT values. Two values — the planted one and the touched
    // one — means the column changed exactly once across the whole burst. This would only
    // undercount if two UPDATEs landed inside one Postgres clock tick, which is why the
    // hook's counter is asserted too and the two must agree.
    expect(
      new Set(observed).size,
      'the stored timestamp must change exactly once across the burst'
    ).toBe(2);
  });

  /**
   * WRITE AMPLIFICATION, MEASURED AT THE DB CLIENT SEAM — the number Coordinator asked for.
   *
   * This does not read the hook's own counters and does not infer from stored values: it
   * counts the `UPDATE sessions SET last_activity_at` STATEMENTS handed to `db.query`,
   * which is the thing that actually costs the shared database something.
   *
   * BOTH SIDES OF THE COMPARISON ARE PRODUCT CODE. The "before" arm is the SAME shipped
   * hook with `activityTouchMinIntervalSec = 0` — i.e. the honest un-throttled design, the
   * thing this task would have shipped if the cost had not been priced. Nothing is stubbed
   * or mutated to produce it, so the ratio is a property of the config knob, not of a
   * patched build.
   */
  test(`write amplification: ${BURST_READS} reads cost ${BURST_READS} UPDATEs unthrottled, 1 UPDATE shipped`, async () => {
    const TOUCH_SQL = /UPDATE\s+sessions\s+SET\s+last_activity_at/i;

    async function updatesFor(label: string, intervalSec: number): Promise<number> {
      const c = conn(`amp-${label}`);
      await plantSession(c, 'active', 3600);
      resetActivityTouchState();

      // Bind BEFORE spying so the counter is a pass-through wrapper, never a stub: every
      // statement still reaches Postgres, so this measures the real workload.
      const originalQuery = db.query.bind(db);
      let touches = 0;
      const spy = vi.spyOn(db, 'query').mockImplementation(((...args: any[]) => {
        const sql = typeof args[0] === 'string' ? args[0] : (args[0]?.text ?? '');
        if (TOUCH_SQL.test(sql)) touches++;
        return (originalQuery as any)(...args);
      }) as any);

      const saved = SESSION_CONFIG.activityTouchMinIntervalSec;
      SESSION_CONFIG.activityTouchMinIntervalSec = intervalSec;
      try {
        for (let i = 0; i < BURST_READS; i++) await read(c);
        await awaitPendingActivityTouches();
      } finally {
        SESSION_CONFIG.activityTouchMinIntervalSec = saved;
        spy.mockRestore();
      }
      return touches;
    }

    const unthrottled = await updatesFor('off', 0);
    const shipped = await updatesFor('on', 60);

    // The bug being priced: an un-throttled hook makes UPDATE volume a function of READ
    // volume. This is the arm that would have tripled prod's write load.
    expect(unthrottled, 'unthrottled: one UPDATE per read').toBe(BURST_READS);
    // The shipped design: UPDATE volume is a function of WALL CLOCK, not of traffic.
    expect(shipped, 'shipped: the whole burst collapses to one UPDATE').toBe(1);
  });

  test('concurrent reads in one window also collapse to ONE UPDATE (the window is claimed before the await)', async () => {
    const c = conn('burst');
    await plantSession(c, 'active', SESSION_CONFIG.activityTouchMinIntervalSec + 300);

    await Promise.all(Array.from({ length: BURST_READS }, () => read(c)));
    await awaitPendingActivityTouches();

    expect(activityTouchStats().issued, 'a concurrent burst must not race past the throttle').toBe(1);
  });

  test('once the window expires, the next read touches again', async () => {
    const c = conn('expiry');
    const sessionId = await plantSession(c, 'active', SESSION_CONFIG.activityTouchMinIntervalSec + 300);

    await read(c);
    await awaitPendingActivityTouches();
    const first = await lastActivityMs(sessionId);
    expect(activityTouchStats().issued).toBe(1);

    // Collapse the window instead of sleeping through 60s. Config is read PER CALL
    // precisely so this is possible without a restart or a fake clock.
    const saved = SESSION_CONFIG.activityTouchMinIntervalSec;
    SESSION_CONFIG.activityTouchMinIntervalSec = 0;
    try {
      // Push the stored value back so a second UPDATE is observable as a change.
      await db.query(
        `UPDATE sessions SET last_activity_at = CURRENT_TIMESTAMP - interval '600 seconds' WHERE id = $1`,
        [sessionId]
      );
      await read(c);
      await awaitPendingActivityTouches();
    } finally {
      SESSION_CONFIG.activityTouchMinIntervalSec = saved;
    }

    expect(activityTouchStats().issued, 'an expired window must permit the next touch').toBe(2);
    expect(await lastActivityMs(sessionId)).toBeGreaterThan(first - 1);
  });

  // ───────────────────────────────────────────────────────────────────────────────────
  // WHAT IT DELIBERATELY WILL NOT DO
  // ───────────────────────────────────────────────────────────────────────────────────
  // Every NON-active state, so the population is the product's own status vocabulary
  // rather than the two states the author happened to think of.
  for (const parked of ['dormant', 'interrupted', 'ended', 'inactive', 'disconnected']) {
    test(`a read does NOT advance liveness for a '${parked}' session, and does not revive it`, async () => {
      const c = conn(`parked-${parked}`);
      const sessionId = await plantSession(c, parked, SESSION_CONFIG.activityTouchMinIntervalSec + 300);
      const before = await lastActivityMs(sessionId);

      await read(c);
      await awaitPendingActivityTouches();

      // The hook DID fire (so this is not vacuously green — it is the SQL predicate
      // that declines, which is the behaviour under test).
      expect(activityTouchStats().issued, 'the hook must have attempted the UPDATE').toBe(1);
      expect(await lastActivityMs(sessionId), `'${parked}' must not be bumped by a read`).toBe(before);
      expect(await statusOf(sessionId), `'${parked}' must not be revived by a read`).toBe(parked);
    });
  }

  test('a connection with no session in RAM issues no UPDATE and creates nothing', async () => {
    const c = conn('nosession');

    await read(c);
    await awaitPendingActivityTouches();

    const s = activityTouchStats();
    expect(s.skippedNoSession, 'no RAM session ⇒ skipped, no DB work at all').toBe(1);
    expect(s.issued).toBe(0);
    expect(
      (await db.query(`SELECT count(*)::int n FROM sessions WHERE connection_id = $1`, [c])).rows[0].n,
      'a read must not resolve-or-create a session'
    ).toBe(0);
  });

  test('the kill switch restores pre-task behaviour exactly (reads stop touching)', async () => {
    const c = conn('killswitch');
    const sessionId = await plantSession(c, 'active', SESSION_CONFIG.activityTouchMinIntervalSec + 300);
    const before = await lastActivityMs(sessionId);

    const saved = SESSION_CONFIG.activityTouchOnRead;
    SESSION_CONFIG.activityTouchOnRead = false;
    try {
      await read(c);
      await awaitPendingActivityTouches();
    } finally {
      SESSION_CONFIG.activityTouchOnRead = saved;
    }

    const s = activityTouchStats();
    expect(s.skippedDisabled).toBe(1);
    expect(s.issued).toBe(0);
    expect(await lastActivityMs(sessionId), 'disabled ⇒ byte-identical to pre-task').toBe(before);
  });
});
