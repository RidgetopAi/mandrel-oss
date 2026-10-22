/**
 * task_bulk_update METADATA MERGE Contract Test
 *
 * THE BUG THIS LOCKS SHUT:
 *   bulkUpdateTasks (handlers/tasks.ts) did a WHOLESALE `metadata = $n` REPLACE of the
 *   jsonb column — so a bulk update that set ONE metadata key silently DROPPED every other
 *   key already on the row. The single task_update path was fixed to shallow-merge via
 *   metadataMergeSql (f7a4f6f), but bulk was left clobbering — an incomplete Lesson-011
 *   "whole class" fix (single merged, bulk clobbered). Bulk now routes through the SAME
 *   metadataMergeSql helper: set/overwrite incoming keys, KEEP untouched sibling keys, and
 *   an explicit `null` deletes a key.
 *
 *   It also locks the latent double-assignment bug: passing metadata AND notes together
 *   used to emit two `metadata = ...` SET clauses (a Postgres "multiple assignments to same
 *   column" error). They now fold into ONE merge.
 *
 * Driven through the SAME public path the bridge uses (validate → routeExecutor), on the
 * real migrated disposable ci_* DB — no SQL shortcuts past the tool contract.
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';

import { db } from '../config/database.js';
import { validateToolArguments } from '../middleware/validation.js';
import { routeExecutor } from '../routes/index.js';

const STAMP = Date.now();
const PROJ_NAME = `bulk-meta-merge-${STAMP}`;
let projectId: string;

async function viaPublicTool(toolName: string, rawArgs: any): Promise<any> {
  const validated = validateToolArguments(toolName, rawArgs);
  return routeExecutor(toolName, validated);
}

async function makeTask(seedMetadata: Record<string, any>): Promise<string> {
  const res = await db.query(
    `INSERT INTO tasks (project_id, title, type, priority, status, metadata)
     VALUES ($1, 'meta-merge-fuse', 'general', 'medium', 'todo', $2::jsonb)
     RETURNING id`,
    [projectId, JSON.stringify(seedMetadata)]
  );
  return res.rows[0].id;
}

async function readMetadata(id: string): Promise<Record<string, any>> {
  const res = await db.query(`SELECT metadata FROM tasks WHERE id = $1`, [id]);
  return res.rows[0].metadata ?? {};
}

describe('task_bulk_update metadata MERGES, does not clobber', () => {
  beforeAll(async () => {
    projectId = (
      await db.query(
        `INSERT INTO projects (name, description) VALUES ($1, 'bulk metadata merge fuse') RETURNING id`,
        [PROJ_NAME]
      )
    ).rows[0].id;
  });

  afterAll(async () => {
    await db.query(`DELETE FROM tasks WHERE project_id = $1`, [projectId]);
    await db.query(`DELETE FROM projects WHERE id = $1`, [projectId]);
  });

  test('bulk metadata update MERGES incoming keys, KEEPS sibling keys (no clobber)', async () => {
    // Seed each row with a back-link key that a naive REPLACE would wipe.
    const a = await makeTask({ parent_task: 'root-1', origin_kind: 'seed' });
    const b = await makeTask({ parent_task: 'root-2', origin_kind: 'seed' });

    const resp = await viaPublicTool('task_bulk_update', {
      projectId,
      task_ids: [a, b],
      metadata: { phase: 'build' }, // sets ONE new key
    });
    expect(resp.isError).toBeFalsy();
    expect(resp.structuredContent.successfullyUpdated).toBe(2);

    for (const id of [a, b]) {
      const md = await readMetadata(id);
      // The new key is set...
      expect(md.phase).toBe('build');
      // ...AND the pre-existing sibling keys survived (the whole point — no clobber).
      expect(md.origin_kind).toBe('seed');
      expect(md.parent_task).toBeDefined();
    }
  });

  test('explicit null in bulk metadata DELETES that key (documented escape hatch)', async () => {
    const a = await makeTask({ keep: 'yes', drop: 'me' });

    const resp = await viaPublicTool('task_bulk_update', {
      projectId,
      task_ids: [a],
      metadata: { drop: null, added: 'new' },
    });
    expect(resp.isError).toBeFalsy();

    const md = await readMetadata(a);
    expect(md.keep).toBe('yes'); // untouched
    expect(md.added).toBe('new'); // added
    expect('drop' in md).toBe(false); // explicit null deleted it
  });

  test('metadata + notes TOGETHER fold into one merge (no double-assignment error)', async () => {
    const a = await makeTask({ parent_task: 'root-x' });

    const resp = await viaPublicTool('task_bulk_update', {
      projectId,
      task_ids: [a],
      metadata: { phase: 'qc' },
      notes: 'reviewer pass',
    });
    // Before the fix this path built two `metadata = ...` SET clauses → Postgres error.
    expect(resp.isError).toBeFalsy();
    expect(resp.structuredContent.successfullyUpdated).toBe(1);

    const md = await readMetadata(a);
    expect(md.parent_task).toBe('root-x'); // sibling survived
    expect(md.phase).toBe('qc'); // metadata merged
    expect(md.notes).toBe('reviewer pass'); // notes merged
    expect(typeof md.lastUpdated).toBe('string'); // notes marker preserved
  });

  test('notes-only bulk update merges (keeps sibling keys)', async () => {
    const a = await makeTask({ parent_task: 'root-y', keep: 'this' });

    const resp = await viaPublicTool('task_bulk_update', {
      projectId,
      task_ids: [a],
      notes: 'note only',
    });
    expect(resp.isError).toBeFalsy();

    const md = await readMetadata(a);
    expect(md.keep).toBe('this'); // sibling survived (old code would have wiped it)
    expect(md.notes).toBe('note only');
  });
});
