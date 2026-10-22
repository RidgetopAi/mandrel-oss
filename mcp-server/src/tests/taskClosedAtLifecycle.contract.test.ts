/**
 * `closed_at` LIFECYCLE + FLOW FILTER Contract Test (gaps 1 and 4).
 *
 * ═══ THE DEFECT THIS LOCKS SHUT ═══
 * MEASURED on prod 2026-09-05: `completed_at` was NULL on ALL 113 cancelled tasks. Cancellation
 * is a close, and the record did not say when it happened — so the 2026-08-19 cull of 107
 * tasks, the single largest outflow event in our backlog history, had its date INFERRED from
 * `updated_at`, which is "last touched" and not "closed".
 *
 * And there was no way to ask a flow question in one call: `dueBefore` filters the DEADLINE,
 * `completedAt` was not on the list record, and no creation or closure date filter existed.
 * The 8-week inflow/outflow table cost a 1,212-row sweep plus 1,212 `task_details` calls.
 *
 * ═══ WHY THE ASSERTIONS ARE TRANSITIONS, NOT SAVES ═══
 * Same reason taskCompletedAtLifecycle.contract.test.ts gives: this is a state machine. A test
 * asserting "cancelling a task sets a timestamp" is the weakest one in the file. The
 * load-bearing ones are re-save-leaves-it-UNCHANGED, transition-OUT-CLEARS-it, and
 * completed-then-cancelled-KEEPS-THE-FIRST-MOMENT — the last of which is the one case where
 * `closed_at` deliberately differs from `completed_at`.
 *
 * ═══ THE POPULATION IS THE ENUM, NOT THE AUTHOR'S EXAMPLES ═══
 * The transition-out cases are generated from the SAME zod status enum the validator
 * enforces, so a sixth status becomes a sixth test automatically instead of inheriting a
 * silent hole. That is the correction taskCompletedAtLifecycle had to make after a mutation
 * narrowing its clause to `blocked` shipped green.
 *
 * CLOCK-INDEPENDENCE: the "unchanged" assertions backdate the stamp to a fixed sentinel
 * before re-saving, so they cannot pass by accident on a coarse clock.
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { db } from '../config/database.js';
import { validateToolArguments, validationSchemas } from '../middleware/validation.js';
import { routeExecutor } from '../routes/index.js';
import { TASK_TERMINAL_STATUSES } from '../config/taskLifecycleConfig.js';

const STAMP = Date.now();
const PROJ_NAME = `closed-at-lifecycle-${STAMP}`;
/** Backdated far enough in the past that no clock skew can reproduce it. */
const SENTINEL = '2019-03-04T05:06:07.890Z';
let projectId: string;

/** The status population, read off the shipped schema rather than typed out. */
const zodStatusOptions = (tool: string): string[] => {
  let schema: any = (validationSchemas as any)[tool];
  while (schema?._def?.typeName === 'ZodEffects') schema = schema._def.schema;
  let field: any = schema.shape.status;
  while (field && typeof field.unwrap === 'function') field = field.unwrap();
  return field.options ?? field._def?.values;
};
const SINGLE_STATUSES: string[] = zodStatusOptions('task_update');
/** Every status that is NOT terminal — i.e. every transition-OUT that must CLEAR the stamp. */
const NON_TERMINAL = SINGLE_STATUSES.filter((s) => !TASK_TERMINAL_STATUSES.includes(s));

/**
 * FAIL LOUD ON A TOOL ERROR. Without this check a mistyped argument makes the call a no-op,
 * the row never changes, and every "the stamp was cleared" assertion passes for the wrong
 * reason — the hollow-guard shape in its quietest form. Measured while writing this file: six
 * assertions went green-for-the-wrong-reason before the check was added, and eight went red
 * because the calls were silently failing on a missing `projectId`.
 */
async function viaPublicTool(toolName: string, rawArgs: any): Promise<any> {
  const res = await routeExecutor(toolName, validateToolArguments(toolName, rawArgs));
  if (res?.isError) {
    throw new Error(`${toolName} FAILED: ${res.content?.[0]?.text ?? JSON.stringify(res)}`);
  }
  return res;
}

async function makeTask(status: string, blockedOn?: string): Promise<string> {
  const res = await db.query(
    `INSERT INTO tasks (project_id, title, type, priority, status, blocked_on)
     VALUES ($1, 'closed_at lifecycle fuse', 'general', 'medium', $2, $3) RETURNING id`,
    [projectId, status, blockedOn ?? null],
  );
  return res.rows[0].id;
}

async function readRow(id: string) {
  const r = await db.query(
    `SELECT status, closed_at, completed_at FROM tasks WHERE id = $1`, [id]);
  return r.rows[0] as { status: string; closed_at: Date | null; completed_at: Date | null };
}

async function backdateClosedAt(id: string, when: string) {
  await db.query(`UPDATE tasks SET closed_at = $2::timestamptz WHERE id = $1`, [id, when]);
}

beforeAll(async () => {
  const p = await db.query(
    `INSERT INTO projects (name, description) VALUES ($1, 'closed_at contract') RETURNING id`,
    [PROJ_NAME]);
  projectId = p.rows[0].id;
});

afterAll(async () => {
  await db.query(`DELETE FROM tasks WHERE project_id = $1`, [projectId]);
  await db.query(`DELETE FROM projects WHERE id = $1`, [projectId]);
});

describe('gap 1 — CANCELLATION IS A CLOSE, and the record now says when', () => {
  test('THE FIX: cancelling stamps closed_at (was NULL on all 113 prod cancellations)', async () => {
    const id = await makeTask('todo');
    expect((await readRow(id)).closed_at).toBeNull();
    await viaPublicTool('task_update', { projectId, taskId: id, status: 'cancelled' });
    const row = await readRow(id);
    expect(row.closed_at).not.toBeNull();
    // AND `completed_at` stays NULL. This is the assertion that makes the naming decision
    // real rather than cosmetic: had we stamped `completed_at` on cancel, every existing
    // `WHERE completed_at IS NOT NULL` query in this product, in the Command backend and in
    // any customer's own SQL would start counting cancellations as completions.
    expect(row.completed_at).toBeNull();
  });

  test('completing stamps closed_at TOO — one field answers "when did it close"', async () => {
    const id = await makeTask('todo');
    await viaPublicTool('task_update', { projectId, taskId: id, status: 'completed' });
    const row = await readRow(id);
    expect(row.closed_at).not.toBeNull();
    expect(row.completed_at).not.toBeNull();
  });
});

describe('gap 1 — FIRST WRITE WINS (a re-save must not move the stamp forward)', () => {
  test.each(TASK_TERMINAL_STATUSES)(
    're-saving an already-%s task leaves closed_at UNCHANGED',
    async (terminal) => {
      const id = await makeTask('todo');
      await viaPublicTool('task_update', { projectId, taskId: id, status: terminal });
      await backdateClosedAt(id, SENTINEL);
      // A no-status edit AND a re-assert of the same status; both must leave it alone.
      await viaPublicTool('task_update', { projectId, taskId: id, priority: 'low' });
      expect(new Date((await readRow(id)).closed_at!).toISOString()).toBe(SENTINEL);
      await viaPublicTool('task_update', { projectId, taskId: id, status: terminal });
      expect(new Date((await readRow(id)).closed_at!).toISOString()).toBe(SENTINEL);
    },
  );

  test('completed -> cancelled KEEPS the ORIGINAL close moment (the task closed ONCE)', async () => {
    // The one case where closed_at deliberately differs from completed_at. Both statuses are
    // terminal, so this is NOT a transition out and must not re-stamp. A rule written as
    // "was completed / is completed" instead of "was terminal / is terminal" gets this wrong.
    const id = await makeTask('todo');
    await viaPublicTool('task_update', { projectId, taskId: id, status: 'completed' });
    await backdateClosedAt(id, SENTINEL);
    await viaPublicTool('task_update', { projectId, taskId: id, status: 'cancelled' });
    const row = await readRow(id);
    expect(new Date(row.closed_at!).toISOString()).toBe(SENTINEL);
    // completed_at, by contrast, DOES clear — it means "reached completed" and the task no
    // longer is. The two columns disagreeing here is correct and is the point of having both.
    expect(row.completed_at).toBeNull();
  });
});

describe('gap 1 — TRANSITION OUT clears the stamp', () => {
  test.each(NON_TERMINAL.flatMap((to) => TASK_TERMINAL_STATUSES.map((from) => [from, to])))(
    '%s -> %s clears closed_at',
    async (from, to) => {
      const id = await makeTask('todo');
      await viaPublicTool('task_update', { projectId, taskId: id, status: from });
      expect((await readRow(id)).closed_at).not.toBeNull();
      // `blocked` is the one destination that now requires a named blocker (gap 2), so it is
      // supplied here. The transition under test is unaffected by it.
      await viaPublicTool('task_update', {
        projectId, taskId: id, status: to, ...(to === 'blocked' ? { blockedOn: 'agent' } : {}),
      });
      expect((await readRow(id)).closed_at).toBeNull();
    },
  );

  test('the transition-out population is derived from the ENUM and is not empty', () => {
    // A test.each over an empty array passes silently and proves nothing. This asserts the
    // population is the schema's, and that it excludes exactly the terminal set.
    expect(NON_TERMINAL.length).toBeGreaterThan(0);
    expect(SINGLE_STATUSES.length).toBe(NON_TERMINAL.length + TASK_TERMINAL_STATUSES.length);
    for (const t of TASK_TERMINAL_STATUSES) expect(NON_TERMINAL).not.toContain(t);
  });
});

describe('gap 1 — THE BULK PATH (the twin site, and how the cull was actually done)', () => {
  test('a bulk CANCEL stamps closed_at on every row', async () => {
    // The 2026-08-19 cull of 107 tasks went through this path. It is the one that mattered
    // most and the one a single-path fix would have missed.
    const ids = [await makeTask('todo'), await makeTask('todo'), await makeTask('todo')];
    await viaPublicTool('task_bulk_update', { task_ids: ids, status: 'cancelled', projectId });
    for (const id of ids) expect((await readRow(id)).closed_at).not.toBeNull();
  });

  test('a bulk transition OUT of cancelled clears it on every row', async () => {
    const ids = [await makeTask('cancelled'), await makeTask('cancelled')];
    await viaPublicTool('task_bulk_update', { task_ids: ids, status: 'todo', projectId });
    for (const id of ids) expect((await readRow(id)).closed_at).toBeNull();
  });
});

describe('gap 1 — the DB owns the column, so nothing can bypass it', () => {
  test('a raw SQL INSERT of a cancelled row is stamped (no application layer involved)', async () => {
    // This is what makes the trigger STRICTLY BETTER than an application clause: it also
    // covers a repair script, a future service, and an operator's psql session. It is also
    // why no handler names this column — see the migration header on order-independence.
    const id = await makeTask('cancelled');
    expect((await readRow(id)).closed_at).not.toBeNull();
  });

  test('F4 — A LEGACY UNSTAMPED ROW STAYS NULL through unrelated updates', async () => {
    // ⚠️ THE ASSERTION THIS COLUMN EXISTS FOR, and the first cut of migration 098 FAILED it.
    //
    // All 113 pre-098 cancelled rows have closed_at NULL and their real close dates are
    // unrecoverable. The header promises they stay NULL. The first trigger keyed on "does
    // this row END UP terminal with no stamp", which is true of every unrelated UPDATE to
    // such a row — so retitling one stamped it with TODAY. MEASURED by Reviewer: a
    // cancelled row given a retitle came back closed_at = 2026-09-05, on a row that closed
    // 2026-08-19. And the NOT VALID CHECK made that fabrication MANDATORY: with the trigger
    // disabled the same retitle failed 23514, so the only alternatives were "fabricate" and
    // "reject the retitle". Both the CHECK and the end-state rule are gone; the trigger now
    // fires only on a TRANSITION.
    //
    // A fabricated date is worse than the NULL it replaces — a NULL is visibly missing, a
    // plausible date is silently believed. Same argument that keeps a forced value out of
    // `blocked_on` and `anonymous` out of `created_by`.
    const id = await makeTask('todo');
    // Seed the LEGACY shape. This INSERT-with-trigger-off is only possible BECAUSE the CHECK
    // was removed — under the first cut it failed 23514, which is itself the proof that the
    // constraint made the honest state unrepresentable.
    await db.query(`ALTER TABLE tasks DISABLE TRIGGER trg_tasks_closed_at_stamp`);
    try {
      await db.query(
        `UPDATE tasks SET status = 'cancelled', closed_at = NULL WHERE id = $1`, [id]);
    } finally {
      await db.query(`ALTER TABLE tasks ENABLE TRIGGER trg_tasks_closed_at_stamp`);
    }
    expect((await readRow(id)).closed_at).toBeNull();

    // Now the edits a real backlog does to old rows. Every one must leave it NULL.
    await viaPublicTool('task_update', { projectId, taskId: id, priority: 'low' });
    expect((await readRow(id)).closed_at, 'a priority edit fabricated a close date').toBeNull();

    await viaPublicTool('task_update', { projectId, taskId: id, title: 'retitled' });
    expect((await readRow(id)).closed_at, 'a retitle fabricated a close date').toBeNull();

    // And RE-ASSERTING the same terminal status is not a close either — it is not a
    // transition, so it must not stamp.
    await viaPublicTool('task_update', { projectId, taskId: id, status: 'cancelled' });
    expect((await readRow(id)).closed_at, 're-asserting cancelled fabricated a close date').toBeNull();
  });

  test('a legacy unstamped row that genuinely REOPENS and RECLOSES is stamped at the reclose', async () => {
    // The honest counterpart: we still do not know when it first closed, but we DID observe
    // the second close, so recording that one invents nothing. This is what stops the fix
    // above from being "never stamp anything".
    const id = await makeTask('todo');
    await db.query(`ALTER TABLE tasks DISABLE TRIGGER trg_tasks_closed_at_stamp`);
    try {
      await db.query(`UPDATE tasks SET status = 'cancelled', closed_at = NULL WHERE id = $1`, [id]);
    } finally {
      await db.query(`ALTER TABLE tasks ENABLE TRIGGER trg_tasks_closed_at_stamp`);
    }
    await viaPublicTool('task_update', { projectId, taskId: id, status: 'todo' });
    expect((await readRow(id)).closed_at).toBeNull();
    await viaPublicTool('task_update', { projectId, taskId: id, status: 'cancelled' });
    expect((await readRow(id)).closed_at).not.toBeNull();
  });

  test('there is NO CHECK constraint on closed_at — its absence is load-bearing', async () => {
    // Pinned, because re-adding it would silently restore the fabrication. A CHECK has no
    // OLD, so it cannot tell a legacy row from a new violation; the invariant is about a
    // TRANSITION and only a trigger can express that. See migration 098 PART 1d.
    const { rows } = await db.query(
      `SELECT count(*)::int n FROM pg_constraint WHERE conname = 'tasks_terminal_needs_closed_at'`);
    expect(rows[0].n).toBe(0);
  });
});

describe('gap 4 — a flow question is ONE call, not a sweep plus N detail calls', () => {
  test('closedAfter selects only rows closed at or after the bound, and excludes OPEN rows', async () => {
    const open = await makeTask('todo');
    const oldClose = await makeTask('cancelled');
    await backdateClosedAt(oldClose, SENTINEL);
    const newClose = await makeTask('completed');

    const res = await viaPublicTool('task_list', {
      projectId, closedAfter: '2020-01-01T00:00:00.000Z', limit: 100,
    });
    const ids: string[] = res.structuredContent.results.map((r: any) => r.id);
    expect(ids).toContain(newClose);
    // The two negatives are the whole filter: a row closed BEFORE the bound, and a row that
    // is STILL OPEN. "Not closed after X" and "never closed" are different answers, and a
    // filter that returned the open row would be answering the wrong question.
    expect(ids).not.toContain(oldClose);
    expect(ids).not.toContain(open);
  });

  test('createdAfter / createdBefore bound the FILING date, and the total agrees with the page', async () => {
    const id = await makeTask('todo');
    const { rows } = await db.query(`SELECT created_at FROM tasks WHERE id = $1`, [id]);
    // ±1s, and the reason is worth stating: `created_at` is timestamptz (MICROsecond
    // precision) and `Date.toISOString()` truncates to MILLIseconds, so an exact-equality
    // window silently excludes the very row it was built from. A test that widened the
    // product's clause to make this pass would have hidden a correct filter behind a wrong
    // fixture — this is the fixture being wrong, and it is bounded rather than removed so the
    // negative case below still means something.
    const t = new Date(rows[0].created_at).getTime();
    const from = new Date(t - 1000).toISOString();
    const to = new Date(t + 1000).toISOString();

    const hit = await viaPublicTool('task_list', {
      projectId, createdAfter: from, createdBefore: to, limit: 100 });
    expect(hit.structuredContent.results.map((r: any) => r.id)).toContain(id);
    // `total` comes from countTasks, which does NOT share the page's JOIN — so the page and
    // its grand total being filtered identically is a property, not an accident, and it is
    // the one that breaks if a new filter is threaded into only one of the two.
    expect(hit.structuredContent.total).toBe(hit.structuredContent.results.length);

    const miss = await viaPublicTool('task_list', {
      projectId, createdAfter: '2099-01-01T00:00:00.000Z', limit: 100 });
    expect(miss.structuredContent.results).toHaveLength(0);
    expect(miss.structuredContent.total).toBe(0);
  });

  test('THE LIST RECORD carries completedAt, closedAt and createdBy — no detail round-trip', async () => {
    // The measured cost of their absence was 1,212 `task_details` calls for ONE report.
    const id = await makeTask('todo');
    await viaPublicTool('task_update', { projectId, taskId: id, status: 'cancelled' });
    const res = await viaPublicTool('task_list', { projectId, limit: 100 });
    const rec = res.structuredContent.results.find((r: any) => r.id === id);
    expect(rec).toBeDefined();
    expect(Object.keys(rec)).toEqual(expect.arrayContaining(['completedAt', 'closedAt', 'createdBy']));
    // A cancelled task: closed, but never completed. Reading `completedAt` alone would say
    // this task never left the board — which is exactly the arithmetic gap 1 exists to fix.
    expect(rec.closedAt).not.toBeNull();
    expect(rec.completedAt).toBeNull();
  });

  test('task_details carries closedAt on both channels', async () => {
    const id = await makeTask('cancelled');
    const res = await viaPublicTool('task_details', { taskId: id, projectId });
    expect(res.structuredContent.task.closedAt).not.toBeNull();
    expect(res.content[0].text).toMatch(/^Closed: /m);
  });
});
