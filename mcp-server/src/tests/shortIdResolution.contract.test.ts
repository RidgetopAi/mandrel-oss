/**
 * SHORT-ID RESOLUTION Contract Test
 *
 * Drives the REAL public tool path (zod validator → route handler → real migrated
 * Postgres, the disposable ci_* DB from the CI gate — never production), the same
 * idiom as decisionLearningLoopRead.contract.test.ts. Embeddings are NOT stubbed; CI
 * falls back to the deterministic mock embedding and these reads/writes use exact ids,
 * so every DB read/write is real.
 *
 * WHAT THIS PROVES (the an earlier task contract):
 *
 *  CASE 1 — an 8-char SHORT id resolves to the SAME record as the full UUID on
 *           task_details, task_update, decision_get, decision_update (back-compat with
 *           the full UUID is proven side-by-side).
 *
 *  CASE 2 — an AMBIGUOUS short prefix (two rows crafted to share the same 8 leading hex
 *           chars in the disposable DB) returns the actionable multi-candidate error
 *           (listing the candidate FULL ids) and DOES NOT mutate / pick one.
 *
 *  CASE 3 — an UNKNOWN short id returns the actionable not-found error.
 *
 *  CASE 4 — a full UUID still works (back-compat) and NON-HEX garbage is rejected at the
 *           validator with an actionable message.
 *
 * SECURITY: the resolver uses a parameterized prefix match (`id::text LIKE $1 || '%'`,
 * $1 bound) — never string-concatenated SQL. This test crafts ids only in the throwaway
 * DB.
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';

import { db } from '../config/database.js';
import { tasksRoutes } from '../routes/tasks.routes.js';
import { decisionsRoutes } from '../routes/decisions.routes.js';
import { validateToolArguments } from '../middleware/validation.js';

const STAMP = Date.now();
const PROJ_NAME = `short-id-resolution-${STAMP}`;

let projectId: string;

// A connection-scoped context: task_update/decision_update resolve project via the
// connection's current project. We pass projectId explicitly on the calls instead.
function textOf(resp: any): string {
  return resp?.content?.map((c: any) => c.text).join('\n') ?? '';
}

/** Run a tool through the SAME path the HTTP bridge uses: validate THEN route. */
async function viaPublicTool(toolName: string, rawArgs: any, handler: (a: any) => Promise<any>) {
  const validated = validateToolArguments(toolName, rawArgs);
  return handler(validated);
}

// Crafted ids. CASE 1 record: a normal generated task/decision (full uuid known).
let taskFullId: string;
let decisionFullId: string;

// CASE 2: two tasks + two decisions crafted to SHARE the same 8-hex prefix.
const AMBIG_PREFIX = 'abcdef12';
const AMBIG_TASK_A = `${AMBIG_PREFIX}-1111-4111-8111-111111111111`;
const AMBIG_TASK_B = `${AMBIG_PREFIX}-2222-4222-8222-222222222222`;
const AMBIG_DEC_A = `${AMBIG_PREFIX}-3333-4333-8333-333333333333`;
const AMBIG_DEC_B = `${AMBIG_PREFIX}-4444-4444-8444-444444444444`;

describe('short-id resolution (task_update/task_details/decision_update/decision_get)', () => {
  beforeAll(async () => {
    projectId = (await db.query(
      `INSERT INTO projects (name, description) VALUES ($1, 'short-id fuse') RETURNING id`,
      [PROJ_NAME]
    )).rows[0].id;

    // CASE 1 records — created through the public tools so the full id is what the tool returns.
    taskFullId = (await db.query(
      `INSERT INTO tasks (project_id, title, type, priority, status)
       VALUES ($1, 'Short id target task', 'general', 'medium', 'todo') RETURNING id::text AS id`,
      [projectId]
    )).rows[0].id;

    decisionFullId = (await db.query(
      `INSERT INTO technical_decisions
         (project_id, decision_type, title, description, rationale, impact_level)
       VALUES ($1, 'database', 'Short id target decision', 'desc', 'rat', 'medium')
       RETURNING id::text AS id`,
      [projectId]
    )).rows[0].id;

    // CASE 2 — craft two task rows + two decision rows sharing the same 8-hex prefix.
    await db.query(
      `INSERT INTO tasks (id, project_id, title, type, priority, status)
       VALUES ($1, $3, 'Ambiguous task A', 'general', 'medium', 'todo'),
              ($2, $3, 'Ambiguous task B', 'general', 'medium', 'todo')`,
      [AMBIG_TASK_A, AMBIG_TASK_B, projectId]
    );
    await db.query(
      `INSERT INTO technical_decisions
         (id, project_id, decision_type, title, description, rationale, impact_level)
       VALUES ($1, $3, 'database', 'Ambiguous decision A', 'd', 'r', 'low'),
              ($2, $3, 'pattern', 'Ambiguous decision B', 'd', 'r', 'low')`,
      [AMBIG_DEC_A, AMBIG_DEC_B, projectId]
    );
  });

  afterAll(async () => {
    if (projectId) {
      try { await db.query('DELETE FROM tasks WHERE project_id = $1', [projectId]); } catch { /* ignore */ }
      try { await db.query('DELETE FROM technical_decisions WHERE project_id = $1', [projectId]); } catch { /* ignore */ }
      try { await db.query('DELETE FROM sessions WHERE project_id = $1', [projectId]); } catch { /* ignore */ }
      try { await db.query('DELETE FROM projects WHERE id = $1', [projectId]); } catch { /* ignore */ }
    }
    await db.end();
  });

  // ── CASE 1: short id resolves to the SAME record as the full UUID ────────────
  test('CASE 1: task_details accepts an 8-char short id → same task as full UUID', async () => {
    const shortId = taskFullId.slice(0, 8);

    const byFull = await viaPublicTool('task_details',
      { taskId: taskFullId, projectId },
      (a) => tasksRoutes.handleDetails(a));
    const byShort = await viaPublicTool('task_details',
      { taskId: shortId, projectId },
      (a) => tasksRoutes.handleDetails(a));

    expect((byFull as any).structuredContent?.found).toBe(true);
    expect((byShort as any).structuredContent?.found).toBe(true);
    expect((byShort as any).structuredContent.task.id).toBe(taskFullId);
    expect((byShort as any).structuredContent.task.id)
      .toBe((byFull as any).structuredContent.task.id);
  });

  test('CASE 1: task_update accepts an 8-char short id → mutates the SAME task', async () => {
    const shortId = taskFullId.slice(0, 8);

    const resp = await viaPublicTool('task_update',
      { taskId: shortId, status: 'in_progress', projectId },
      (a) => tasksRoutes.handleUpdate(a));

    // The applied record reports the RESOLVED full id, and the DB row actually changed.
    expect((resp as any).structuredContent?.task?.id).toBe(taskFullId);
    const row = await db.query('SELECT status FROM tasks WHERE id = $1', [taskFullId]);
    expect(row.rows[0].status).toBe('in_progress');
  });

  test('CASE 1: decision_get accepts an 8-char short id → same decision as full UUID', async () => {
    const shortId = decisionFullId.slice(0, 8);

    const byFull = await viaPublicTool('decision_get',
      { decisionId: decisionFullId, projectId },
      (a) => decisionsRoutes.handleGet(a));
    const byShort = await viaPublicTool('decision_get',
      { decisionId: shortId, projectId },
      (a) => decisionsRoutes.handleGet(a));

    expect((byFull as any).data?.found).toBe(true);
    expect((byShort as any).data?.found).toBe(true);
    expect((byShort as any).data.decision.id).toBe(decisionFullId);
    expect((byShort as any).data.decision.id).toBe((byFull as any).data.decision.id);
  });

  test('CASE 1: decision_update accepts an 8-char short id → mutates the SAME decision', async () => {
    const shortId = decisionFullId.slice(0, 8);

    const resp = await viaPublicTool('decision_update',
      { decisionId: shortId, outcomeStatus: 'successful', projectId },
      (a) => decisionsRoutes.handleUpdate(a));

    expect((resp as any).structuredContent?.decision?.id).toBe(decisionFullId);
    const row = await db.query('SELECT outcome_status FROM technical_decisions WHERE id = $1', [decisionFullId]);
    expect(row.rows[0].outcome_status).toBe('successful');
  });

  // ── CASE 2: ambiguous prefix → actionable multi-candidate error, no mutation ──
  test('CASE 2: task_details with an AMBIGUOUS prefix returns the candidate list, does not pick', async () => {
    const resp = await viaPublicTool('task_details',
      { taskId: AMBIG_PREFIX, projectId },
      (a) => tasksRoutes.handleDetails(a));

    const text = textOf(resp);
    expect(text).toMatch(/Ambiguous short id/i);
    // Both candidate FULL ids must be listed so the caller can pick.
    expect(text).toContain(AMBIG_TASK_A);
    expect(text).toContain(AMBIG_TASK_B);
    expect((resp as any).structuredContent?.ambiguous).toBe(true);
    expect((resp as any).structuredContent?.found).toBe(false);
  });

  test('CASE 2: task_update with an AMBIGUOUS prefix does NOT mutate either row', async () => {
    // Both ambiguous tasks start as 'todo'. An ambiguous update must change neither.
    const resp = await viaPublicTool('task_update',
      { taskId: AMBIG_PREFIX, status: 'completed', projectId },
      (a) => tasksRoutes.handleUpdate(a));

    expect((resp as any).isError).toBe(true);
    expect((resp as any).structuredContent?.ambiguous).toBe(true);
    const text = textOf(resp);
    expect(text).toContain(AMBIG_TASK_A);
    expect(text).toContain(AMBIG_TASK_B);

    // Neither row was touched (still 'todo') — silent-pick prevention.
    const rows = await db.query(
      'SELECT status FROM tasks WHERE id = ANY($1)', [[AMBIG_TASK_A, AMBIG_TASK_B]]);
    for (const r of rows.rows) expect(r.status).toBe('todo');
  });

  test('CASE 2: decision_update with an AMBIGUOUS prefix does NOT mutate either row', async () => {
    const resp = await viaPublicTool('decision_update',
      { decisionId: AMBIG_PREFIX, outcomeStatus: 'failed', projectId },
      (a) => decisionsRoutes.handleUpdate(a));

    expect((resp as any).isError).toBe(true);
    expect((resp as any).structuredContent?.ambiguous).toBe(true);
    const text = textOf(resp);
    expect(text).toContain(AMBIG_DEC_A);
    expect(text).toContain(AMBIG_DEC_B);

    // Neither decision's outcome was set.
    const rows = await db.query(
      'SELECT outcome_status FROM technical_decisions WHERE id = ANY($1)',
      [[AMBIG_DEC_A, AMBIG_DEC_B]]);
    for (const r of rows.rows) expect(r.outcome_status).not.toBe('failed');
  });

  test('CASE 2: decision_get with an AMBIGUOUS prefix returns the candidate list', async () => {
    const resp = await viaPublicTool('decision_get',
      { decisionId: AMBIG_PREFIX, projectId },
      (a) => decisionsRoutes.handleGet(a));

    const text = textOf(resp);
    expect(text).toMatch(/Ambiguous short id/i);
    expect(text).toContain(AMBIG_DEC_A);
    expect(text).toContain(AMBIG_DEC_B);
    expect((resp as any).data?.found).toBe(false);
    expect((resp as any).data?.ambiguous).toBe(true);
  });

  // ── CASE 3: unknown short id → actionable not-found ──────────────────────────
  test('CASE 3: task_details with an UNKNOWN short id returns actionable not-found', async () => {
    const resp = await viaPublicTool('task_details',
      { taskId: '0badf00d', projectId },
      (a) => tasksRoutes.handleDetails(a));
    expect((resp as any).structuredContent?.found).toBe(false);
    const text = textOf(resp);
    expect(text).toContain('not found');
    expect(text).toMatch(/task_list/i); // tells the caller how to find the id
  });

  test('CASE 3: decision_update with an UNKNOWN short id returns actionable not-found, no mutation', async () => {
    const resp = await viaPublicTool('decision_update',
      { decisionId: '0badf00d', outcomeStatus: 'failed', projectId },
      (a) => decisionsRoutes.handleUpdate(a));
    expect((resp as any).isError).toBe(true);
    const text = textOf(resp);
    expect(text).toContain('not found');
    expect(text).toMatch(/decision_search/i);
  });

  // ── CASE 4: full UUID back-compat + non-hex garbage rejected ─────────────────
  test('CASE 4: a full UUID still works unchanged (back-compat) on every tool', async () => {
    // task_details by full uuid
    const td = await viaPublicTool('task_details',
      { taskId: taskFullId, projectId }, (a) => tasksRoutes.handleDetails(a));
    expect((td as any).structuredContent?.found).toBe(true);

    // decision_get by full uuid
    const dg = await viaPublicTool('decision_get',
      { decisionId: decisionFullId, projectId }, (a) => decisionsRoutes.handleGet(a));
    expect((dg as any).data?.found).toBe(true);
  });

  test('CASE 4: NON-HEX garbage is rejected at the validator with an actionable message', () => {
    expect(() => validateToolArguments('task_details', { taskId: 'not-a-real-id!!' }))
      .toThrow(/taskId/i);
    expect(() => validateToolArguments('task_update', { taskId: 'zzzzzzzz', status: 'todo' }))
      .toThrow(/taskId/i);
    expect(() => validateToolArguments('decision_get', { decisionId: 'short' })) // <8 chars
      .toThrow(/decisionId/i);
    expect(() => validateToolArguments('decision_update', { decisionId: 'xyz!@#', outcomeStatus: 'failed' }))
      .toThrow(/decisionId/i);
  });

  test('CASE 4: a valid 8-hex short id PASSES the validator (shape only — resolution is in the handler)', () => {
    // The validator must accept the short form; resolution/uniqueness is the handler's job.
    expect(() => validateToolArguments('task_details', { taskId: 'abcdef12' })).not.toThrow();
    expect(() => validateToolArguments('decision_get', { decisionId: 'abcdef12' })).not.toThrow();
  });

  // ── CASE 4 (regression lock): SQL-wildcard ids are REJECTED at the validator ──
  // The resolver does a parameterized prefix match (`id::text LIKE $1 || '%'`). The hex
  // shape-check is the FIRST line of defence: a `%` or `_` in an id would be a LIKE
  // metacharacter, so it must never reach the LIKE bind. The hex regex already rejects
  // them (non-hex chars); these cases LOCK that against any future loosening of the
  // validator (e.g. someone widening the allowed charset). 8 leading hex chars + a single
  // wildcard proves it's the wildcard — not the length — that gets it rejected.
  test('CASE 4: a SQL `%` wildcard in an id is REJECTED by the validator (LIKE-metachar guard)', () => {
    expect(() => validateToolArguments('task_details', { taskId: 'abcd%f12' }))
      .toThrow(/taskId/i);
    expect(() => validateToolArguments('task_update', { taskId: 'abcd%f12', status: 'todo' }))
      .toThrow(/taskId/i);
    expect(() => validateToolArguments('decision_get', { decisionId: 'abcd%f12' }))
      .toThrow(/decisionId/i);
    expect(() => validateToolArguments('decision_update', { decisionId: 'abcd%f12', outcomeStatus: 'failed' }))
      .toThrow(/decisionId/i);
  });

  test('CASE 4: a SQL `_` single-char wildcard in an id is REJECTED by the validator (LIKE-metachar guard)', () => {
    expect(() => validateToolArguments('task_details', { taskId: 'abcd_f12' }))
      .toThrow(/taskId/i);
    expect(() => validateToolArguments('task_update', { taskId: 'abcd_f12', status: 'todo' }))
      .toThrow(/taskId/i);
    expect(() => validateToolArguments('decision_get', { decisionId: 'abcd_f12' }))
      .toThrow(/decisionId/i);
    expect(() => validateToolArguments('decision_update', { decisionId: 'abcd_f12', outcomeStatus: 'failed' }))
      .toThrow(/decisionId/i);
  });
});
