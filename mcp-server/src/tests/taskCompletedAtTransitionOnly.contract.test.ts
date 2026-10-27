/**
 * `completed_at` STAMPS ON THE TRANSITION ONLY — Contract Test
 * (migration 099).
 *
 * ═══ THE DEFECT THIS LOCKS SHUT ═══
 * Migration 094's trigger keyed on "does this row END UP completed with no stamp", which is
 * true of every unrelated UPDATE to a legacy unstamped row — so a retitle of one of the 208
 * pre-094 completed rows stamped it with the retitle's date. And 094's NOT VALID CHECK made
 * that mandatory: with the trigger off, the same retitle fails 23514. Migration 098 measured
 * exactly this on its own first cut for `closed_at` and fixed itself (its F4 test is the
 * template for this file); 099 applies the same fix to `completed_at`.
 *
 * ═══ WHY THE LOAD-BEARING ASSERTION IS "STAYS NULL" ═══
 * "Completing a task sets a timestamp" passes against the 094 body and proves nothing. The
 * assertion that FAILS on the pre-099 tree is: a completed row with NO stamp, given
 * unrelated edits, is STILL unstamped afterwards. That is the one that keeps a NULL (visibly
 * missing) from becoming a plausible date (silently believed).
 *
 * Unrelated edits are driven through the SAME public path the bridge uses (validate →
 * routeExecutor); the seeded legacy shape and the raw-SQL cases use SQL, because the trigger
 * exists precisely for writers that bypass the application layer.
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { db } from '../config/database.js';
import { validateToolArguments } from '../middleware/validation.js';
import { routeExecutor } from '../routes/index.js';

const STAMP = Date.now();
const PROJ_NAME = `completed-at-transition-only-${STAMP}`;
/** Backdated far enough that no clock skew can reproduce it. */
const SENTINEL = '2019-03-04T05:06:07.890Z';
let projectId: string;

/** FAIL LOUD on a tool error — a silently failing call leaves the row unchanged and every
 *  "stayed NULL" assertion below would pass for the wrong reason. */
async function viaPublicTool(toolName: string, rawArgs: any): Promise<any> {
  const res = await routeExecutor(toolName, validateToolArguments(toolName, rawArgs));
  if (res?.isError) {
    throw new Error(`${toolName} FAILED: ${res.content?.[0]?.text ?? JSON.stringify(res)}`);
  }
  return res;
}

async function makeTask(status: string): Promise<string> {
  const r = await db.query(
    `INSERT INTO tasks (project_id, title, type, priority, status)
     VALUES ($1, 'completed_at transition-only fuse', 'general', 'medium', $2) RETURNING id`,
    [projectId, status],
  );
  return r.rows[0].id;
}

async function readRow(id: string) {
  const r = await db.query(`SELECT status, completed_at FROM tasks WHERE id = $1`, [id]);
  return r.rows[0] as { status: string; completed_at: Date | null };
}

/**
 * Seed THE LEGACY SHAPE: status=completed, completed_at NULL. Possible with only the trigger
 * off BECAUSE 099 dropped the CHECK — under 094 this UPDATE failed 23514, which is itself the
 * proof that the constraint made the honest state unrepresentable.
 */
async function makeLegacyUnstampedCompleted(): Promise<string> {
  const id = await makeTask('todo');
  await db.query(`ALTER TABLE tasks DISABLE TRIGGER trg_tasks_completed_at_stamp`);
  try {
    await db.query(`UPDATE tasks SET status = 'completed', completed_at = NULL WHERE id = $1`, [id]);
  } finally {
    await db.query(`ALTER TABLE tasks ENABLE TRIGGER trg_tasks_completed_at_stamp`);
  }
  // POSITIVE CONTROL on the fixture: it really is in the legacy state.
  const row = await readRow(id);
  expect(row.status).toBe('completed');
  expect(row.completed_at).toBeNull();
  return id;
}

beforeAll(async () => {
  const p = await db.query(
    `INSERT INTO projects (name, description) VALUES ($1, 'completed_at transition-only contract') RETURNING id`,
    [PROJ_NAME]);
  projectId = p.rows[0].id;
});

afterAll(async () => {
  await db.query(`DELETE FROM tasks WHERE project_id = $1`, [projectId]);
  await db.query(`DELETE FROM projects WHERE id = $1`, [projectId]);
});

describe('(a) A LEGACY UNSTAMPED COMPLETED ROW STAYS NULL through unrelated updates', () => {
  test('public-tool edits (priority, title) do not fabricate a completion date', async () => {
    const id = await makeLegacyUnstampedCompleted();

    await viaPublicTool('task_update', { projectId, taskId: id, priority: 'low' });
    expect((await readRow(id)).completed_at, 'a priority edit fabricated a completion date').toBeNull();

    await viaPublicTool('task_update', { projectId, taskId: id, title: 'retitled' });
    expect((await readRow(id)).completed_at, 'a retitle fabricated a completion date').toBeNull();
  });

  test('a raw-SQL unrelated UPDATE (the writer the CHECK used to reject) succeeds and does not stamp', async () => {
    const id = await makeLegacyUnstampedCompleted();
    // Under 094 this statement had exactly two reachable outcomes: fabricate, or fail 23514.
    await db.query(`UPDATE tasks SET description = 'note appended' WHERE id = $1`, [id]);
    expect((await readRow(id)).completed_at, 'a raw-SQL note append fabricated a completion date').toBeNull();
  });

  test('a raw-SQL re-assert of status=completed is not a transition and does not stamp', async () => {
    const id = await makeLegacyUnstampedCompleted();
    await db.query(`UPDATE tasks SET status = 'completed' WHERE id = $1`, [id]);
    expect((await readRow(id)).completed_at, 're-asserting completed fabricated a completion date').toBeNull();
  });
});

describe('(a2) A RE-ASSERT through the PUBLIC TOOLS does not stamp (the app path, not just the trigger)', () => {
  test('task_update{status:completed} on a legacy NULL row stays NULL', async () => {
    const id = await makeLegacyUnstampedCompleted();
    await viaPublicTool('task_update', { projectId, taskId: id, status: 'completed' });
    expect((await readRow(id)).completed_at, 'task_update re-assert fabricated a completion date').toBeNull();
  });

  test('task_bulk_update{status:completed} over a legacy NULL row stays NULL', async () => {
    const id = await makeLegacyUnstampedCompleted();
    await viaPublicTool('task_bulk_update', { projectId, task_ids: [id], status: 'completed' });
    expect((await readRow(id)).completed_at, 'task_bulk_update re-assert fabricated a completion date').toBeNull();
  });

  test('completed -> todo through the public tool CLEARS the stamp (trigger owns the out-transition too)', async () => {
    const id = await makeTask('todo');
    await viaPublicTool('task_update', { projectId, taskId: id, status: 'completed' });
    expect((await readRow(id)).completed_at).not.toBeNull();
    await viaPublicTool('task_update', { projectId, taskId: id, status: 'todo' });
    expect((await readRow(id)).completed_at).toBeNull();
  });
});

describe('(b) A GENUINE TRANSITION still stamps', () => {
  test('todo -> completed through the public tool stamps', async () => {
    const id = await makeTask('todo');
    await viaPublicTool('task_update', { projectId, taskId: id, status: 'completed' });
    expect((await readRow(id)).completed_at).not.toBeNull();
  });

  test('todo -> completed through raw SQL (no application layer) stamps', async () => {
    const id = await makeTask('todo');
    await db.query(`UPDATE tasks SET status = 'completed' WHERE id = $1`, [id]);
    expect((await readRow(id)).completed_at).not.toBeNull();
  });

  test('a row born completed via raw INSERT is stamped', async () => {
    const id = await makeTask('completed');
    expect((await readRow(id)).completed_at).not.toBeNull();
  });

  test('a legacy unstamped row that genuinely REOPENS and RECOMPLETES is stamped at the recompletion', async () => {
    // The honest counterpart to (a): we still do not know when it first completed, but we
    // DID observe the second completion, so recording that invents nothing.
    const id = await makeLegacyUnstampedCompleted();
    await viaPublicTool('task_update', { projectId, taskId: id, status: 'in_progress' });
    expect((await readRow(id)).completed_at).toBeNull();
    await viaPublicTool('task_update', { projectId, taskId: id, status: 'completed' });
    expect((await readRow(id)).completed_at).not.toBeNull();
  });
});

describe('the rest of the 094 state machine survives the rewrite', () => {
  test('a re-save of a STAMPED completed row leaves the stamp unchanged', async () => {
    const id = await makeTask('todo');
    await viaPublicTool('task_update', { projectId, taskId: id, status: 'completed' });
    await db.query(`UPDATE tasks SET completed_at = $2::timestamptz WHERE id = $1`, [id, SENTINEL]);
    await viaPublicTool('task_update', { projectId, taskId: id, priority: 'low' });
    expect(new Date((await readRow(id)).completed_at!).toISOString()).toBe(SENTINEL);
    await db.query(`UPDATE tasks SET status = 'completed' WHERE id = $1`, [id]);
    expect(new Date((await readRow(id)).completed_at!).toISOString()).toBe(SENTINEL);
  });

  test('a transition OUT of completed clears the stamp', async () => {
    const id = await makeTask('completed');
    expect((await readRow(id)).completed_at).not.toBeNull();
    await db.query(`UPDATE tasks SET status = 'in_progress' WHERE id = $1`, [id]);
    expect((await readRow(id)).completed_at).toBeNull();
  });

  test('an explicit correction to NULL on a completed row is HONORED (a repair can un-stamp)', async () => {
    // 094 recovered OLD.completed_at over a supplied NULL, which silently defeated repair —
    // the 098 finding. A supplied NULL is "we do not know", and the trigger must not answer
    // that with either the old value or "now".
    const id = await makeTask('completed');
    await db.query(`UPDATE tasks SET completed_at = NULL WHERE id = $1`, [id]);
    expect((await readRow(id)).completed_at).toBeNull();
  });

  test('there is NO CHECK constraint on completed_at — its absence is load-bearing', async () => {
    // Re-adding it would silently restore the fabrication: a CHECK has no OLD, so it cannot
    // tell a legacy row from a new violation. See migration 099 and 098 PART 1d.
    const { rows } = await db.query(
      `SELECT count(*)::int n FROM pg_constraint WHERE conname = 'tasks_completed_needs_stamp'`);
    expect(rows[0].n).toBe(0);
  });
});
