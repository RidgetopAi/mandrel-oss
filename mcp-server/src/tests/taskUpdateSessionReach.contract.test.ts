/**
 * BATCH 6 / LANE M-10 — task_update's ROUTE could not resolve a session at all.
 *
 * =============================================================================
 * THE DEFECT
 * =============================================================================
 * `handlers/tasks.ts#updateTaskStatus` ends with a session-activity block:
 *
 *     const sessionId = await SessionTracker.getActiveSession(connectionId, { actor });
 *     if (sessionId) {
 *       await SessionTracker.updateSessionActivity(sessionId);
 *       SessionTracker.recordTaskUpdated(sessionId, isCompleted);
 *     }
 *
 * That code was UNREACHABLE through the tool surface, because BOTH routes that call
 * the handler passed a literal `undefined` for the `connectionId` parameter:
 *   - `handleUpdate`  (tool `task_update`)  — a commented literal `undefined`
 *   - `handleCancel`  (tool `cancel_task`)  — a bare POSITIONAL `undefined` in slot 5
 * The handler is fine; the ROUTE's plumbing was not. This is the same class as the
 * bulk-update defect (lane M-6), one layer up.
 *
 * =============================================================================
 * WHAT THIS FILE ASSERTS, AND WHY THAT OBSERVABLE
 * =============================================================================
 * `sessions.last_activity_at` is the WRONG observable here: since an earlier task the
 * read-path touch in `services/session/activityTouch.ts` fires for EVERY tool call via
 * `runWithProjectScope`, so the column advances on a `task_update` whether or not the
 * handler's own block ran. It would give a false GREEN.
 *
 * The observable that ONLY this block can move is the per-session activity DELTA
 * `tasks_updated` / `tasks_completed` (`ActivityCountStore`, written from exactly one
 * place: `OperationTracker.recordTaskUpdated`, verified by
 *   grep -rn "incrementTasksUpdated" src --include=*.ts | grep -v test
 * → 1 writer + the store's own definition). So a non-zero `tasks_updated` after a
 * `task_update` PROVES the handler resolved a session; a zero proves it did not.
 *
 * Every assertion drives the SHIPPED entry point `routeExecutor` — the seam both tool
 * surfaces (flat `/mcp/tools/*` and the gateway) call. Nothing here re-builds the
 * pipeline the product performs.
 *
 * DB target: an isolated throwaway test database (scripts/provision-test-db.sh).
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { db } from '../config/database.js';
import { routeExecutor } from '../routes/index.js';
import { ActiveSessionStore } from '../services/session/state/ActiveSessionStore.js';
import { ActivityCountStore } from '../services/session/state/ActivityCountStore.js';

const STAMP = Date.now();
const CONN_PREFIX = `tusr-${STAMP}`;
const ACTOR = `tusr-actor-${STAMP}`;

let projectId: string;

const conn = (label: string) => `${CONN_PREFIX}-${label}`;

/** Plant an OPEN session for `connectionId` and cache it the way a prior action would. */
async function plantSession(connectionId: string): Promise<string> {
  const r = await db.query(
    `INSERT INTO sessions (project_id, connection_id, agent_type, status, started_at, last_activity_at)
     VALUES ($1, $2, 'test', 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
     RETURNING id`,
    [projectId, connectionId]
  );
  const id: string = r.rows[0].id;
  ActiveSessionStore.set(id, connectionId);
  return id;
}

/** A task to mutate. Inserted directly so task_create's own counters never confound. */
async function plantTask(title: string): Promise<string> {
  const r = await db.query(
    `INSERT INTO tasks (project_id, title, type, status, priority)
     VALUES ($1, $2, 'general', 'todo', 'medium') RETURNING id`,
    [projectId, title]
  );
  return r.rows[0].id;
}

/**
 * The session's un-flushed activity delta. `consume` is get-and-delete, so this both
 * reads and zeroes — exactly what we want between phases of a test.
 */
const delta = (sessionId: string) => ActivityCountStore.consume(sessionId);

describe('lane M-10: the task-write ROUTES reach a session', () => {
  beforeAll(async () => {
    projectId = (
      await db.query(
        `INSERT INTO projects (name, description) VALUES ($1, 'M-10 task_update session reach')
         RETURNING id`,
        [`tusr-proj-${STAMP}`]
      )
    ).rows[0].id;
  });

  afterAll(async () => {
    ActiveSessionStore.clearAll();
    try {
      await db.query(`DELETE FROM tasks WHERE project_id = $1`, [projectId]);
      await db.query(`DELETE FROM sessions WHERE connection_id LIKE $1`, [`${CONN_PREFIX}-%`]);
      await db.query(`DELETE FROM projects WHERE id = $1`, [projectId]);
    } catch {
      /* ignore */
    }
    await db.end();
  });

  beforeEach(() => {
    ActiveSessionStore.clearAll();
  });

  /**
   * THE DEFECT, AS A GUARD. RED before the fix (delta 0), GREEN after (delta 1).
   */
  test('task_update through the shipped route records session activity', async () => {
    const c = conn('update');
    const sessionId = await plantSession(c);
    const taskId = await plantTask(`m10-update-${STAMP}`);
    delta(sessionId); // zero the counter

    await routeExecutor(
      'task_update',
      { taskId, status: 'in_progress', projectId },
      { connectionId: c, actor: ACTOR } as any
    );

    const d = delta(sessionId);
    expect(d.tasks_updated).toBe(1);
    expect(d.tasks_completed).toBe(0);
  });

  /** `completed` must land in the completed counter too — the isCompleted branch. */
  test('task_update to completed records a completion', async () => {
    const c = conn('complete');
    const sessionId = await plantSession(c);
    const taskId = await plantTask(`m10-complete-${STAMP}`);
    delta(sessionId);

    await routeExecutor(
      'task_update',
      { taskId, status: 'completed', projectId },
      { connectionId: c, actor: ACTOR } as any
    );

    const d = delta(sessionId);
    expect(d.tasks_updated).toBe(1);
    expect(d.tasks_completed).toBe(1);
  });

  /**
   * `cancel_task` is `task_update(status='cancelled')` in a wrapper and carried the SAME
   * defect, as a bare positional `undefined` in argument slot 5. Found by sweeping the
   * file rather than fixing the reported line.
   */
  test('cancel_task through the shipped route records session activity', async () => {
    const c = conn('cancel');
    const sessionId = await plantSession(c);
    const taskId = await plantTask(`m10-cancel-${STAMP}`);
    delta(sessionId);

    await routeExecutor(
      'cancel_task',
      { taskId, projectId },
      { connectionId: c, actor: ACTOR } as any
    );

    const d = delta(sessionId);
    expect(d.tasks_updated).toBe(1);
  });

  /**
   * THE POPULATION IS COMPLETE, EXECUTABLY.
   *
   * The two tests above cover the two routes that call `tasksHandler.updateTaskStatus`.
   * "Two" is not a claim in prose — it is derived here from the file, so a THIRD call site
   * added later turns this RED until whoever adds it thinks about connectionId. This is
   * the coverage assertion, deliberately not a comment listing the call sites.
   *
   * The read throws (never returns 0) if the path is wrong, so it cannot fail open.
   */
  test('every updateTaskStatus call site in tasks.routes.ts is covered above', () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(path.join(here, '..', 'routes', 'tasks.routes.ts'), 'utf8');
    const callSites = src.match(/tasksHandler\.updateTaskStatus\(/g) ?? [];
    expect(callSites.length).toBe(2);
  });

});
