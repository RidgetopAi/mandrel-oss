/**
 * task_update CAN RE-CLASSIFY A TASK — contract test (batch-5 lane K).
 *
 * THE DEFECT THIS LOCKS SHUT
 *   `tasks.type` is a real column that task_create writes and task_list FILTERS ON, and
 *   nothing could change it after the fact. It was missing from BOTH ends at once:
 *     · middleware/validation.ts `taskSchemas.update` never declared it, and validation is
 *       STRICT — an undeclared param is REJECTED, not stripped; and
 *     · handlers/tasks.ts `updateTaskStatus` had no `type = $n` clause at all, so there was
 *       no write path to reach even if it had been declared.
 *   It stayed invisible while the Command backend wrote the column with its own raw SQL.
 *   The moment that backend delegates its update to this tool (batch-5 lane F, which is the
 *   right fix), the TaskDrawer's type control breaks — a capability lost to a correct
 *   refactor. This file fails on any tree without BOTH ends of the fix.
 *
 * AND THE CLASS, MADE EXECUTABLE
 *   validation.ts already carries a comment about `decision_update` where "the zod schema
 *   declared `outcome`/`lessons` but the route handler reads outcomeStatus/… → the real
 *   params were SILENTLY STRIPPED", called a "declared==handler boundary" fix. Four such
 *   drifts are catalogued in that one file, each found by hand, one field at a time. So the
 *   last test here stops hand-matching: it ENUMERATES task_update's declared params from the
 *   schema itself and drives each one, ALONE, through the public tool path, asserting the
 *   database actually moved. A future param declared with no write path fails here without
 *   anyone remembering to add a case — and a declared param this file cannot classify is a
 *   FAILURE, never a silent skip (an unresolvable input is a finding, not a pass).
 *
 * Driven through the SAME public path the bridge uses (validate -> routeExecutor), on the
 * real migrated disposable ci_* DB.
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';

import { db } from '../config/database.js';
import { validateToolArguments, validationSchemas } from '../middleware/validation.js';
import { routeExecutor } from '../routes/index.js';
import { activeEmbedder, activeEmbeddingColumn } from '../config/embeddingConfig.js';

const STAMP = Date.now();
const PROJ_NAME = `taskupd-type-${STAMP}`;
let projectId: string;

async function viaPublicTool(toolName: string, rawArgs: any): Promise<any> {
  const validated = validateToolArguments(toolName, rawArgs);
  return routeExecutor(toolName, validated);
}

/**
 * A fresh task row, inserted directly so no probe depends on another probe's edits.
 *
 * STAGE PINNED TO 'draft' (an earlier task clause 10): a bare INSERT naming no `stage` is
 * backfilled to 'ready' by the tasks_sync_stage_status trigger (migration 101, status='todo'
 * -> stage='ready'). Once the completeness gate is keyed on the MERGED row's stage rather
 * than only the call's own `stage` argument, an unrelated field-only update against such a
 * row is correctly refused (the row is `ready` with no punch fields) — a gate defect this
 * file's probes are not testing. Pinning `stage='draft'` here keeps these probes about
 * "does the field write", not "is this row punch-complete".
 */
async function newTask(title: string, type = 'general'): Promise<string> {
  const r = await db.query(
    `INSERT INTO tasks (project_id, title, type, priority, status, stage)
     VALUES ($1, $2, $3, 'medium', 'todo', 'draft') RETURNING id`,
    [projectId, title, type],
  );
  return r.rows[0].id;
}

/** Unwrap zod wrappers (.optional(), .default(), …) down to the enum that carries values. */
function enumValues(schema: any): string[] {
  let node = schema;
  for (let i = 0; i < 8 && node?._def; i++) {
    if (Array.isArray(node._def.values)) return [...node._def.values];
    node = node._def.innerType ?? node._def.schema ?? node._def.type;
  }
  throw new Error('no enum values found on schema');
}

/** task_update is a ZodEffects (the "at least one field" refine) wrapping the object. */
function updateShape(): Record<string, any> {
  const s: any = validationSchemas.task_update;
  return (s.shape ?? s._def.schema.shape) as Record<string, any>;
}

describe('task_update re-classifies a task (batch-5 lane K)', () => {
  beforeAll(async () => {
    projectId = (
      await db.query(
        `INSERT INTO projects (name, description) VALUES ($1, 'lane K type fuse') RETURNING id`,
        [PROJ_NAME],
      )
    ).rows[0].id;
  });

  afterAll(async () => {
    await db.query(`DELETE FROM tasks WHERE project_id = $1`, [projectId]);
    await db.query(`DELETE FROM projects WHERE id = $1`, [projectId]);
  });

  // ── THE REGRESSION ITSELF ────────────────────────────────────────────────────────────
  test('type ALONE is a legal update and lands in the column', async () => {
    const taskId = await newTask('retype me');

    const resp = await viaPublicTool('task_update', { projectId, taskId, type: 'bugfix' });

    expect(resp.isError).toBeFalsy();
    expect(resp.structuredContent.action).toBe('updated');
    const row = await db.query(`SELECT type FROM tasks WHERE id = $1`, [taskId]);
    expect(row.rows[0].type).toBe('bugfix');
  });

  test('an update that does not mention type leaves the column alone', async () => {
    const taskId = await newTask('keep my type', 'feature');

    await viaPublicTool('task_update', { projectId, taskId, status: 'in_progress' });

    const row = await db.query(`SELECT type, status FROM tasks WHERE id = $1`, [taskId]);
    expect(row.rows[0].type).toBe('feature');
    expect(row.rows[0].status).toBe('in_progress');
  });

  test('an out-of-enum type is refused at the EDGE, and nothing is written', async () => {
    const taskId = await newTask('bad type', 'feature');

    expect(() =>
      validateToolArguments('task_update', { projectId, taskId, type: 'not-a-real-type' }),
    ).toThrow();

    const row = await db.query(`SELECT type FROM tasks WHERE id = $1`, [taskId]);
    expect(row.rows[0].type).toBe('feature');
  });

  test('create and update accept the IDENTICAL value set (one enum, not two copies)', () => {
    const createType = (validationSchemas.task_create as any).shape.type;
    const updateType = updateShape().type;
    expect(updateType).toBeDefined();
    expect(enumValues(updateType)).toEqual(enumValues(createType));
  });

  // ── THE SIDE EFFECT THAT WOULD HAVE ROTTED SILENTLY ──────────────────────────────────
  // services/embedding/taskEmbeddingText.ts reads `type` into the embed text, and
  // updateTaskStatus only re-embeds when a field the text READS changed. Adding the write
  // path without adding `type` to that trigger set would leave every re-typed task
  // retrievable forever under its OLD type, with nothing NULL for the self-heal worker to
  // notice. A sentinel vector makes the branch observable whether the embedder answers
  // (re-embedded) or is down (NULLed as the needs-reembed marker) — the ONE thing that must
  // not happen is the vector surviving the edit unchanged.
  test('re-typing invalidates the stored embedding (the re-embed trigger includes type)', async () => {
    const taskId = await newTask('embed me');
    const col = activeEmbeddingColumn();
    const sentinel = `[${new Array(activeEmbedder().dimensions).fill(0.125).join(',')}]`;
    await db.query(`UPDATE tasks SET ${col} = $1::vector WHERE id = $2`, [sentinel, taskId]);

    const before = await db.query(`SELECT ${col}::text AS v FROM tasks WHERE id = $1`, [taskId]);
    expect(before.rows[0].v).not.toBeNull(); // the sentinel really is in the row

    await viaPublicTool('task_update', { projectId, taskId, type: 'devops' });

    const after = await db.query(`SELECT ${col}::text AS v FROM tasks WHERE id = $1`, [taskId]);
    expect(after.rows[0].v).not.toBe(before.rows[0].v);
  });

  // ── DECLARED == HANDLER, ENUMERATED FROM THE SCHEMA ──────────────────────────────────
  // Population: every key of taskSchemas.update. Each is either NOT an updatable field (it
  // scopes or fences the call) or it must be provable to WRITE. There is no third bucket:
  // an unclassified key fails, so the guard cannot silently shrink when a param is added.
  describe('every declared updatable param actually writes (declared == handler)', () => {
    /** Declared, but not a field to update: these scope the lookup or fence the write. */
    const NOT_A_FIELD = new Set(['taskId', 'projectId', 'claimId', 'force']);

    /**
     * A real task for `dependencies` to point AT. Resolved lazily via the getter below,
     * because this table is built when the describe body evaluates — before any beforeAll has
     * run — so a plain `value: depTarget` would capture undefined and the probe would assert
     * against a dependency that does not exist.
     */
    let depTarget = '';
    beforeAll(async () => { depTarget = await newTask('probe dependency target'); });

    /** field -> the value to send ALONE, and what must be observable afterwards. */
    const PROBES: Record<string, { value: any; changed: (row: any) => boolean }> = {
      status:      { value: 'in_progress', changed: r => r.status === 'in_progress' },
      priority:    { value: 'urgent',      changed: r => r.priority === 'urgent' },
      type:        { value: 'refactor',    changed: r => r.type === 'refactor' },
      assignedTo:  { value: 'lane-k',      changed: r => r.assigned_to === 'lane-k' },
      progress:    { value: 42,            changed: r => Number(r.progress) === 42 },
      title:       { value: 'probe title', changed: r => r.title === 'probe title' },
      description: { value: 'probe desc',  changed: r => r.description === 'probe desc' },
      tags:        { value: ['lanek'],     changed: r => (r.tags ?? []).includes('lanek') },
      metadata:    { value: { laneK: 'p' }, changed: r => r.metadata?.laneK === 'p' },
      // notes APPENDS to metadata.noteLog and never touches description.
      notes:       { value: 'probe note',  changed: r => (r.metadata?.noteLog ?? []).length === 1 },
      blockedOn:   { value: 'human',       changed: r => r.blocked_on === 'human' },
      dueAt:       { value: '2027-01-02T03:04:05.000Z', changed: r => r.due_at !== null },
      // `dependencies` became updatable. It was WRITE-ONCE AT CREATE — declared
      // on task_create, absent from this schema AND from the handler's SET builder — so a task
      // could never acquire a dependency after being filed, which is exactly when a task
      // becomes blocked. A getter, not a literal: see depTarget above.
      dependencies: {
        get value() { return [depTarget]; },
        changed: r => Array.isArray(r.dependencies) && r.dependencies.includes(depTarget),
      },
      // migration 101: stage is a real column, source of truth over
      // status (tasks_stage_status_sync derives status FROM it — 'claimed' -> 'in_progress').
      stage: { value: 'claimed', changed: r => r.stage === 'claimed' && r.status === 'in_progress' },
      // `punch` shallow-merges into metadata.punch (utils/punchMerge.ts).
      punch: {
        value: { doneWhen: 'probe done', proofKind: 'test' },
        changed: r => r.metadata?.punch?.doneWhen === 'probe done' && r.metadata?.punch?.proofKind === 'test',
      },
    };

    const declared = Object.keys(updateShape());

    test('every declared param is classified — an unknown one is a FINDING, not a skip', () => {
      const unclassified = declared.filter(k => !NOT_A_FIELD.has(k) && !(k in PROBES));
      expect(unclassified).toEqual([]);
      // and the probe table may not carry a field the schema no longer declares
      expect(Object.keys(PROBES).filter(k => !declared.includes(k))).toEqual([]);
    });

    for (const field of Object.keys(PROBES)) {
      test(`${field} alone is accepted and persists`, async () => {
        const taskId = await newTask(`probe ${field}`);
        const probe = PROBES[field];

        const resp = await viaPublicTool('task_update', {
          projectId,
          taskId,
          [field]: probe.value,
        });
        expect(resp.isError).toBeFalsy();

        const row = (await db.query(`SELECT * FROM tasks WHERE id = $1`, [taskId])).rows[0];
        expect(probe.changed(row)).toBe(true);
      });
    }
  });
});
