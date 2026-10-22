/**
 * task_update existence-enforcement Contract Test
 *
 * THE BUG THIS LOCKS SHUT:
 *   task_update with a syntactically-valid but NON-EXISTENT full UUID reported
 *   `{ action: 'updated', ok: true }` — a PHANTOM SUCCESS. The short-id resolver
 *   short-circuits a full UUID WITHOUT a DB round-trip (by design, for canonical ids),
 *   so the bare `UPDATE ... WHERE id = $n` matched 0 rows SILENTLY while the route still
 *   claimed success. An agent could "update" a task that doesn't exist and never know.
 *
 * THE FIX (pinned here — FAILS before, PASSES after):
 *   updateTaskStatus now `RETURNING id` + a rowCount guard: 0 rows → throw IdNotFoundError,
 *   which the route surfaces as the SAME actionable not-found the resolve path uses
 *   (isError:true, structuredContent {ok:false, found:false}). A real update still succeeds.
 *
 * Driven through the SAME public path the bridge uses (validate → routeExecutor), on the
 * real migrated disposable ci_* DB.
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';

import { db } from '../config/database.js';
import { validateToolArguments } from '../middleware/validation.js';
import { routeExecutor } from '../routes/index.js';

const STAMP = Date.now();
const PROJ_NAME = `taskupd-exist-${STAMP}`;
let projectId: string;
let realTaskId: string;

async function viaPublicTool(toolName: string, rawArgs: any): Promise<any> {
  const validated = validateToolArguments(toolName, rawArgs);
  return routeExecutor(toolName, validated);
}

describe('task_update existence enforcement', () => {
  beforeAll(async () => {
    projectId = (
      await db.query(`INSERT INTO projects (name, description) VALUES ($1, 'exist fuse') RETURNING id`, [PROJ_NAME])
    ).rows[0].id;
    realTaskId = (
      await db.query(
        `INSERT INTO tasks (project_id, title, type, priority, status) VALUES ($1, 'real', 'general', 'medium', 'todo') RETURNING id`,
        [projectId]
      )
    ).rows[0].id;
  });

  afterAll(async () => {
    await db.query(`DELETE FROM tasks WHERE project_id = $1`, [projectId]);
    await db.query(`DELETE FROM projects WHERE id = $1`, [projectId]);
  });

  test('non-existent FULL UUID → actionable not-found, NOT phantom success', async () => {
    const fakeId = randomUUID(); // valid UUID shape, no such row
    const resp = await viaPublicTool('task_update', { projectId, taskId: fakeId, status: 'completed' });

    // The bug: this used to be { action:'updated', ok:true } with no error.
    expect(resp.isError).toBe(true);
    expect(resp.structuredContent.ok).toBe(false);
    expect(resp.structuredContent.found).toBe(false);
    expect(resp.structuredContent.action).toBeUndefined(); // no phantom "updated"
    expect(resp.content?.[0]?.text).toContain('not found');

    // And nothing was written (no row with that id exists).
    const check = await db.query(`SELECT 1 FROM tasks WHERE id = $1`, [fakeId]);
    expect(check.rows.length).toBe(0);
  });

  test('non-existent SHORT id → actionable not-found (resolve-path, unchanged)', async () => {
    const resp = await viaPublicTool('task_update', { projectId, taskId: 'deadbeef', status: 'completed' });
    expect(resp.isError).toBe(true);
    expect(resp.structuredContent.ok).toBe(false);
    expect(resp.structuredContent.found).toBe(false);
  });

  test('EXISTING task → real update still succeeds and persists', async () => {
    const resp = await viaPublicTool('task_update', { projectId, taskId: realTaskId, status: 'completed' });
    expect(resp.isError).toBeFalsy();
    expect(resp.structuredContent.action).toBe('updated');
    expect(resp.structuredContent.task.id).toBe(realTaskId);
    expect(resp.structuredContent.task.status).toBe('completed');

    const row = await db.query(`SELECT status FROM tasks WHERE id = $1`, [realTaskId]);
    expect(row.rows[0].status).toBe('completed');
  });
});
