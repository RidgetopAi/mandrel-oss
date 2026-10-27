/**
 * A BULK TASK WRITE IS ACTIVITY (folded in from lane M-5).
 *
 * ════════════════════════════════════════════════════════════════════════════════════
 * THE DEFECT THIS EXISTS TO CATCH
 * ════════════════════════════════════════════════════════════════════════════════════
 * Every task WRITE path in handlers/tasks.ts ends by resolving the caller's session and
 * touching its liveness — createTask (~340) and updateTask (~1082) both call
 * `SessionTracker.updateSessionActivity(sessionId)`. `bulkUpdateTasks` did NOT. It
 * resolved the session and called `recordTaskUpdated` (an in-RAM counter) and then never
 * advanced `sessions.last_activity_at`. So the ONE task write that can move fifty rows
 * was the one write that left no mark on the column every liveness consumer is defined
 * off — the Sessions UI, the LIVE NOW grouping, and the actor-mode dormant/close windows.
 *
 * ════════════════════════════════════════════════════════════════════════════════════
 * WHY THIS GUARD TURNS THE READ-PATH TOUCH OFF, AND WHY THAT IS NOT CHEATING
 * ════════════════════════════════════════════════════════════════════════════════════
 * Since an earlier task, `runWithProjectScope` fires `noteToolActivity` for EVERY tool call,
 * read or write. Left on, it would advance the column here whether or not the write path
 * did anything — the guard would be green with the feature deleted, which is the
 * definition of hollow. So `SESSION_CONFIG.activityTouchOnRead` is flipped OFF for the
 * duration (it is read per call, by design, precisely so it can be flipped), leaving the
 * write-path touch as the ONLY thing that can move the column.
 *
 * That is also the honest statement of the bug's blast radius, which is narrower than
 * "the session looks idle": with the read touch ON, the transport wrap covers the bulk
 * call at a 60s granularity. It stops covering it whenever the kill switch is off, and it
 * never covered the WRITE as a write. Parity across the three task write paths is the
 * property being asserted, and it is asserted at the surface, not by reading the source.
 *
 * ════════════════════════════════════════════════════════════════════════════════════
 * THE POPULATION
 * ════════════════════════════════════════════════════════════════════════════════════
 * The three task write paths: task_create and task_bulk_update through validate →
 * routeExecutor (the shipped entry point), and the single UPDATE path at the handler,
 * because its ROUTE passes a literal `undefined` for connectionId and therefore cannot
 * resolve a session at all — a separate defect, called out at that test and left alone.
 * The two already-correct paths are the CONTROL that proves this harness can observe a
 * touch at all: a RED on bulk alone means the harness works and bulk is the outlier.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';

import { db } from '../config/database.js';
import { validateToolArguments } from '../middleware/validation.js';
import { routeExecutor } from '../routes/index.js';
import { SESSION_CONFIG } from '../config/sessionConfig.js';
import { ActiveSessionStore } from '../services/session/state/ActiveSessionStore.js';
import { resetActivityTouchState } from '../services/session/activityTouch.js';
import { tasksHandler } from '../handlers/tasks.js';

const STAMP = Date.now();
const CONN_PREFIX = `bulk-act-${STAMP}`;
/** How far back a planted session's clock is set, so any touch is unambiguously visible. */
const BACKDATE_SEC = 600;
let projectId: string;

async function viaPublicTool(toolName: string, rawArgs: any, connectionId: string): Promise<any> {
  const validated = validateToolArguments(toolName, rawArgs);
  return routeExecutor(toolName, validated, { connectionId } as any);
}

async function plantSession(connectionId: string): Promise<string> {
  const r = await db.query(
    `INSERT INTO sessions (project_id, connection_id, agent_type, status, started_at, last_activity_at)
     VALUES ($1, $2, 'test', 'active',
             CURRENT_TIMESTAMP - ($3 || ' seconds')::interval,
             CURRENT_TIMESTAMP - ($3 || ' seconds')::interval)
     RETURNING id`,
    [projectId, connectionId, String(BACKDATE_SEC)]
  );
  const id: string = r.rows[0].id;
  ActiveSessionStore.set(id, connectionId);
  return id;
}

/** Seconds between the session's last_activity_at and the DB's own clock. One clock only. */
async function activityAgeSec(sessionId: string): Promise<number> {
  const r = await db.query(
    `SELECT EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - last_activity_at)) AS age
       FROM sessions WHERE id = $1`,
    [sessionId]
  );
  if (r.rows.length === 0) throw new Error(`planted session ${sessionId} vanished`);
  return Number(r.rows[0].age);
}

async function makeTask(): Promise<string> {
  const res = await db.query(
    `INSERT INTO tasks (project_id, title, type, priority, status)
     VALUES ($1, 'bulk-activity fuse', 'general', 'medium', 'todo') RETURNING id`,
    [projectId]
  );
  return res.rows[0].id;
}

/** Under 30s = touched (the plant is 600s old). Wide on purpose; the two states are 600s apart. */
const TOUCHED_WITHIN_SEC = 30;

describe('a bulk task write advances session liveness', () => {
  let savedTouchOnRead: boolean;

  beforeAll(async () => {
    projectId = (
      await db.query(
        `INSERT INTO projects (name, description) VALUES ($1, 'bulk activity fuse') RETURNING id`,
        [`bulk-act-${STAMP}`]
      )
    ).rows[0].id;
    savedTouchOnRead = SESSION_CONFIG.activityTouchOnRead;
    // See the header: with this ON the transport wrap would touch for us and this guard
    // would pass with the write-path touch deleted.
    SESSION_CONFIG.activityTouchOnRead = false;
  });

  afterAll(async () => {
    SESSION_CONFIG.activityTouchOnRead = savedTouchOnRead;
    ActiveSessionStore.clearAll();
    await db.query(`DELETE FROM tasks WHERE project_id = $1`, [projectId]);
    await db.query(`DELETE FROM sessions WHERE connection_id LIKE $1`, [`${CONN_PREFIX}-%`]);
    await db.query(`DELETE FROM projects WHERE id = $1`, [projectId]);
  });

  beforeEach(() => {
    resetActivityTouchState();
    ActiveSessionStore.clearAll();
  });

  test('THE HARNESS IS HONEST: the read-path touch is off and cannot mask the result', async () => {
    expect(SESSION_CONFIG.activityTouchOnRead).toBe(false);
    const conn = `${CONN_PREFIX}-readonly`;
    const sessionId = await plantSession(conn);
    // A pure READ through the same entry point must leave the column where it was.
    await routeExecutor('mandrel_ping', {}, { connectionId: conn } as any);
    expect(
      await activityAgeSec(sessionId),
      'with activityTouchOnRead off, a read must NOT advance the column — otherwise every ' +
        'assertion below would be green with the write-path touch deleted'
    ).toBeGreaterThan(TOUCHED_WITHIN_SEC);
  });

  test('CONTROL: the single UPDATE path touches when it is given a connectionId', async () => {
    // Driven at the HANDLER, not through routeExecutor, and that is a finding rather than a
    // convenience: `task_update`'s route passes a literal `undefined` for connectionId
    // (routes/tasks.routes.ts, "connectionId (not threaded on this route today)"), so the
    // single path cannot resolve a session through the tool surface at all. That is a
    // SEPARATE defect from the one this file fixes and is deliberately not fixed here —
    // this case exists to prove the handler seam itself is correct, so a RED on bulk below
    // is about bulk and not about the harness.
    const conn = `${CONN_PREFIX}-single`;
    const sessionId = await plantSession(conn);
    const taskId = await makeTask();

    await tasksHandler.updateTaskStatus(taskId, 'in_progress', undefined, undefined, conn);

    expect(await activityAgeSec(sessionId)).toBeLessThan(TOUCHED_WITHIN_SEC);
  });

  test('CONTROL: task_create advances it', async () => {
    const conn = `${CONN_PREFIX}-create`;
    const sessionId = await plantSession(conn);

    await viaPublicTool('task_create', { title: 'bulk-activity control', projectId }, conn);

    expect(await activityAgeSec(sessionId)).toBeLessThan(TOUCHED_WITHIN_SEC);
  });

  test('THE FIX: task_bulk_update advances it too (pre-fix: it did not)', async () => {
    const conn = `${CONN_PREFIX}-bulk`;
    const sessionId = await plantSession(conn);
    const a = await makeTask();
    const b = await makeTask();

    const resp = await viaPublicTool(
      'task_bulk_update',
      { projectId, task_ids: [a, b], status: 'in_progress' },
      conn
    );
    expect(resp.isError).toBeFalsy();
    expect(resp.structuredContent.successfullyUpdated).toBe(2);

    expect(
      await activityAgeSec(sessionId),
      'a bulk write of N tasks must mark the session live, exactly as its two siblings do'
    ).toBeLessThan(TOUCHED_WITHIN_SEC);
  });

  test('a bulk call that updated NOTHING does not fabricate liveness', async () => {
    // The empty population (C3). `task_ids` must be non-empty per the schema, so the
    // reachable "nothing moved" case is a fenced/no-op batch; here every id is fenced out
    // by naming a task in a DIFFERENT project, which the handler rejects before any write.
    const conn = `${CONN_PREFIX}-empty`;
    const sessionId = await plantSession(conn);
    const otherProject = (
      await db.query(
        `INSERT INTO projects (name, description) VALUES ($1, 'bulk activity other') RETURNING id`,
        [`bulk-act-other-${STAMP}`]
      )
    ).rows[0].id;
    const foreign = (
      await db.query(
        `INSERT INTO tasks (project_id, title, type, priority, status)
         VALUES ($1, 'foreign', 'general', 'medium', 'todo') RETURNING id`,
        [otherProject]
      )
    ).rows[0].id;

    const resp = await viaPublicTool(
      'task_bulk_update',
      { projectId, task_ids: [foreign], status: 'in_progress' },
      conn
    );
    expect(resp.isError, 'a cross-project bulk edit must be refused').toBeTruthy();

    expect(
      await activityAgeSec(sessionId),
      'a refused bulk write moved no rows; it must not advance liveness'
    ).toBeGreaterThan(TOUCHED_WITHIN_SEC);

    await db.query(`DELETE FROM tasks WHERE project_id = $1`, [otherProject]);
    await db.query(`DELETE FROM projects WHERE id = $1`, [otherProject]);
  });
});
