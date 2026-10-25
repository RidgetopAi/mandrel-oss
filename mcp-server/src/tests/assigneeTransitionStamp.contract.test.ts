/**
 * assignee TRANSITION STAMP Contract Test — MCP surface (Phase 2).
 *
 * THE DEFECT THIS LOCKS SHUT — `tasks.assigned_to` was written by exactly two things: a
 * caller typing a name, and `task_claim`. Most work does not claim; Coordinator or a Builder
 * moves the status directly. So THE DOER WAS LOST AT COMPLETION TIME. Measured on prod
 * 2026-08-09, project riverbend: 364 of 925 live tasks are `completed` with no assignee.
 *
 * THE SEMANTIC (declared once in config/assigneeStamp.ts; the Command backend carries a
 * byte-pinned mirror, so the two surfaces cannot answer differently):
 *   → in_progress / completed, assignee would be empty: write the session actor
 *   → in_progress / completed, assignee non-empty:      leave it (explicit always wins)
 *   → todo / blocked / cancelled:                       never stamp (unowned is TRUE)
 *   → no derivable actor:                               leave it EMPTY (never a placeholder)
 *   → no status in the update:                          the column is not touched
 *
 * WHY THESE TESTS HAVE TEETH: the observable is the ROW, read with raw SQL; every request
 * goes through the SAME public path the bridge uses (validate → routeExecutor with a real
 * RouteContext carrying the actor), never a direct handler call; the non-stamping
 * population is DERIVED from the tool's own zod status enum, so a sixth status becomes a
 * sixth test rather than a silent hole; and both the single AND the bulk site are covered,
 * because the twin site is where this class keeps recurring (see taskCompletedAtLifecycle).
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';

import { db } from '../config/database.js';
import { validateToolArguments, validationSchemas } from '../middleware/validation.js';
import { routeExecutor } from '../routes/index.js';
import { ASSIGNEE_STAMP_CONFIG } from '../config/assigneeStamp.js';
import { cap } from '../config/fieldLimits.js';

/** The status enum the validator actually enforces (same unwrap the shipped code uses). */
const zodStatusOptions = (tool: string): string[] => {
  let schema: any = (validationSchemas as any)[tool];
  while (schema?._def?.typeName === 'ZodEffects') schema = schema._def.schema;
  let field: any = schema.shape.status;
  while (field && typeof field.unwrap === 'function') field = field.unwrap();
  return field.options ?? field._def?.values;
};

const STATUSES = zodStatusOptions('task_update');
const STAMPING = [...ASSIGNEE_STAMP_CONFIG.stampOnStatuses];
const NON_STAMPING = STATUSES.filter((s) => !STAMPING.includes(s));

const ACTOR = 'builder-0544f00d';
const PROJ_NAME = `assignee-stamp-${Date.now()}`;
let projectId: string;

/** Drive the tool exactly as the bridge does, with a RouteContext carrying the actor. */
async function viaPublicTool(toolName: string, rawArgs: any, actor?: string): Promise<any> {
  const validated = validateToolArguments(toolName, rawArgs);
  return routeExecutor(toolName, validated, actor === undefined ? undefined : { actor });
}

async function makeTask(status: string, assignedTo: string | null = null): Promise<string> {
  const res = await db.query(
    `INSERT INTO tasks (project_id, title, type, priority, status, assigned_to)
     VALUES ($1, 'assignee transition stamp fuse', 'general', 'medium', $2, $3)
     RETURNING id`,
    [projectId, status, assignedTo]
  );
  return res.rows[0].id;
}

async function readAssignee(id: string): Promise<string | null> {
  const res = await db.query(`SELECT assigned_to FROM tasks WHERE id = $1`, [id]);
  expect(res.rows).toHaveLength(1);
  return res.rows[0].assigned_to;
}

beforeAll(async () => {
  projectId = (
    await db.query(
      `INSERT INTO projects (name, description) VALUES ($1, 'assignee transition stamp fuse') RETURNING id`,
      [PROJ_NAME]
    )
  ).rows[0].id;
});

afterAll(async () => {
  await db.query(`DELETE FROM tasks WHERE project_id = $1`, [projectId]);
  await db.query(`DELETE FROM projects WHERE id = $1`, [projectId]);
});

describe('the population this file guards', () => {
  test('the stamping statuses are exactly in_progress + completed', () => {
    expect([...STAMPING].sort()).toEqual(['completed', 'in_progress']);
  });

  test('the non-stamping statuses are DERIVED from the tool enum and non-empty', () => {
    // The empty population is the one that slips through: if the unwrap ever returned
    // nothing, the generated tables below would be zero cases passing vacuously.
    expect(STATUSES.length).toBeGreaterThanOrEqual(5);
    expect(NON_STAMPING.length).toBe(STATUSES.length - 2);
    expect([...NON_STAMPING].sort()).toEqual(['blocked', 'cancelled', 'todo']);
  });
});

describe('transition stamp — SINGLE path (task_update)', () => {
  test.each(STAMPING)('todo → %s stamps the session actor into an EMPTY assignee', async (status) => {
    const id = await makeTask('todo');
    expect(await readAssignee(id)).toBeNull(); // positive control: started empty

    // a `blocked` destination must now NAME its blocker. Supplied only for
    // that member so the generated population — and therefore this test's whole point, that
    // the population IS the enum — is untouched.
    const resp = await viaPublicTool(
      'task_update',
      { projectId, taskId: id, status, ...(status === 'blocked' ? { blockedOn: 'agent' } : {}) },
      ACTOR,
    );
    expect(resp.isError).toBeFalsy();
    expect(await readAssignee(id)).toBe(ACTOR);
  });

  test('a WHITESPACE-ONLY assignee counts as empty', async () => {
    const id = await makeTask('todo', '   ');
    expect(await readAssignee(id)).toBe('   ');
    await viaPublicTool('task_update', { projectId, taskId: id, status: 'completed' }, ACTOR);
    expect(await readAssignee(id)).toBe(ACTOR);
  });

  test.each(STAMPING)('an existing owner is NOT overwritten on a move to %s', async (status) => {
    const id = await makeTask('todo', 'operator');
    // a `blocked` destination must now NAME its blocker. Supplied only for
    // that member so the generated population — and therefore this test's whole point, that
    // the population IS the enum — is untouched.
    const resp = await viaPublicTool(
      'task_update',
      { projectId, taskId: id, status, ...(status === 'blocked' ? { blockedOn: 'agent' } : {}) },
      ACTOR,
    );
    expect(resp.isError).toBeFalsy();
    expect(await readAssignee(id)).toBe('operator');
  });

  test('an assignee set in the SAME call wins over the stamp', async () => {
    const id = await makeTask('todo');
    await viaPublicTool(
      'task_update',
      { projectId, taskId: id, status: 'completed', assignedTo: 'carol' },
      ACTOR
    );
    expect(await readAssignee(id)).toBe('carol');
  });

  test.each(NON_STAMPING)('todo → %s does NOT stamp — unowned backlog stays expressible', async (status) => {
    const id = await makeTask('todo');
    // a `blocked` destination must now NAME its blocker. Supplied only for
    // that member so the generated population — and therefore this test's whole point, that
    // the population IS the enum — is untouched.
    const resp = await viaPublicTool(
      'task_update',
      { projectId, taskId: id, status, ...(status === 'blocked' ? { blockedOn: 'agent' } : {}) },
      ACTOR,
    );
    expect(resp.isError).toBeFalsy();
    expect(await readAssignee(id)).toBeNull();
  });

  test('an update with NO status does not touch the column', async () => {
    const id = await makeTask('in_progress');
    const resp = await viaPublicTool('task_update', { projectId, taskId: id, priority: 'high' }, ACTOR);
    expect(resp.isError).toBeFalsy();
    expect(await readAssignee(id)).toBeNull();
    // …and the edit it DID ask for landed, so this is not passing on a rejected call.
    const row = await db.query('SELECT priority FROM tasks WHERE id = $1', [id]);
    expect(row.rows[0].priority).toBe('high');
  });

  test.each([undefined, '', '   '])(
    'no derivable actor (%p) leaves it EMPTY — never a placeholder',
    async (actor) => {
      const id = await makeTask('todo');
      const resp = await viaPublicTool('task_update', { projectId, taskId: id, status: 'completed' }, actor);
      expect(resp.isError).toBeFalsy();
      expect(await readAssignee(id)).toBeNull();
      // Refusing to stamp must never refuse the update itself.
      const row = await db.query('SELECT status FROM tasks WHERE id = $1', [id]);
      expect(row.rows[0].status).toBe('completed');
    }
  );

  test('an OVER-LENGTH actor is dropped rather than detonating the update', async () => {
    // A composite actor (`<oauth-sub>/<handle>`) can exceed varchar(200). Stamping it would
    // turn a valid status change into a raw Postgres 22001 surfaced as a 500.
    const id = await makeTask('todo');
    const tooLong = 'a'.repeat(cap('tasks.assigned_to') + 1);
    const resp = await viaPublicTool('task_update', { projectId, taskId: id, status: 'completed' }, tooLong);
    expect(resp.isError).toBeFalsy();
    expect(await readAssignee(id)).toBeNull();
  });
});

describe('transition stamp — BULK path (task_bulk_update), the twin site', () => {
  test('stamps only the EMPTY rows of the batch, per row', async () => {
    const empty = await makeTask('todo');
    const owned = await makeTask('todo', 'operator');

    const resp = await viaPublicTool(
      'task_bulk_update',
      { projectId, task_ids: [empty, owned], status: 'completed' },
      ACTOR
    );
    expect(resp.isError).toBeFalsy();

    expect(await readAssignee(empty)).toBe(ACTOR);
    expect(await readAssignee(owned)).toBe('operator');
  });

  test.each(NON_STAMPING)('a bulk move to %s does NOT stamp', async (status) => {
    const id = await makeTask('todo');
    // a `blocked` destination must now NAME its blocker, on the bulk path too.
    const resp = await viaPublicTool(
      'task_bulk_update',
      { projectId, task_ids: [id], status, ...(status === 'blocked' ? { blockedOn: 'agent' } : {}) },
      ACTOR,
    );
    expect(resp.isError).toBeFalsy();
    expect(await readAssignee(id)).toBeNull();
  });

  test('a bulk call with no derivable actor leaves it EMPTY', async () => {
    const id = await makeTask('todo');
    const resp = await viaPublicTool('task_bulk_update', { projectId, task_ids: [id], status: 'completed' });
    expect(resp.isError).toBeFalsy();
    expect(await readAssignee(id)).toBeNull();
  });

  test('a bulk assignedTo set in the SAME call wins over the stamp', async () => {
    const id = await makeTask('todo');
    await viaPublicTool(
      'task_bulk_update',
      { projectId, task_ids: [id], status: 'completed', assignedTo: 'carol' },
      ACTOR
    );
    expect(await readAssignee(id)).toBe('carol');
  });
});
