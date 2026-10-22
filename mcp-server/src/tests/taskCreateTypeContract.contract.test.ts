/**
 * task_create Type-Surfacing Contract Test  (the executable fuse for 36aa0549)
 *
 * THE BUG (a tool-use-eval wrong-success, same schema-from-zod class as the
 * retrieval drift):
 *   The model-facing MCP `inputSchema` for `task_create` in config/toolDefinitions.ts
 *   was HAND-WRITTEN and advertised ONLY `title`. The zod validator
 *   (middleware/validation.ts → taskSchemas.create) AND the handler/route already
 *   accepted `type` (with a full enum), `priority`, `description`, `assignedTo`,
 *   `tags`, etc. Because the model never SAW `type`, an agent asked to "create a bug"
 *   omitted it, the handler's `.default('general')` won, and the agent reported
 *   success believing it had made a `bug` — a silent wrong-success. task_update
 *   cannot change `type` afterward, so the mistake is unrecoverable through the tools.
 *
 * THE FIX (class fix, not instance):
 *   toolDefinitions.ts now DERIVES task_create's inputSchema from the zod validator
 *   (buildInputSchema), so every accepted/validated field — `type` with its enum
 *   included — is advertised to the model and can never silently drift again. The
 *   previously-accepted-but-unwired `status` field was wired through route→handler so
 *   declared == zod == handler-reads across the whole field set.
 *
 * WHAT THIS PROVES (real Postgres, zero SQL on the write path):
 *   Driving the EXACT public path the HTTP bridge uses —
 *   validateToolArguments('task_create', {... type:'bug'}) THEN
 *   tasksRoutes.handleCreate(validated) — produces a task whose DB `type` column is
 *   'bug' (NOT 'general'). On the pre-fix code the model would never have sent `type`;
 *   this test sends it through the validator (which already accepted it) and asserts
 *   it survives to the row — and the companion schema test asserts the model can now
 *   SEE it.
 *
 * DB target: the disposable migrated Postgres from the CI gate stage 0b. Run via:
 *   DATABASE_HOST=127.0.0.1 DATABASE_PORT=15432 DATABASE_NAME=ci_xxx \
 *   DATABASE_USER=mandrel DATABASE_PASSWORD=*** \
 *   npx vitest run src/tests/taskCreateTypeContract.contract.test.ts
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';

import { db } from '../config/database.js';
import { tasksRoutes } from '../routes/tasks.routes.js';
import { validateToolArguments } from '../middleware/validation.js';
import { AIDIS_TOOL_DEFINITIONS } from '../config/toolDefinitions.js';

const STAMP = Date.now();
const PROJ_NAME = `task-create-type-${STAMP}`;

let projectId: string;

function textOf(resp: any): string {
  return resp?.content?.map((c: any) => c.text).join('\n') ?? '';
}

/** Extract the task UUID this route prints (`ID: <uuid>`). */
function idFromCreateText(text: string): string {
  const m = text.match(/\bID:\s*([0-9a-f-]{36})/i);
  expect(m, 'create response must include the task UUID').toBeTruthy();
  return m![1];
}

/** Run a tool through the SAME path the HTTP bridge uses: validate THEN route. */
async function viaPublicTool(toolName: string, rawArgs: any, handler: (a: any) => Promise<any>) {
  const validated = validateToolArguments(toolName, rawArgs);
  return handler(validated);
}

describe('task_create type-surfacing contract (36aa0549 fuse, zero SQL on write)', () => {
  beforeAll(async () => {
    projectId = (await db.query(
      `INSERT INTO projects (name, description) VALUES ($1, 'task_create type fuse') RETURNING id`,
      [PROJ_NAME]
    )).rows[0].id;
  });

  afterAll(async () => {
    if (projectId) {
      try { await db.query('DELETE FROM tasks WHERE project_id = $1', [projectId]); } catch { /* ignore */ }
      try { await db.query('DELETE FROM sessions WHERE project_id = $1', [projectId]); } catch { /* ignore */ }
      try { await db.query('DELETE FROM projects WHERE id = $1', [projectId]); } catch { /* ignore */ }
    }
    await db.end();
  });

  test("MOAT: task_create(type:'bug') via validate→route persists DB type='bug' (not 'general')", async () => {
    // The headline reproduction: an agent that PASSES type:'bug' (now possible because
    // the schema advertises it) must get a 'bug' task — not the silent 'general' default.
    const resp = await viaPublicTool(
      'task_create',
      { title: `Fix the login crash ${STAMP}`, type: 'bug', projectId },
      (a) => tasksRoutes.handleCreate(a)
    );
    const text = textOf(resp);
    expect(text).toContain('Task created successfully');
    expect(text).toContain('Type: bug');
    const taskId = idFromCreateText(text);

    // Authoritative check: read the DB `type` column directly (read-only assertion).
    const row = (await db.query('SELECT type, status, priority FROM tasks WHERE id = $1', [taskId])).rows[0];
    expect(row, 'created task row must exist').toBeTruthy();
    expect(row.type).toBe('bug');
    // Untouched fields still take their documented defaults.
    expect(row.status).toBe('todo');
    expect(row.priority).toBe('medium');
  });

  test("DEFAULT: omitting type still yields 'general' (default behavior preserved)", async () => {
    const resp = await viaPublicTool(
      'task_create',
      { title: `Some generic task ${STAMP}`, projectId },
      (a) => tasksRoutes.handleCreate(a)
    );
    const taskId = idFromCreateText(textOf(resp));
    const row = (await db.query('SELECT type FROM tasks WHERE id = $1', [taskId])).rows[0];
    expect(row.type).toBe('general');
  });

  test('SWEEP: priority/description/status all survive validate→route (no silent drop)', async () => {
    // Every previously-hidden-but-accepted field the fix surfaced must round-trip.
    const resp = await viaPublicTool(
      'task_create',
      {
        title: `Refactor the auth module ${STAMP}`,
        type: 'refactor',
        priority: 'high',
        description: 'Split the monolithic auth handler into focused units',
        status: 'in_progress',
        projectId,
      },
      (a) => tasksRoutes.handleCreate(a)
    );
    const taskId = idFromCreateText(textOf(resp));
    const row = (await db.query(
      'SELECT type, priority, description, status FROM tasks WHERE id = $1',
      [taskId]
    )).rows[0];
    expect(row.type).toBe('refactor');
    expect(row.priority).toBe('high');
    expect(row.description).toBe('Split the monolithic auth handler into focused units');
    expect(row.status).toBe('in_progress');
  });

  test('SCHEMA: task_create inputSchema advertises type+enum and the full accepted field set', () => {
    // Guards the model-facing surface (no DB): the agent can actually SEE `type`.
    const def = AIDIS_TOOL_DEFINITIONS.find(t => t.name === 'task_create')!;
    const props = def.inputSchema.properties as Record<string, any>;
    expect(Object.keys(props).sort()).toEqual(
      // DRIFT-CLEANUP: createdBy added — a real tasks.created_by column the
      // handler writes, now declared so it's reachable under strict mode.
      // T5a PARITY: `links` added — the explicit-edge write param that
      // context_store/decision_record already advertised.
      // `parentTaskId` added — the declared structural parent (the ONLY
      // source of a subtask_of edge; position never mints it).
      // P5.5 (migration 093): `blockedOn` + `dueAt` added — "waiting on a human" stops being
      // a four-tag convention a customer has to invent and becomes a FIELD the briefing
      // selects on with a WHERE clause. Purely additive: nothing renamed, nothing removed.
      // migration 101: `stage` + `punch` added — the Punch List lane.
      ['assignedTo', 'blockedOn', 'createdBy', 'dependencies', 'description', 'dueAt', 'links', 'metadata', 'parentTaskId', 'priority', 'projectId', 'status', 'tags', 'title', 'type', 'stage', 'punch'].sort()
    );
    expect(props.type.enum).toContain('bug');
    expect(props.type.enum).toContain('general');
  });
});
