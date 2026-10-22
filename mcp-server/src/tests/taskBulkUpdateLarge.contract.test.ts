/**
 * task_bulk_update large-payload + honest-response Contract Test
 *
 * THE BUGS THIS LOCKS SHUT:
 *   (a) SILENT NO-OP: bulk update must ALWAYS return an honest count object
 *       { totalRequested, successfullyUpdated, failed, updatedTaskIds } — never an empty
 *       no-op response with no status change.
 *   (b) LARGE-PAYLOAD FAILURE: it worked at ~11 ids but a 90+ id update was rejected by a
 *       HARDCODED zod cap of 50 — and the bridge surfaced that rejection as a bare `null`
 *       to the caller. The bulk UPDATE is a single atomic `id = ANY($n)` statement, so a
 *       large id list is safe at the DB layer; the only barrier was the cap. It is now
 *       CONFIG-DRIVEN (TASK_BULK_MAX_IDS, default 500) so a real board sweep succeeds, and
 *       exceeding the cap fails with a CLEAR, actionable zod error (never a silent null).
 *
 * Driven through the SAME public path the bridge uses (validate → routeExecutor), on the
 * real migrated disposable ci_* DB.
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';

import { db } from '../config/database.js';
import { validateToolArguments } from '../middleware/validation.js';
import { routeExecutor } from '../routes/index.js';
import { TASK_BULK_MAX_IDS } from '../config/taskConfig.js';

const STAMP = Date.now();
const PROJ_NAME = `bulk-large-${STAMP}`;
let projectId: string;
const N = 90; // the "fails at ~92" regression vector — comfortably > the old cap of 50
let ids: string[] = [];

async function viaPublicTool(toolName: string, rawArgs: any): Promise<any> {
  const validated = validateToolArguments(toolName, rawArgs);
  return routeExecutor(toolName, validated);
}

describe('task_bulk_update large payload + honest response', () => {
  beforeAll(async () => {
    projectId = (
      await db.query(`INSERT INTO projects (name, description) VALUES ($1, 'bulk large fuse') RETURNING id`, [PROJ_NAME])
    ).rows[0].id;
    const res = await db.query(
      `INSERT INTO tasks (project_id, title, type, priority, status)
       SELECT $1, 'bulk-' || g, 'general', 'medium', 'todo'
       FROM generate_series(1, $2) g
       RETURNING id`,
      [projectId, N]
    );
    ids = res.rows.map((r) => r.id);
  });

  afterAll(async () => {
    await db.query(`DELETE FROM tasks WHERE project_id = $1`, [projectId]);
    await db.query(`DELETE FROM projects WHERE id = $1`, [projectId]);
  });

  test('config: the cap is generous enough for a real sweep (>= 90)', () => {
    expect(TASK_BULK_MAX_IDS).toBeGreaterThanOrEqual(90);
  });

  test('90-id bulk update SUCCEEDS with a truthful full count object (not null / no-op)', async () => {
    const resp = await viaPublicTool('task_bulk_update', {
      projectId, task_ids: ids, status: 'completed',
    });
    const sc = resp.structuredContent;
    expect(resp.isError).toBeFalsy();
    // The full honest shape — never an empty no-op.
    expect(sc.totalRequested).toBe(N);
    expect(sc.successfullyUpdated).toBe(N);
    expect(sc.failed).toBe(0);
    expect(Array.isArray(sc.updatedTaskIds)).toBe(true);
    expect(sc.updatedTaskIds.length).toBe(N);

    // And it actually changed status on all 90 rows (no silent no-op).
    const done = await db.query(
      `SELECT count(*)::int AS c FROM tasks WHERE project_id = $1 AND status = 'completed'`,
      [projectId]
    );
    expect(done.rows[0].c).toBe(N);
  });

  test('no-match bulk update returns a TRUTHFUL failure, never a silent empty', async () => {
    const fakeIds = Array.from({ length: 5 }, () => randomUUID());
    const resp = await viaPublicTool('task_bulk_update', {
      projectId, task_ids: fakeIds, status: 'completed',
    });
    // All-or-nothing transaction: an id that matches no row aborts with an honest error
    // (isError + a truthful requested count) — not an empty success.
    expect(resp.isError).toBe(true);
    expect(resp.structuredContent.ok).toBe(false);
    expect(resp.structuredContent.error ?? '').toContain('not found');
  });

  test('exceeding the cap fails with a CLEAR error (not a silent null)', () => {
    const tooMany = Array.from({ length: TASK_BULK_MAX_IDS + 1 }, () => randomUUID());
    expect(() =>
      validateToolArguments('task_bulk_update', { projectId, task_ids: tooMany, status: 'completed' })
    ).toThrow(/too big|maximum/i);
  });
});
