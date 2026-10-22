/**
 * cancel_task Contract Test
 *
 * WHAT THIS PROVES:
 *   `cancelled` is a first-class task lifecycle status (already accepted by task_update /
 *   task_bulk_update, advertised in taskStatusEnum, rendered by task_list/details). This
 *   adds a DEDICATED convenience verb, cancel_task, and locks its end-to-end wiring:
 *   validation schema → route handler → executor case → toolDefinition (+ outputSchema) →
 *   help category. It sets status='cancelled', is project-scoped short-id-resolvable,
 *   is idempotent, and surfaces the SAME actionable not-found as task_update for a bad id
 *   (never a phantom success — updateTaskStatus enforces existence).
 *
 * Driven through the SAME public path the bridge uses (validate → routeExecutor).
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';

import { db } from '../config/database.js';
import { validateToolArguments } from '../middleware/validation.js';
import { routeExecutor } from '../routes/index.js';
import { AIDIS_TOOL_DEFINITIONS, categoryForTool } from '../config/toolDefinitions.js';
import { outputZodSchemas } from '../config/outputSchemas.js';

const STAMP = Date.now();
const PROJ_NAME = `cancel-${STAMP}`;
let projectId: string;
let taskId: string;

async function viaPublicTool(toolName: string, rawArgs: any): Promise<any> {
  const validated = validateToolArguments(toolName, rawArgs);
  return routeExecutor(toolName, validated);
}

describe('cancel_task tool', () => {
  beforeAll(async () => {
    projectId = (
      await db.query(`INSERT INTO projects (name, description) VALUES ($1, 'cancel fuse') RETURNING id`, [PROJ_NAME])
    ).rows[0].id;
    taskId = (
      await db.query(
        `INSERT INTO tasks (project_id, title, type, priority, status) VALUES ($1, 'cancel me', 'general', 'medium', 'todo') RETURNING id`,
        [projectId]
      )
    ).rows[0].id;
  });
  afterAll(async () => {
    await db.query(`DELETE FROM tasks WHERE project_id = $1`, [projectId]);
    await db.query(`DELETE FROM projects WHERE id = $1`, [projectId]);
  });

  // ── Registration / wiring (drift guards) ────────────────────────────────────
  test('cancel_task is a registered, categorized tool with an output schema', () => {
    const def = AIDIS_TOOL_DEFINITIONS.find((d) => d.name === 'cancel_task');
    expect(def, 'cancel_task tool definition').toBeTruthy();
    expect(def!.outputSchema, 'cancel_task outputSchema').toBeTruthy();
    expect('cancel_task' in outputZodSchemas).toBe(true);
    expect(categoryForTool('cancel_task')).toBe('Task Management');
    // taskId is advertised (strict input schema).
    expect(Object.keys(def!.inputSchema.properties)).toContain('taskId');
  });

  // ── Behavior ────────────────────────────────────────────────────────────────
  test('cancels an existing task → status cancelled, persisted', async () => {
    const resp = await viaPublicTool('cancel_task', { projectId, taskId });
    expect(resp.isError).toBeFalsy();
    expect(resp.structuredContent.action).toBe('cancelled');
    expect(resp.structuredContent.task.id).toBe(taskId);
    expect(resp.structuredContent.task.status).toBe('cancelled');

    const row = await db.query(`SELECT status FROM tasks WHERE id = $1`, [taskId]);
    expect(row.rows[0].status).toBe('cancelled');
  });

  test('idempotent: cancelling an already-cancelled task re-affirms without error', async () => {
    const resp = await viaPublicTool('cancel_task', { projectId, taskId });
    expect(resp.isError).toBeFalsy();
    expect(resp.structuredContent.task.status).toBe('cancelled');
  });

  test('short-id resolves and cancels', async () => {
    const t2 = (
      await db.query(
        `INSERT INTO tasks (project_id, title, type, priority, status) VALUES ($1, 't2', 'general', 'medium', 'todo') RETURNING id`,
        [projectId]
      )
    ).rows[0].id;
    const shortId = String(t2).replace(/-/g, '').slice(0, 8);
    const resp = await viaPublicTool('cancel_task', { projectId, taskId: shortId });
    expect(resp.isError).toBeFalsy();
    expect(resp.structuredContent.task.status).toBe('cancelled');
  });

  test('non-existent full UUID → actionable not-found, NOT phantom success', async () => {
    const resp = await viaPublicTool('cancel_task', { projectId, taskId: randomUUID() });
    expect(resp.isError).toBe(true);
    expect(resp.structuredContent.ok).toBe(false);
    expect(resp.structuredContent.found).toBe(false);
    expect(resp.structuredContent.action).toBeUndefined();
  });
});
