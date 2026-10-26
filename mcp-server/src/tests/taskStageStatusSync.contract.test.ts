/**
 * `tasks.stage` <-> `tasks.status` SYNC Contract Test (migration 101, 
 * Punch List lane A).
 *
 * Asserts the trigger's four required cases, plus the FIRING-ORDER property this migration's
 * header claims: a stage='merged' write must stamp `closed_at` AND `completed_at` in the SAME
 * statement, which only happens if migrations 098/099's triggers see the FINAL status this
 * trigger computed — i.e. tasks_stage_status_sync genuinely runs BEFORE them, not merely that
 * the two migrations' triggers happen to agree by luck.
 *
 * Extended for migration 103: 101 minted `blocked` into
 * stage `ready` (a NON-pickable row landing in the picker's pick lane) at two sites — the
 * one-time backfill and rule (a)'s bare-INSERT branch — and left stage untouched when a task
 * was cancelled, contradicting its own column comment ("or NULL for a cancelled task"). 103
 * fixes both mint sites to target `draft`, makes a cancel ALWAYS null the stage, backfills the
 * rows 101 already polluted, and preserves the blocked/claimed carve-out. The cases below pin:
 * the new mint target (never `ready`), the cancel-nulls-stage fix at both the SQL and TOOL
 * surface, the carve-out control (blocking a claimed task must still resume at `claimed`), and
 * the data migration.
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { db } from '../config/database.js';
import { tasksRoutes } from '../routes/tasks.routes.js';
import { validateToolArguments } from '../middleware/validation.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// src/tests/ -> mcp-server/database/migrations/103_stage_never_mints_ready_for_blocked.sql
// Read (not re-typed) so the mutation probe "delete the data migration -> (7) goes RED"
// actually exercises the shipped file, not a hand-copied restatement of it.
const MIGRATION_103 = resolve(
  __dirname, '../../database/migrations/103_stage_never_mints_ready_for_blocked.sql',
);
const MIGRATION_103_SQL = readFileSync(MIGRATION_103, 'utf8');
// Migration 107: todo derives draft, not ready. Same read-from-disk rule.
const MIGRATION_107 = resolve(
  __dirname, '../../database/migrations/107_todo_derives_draft_not_ready.sql',
);
const MIGRATION_107_SQL = readFileSync(MIGRATION_107, 'utf8');

const STAMP = Date.now();
const PROJ_NAME = `task-stage-sync-${STAMP}`;
let projectId: string;

async function viaPublicTool(toolName: string, rawArgs: any, handler: (a: any) => Promise<any>) {
  const validated = validateToolArguments(toolName, rawArgs);
  return handler(validated);
}

/** ids returned by task_list, at the TOOL surface (validate -> handleList). */
async function listReadyIds(pid: string): Promise<string[]> {
  const resp: any = await viaPublicTool(
    'task_list', { projectId: pid, stage: 'ready', limit: 100 },
    (a) => tasksRoutes.handleList(a),
  );
  return (resp?.structuredContent?.results ?? []).map((r: any) => r.id);
}

async function makeTask(status: string, stage?: string): Promise<string> {
  const cols = ['project_id', 'title', 'type', 'priority', 'status'];
  const vals: any[] = [projectId, 'stage sync fuse', 'general', 'medium', status];
  if (stage !== undefined) { cols.push('stage'); vals.push(stage); }
  const placeholders = vals.map((_, i) => `$${i + 1}`).join(', ');
  const res = await db.query(
    `INSERT INTO tasks (${cols.join(', ')}) VALUES (${placeholders}) RETURNING id`,
    vals,
  );
  return res.rows[0].id;
}

async function readRow(id: string) {
  const r = await db.query(
    `SELECT stage, status, closed_at, completed_at FROM tasks WHERE id = $1`, [id]);
  return r.rows[0] as {
    stage: string | null; status: string;
    closed_at: Date | null; completed_at: Date | null;
  };
}

beforeAll(async () => {
  const p = await db.query(
    `INSERT INTO projects (name, description) VALUES ($1, 'stage sync contract') RETURNING id`,
    [PROJ_NAME]);
  projectId = p.rows[0].id;
  // Install migration 107's trigger body (idempotent CREATE OR REPLACE) so the suite measures
  // the shipped file even on a DB that has not yet had it applied.
  await db.query(MIGRATION_107_SQL);
});

afterAll(async () => {
  await db.query(`DELETE FROM tasks WHERE project_id = $1`, [projectId]);
  await db.query(`DELETE FROM projects WHERE id = $1`, [projectId]);
});

describe('migration 101 — tasks_stage_status_sync', () => {
  test('CASE 1: stage=merged sets status=completed AND closed_at (firing-order proof)', async () => {
    const id = await makeTask('todo');
    await db.query(`UPDATE tasks SET stage = 'merged' WHERE id = $1`, [id]);
    const row = await readRow(id);
    expect(row.stage).toBe('merged');
    expect(row.status).toBe('completed');
    // Only true if 098's trigger saw the FINAL status this trigger computed — a fire-order
    // regression (e.g. renaming this trigger to carry a `trg_` prefix) would leave these NULL.
    expect(row.closed_at).not.toBeNull();
    expect(row.completed_at).not.toBeNull();
  });

  test('CASE 2: status=completed (legacy writer) sets stage=merged', async () => {
    const id = await makeTask('todo');
    await db.query(`UPDATE tasks SET status = 'completed' WHERE id = $1`, [id]);
    const row = await readRow(id);
    expect(row.stage).toBe('merged');
    expect(row.status).toBe('completed');
  });

  test('CASE 3: status=blocked preserves stage', async () => {
    const id = await makeTask('in_progress', 'claimed');
    await db.query(`UPDATE tasks SET status = 'blocked' WHERE id = $1`, [id]);
    const row = await readRow(id);
    expect(row.stage).toBe('claimed'); // untouched by the override status
    expect(row.status).toBe('blocked'); // honored verbatim
  });

  test('CASE 4: clearing a block with status=todo derives draft (migration 107), not ready', async () => {
    const id = await makeTask('in_progress', 'claimed');
    await db.query(`UPDATE tasks SET status = 'blocked' WHERE id = $1`, [id]);
    expect((await readRow(id)).stage).toBe('claimed');
    // Clearing the block via an explicit status write is a legacy status-only write (rule c):
    // stage is derived from the NEW status.
    await db.query(`UPDATE tasks SET status = 'todo' WHERE id = $1`, [id]);
    const row = await readRow(id);
    expect(row.stage).toBe('draft');
    expect(row.status).toBe('todo');
  });

  test('INSERT with neither stage nor status derives stage=draft for status=todo (rule d, migration 107)', async () => {
    const id = await makeTask('todo');
    const row = await readRow(id);
    expect(row.stage).toBe('draft');
    expect(row.status).toBe('todo');
  });

  test('INSERT born completed derives stage=merged', async () => {
    const id = await makeTask('completed');
    const row = await readRow(id);
    expect(row.stage).toBe('merged');
    expect(row.status).toBe('completed');
  });

  test('INSERT with an explicit stage overrides the derived status', async () => {
    const id = await makeTask('todo', 'claimed');
    const row = await readRow(id);
    expect(row.stage).toBe('claimed');
    expect(row.status).toBe('in_progress');
  });

  test('status=cancelled ALWAYS clears stage to NULL (migration 103)', async () => {
    const id = await makeTask('todo');
    await db.query(`UPDATE tasks SET status = 'cancelled' WHERE id = $1`, [id]);
    const row = await readRow(id);
    expect(row.status).toBe('cancelled');
    // Pre-103, rule (a)'s carve-out left stage untouched on this UPDATE (this row had
    // stage='ready' from its INSERT default and would have stayed 'ready') — contradicting
    // the column's own comment ("or NULL for a cancelled task"). 103 makes cancel always null
    // the stage, on INSERT or UPDATE alike, matching that documented contract.
    expect(row.stage).toBeNull();
  });

  test('stage wins when BOTH stage and status are supplied in the same UPDATE', async () => {
    const id = await makeTask('todo');
    await db.query(`UPDATE tasks SET stage = 'evidence', status = 'todo' WHERE id = $1`, [id]);
    const row = await readRow(id);
    expect(row.stage).toBe('evidence');
    expect(row.status).toBe('in_progress'); // derived from stage, NOT the supplied 'todo'
  });

  test('a re-save that touches neither stage nor status leaves both untouched', async () => {
    const id = await makeTask('todo', 'draft');
    await db.query(`UPDATE tasks SET priority = 'high' WHERE id = $1`, [id]);
    const row = await readRow(id);
    expect(row.stage).toBe('draft');
    expect(row.status).toBe('todo');
  });
});

describe('migration 103 — blocked never mints ready; cancel clears stage', () => {
  const PROJ_NAME_2 = `task-stage-sync-b-${STAMP}`;
  let projectId2: string;

  async function makeTaskIn(pid: string, status: string, stage?: string): Promise<string> {
    const cols = ['project_id', 'title', 'type', 'priority', 'status'];
    const vals: any[] = [pid, 'stage sync fuse (103)', 'general', 'medium', status];
    if (stage !== undefined) { cols.push('stage'); vals.push(stage); }
    const placeholders = vals.map((_, i) => `$${i + 1}`).join(', ');
    const res = await db.query(
      `INSERT INTO tasks (${cols.join(', ')}) VALUES (${placeholders}) RETURNING id`,
      vals,
    );
    return res.rows[0].id;
  }

  beforeAll(async () => {
    const p = await db.query(
      `INSERT INTO projects (name, description) VALUES ($1, 'stage sync contract, second project') RETURNING id`,
      [PROJ_NAME_2]);
    projectId2 = p.rows[0].id;
  });

  afterAll(async () => {
    await db.query(`DELETE FROM tasks WHERE project_id = $1`, [projectId2]);
    await db.query(`DELETE FROM projects WHERE id = $1`, [projectId2]);
  });

  // ── (1) A blocked row's stage is never MINTED as `ready` ──────────────────────────────
  test('(1) INSERT status=blocked with no stage mints draft, NOT ready', async () => {
    const id = await makeTask('blocked');
    const row = await readRow(id);
    expect(row.stage).toBe('draft');
    expect(row.stage).not.toBe('ready');
    expect(row.status).toBe('blocked');
  });

  // ── (2) cancel clears stage ────────────────────────────────────────────────────────────
  test('(2) UPDATE to status=cancelled from stage=ready sets stage NULL, status stays cancelled', async () => {
    const id = await makeTask('todo', 'ready');
    await db.query(`UPDATE tasks SET status = 'cancelled' WHERE id = $1`, [id]);
    const row = await readRow(id);
    expect(row.stage).toBeNull();
    expect(row.status).toBe('cancelled');
  });

  // ── (3) tool-surface proof: cancelled never shows up under stage=ready ────────────────
  test('(3) task_list stage=ready does NOT return a cancelled row (tool surface)', async () => {
    const id = await makeTask('todo', 'ready');
    expect(await listReadyIds(projectId)).toContain(id);
    await db.query(`UPDATE tasks SET status = 'cancelled' WHERE id = $1`, [id]);
    const ids = await listReadyIds(projectId);
    expect(ids).not.toContain(id);
  });

  // ── (4) THE PICKER-FACING ASSERTION — a blocked task never surfaces as pickable ───────
  test('(4) task_list stage=ready does NOT return a blocked task, in any project', async () => {
    const idA = await makeTask('blocked');
    const idB = await makeTaskIn(projectId2, 'blocked');
    const idsA = await listReadyIds(projectId);
    const idsB = await listReadyIds(projectId2);
    expect(idsA).not.toContain(idA);
    expect(idsB).not.toContain(idB);
  });

  // ── (5) THE CARVE-OUT CONTROL ──────────────────────────────────────────────────────────
  test('(5) blocking a claimed task keeps stage=claimed; unblocking resumes at claimed, not ready', async () => {
    const id = await makeTask('in_progress', 'claimed');
    await db.query(`UPDATE tasks SET status = 'blocked' WHERE id = $1`, [id]);
    const blockedRow = await readRow(id);
    expect(blockedRow.stage).toBe('claimed'); // carve-out: untouched by the override status
    expect(blockedRow.status).toBe('blocked');

    await db.query(`UPDATE tasks SET status = 'in_progress' WHERE id = $1`, [id]);
    const resumedRow = await readRow(id);
    expect(resumedRow.stage).toBe('claimed');
    expect(resumedRow.stage).not.toBe('ready');
    expect(resumedRow.status).toBe('in_progress');
  });

  // ── (7) BACKFILL ────────────────────────────────────────────────────────────────────────
  test('(7) backfill moves every stage=ready/status=blocked row to draft, and nothing else', async () => {
    // Seed the polluted signature directly (bypasses the mint path via an explicit UPDATE,
    // which rule (a)'s carve-out still honors verbatim on an UPDATE — see case (5) above).
    const polluted1 = await makeTask('todo', 'ready');
    await db.query(`UPDATE tasks SET status = 'blocked', stage = 'ready' WHERE id = $1`, [polluted1]);
    const polluted2 = await makeTask('todo', 'ready');
    await db.query(`UPDATE tasks SET status = 'blocked', stage = 'ready' WHERE id = $1`, [polluted2]);
    expect((await readRow(polluted1)).stage).toBe('ready');
    expect((await readRow(polluted2)).stage).toBe('ready');

    // Controls: rows in OTHER (stage, status) pairs that must NOT be touched by the backfill.
    const controlClaimed = await makeTask('in_progress', 'claimed');
    const controlDraftBlocked = await makeTask('blocked'); // already draft via the mint fix
    const controlReadyTodo = await makeTask('todo', 'ready');

    const before = await db.query(
      `SELECT count(*)::int AS n FROM tasks WHERE stage = 'ready' AND status = 'blocked'`,
    );
    expect(before.rows[0].n).toBeGreaterThanOrEqual(2);

    // Execute the ACTUAL migration 103 FILE (read from disk above, byte-for-byte what
    // migrate.ts runs via `db.query(migration.content)`) — NOT a hand-typed restatement of
    // its SQL. A mutant that deletes migration 103's PART 1 data migration changes what this
    // call executes, so the assertions below go RED for that mutant; a restated UPDATE
    // (the prior version of this test) would stay GREEN regardless of what the shipped file
    // contains, which is exactly the hollowness the walkthrough critic flagged.
    await db.query(MIGRATION_103_SQL);

    const after = await db.query(
      `SELECT count(*)::int AS n FROM tasks WHERE stage = 'ready' AND status = 'blocked'`,
    );
    expect(after.rows[0].n).toBe(0);

    expect((await readRow(polluted1)).stage).toBe('draft');
    expect((await readRow(polluted2)).stage).toBe('draft');
    expect((await readRow(controlClaimed)).stage).toBe('claimed');
    expect((await readRow(controlDraftBlocked)).stage).toBe('draft');
    expect((await readRow(controlReadyTodo)).stage).toBe('ready');
  });
});

describe('migration 107 — a stage derived from status=todo is draft, never ready', () => {
  const COMPLETE_PUNCH = {
    doneWhen: [{ text: 'it works', owner: 'lane', proof: 'a test' }],
    proofKind: 'test',
  };

  // The 103 describe above re-runs migration 103's file, which restores 103's trigger body
  // (todo->ready). Re-apply 107 on top, exactly as the migration runner orders them.
  beforeAll(async () => { await db.query(MIGRATION_107_SQL); });

  async function createViaTool(args: Record<string, unknown>) {
    return viaPublicTool(
      'task_create', { projectId, title: 'an earlier change create', ...args },
      (a) => tasksRoutes.handleCreate(a),
    );
  }

  // ── (1) create with no stage, no status ───────────────────────────────────────────────
  test('(1) task_create with NO stage and NO status is stored at stage=draft, status=todo', async () => {
    const resp: any = await createViaTool({});
    const id = resp.structuredContent?.task?.id as string;
    expect(id).toBeTruthy();
    const row = await readRow(id);
    expect(row.stage).toBe('draft');
    expect(row.stage).not.toBe('ready');
    expect(row.status).toBe('todo');
    expect(await listReadyIds(projectId)).not.toContain(id);
  });

  // ── (2) reopen ─────────────────────────────────────────────────────────────────────────
  test('(2) status-only todo on a merged task reopens to draft; in_progress/completed keep their mapping', async () => {
    const id = await makeTask('todo', 'merged');
    expect((await readRow(id)).status).toBe('completed');
    await db.query(`UPDATE tasks SET status = 'todo' WHERE id = $1`, [id]);
    let row = await readRow(id);
    expect(row.stage).toBe('draft');
    expect(row.status).toBe('todo');

    await db.query(`UPDATE tasks SET status = 'in_progress' WHERE id = $1`, [id]);
    row = await readRow(id);
    expect(row.stage).toBe('claimed');
    expect(row.status).toBe('in_progress');

    await db.query(`UPDATE tasks SET status = 'completed' WHERE id = $1`, [id]);
    row = await readRow(id);
    expect(row.stage).toBe('merged');
    expect(row.status).toBe('completed');
  });

  // ── (3) controls ───────────────────────────────────────────────────────────────────────
  test('(3a) control: stage=ready with a missing punch is still refused PUNCH_INCOMPLETE and writes nothing', async () => {
    const title = `an earlier change refused ${STAMP}`;
    const resp: any = await createViaTool({ title, stage: 'ready' });
    expect(resp.isError).toBe(true);
    expect(resp.structuredContent?.code).toBe('PUNCH_INCOMPLETE');
    const n = await db.query(
      `SELECT count(*)::int AS n FROM tasks WHERE project_id = $1 AND title = $2`, [projectId, title]);
    expect(n.rows[0].n).toBe(0);
  });

  test('(3b) control: stage=ready with a complete punch lands at stage=ready, status=todo', async () => {
    const resp: any = await createViaTool({ stage: 'ready', metadata: { punch: COMPLETE_PUNCH } });
    const id = resp.structuredContent?.task?.id as string;
    const row = await readRow(id);
    expect(row.stage).toBe('ready');
    expect(row.status).toBe('todo');
  });

  // ── (4) data repair ────────────────────────────────────────────────────────────────────
  test('(4) migration 107 moves ready rows lacking doneWhen to draft, spares those with it, and is idempotent', async () => {
    const insertReady = async (metadata: unknown) => (await db.query(
      `INSERT INTO tasks (project_id, title, type, priority, status, stage, metadata)
       VALUES ($1, 'repair seed', 'general', 'medium', 'todo', 'ready', $2::jsonb) RETURNING id`,
      [projectId, JSON.stringify(metadata)])).rows[0].id as string;

    const noPunch = await insertReady({});
    const punchNoDone = await insertReady({ punch: { proofKind: 'test' } });
    const complete = await insertReady({ punch: COMPLETE_PUNCH });
    const claimed = await makeTask('in_progress', 'claimed');
    for (const id of [noPunch, punchNoDone, complete]) expect((await readRow(id)).stage).toBe('ready');

    await db.query(MIGRATION_107_SQL);
    expect((await readRow(noPunch)).stage).toBe('draft');
    expect((await readRow(punchNoDone)).stage).toBe('draft');
    expect((await readRow(complete)).stage).toBe('ready');
    expect((await readRow(claimed)).stage).toBe('claimed');

    // Second run: nothing left matching the signature, so the repair UPDATE moves 0 rows.
    const left = await db.query(
      `SELECT count(*)::int AS n FROM tasks
        WHERE stage = 'ready' AND (metadata #>> '{punch,doneWhen}') IS NULL`);
    expect(left.rows[0].n).toBe(0);
    await db.query(MIGRATION_107_SQL);
    expect((await readRow(noPunch)).stage).toBe('draft');
    expect((await readRow(complete)).stage).toBe('ready');
  });
});
