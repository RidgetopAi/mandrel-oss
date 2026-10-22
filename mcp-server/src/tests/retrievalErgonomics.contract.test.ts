/**
 * Retrieval Ergonomics Contract Test (tags-only search + task_list limit)
 *
 * Drives the REAL route handlers + zod validator against a REAL migrated Postgres
 * (the disposable ci_* DB from the CI gate — never production). Embeddings are
 * stubbed (no native sharp/transformers in CI), but every DB read/write is real.
 *
 * PROVES:
 *  1. zod accepts a TAGS-ONLY context_search (no id, no query) — the relaxed
 *     .refine. Previously it threw "Either 'id' or 'query' must be provided".
 *  2. context_search({tags:[...]}) returns the matching context via the existing
 *     `tags && $1` GIN filter — NO dummy query needed.
 *  3. task_list `limit` is now applied (LIMIT in SQL): limit:N returns at most N
 *     even when more tasks exist. Previously `limit` was a silent no-op.
 *  4. task_list `assignedTo` filter is now applied end-to-end (zod declares it,
 *     the route handler reads it, it reaches the SQL `assigned_to = $n` WHERE).
 *     Previously zod declared `assignedAgent` while the handler read `assignedTo`,
 *     so zod .parse() STRIPPED assignedTo → undefined → the filter never applied
 *     and EVERY task was returned regardless of assignee (a past incident class:
 *     declared-vs-handler boundary drift).
 */

import { describe, test, expect, beforeAll, afterAll, vi } from 'vitest';
import { embedDim, patternEmbedding } from './helpers/embedGeometry.js';

// Stub embeddings (same approach as smartSearchRetrieval.contract.test.ts).
vi.mock('../services/embedding.js', () => ({
  embeddingService: {
    generateEmbedding: vi.fn(async () => ({
      embedding: patternEmbedding(),
      dimensions: embedDim(),
      model: 'mock',
    })),
  },
}));

import { db } from '../config/database.js';
import { contextHandler } from '../handlers/context.js';
import { tasksHandler } from '../handlers/tasks.js';
import { contextRoutes } from '../routes/context.routes.js';
import { tasksRoutes } from '../routes/tasks.routes.js';
import { validateToolArguments } from '../middleware/validation.js';

const STAMP = Date.now();
const PROJ_NAME = `retrieval-ergonomics-${STAMP}`;
const REF_TAG = `ref:cp-gaps-${STAMP}`;
const ASSIGNEE_A = `builder-${STAMP}`;
const ASSIGNEE_B = `reviewer-${STAMP}`;

let projectId: string;

function textOf(resp: any): string {
  return resp?.content?.map((c: any) => c.text).join('\n') ?? '';
}

describe('retrieval ergonomics: tags-only search + task_list limit', () => {
  beforeAll(async () => {
    projectId = (await db.query(
      `INSERT INTO projects (name, description) VALUES ($1, 'retrieval ergonomics fuse') RETURNING id`,
      [PROJ_NAME]
    )).rows[0].id;

    // One context carrying the ref: tag (the tags-only target), plus a decoy.
    await contextHandler.storeContext({
      projectId, type: 'milestone',
      content: 'The cross-project gaps milestone we want to fetch by tag alone',
      tags: [REF_TAG, 'milestone'],
    });
    await contextHandler.storeContext({
      projectId, type: 'discussion',
      content: 'An unrelated context that must NOT match the ref tag',
      tags: ['unrelated'],
    });

    // Five tasks so a LIMIT actually has something to cut.
    for (let i = 0; i < 5; i++) {
      await tasksHandler.createTask(projectId, `limit-test task ${i}`, undefined, 'general', 'medium');
    }

    // Distinctly-assigned tasks for the assignee-filter test. ASSIGNEE_A is a
    // non-UUID string on purpose — assigned_to is a free-form string (not an FK),
    // matching how task_create/task_update store it; the prior list zod used
    // .uuid() which would also have wrongly rejected this real value.
    await tasksHandler.createTask(projectId, 'assignee-A task 1', undefined, 'general', 'medium', ASSIGNEE_A);
    await tasksHandler.createTask(projectId, 'assignee-A task 2', undefined, 'general', 'medium', ASSIGNEE_A);
    await tasksHandler.createTask(projectId, 'assignee-B task 1', undefined, 'general', 'medium', ASSIGNEE_B);
  });

  afterAll(async () => {
    if (projectId) {
      try { await db.query('DELETE FROM contexts WHERE project_id = $1', [projectId]); } catch { /* ignore */ }
      try { await db.query('DELETE FROM tasks WHERE project_id = $1', [projectId]); } catch { /* ignore */ }
      try { await db.query('DELETE FROM sessions WHERE project_id = $1', [projectId]); } catch { /* ignore */ }
      try { await db.query('DELETE FROM projects WHERE id = $1', [projectId]); } catch { /* ignore */ }
    }
    await db.end();
  });

  test('zod accepts a tags-only context_search (relaxed .refine)', () => {
    // Must NOT throw — previously this raised "Either 'id' or 'query' must be provided".
    const validated = validateToolArguments('context_search', { tags: [REF_TAG] });
    expect(validated.tags).toEqual([REF_TAG]);
    // A truly empty call (no id/query/tags) is still rejected.
    expect(() => validateToolArguments('context_search', {})).toThrow();
    // An empty tags array is NOT enough either.
    expect(() => validateToolArguments('context_search', { tags: [] })).toThrow();
  });

  test('context_search({tags:[ref]}) returns the tagged context with NO query', async () => {
    const resp = await contextRoutes.handleSearch({ tags: [REF_TAG], projectId });
    const text = textOf(resp);
    expect(text).toContain('milestone'); // the matched context type
    expect(text).toContain('cross-project gaps milestone'); // its content
    expect(text).not.toContain('must NOT match'); // decoy excluded
  });

  test('tags-only search returns empty cleanly for a non-existent tag', async () => {
    const resp = await contextRoutes.handleSearch({ tags: [`ref:does-not-exist-${STAMP}`], projectId });
    expect(textOf(resp)).toContain('No contexts found');
  });

  test('task_list limit is applied (LIMIT reaches SQL)', async () => {
    const all = await tasksHandler.listTasks(projectId);
    expect(all.length).toBeGreaterThanOrEqual(5); // baseline: more than the limit

    const limited = await tasksHandler.listTasks(
      projectId, undefined, undefined, undefined, undefined, undefined, undefined, undefined, 3
    );
    expect(limited.length).toBe(3); // previously this returned ALL rows
  });

  test('zod task_list now PASSES assignedTo (was declared as assignedAgent → stripped)', () => {
    const validated = validateToolArguments('task_list', { assignedTo: ASSIGNEE_A });
    // The previously-declared param name no longer survives validation; the real
    // handler-read name does.
    expect(validated.assignedTo).toBe(ASSIGNEE_A);
    expect((validated as any).assignedAgent).toBeUndefined();
    // type + tags were also undeclared (silently dropped) — now they pass through.
    const v2 = validateToolArguments('task_list', { type: 'bugfix', tags: ['x'] });
    expect(v2.type).toBe('bugfix');
    expect(v2.tags).toEqual(['x']);
  });

  test('task_list assignedTo filter reaches SQL and returns ONLY that assignee', async () => {
    // Baseline: without a filter, all assignees (and unassigned) are visible.
    const all = await tasksHandler.listTasks(projectId);
    const titles = all.map(t => t.title);
    expect(titles).toContain('assignee-A task 1');
    expect(titles).toContain('assignee-B task 1');

    // Filtered by ASSIGNEE_A — must return exactly the two A tasks and nothing else.
    const onlyA = await tasksHandler.listTasks(projectId, ASSIGNEE_A);
    expect(onlyA.length).toBe(2);
    expect(onlyA.every(t => t.assignedTo === ASSIGNEE_A)).toBe(true);
    expect(onlyA.map(t => t.title).sort()).toEqual(['assignee-A task 1', 'assignee-A task 2']);
    // The B task and the unassigned limit-test tasks are excluded.
    expect(onlyA.some(t => t.title === 'assignee-B task 1')).toBe(false);
  });

  test('task_list handler (validated args → route) filters end-to-end by assignedTo', async () => {
    // Drive the FULL public path the model hits: zod validation THEN the route
    // handler that reads args.assignedTo. This is the boundary that was broken —
    // proves the declared param name now flows through to the SQL WHERE.
    const args = validateToolArguments('task_list', { assignedTo: ASSIGNEE_B, projectId });
    const resp = await tasksRoutes.handleList(args);
    const text = textOf(resp);
    expect(text).toContain('assignee-B task 1');
    expect(text).not.toContain('assignee-A task 1');
    expect(text).not.toContain('limit-test task'); // unassigned excluded too
  });
});
