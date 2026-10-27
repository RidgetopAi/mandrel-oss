/**
 * task_create `dependencies` short-id resolution contract  (fuse for an earlier change)
 *
 * THE BUG (hit live 2026-07-16): task_create({dependencies:["an earlier change"]}) →
 *   "❌ Error: invalid input syntax for type uuid: an earlier change"
 * The 8-hex short id is the form we SHOW everywhere and every OTHER id-taking tool
 * accepts (link/get_links/task_update/task_details/…) via the ONE shared resolver — but
 * `dependencies` passed its raw strings straight into the `dependencies uuid[]` column and
 * let a Postgres cast blow up with a LEAKED DB-level error.
 *
 * THE FIX (whole class, not the instance): handleCreate resolves each dependency (full
 * UUID OR id8) → full UUID via resolveEntityId, project-scoped, BEFORE the INSERT; an
 * unknown/ambiguous id returns a TOOL-level actionable error (idErrorResponse), never a
 * raw DB cast error.
 *
 * WHAT THIS PROVES (real Postgres, driving the PUBLIC path: validate → route):
 *   1. dependencies:["<id8>"] resolves to the full UUID and persists in the uuid[] column.
 *   2. a syntactically-valid-but-UNKNOWN id returns a tool-level not-found (isError),
 *      NOT the raw "invalid input syntax for type uuid" Postgres message.
 *
 * DB target: the disposable migrated Postgres from the CI gate stage 0b.
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';

import { db } from '../config/database.js';
import { tasksRoutes } from '../routes/tasks.routes.js';
import { validateToolArguments } from '../middleware/validation.js';

const STAMP = Date.now();
const PROJ_NAME = `task-dep-resolve-${STAMP}`;

let projectId: string;

function textOf(resp: any): string {
  return resp?.content?.map((c: any) => c.text).join('\n') ?? '';
}
function idFromCreateText(text: string): string {
  const m = text.match(/\bID:\s*([0-9a-f-]{36})/i);
  expect(m, 'create response must include the task UUID').toBeTruthy();
  return m![1];
}
async function viaPublicTool(toolName: string, rawArgs: any, handler: (a: any) => Promise<any>) {
  const validated = validateToolArguments(toolName, rawArgs);
  return handler(validated);
}

describe('task_create dependencies id8 resolution (an earlier change fuse, zero SQL on write)', () => {
  beforeAll(async () => {
    projectId = (await db.query(
      `INSERT INTO projects (name, description) VALUES ($1, 'task_create dep resolve fuse') RETURNING id`,
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

  test('MOAT: dependencies:["<id8>"] resolves to the full UUID and persists in uuid[]', async () => {
    // Create the prerequisite task, capture its full UUID + derive the id8 we SHOW.
    const depResp = await viaPublicTool(
      'task_create',
      { title: `prerequisite ${STAMP}`, projectId },
      (a) => tasksRoutes.handleCreate(a)
    );
    const depFullId = idFromCreateText(textOf(depResp));
    const depId8 = depFullId.slice(0, 8);

    // The reproduction: pass the id8 (previously → raw Postgres uuid cast error).
    const resp = await viaPublicTool(
      'task_create',
      { title: `dependent ${STAMP}`, dependencies: [depId8], projectId },
      (a) => tasksRoutes.handleCreate(a)
    );
    const text = textOf(resp);
    expect(text).toContain('Task created successfully');
    // NO leaked Postgres cast error.
    expect(text).not.toMatch(/invalid input syntax for type uuid/i);
    const taskId = idFromCreateText(text);

    // Authoritative: the uuid[] column holds the RESOLVED full UUID, not the id8.
    const row = (await db.query('SELECT dependencies FROM tasks WHERE id = $1', [taskId])).rows[0];
    expect(row, 'created task row must exist').toBeTruthy();
    expect(row.dependencies).toEqual([depFullId]);
  });

  test('a full-UUID dependency still resolves + persists (back-compat)', async () => {
    const depResp = await viaPublicTool(
      'task_create',
      { title: `prereq-full ${STAMP}`, projectId },
      (a) => tasksRoutes.handleCreate(a)
    );
    const depFullId = idFromCreateText(textOf(depResp));

    const resp = await viaPublicTool(
      'task_create',
      { title: `dependent-full ${STAMP}`, dependencies: [depFullId], projectId },
      (a) => tasksRoutes.handleCreate(a)
    );
    const taskId = idFromCreateText(textOf(resp));
    const row = (await db.query('SELECT dependencies FROM tasks WHERE id = $1', [taskId])).rows[0];
    expect(row.dependencies).toEqual([depFullId]);
  });

  test('an UNKNOWN id returns a TOOL-level not-found — NEVER a raw Postgres cast error', async () => {
    // A syntactically valid id8 (hex, passes zod shape) that matches no task in-project.
    const resp = await viaPublicTool(
      'task_create',
      { title: `bad-dep ${STAMP}`, dependencies: ['deadbeef'], projectId },
      (a) => tasksRoutes.handleCreate(a)
    );
    const text = textOf(resp);
    expect(resp.isError).toBe(true);
    // Tool-level actionable message, not a leaked DB error.
    expect(text).toMatch(/not found/i);
    expect(text).not.toMatch(/invalid input syntax for type uuid/i);
    // And nothing was written (the create aborted before the INSERT).
    const cnt = (await db.query(
      `SELECT count(*)::int AS n FROM tasks WHERE project_id = $1 AND title = $2`,
      [projectId, `bad-dep ${STAMP}`]
    )).rows[0].n;
    expect(cnt).toBe(0);
  });
});
