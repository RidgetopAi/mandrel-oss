/**
 * SOFT-DELETE / ARCHIVE Contract Test
 *
 * Drives the REAL public tool path (zod validator → route handler → real migrated
 * Postgres, the disposable ci_* DB from the CI gate — never production), the same
 * idiom as shortIdResolution.contract.test.ts. Embeddings are NOT stubbed; CI falls
 * back to the deterministic mock embedding and these reads/writes use exact ids, so
 * every DB read/write is real and the migration-046 archived_at column is exercised.
 *
 * WHAT THIS PROVES (the earlier task contract — reversible soft-delete, no raw SQL):
 *
 *  G1 — *_delete sets archived_at AND the row then DISAPPEARS from the default
 *       list/search, but STILL EXISTS in the DB (soft, not hard).
 *  G2 — *_restore brings the row back into default listings (and clears archived_at).
 *  G3 — includeArchived:true (and the STRING "true" from the bridge) shows archived rows.
 *  G4 — delete is PROJECT-SCOPED (cannot archive a row in another project) and accepts a
 *       SHORT id (8-hex prefix) — compounding on an earlier task's idResolver.
 *  G5 — delete of an unknown short id returns an actionable not-found (no mutation);
 *       a second delete of an already-archived row is an idempotent no-op.
 *  G6 — the new tools declare an outputSchema (the task-2 all-tools guard already
 *       enforces this globally; asserted here for the 3 delete + 3 restore tools).
 *
 * Covers all three entities (context, decision, task). Validation runs through the SAME
 * validateToolArguments the bridge uses, so the coercedBoolean (task 3) path for
 * includeArchived:"true" is genuinely exercised.
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';

import { db } from '../config/database.js';
import { tasksRoutes } from '../routes/tasks.routes.js';
import { decisionsRoutes } from '../routes/decisions.routes.js';
import { contextRoutes } from '../routes/context.routes.js';
import { validateToolArguments } from '../middleware/validation.js';
import { AIDIS_TOOL_DEFINITIONS } from '../config/toolDefinitions.js';

const STAMP = Date.now();
const PROJ_NAME = `soft-delete-${STAMP}`;
const OTHER_PROJ_NAME = `soft-delete-other-${STAMP}`;

let projectId: string;
let otherProjectId: string;

// One row per entity in the MAIN project, plus one TASK in the OTHER project (G4 scope).
let taskId: string;
let decisionId: string;
let contextId: string;
let otherProjectTaskId: string;

function textOf(resp: any): string {
  return resp?.content?.map((c: any) => c.text).join('\n') ?? '';
}

/** Run a tool through the SAME path the HTTP bridge uses: validate THEN route. */
async function viaPublicTool(toolName: string, rawArgs: any, handler: (a: any) => Promise<any>) {
  const validated = validateToolArguments(toolName, rawArgs);
  return handler(validated);
}

describe('soft-delete / archive (context/decision/task delete + restore)', () => {
  beforeAll(async () => {
    projectId = (await db.query(
      `INSERT INTO projects (name, description) VALUES ($1, 'soft-delete fuse') RETURNING id`,
      [PROJ_NAME]
    )).rows[0].id;
    otherProjectId = (await db.query(
      `INSERT INTO projects (name, description) VALUES ($1, 'soft-delete other') RETURNING id`,
      [OTHER_PROJ_NAME]
    )).rows[0].id;

    taskId = (await db.query(
      `INSERT INTO tasks (project_id, title, type, priority, status)
       VALUES ($1, 'Archive target task', 'general', 'medium', 'todo') RETURNING id::text AS id`,
      [projectId]
    )).rows[0].id;

    decisionId = (await db.query(
      `INSERT INTO technical_decisions
         (project_id, decision_type, title, description, rationale, impact_level)
       VALUES ($1, 'database', 'Archive target decision', 'desc', 'rat', 'medium')
       RETURNING id::text AS id`,
      [projectId]
    )).rows[0].id;

    contextId = (await db.query(
      `INSERT INTO contexts (project_id, context_type, content, tags)
       VALUES ($1, 'planning', 'Archive target context body', ARRAY['archive-test'])
       RETURNING id::text AS id`,
      [projectId]
    )).rows[0].id;

    // A task in a DIFFERENT project — used to prove project-scoping (G4).
    otherProjectTaskId = (await db.query(
      `INSERT INTO tasks (project_id, title, type, priority, status)
       VALUES ($1, 'Other project task', 'general', 'medium', 'todo') RETURNING id::text AS id`,
      [otherProjectId]
    )).rows[0].id;
  });

  afterAll(async () => {
    for (const p of [projectId, otherProjectId]) {
      if (!p) continue;
      try { await db.query('DELETE FROM tasks WHERE project_id = $1', [p]); } catch { /* ignore */ }
      try { await db.query('DELETE FROM technical_decisions WHERE project_id = $1', [p]); } catch { /* ignore */ }
      try { await db.query('DELETE FROM contexts WHERE project_id = $1', [p]); } catch { /* ignore */ }
      try { await db.query('DELETE FROM sessions WHERE project_id = $1', [p]); } catch { /* ignore */ }
      try { await db.query('DELETE FROM projects WHERE id = $1', [p]); } catch { /* ignore */ }
    }
    await db.end();
  });

  // ── G1 + G2 + G3: TASK delete → vanishes from default list → restore → returns ──
  test('G1: task_delete archives → vanishes from default task_list, STILL EXISTS in DB', async () => {
    const del = await viaPublicTool('task_delete',
      { taskId, projectId }, (a) => tasksRoutes.handleDelete(a));
    expect((del as any).structuredContent?.action).toBe('archived');
    expect((del as any).structuredContent?.task?.id).toBe(taskId);

    // archived_at is set in the DB; the row STILL EXISTS (soft, not hard).
    const row = await db.query('SELECT archived_at FROM tasks WHERE id = $1', [taskId]);
    expect(row.rows.length).toBe(1);              // not hard-deleted
    expect(row.rows[0].archived_at).not.toBeNull(); // archived

    // Default task_list excludes it.
    const list = await viaPublicTool('task_list',
      { projectId, limit: 50 }, (a) => tasksRoutes.handleList(a));
    const ids = ((list as any).structuredContent?.results ?? []).map((r: any) => r.id);
    expect(ids).not.toContain(taskId);
  });

  test('G3: task_list with includeArchived:true (and the STRING "true") shows the archived task', async () => {
    const boolForm = await viaPublicTool('task_list',
      { projectId, limit: 50, includeArchived: true }, (a) => tasksRoutes.handleList(a));
    const boolIds = ((boolForm as any).structuredContent?.results ?? []).map((r: any) => r.id);
    expect(boolIds).toContain(taskId);

    // STRING "true" over the bridge must coerce (task-3 coercedBoolean), not be rejected.
    const strForm = await viaPublicTool('task_list',
      { projectId, limit: 50, includeArchived: 'true' }, (a) => tasksRoutes.handleList(a));
    const strIds = ((strForm as any).structuredContent?.results ?? []).map((r: any) => r.id);
    expect(strIds).toContain(taskId);
  });

  test('G2: task_restore un-archives → task returns to default task_list, archived_at cleared', async () => {
    const res = await viaPublicTool('task_restore',
      { taskId, projectId }, (a) => tasksRoutes.handleRestore(a));
    expect((res as any).structuredContent?.action).toBe('restored');

    const row = await db.query('SELECT archived_at FROM tasks WHERE id = $1', [taskId]);
    expect(row.rows[0].archived_at).toBeNull();

    const list = await viaPublicTool('task_list',
      { projectId, limit: 50 }, (a) => tasksRoutes.handleList(a));
    const ids = ((list as any).structuredContent?.results ?? []).map((r: any) => r.id);
    expect(ids).toContain(taskId);
  });

  // ── G4: project-scope + SHORT id ────────────────────────────────────────────
  test('G4: task_delete accepts a SHORT id (8-hex) and archives the right task', async () => {
    const shortId = taskId.slice(0, 8);
    const del = await viaPublicTool('task_delete',
      { taskId: shortId, projectId }, (a) => tasksRoutes.handleDelete(a));
    expect((del as any).structuredContent?.task?.id).toBe(taskId); // resolved to the full id
    const row = await db.query('SELECT archived_at FROM tasks WHERE id = $1', [taskId]);
    expect(row.rows[0].archived_at).not.toBeNull();
    // restore for cleanliness
    await viaPublicTool('task_restore', { taskId, projectId }, (a) => tasksRoutes.handleRestore(a));
  });

  test('G4: task_delete is PROJECT-SCOPED — cannot archive a task in another project', async () => {
    // Try to archive the OTHER project's task while scoped to the MAIN project.
    const del = await viaPublicTool('task_delete',
      { taskId: otherProjectTaskId, projectId }, (a) => tasksRoutes.handleDelete(a));
    // Scoped resolver finds nothing in this project → actionable not-found, NO mutation.
    expect((del as any).isError).toBe(true);
    expect((del as any).structuredContent?.found).toBe(false);

    const row = await db.query('SELECT archived_at FROM tasks WHERE id = $1', [otherProjectTaskId]);
    expect(row.rows[0].archived_at).toBeNull(); // untouched
  });

  // ── G5: not-found + idempotency ─────────────────────────────────────────────
  test('G5: task_delete with an UNKNOWN short id returns actionable not-found (no mutation)', async () => {
    const del = await viaPublicTool('task_delete',
      { taskId: '0badf00d', projectId }, (a) => tasksRoutes.handleDelete(a));
    expect((del as any).structuredContent?.found).toBe(false);
    expect(textOf(del)).toMatch(/not found/i);
  });

  test('G5: task_delete is IDEMPOTENT — a second delete reports already-archived, stays archived', async () => {
    await viaPublicTool('task_delete', { taskId, projectId }, (a) => tasksRoutes.handleDelete(a));
    const again = await viaPublicTool('task_delete', { taskId, projectId }, (a) => tasksRoutes.handleDelete(a));
    expect((again as any).structuredContent?.alreadyArchived).toBe(true);
    const row = await db.query('SELECT archived_at FROM tasks WHERE id = $1', [taskId]);
    expect(row.rows[0].archived_at).not.toBeNull();
    await viaPublicTool('task_restore', { taskId, projectId }, (a) => tasksRoutes.handleRestore(a)); // cleanup
  });

  // ── DECISION entity: delete hides from default search, restore brings back ───
  test('G1/G2: decision_delete hides from default decision_search; restore brings it back', async () => {
    await viaPublicTool('decision_delete',
      { decisionId, projectId }, (a) => decisionsRoutes.handleDelete(a));
    const dbRow = await db.query('SELECT archived_at FROM technical_decisions WHERE id = $1', [decisionId]);
    expect(dbRow.rows[0].archived_at).not.toBeNull(); // soft, still present

    // Default search excludes archived.
    const search = await viaPublicTool('decision_search',
      { query: 'Archive target decision', projectId }, (a) => decisionsRoutes.handleSearch(a));
    const found = (((search as any).structuredContent?.results) ?? (search as any).data?.results ?? [])
      .map((r: any) => r.id);
    expect(found).not.toContain(decisionId);

    // includeArchived reveals it.
    const searchInc = await viaPublicTool('decision_search',
      { query: 'Archive target decision', projectId, includeArchived: true },
      (a) => decisionsRoutes.handleSearch(a));
    const foundInc = (((searchInc as any).structuredContent?.results) ?? (searchInc as any).data?.results ?? [])
      .map((r: any) => r.id);
    expect(foundInc).toContain(decisionId);

    // Restore.
    await viaPublicTool('decision_restore',
      { decisionId, projectId }, (a) => decisionsRoutes.handleRestore(a));
    const after = await db.query('SELECT archived_at FROM technical_decisions WHERE id = $1', [decisionId]);
    expect(after.rows[0].archived_at).toBeNull();
  });

  // ── CONTEXT entity: delete hides from get_recent + tags search, restore back ─
  test('G1/G2: context_delete hides from default get_recent/tags-search; restore brings it back', async () => {
    await viaPublicTool('context_delete',
      { contextId, projectId }, (a) => contextRoutes.handleDelete(a));
    const dbRow = await db.query('SELECT archived_at FROM contexts WHERE id = $1', [contextId]);
    expect(dbRow.rows[0].archived_at).not.toBeNull(); // soft, still present

    // Default get_recent excludes archived.
    const recent = await viaPublicTool('context_get_recent',
      { projectId, limit: 20 }, (a) => contextRoutes.handleGetRecent(a));
    const recentIds = ((recent as any).structuredContent?.results ?? []).map((r: any) => r.id);
    expect(recentIds).not.toContain(contextId);

    // Default tags-only search excludes archived.
    const tagSearch = await viaPublicTool('context_search',
      { tags: ['archive-test'], projectId }, (a) => contextRoutes.handleSearch(a));
    const tagIds = ((tagSearch as any).structuredContent?.results ?? []).map((r: any) => r.id);
    expect(tagIds).not.toContain(contextId);

    // includeArchived (tags-only path) reveals it.
    const tagInc = await viaPublicTool('context_search',
      { tags: ['archive-test'], projectId, includeArchived: true }, (a) => contextRoutes.handleSearch(a));
    const tagIncIds = ((tagInc as any).structuredContent?.results ?? []).map((r: any) => r.id);
    expect(tagIncIds).toContain(contextId);

    // Restore.
    await viaPublicTool('context_restore',
      { contextId, projectId }, (a) => contextRoutes.handleRestore(a));
    const after = await db.query('SELECT archived_at FROM contexts WHERE id = $1', [contextId]);
    expect(after.rows[0].archived_at).toBeNull();

    const recent2 = await viaPublicTool('context_get_recent',
      { projectId, limit: 20 }, (a) => contextRoutes.handleGetRecent(a));
    const recent2Ids = ((recent2 as any).structuredContent?.results ?? []).map((r: any) => r.id);
    expect(recent2Ids).toContain(contextId);
  });

  // ── G6: the 6 new tools declare an outputSchema (compounding on task 2) ──────
  test('G6: every new soft-delete/restore tool declares an outputSchema', () => {
    const newTools = [
      'context_delete', 'context_restore',
      'decision_delete', 'decision_restore',
      'task_delete', 'task_restore',
    ];
    for (const name of newTools) {
      const def = AIDIS_TOOL_DEFINITIONS.find((d) => d.name === name);
      expect(def, `${name} tool definition exists`).toBeDefined();
      expect(def!.outputSchema, `${name} declares an outputSchema`).toBeDefined();
      expect(def!.outputSchema!.type).toBe('object');
    }
  });
});
