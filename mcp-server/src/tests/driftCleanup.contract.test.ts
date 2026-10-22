/**
 * DRIFT-CLEANUP Contract Test (an earlier task — MCP overhaul task 7/8)
 *
 * Proves that every param the drift-cleanup task IMPLEMENTED actually takes effect
 * END-TO-END through the REAL public tool path (zod validator → route handler → real
 * migrated Postgres — the disposable ci_* DB from the CI gate, never production), the
 * same idiom as softDeleteArchive.contract.test.ts. Embeddings fall back to the
 * deterministic CI mock; every read/write below uses exact ids/filters so the DB work is
 * real.
 *
 * The class this guards: a param ADVERTISED in a tool's schema that the route/handler
 * never forwards OR has no backing column → silent wrong-success. For each formerly-
 * drifted param we make an explicit IMPLEMENT (wire end-to-end) or DEPRECATE (stop
 * advertising) call; these tests are the deterministic proof of the IMPLEMENT calls.
 *
 * WHAT THIS PROVES:
 *  D1 — decision_record.metadata PERSISTS and READS BACK (migration 047 column).
 *  D2 — task_list.phase filters to tasks tagged `phase-<phase>` (real tag filter).
 *  D3 — task_list.statuses filters to the multi-status set (status IN (...)).
 *  D4 — task_list.projectId project-scopes the list (confirms task-3 wiring works e2e).
 *  D5 — task_create.createdBy persists (created_by column) + is reachable under strict mode.
 *  D6 — task_update.metadata persists (tasks.metadata jsonb) + is reachable under strict mode.
 *  D7 — smart_search.scope is DEPRECATED → the validator REJECTS it (strict mode), proving
 *       it's no longer an advertised-but-ignored lie.
 *
 * Validation runs through the SAME validateToolArguments the bridge uses, so strict-mode
 * acceptance of the newly-declared params (and rejection of the deprecated one) is real.
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';

import { db } from '../config/database.js';
import { tasksRoutes } from '../routes/tasks.routes.js';
import { decisionsRoutes } from '../routes/decisions.routes.js';
import { validateToolArguments } from '../middleware/validation.js';

const STAMP = Date.now();
const PROJ_NAME = `drift-cleanup-${STAMP}`;
const OTHER_PROJ_NAME = `drift-cleanup-other-${STAMP}`;

let projectId: string;
let otherProjectId: string;

/** Run a tool through the SAME path the HTTP bridge uses: validate THEN route. */
async function viaPublicTool(toolName: string, rawArgs: any, handler: (a: any) => Promise<any>) {
  const validated = validateToolArguments(toolName, rawArgs);
  return handler(validated);
}

/** Result ids from a task_list structuredContent payload. */
function listedIds(resp: any): string[] {
  return (resp?.structuredContent?.results ?? []).map((r: any) => r.id);
}

describe('drift-cleanup: implemented params take effect end-to-end', () => {
  beforeAll(async () => {
    projectId = (await db.query(
      `INSERT INTO projects (name, description) VALUES ($1, 'drift-cleanup guard') RETURNING id`,
      [PROJ_NAME]
    )).rows[0].id;
    otherProjectId = (await db.query(
      `INSERT INTO projects (name, description) VALUES ($1, 'drift-cleanup other') RETURNING id`,
      [OTHER_PROJ_NAME]
    )).rows[0].id;
  });

  afterAll(async () => {
    if (projectId) {
      await db.query(`DELETE FROM tasks WHERE project_id = $1`, [projectId]);
      await db.query(`DELETE FROM technical_decisions WHERE project_id = $1`, [projectId]);
      await db.query(`DELETE FROM projects WHERE id = $1`, [projectId]);
    }
    if (otherProjectId) {
      await db.query(`DELETE FROM tasks WHERE project_id = $1`, [otherProjectId]);
      await db.query(`DELETE FROM projects WHERE id = $1`, [otherProjectId]);
    }
  });

  // ── D1: decision_record.metadata persists + reads back (IMPLEMENT, migration 047) ──
  test('D1: decision_record.metadata round-trips (persist on record → read back on get)', async () => {
    const meta = { ticket: 'RA-9c52', reviewer: 'reviewer', flags: ['drift', 'metadata'] };
    const rec = await viaPublicTool(
      'decision_record',
      {
        decisionType: 'database',
        title: 'Metadata round-trip decision',
        description: 'Proves decision metadata persists',
        rationale: 'Guard the implement call',
        impactLevel: 'low',
        metadata: meta,
        projectId,
      },
      (a) => decisionsRoutes.handleRecord(a),
    );
    // Echoed back on create.
    expect(rec.structuredContent?.decision?.metadata).toEqual(meta);
    const newId = rec.structuredContent?.decision?.id as string;
    expect(newId).toBeTruthy();

    // Independently read back via decision_get (fresh DB read, not the create echo).
    const got = await viaPublicTool(
      'decision_get',
      { decisionId: newId, projectId },
      (a) => decisionsRoutes.handleGet(a),
    );
    expect(got.data?.found).toBe(true);
    expect(got.data?.decision?.metadata).toEqual(meta);

    // And it is genuinely on the row in Postgres (not just in-memory).
    const row = await db.query(
      `SELECT metadata FROM technical_decisions WHERE id = $1`,
      [newId],
    );
    expect(row.rows[0].metadata).toEqual(meta);
  });

  // ── D2/D3/D4: task_list filters (IMPLEMENT phase/statuses; CONFIRM projectId) ──
  describe('task_list filters take effect', () => {
    let phaseTaskId: string;
    let blockedTaskId: string;
    let doneTaskId: string;
    let otherProjTaskId: string;

    beforeAll(async () => {
      // A task tagged phase-7 (for the phase filter).
      phaseTaskId = (await db.query(
        `INSERT INTO tasks (project_id, title, type, priority, status, tags)
         VALUES ($1, 'Phase-7 task', 'general', 'medium', 'todo', ARRAY['phase-7'])
         RETURNING id::text AS id`,
        [projectId]
      )).rows[0].id;
      // A blocked + a completed task (for the statuses multi-filter).
      blockedTaskId = (await db.query(
        `INSERT INTO tasks (project_id, title, type, priority, status)
         VALUES ($1, 'Blocked task', 'general', 'medium', 'blocked')
         RETURNING id::text AS id`,
        [projectId]
      )).rows[0].id;
      doneTaskId = (await db.query(
        `INSERT INTO tasks (project_id, title, type, priority, status)
         VALUES ($1, 'Completed task', 'general', 'medium', 'completed')
         RETURNING id::text AS id`,
        [projectId]
      )).rows[0].id;
      // A task in the OTHER project (for the projectId scope check).
      otherProjTaskId = (await db.query(
        `INSERT INTO tasks (project_id, title, type, priority, status)
         VALUES ($1, 'Other-project task', 'general', 'medium', 'todo')
         RETURNING id::text AS id`,
        [otherProjectId]
      )).rows[0].id;
    });

    test('D2: phase:"7" returns only the phase-7-tagged task', async () => {
      const resp = await viaPublicTool(
        'task_list',
        { phase: '7', projectId },
        (a) => tasksRoutes.handleList(a),
      );
      const ids = listedIds(resp);
      expect(ids).toContain(phaseTaskId);
      expect(ids).not.toContain(blockedTaskId);
      expect(ids).not.toContain(doneTaskId);
    });

    test('D3: statuses:["blocked","completed"] returns exactly those two statuses', async () => {
      const resp = await viaPublicTool(
        'task_list',
        { statuses: ['blocked', 'completed'], projectId },
        (a) => tasksRoutes.handleList(a),
      );
      const ids = listedIds(resp);
      expect(ids).toContain(blockedTaskId);
      expect(ids).toContain(doneTaskId);
      // the phase-7 task is status 'todo' → excluded by the statuses filter.
      expect(ids).not.toContain(phaseTaskId);
    });

    test('D4: projectId project-scopes the list (other project rows excluded)', async () => {
      const resp = await viaPublicTool(
        'task_list',
        { projectId },
        (a) => tasksRoutes.handleList(a),
      );
      const ids = listedIds(resp);
      expect(ids).toContain(phaseTaskId);
      expect(ids).not.toContain(otherProjTaskId);

      // Sanity: querying the OTHER project DOES return its task (proves scoping, not a bug).
      const otherResp = await viaPublicTool(
        'task_list',
        { projectId: otherProjectId },
        (a) => tasksRoutes.handleList(a),
      );
      expect(listedIds(otherResp)).toContain(otherProjTaskId);
    });
  });

  // ── D5: task_create.createdBy persists + reachable under strict mode (IMPLEMENT) ──
  test('D5: task_create.createdBy is accepted (strict mode) and persisted', async () => {
    const resp = await viaPublicTool(
      'task_create',
      { title: 'Has a creator', createdBy: 'builder-agent', projectId },
      (a) => tasksRoutes.handleCreate(a),
    );
    const newId = resp.structuredContent?.task?.id as string;
    expect(newId).toBeTruthy();
    const row = await db.query(`SELECT created_by FROM tasks WHERE id = $1`, [newId]);
    expect(row.rows[0].created_by).toBe('builder-agent');
  });

  // ── D6: task_update.metadata persists + reachable under strict mode (IMPLEMENT) ──
  test('D6: task_update.metadata is accepted (strict mode) and persisted', async () => {
    // STAGE PINNED TO 'draft' (an earlier task clause 10): a bare INSERT naming no `stage` is
    // backfilled to 'ready' by the tasks_sync_stage_status trigger (status='todo' ->
    // stage='ready'), which the completeness gate now correctly refuses a metadata-only
    // write against (ready, no punch fields) — not what this test is exercising.
    const newId = (await db.query(
      `INSERT INTO tasks (project_id, title, type, priority, status, stage)
       VALUES ($1, 'Metadata update target', 'general', 'medium', 'todo', 'draft')
       RETURNING id::text AS id`,
      [projectId]
    )).rows[0].id;

    const meta = { sprint: 42, owner: 'qc' };
    await viaPublicTool(
      'task_update',
      { taskId: newId, metadata: meta, projectId },
      (a) => tasksRoutes.handleUpdate(a),
    );
    const row = await db.query(`SELECT metadata FROM tasks WHERE id = $1`, [newId]);
    expect(row.rows[0].metadata).toEqual(meta);
  });

  // ── D7: smart_search.scope is DEPRECATED → strict mode REJECTS it (no longer a lie) ──
  test('D7: smart_search.scope is no longer accepted (deprecated, strict-mode rejects it)', () => {
    expect(() =>
      validateToolArguments('smart_search', { query: 'anything', scope: 'contexts' }),
    ).toThrow(/scope/);
    // includeTypes — the real source filter — IS still accepted.
    expect(() =>
      validateToolArguments('smart_search', { query: 'anything', includeTypes: ['context'] }),
    ).not.toThrow();
  });
});
