/**
 * completedAtUnforgettable.db.test.ts — `tasks.completed_at` cannot be forgotten
 * (migration 094) and cannot be FABRICATED ( * migration 099).
 *
 * THE DEFECT THIS GUARDS
 *   The completion-stamp rule lived ONLY in application code, in TWO codebases and four
 *   call sites (services/task.ts single + bulk, handlers/tasks.ts single + bulk). The
 *   database enforced nothing: `completed_at` was a plain nullable column with no default,
 *   no trigger, and the only CHECK on `tasks` was `tasks_progress_check`. Any other writer
 *   — a migration, a repair script, a new service, an operator's psql session — silently
 *   produced `status='completed'` with no completion time. That state is permanently
 *   unrecoverable: the moment is gone.
 *
 * WHY THESE TESTS HAVE TEETH (C3)
 *   The whole point of moving the rule down a layer is that it holds against callers that
 *   do not go through either application layer. So the primary cases here drive RAW SQL —
 *   `UPDATE tasks SET status='completed'` with no `completed_at` in sight — and read the
 *   row back with raw SQL. Application-layer cases are included too, but they are the
 *   WEAKER evidence: they would pass on the pre-migration schema.
 *
 *   Every case is preceded by a positive control on the row's pre-state, so a green can
 *   never come from an absent row or a fixture that was already stamped.
 *
 *   THERE IS NO CHECK BACKSTOP ANY MORE, AND ITS ABSENCE IS ASSERTED. 094 paired the trigger
 *   with `tasks_completed_needs_stamp` NOT VALID; migration 099 dropped it, because a CHECK
 *   has no OLD and so cannot tell a legacy unstamped row from a new violation — every
 *   unrelated UPDATE to one of the 208 legacy rows had to either fabricate a stamp (the 094
 *   trigger body) or fail 23514 (trigger off). The trigger is now transition-only, and the
 *   legacy-row case below asserts the row STAYS NULL through unrelated edits.
 *
 * RUN (throwaway DB — provision FIRST; --runInBand, the backend suites cross-contaminate
 * under parallel run):
 *   bash scripts/provision-test-db.sh ci_b1_dataloss
 *   eval "$(bash scripts/provision-test-db.sh ci_b1_dataloss --print-env)"
 *   npx jest completedAtUnforgettable --runInBand --forceExit
 *   bash scripts/provision-test-db.sh ci_b1_dataloss --drop
 */

import { v4 as uuidv4 } from 'uuid';

import { db } from '../database/connection';
import { TaskService } from '../services/task';
import { describeDb } from './helpers/dbContractGate';

describeDb('tasks.completed_at is UNFORGETTABLE — trigger + CHECK', () => {
  let projectId: string;
  const createdTaskIds: string[] = [];

  /** Insert a task with raw SQL. `completedAt` is passed straight through to the column. */
  async function seedTask(opts: {
    status?: string;
    completedAt?: string | null;
    triggerDisabled?: boolean;
  } = {}): Promise<string> {
    const id = uuidv4();
    createdTaskIds.push(id);
    await db.query(
      `INSERT INTO tasks (id, project_id, title, description, type, status, priority, completed_at)
       VALUES ($1, $2, $3, 'seeded by completedAtUnforgettable.db.test', 'general', $4, 'medium', $5::timestamptz)`,
      [id, projectId, `probe ${id.slice(0, 8)}`, opts.status ?? 'todo', opts.completedAt ?? null],
    );
    return id;
  }

  /** Raw read — the real observable. The product code does not share this query. */
  async function rawRow(id: string): Promise<{ status: string; completedAt: Date | null } | null> {
    const res = await db.query('SELECT status, completed_at FROM tasks WHERE id = $1', [id]);
    if (res.rows.length === 0) return null;
    return { status: res.rows[0].status, completedAt: res.rows[0].completed_at };
  }

  /** Run `fn` with the auto-stamp trigger switched off, then switch it back on. */
  async function withTriggerDisabled<T>(fn: () => Promise<T>): Promise<T> {
    await db.query('ALTER TABLE tasks DISABLE TRIGGER trg_tasks_completed_at_stamp');
    try {
      return await fn();
    } finally {
      await db.query('ALTER TABLE tasks ENABLE TRIGGER trg_tasks_completed_at_stamp');
    }
  }

  /**
   * Reproduce a row that PREDATES the rule — the shape of the 208 legacy rows on prod.
   * Since migration 099 dropped the CHECK, switching the trigger off is sufficient; this is
   * the same thing the shared legacyUnstampedTask helper does.
   */
  const withLegacyRowsPossible = withTriggerDisabled;

  beforeAll(async () => {
    projectId = uuidv4();
    await db.query(
      `INSERT INTO projects (id, name, description, status, created_at)
       VALUES ($1, $2, 'completedAtUnforgettable fixture', 'active', NOW())`,
      [projectId, `32e6f00d-${projectId.slice(0, 8)}`],
    );
  });

  afterAll(async () => {
    if (createdTaskIds.length) {
      await db.query('DELETE FROM tasks WHERE id = ANY($1::uuid[])', [createdTaskIds]);
    }
    await db.query('DELETE FROM projects WHERE id = $1', [projectId]);
    await db.end();
  });

  // ──────────────────────────────────────────────────────────────────────────────
  // THE SCHEMA OBJECTS EXIST AT ALL — if these fail, every case below is vacuous
  // ──────────────────────────────────────────────────────────────────────────────

  it('the trigger is installed, and the 094 CHECK is ABSENT (dropped by migration 099)', async () => {
    const trg = await db.query(
      `SELECT tgname, tgenabled FROM pg_trigger
        WHERE tgrelid = 'tasks'::regclass AND tgname = 'trg_tasks_completed_at_stamp'`,
    );
    expect(trg.rows.length).toBe(1);
    expect(trg.rows[0].tgenabled).toBe('O'); // enabled for origin (normal) writes

    // The absence is load-bearing: re-adding the CHECK, even NOT VALID, would silently
    // restore the fabrication the legacy-row case below guards against.
    const con = await db.query(
      `SELECT 1 FROM pg_constraint
        WHERE conrelid = 'tasks'::regclass AND conname = 'tasks_completed_needs_stamp'`,
    );
    expect(con.rows.length).toBe(0);
  });

  // ──────────────────────────────────────────────────────────────────────────────
  // RAW SQL — the writer that bypasses BOTH application layers. This is the point.
  // ──────────────────────────────────────────────────────────────────────────────

  it('a raw-SQL UPDATE to completed, with no completed_at, comes out STAMPED', async () => {
    const id = await seedTask({ status: 'todo' });

    // POSITIVE CONTROL: unstamped and not completed before we touch it.
    const before = await rawRow(id);
    expect(before).toEqual({ status: 'todo', completedAt: null });

    // No mention of completed_at anywhere in this statement. On the pre-migration schema
    // the row would now be `completed` with a NULL stamp, forever.
    await db.query(`UPDATE tasks SET status = 'completed' WHERE id = $1`, [id]);

    const after = await rawRow(id);
    expect(after!.status).toBe('completed');
    expect(after!.completedAt).not.toBeNull();
  });

  it('a raw-SQL INSERT of a completed task, with no completed_at, comes out STAMPED', async () => {
    const id = await seedTask({ status: 'completed' }); // completedAt defaults to null
    const row = await rawRow(id);
    expect(row!.status).toBe('completed');
    expect(row!.completedAt).not.toBeNull();
  });

  it('an INSERT carrying a real completed_at keeps it byte-identical', async () => {
    const historic = '2026-01-02T03:04:05.000Z';
    const id = await seedTask({ status: 'completed', completedAt: historic });
    const row = await rawRow(id);
    expect(row!.completedAt!.toISOString()).toBe(historic);
  });

  // ──────────────────────────────────────────────────────────────────────────────
  // NEVER OVERWRITE A REAL TIMESTAMP — the defect COALESCE was introduced to fix
  // ──────────────────────────────────────────────────────────────────────────────

  it('an unrelated update leaves an existing completed_at byte-identical', async () => {
    const historic = '2026-02-03T04:05:06.000Z';
    const id = await seedTask({ status: 'completed', completedAt: historic });
    const before = await rawRow(id);
    expect(before!.completedAt!.toISOString()).toBe(historic);

    await db.query(`UPDATE tasks SET title = $2 WHERE id = $1`, [id, 'renamed by probe']);

    const after = await rawRow(id);
    expect(after!.completedAt!.toISOString()).toBe(historic);
  });

  it('a re-save that re-states status=completed does NOT move the stamp forward', async () => {
    const historic = '2026-03-04T05:06:07.000Z';
    const id = await seedTask({ status: 'completed', completedAt: historic });

    await db.query(`UPDATE tasks SET status = 'completed' WHERE id = $1`, [id]);

    const after = await rawRow(id);
    expect(after!.completedAt!.toISOString()).toBe(historic);
  });

  it('BLANKING the stamp on a still-completed row is HONORED (a repair can un-stamp)', async () => {
    const historic = '2026-04-05T06:07:08.000Z';
    const id = await seedTask({ status: 'completed', completedAt: historic });

    // The exact statement a repair script writes. 094 answered it by recovering the old
    // value, which silently defeated repair (the 098 finding); 099 leaves a non-transition
    // UPDATE untouched, so a supplied NULL stays NULL — never "now", never the old value.
    await db.query(`UPDATE tasks SET completed_at = NULL WHERE id = $1`, [id]);

    const after = await rawRow(id);
    expect(after!.completedAt).toBeNull();
  });

  // ──────────────────────────────────────────────────────────────────────────────
  // TRANSITION OUT — mirrors both application writers
  // ──────────────────────────────────────────────────────────────────────────────

  it('a transition OUT of completed clears the stamp', async () => {
    const id = await seedTask({ status: 'completed', completedAt: '2026-05-06T07:08:09.000Z' });
    const before = await rawRow(id);
    expect(before!.completedAt).not.toBeNull();

    await db.query(`UPDATE tasks SET status = 'in_progress' WHERE id = $1`, [id]);

    const after = await rawRow(id);
    expect(after!.status).toBe('in_progress');
    expect(after!.completedAt).toBeNull();
  });

  it('a NON-completed row that already carries a stamp KEEPS it through an unrelated update', async () => {
    // The deliberate non-behaviour, stated as a test so a future author cannot widen the
    // rule to "status<>completed implies NULL" without this going red. That wider rule
    // would DESTROY a real timestamp — a data-loss fix that introduces data loss.
    const historic = '2026-06-07T08:09:10.000Z';
    const id = await withTriggerDisabled(async () =>
      seedTask({ status: 'in_progress', completedAt: historic }),
    );
    const before = await rawRow(id);
    expect(before).toEqual({ status: 'in_progress', completedAt: new Date(historic) });

    await db.query(`UPDATE tasks SET priority = 'high' WHERE id = $1`, [id]);

    const after = await rawRow(id);
    expect(after!.completedAt!.toISOString()).toBe(historic);
  });

  // ──────────────────────────────────────────────────────────────────────────────
  // THE LEGACY ROWS — they keep working AND THEY STAY NULL (migration 099).
  // Under 094's body this exact case asserted the opposite: that an unrelated retitle
  // "auto-corrected" the row with the retitle's date. That is a fabricated completion
  // date on the rows whose real dates are unrecoverable — a NULL is visibly missing, a
  // plausible date is silently believed.
  // ──────────────────────────────────────────────────────────────────────────────

  it('a legacy unstamped completed row still READS and UPDATES fine, and STAYS NULL', async () => {
    // Exactly the shape of the 208 rows on prod: completed, no stamp, predating the rule.
    const id = await withLegacyRowsPossible(async () => seedTask({ status: 'completed' }));

    // POSITIVE CONTROL: the fixture really is in the legacy state.
    const before = await rawRow(id);
    expect(before!.status).toBe('completed');
    expect(before!.completedAt).toBeNull();

    // It reads through the product, and unrelated updates succeed rather than raising —
    // under 094's CHECK the same UPDATE with the trigger off failed 23514.
    const viaService = await TaskService.getTaskById(id);
    expect(viaService?.id).toBe(id);
    await db.query(`UPDATE tasks SET title = $2 WHERE id = $1`, [id, 'legacy row, still editable']);
    expect((await rawRow(id))!.completedAt).toBeNull();
    await db.query(`UPDATE tasks SET priority = 'high' WHERE id = $1`, [id]);
    expect((await rawRow(id))!.completedAt).toBeNull();

    // A genuine reopen + recomplete IS observed, so recording it invents nothing.
    await db.query(`UPDATE tasks SET status = 'in_progress' WHERE id = $1`, [id]);
    await db.query(`UPDATE tasks SET status = 'completed' WHERE id = $1`, [id]);
    expect((await rawRow(id))!.completedAt).not.toBeNull();
  });

  // ──────────────────────────────────────────────────────────────────────────────
  // THE COMMAND-BACKEND APPLICATION CASES ARE GONE, ON PURPOSE.
  //
  // They used to drive `TaskService.updateTask` / `bulkUpdateStatus` and assert the row
  // came out stamped. Both now DELEGATE to the mcp-server `task_update` /
  // `task_bulk_update` tools, so running them here would exercise an HTTP call to a server
  // this suite does not start — a test that measures whether localhost:8080 is up is worse // reserved-port-ok: prose naming prod's bind; this suite starts no listener
  // than no test, because its RED means nothing.
  //
  // Nothing that mattered was lost. The file's own header already called these the WEAKER
  // evidence ("they would pass on the pre-migration schema"). The rule is now guarded in
  // two stronger places, neither of which is application code:
  //   - the TRIGGER exercised by every raw-SQL case ABOVE, which holds against ANY writer
  //     including the delegated one — that is the whole reason the rule was pushed down a
  //     layer;
  //   - the remaining application copy, in mcp-server/src/handlers/tasks.ts, guarded by
  //     mcp-server's own taskCompletedAtLifecycle contract test.
  // There is no longer a second application copy that could disagree with the first.
  // ──────────────────────────────────────────────────────────────────────────────
});
