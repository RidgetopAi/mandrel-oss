/**
 * task_bulk_update CAN RE-TYPE A TASK, AND A RE-TYPE INVALIDATES THE EMBEDDING
 * (part 2 — the sibling Lane K measured and deliberately left).
 *
 * ════════════════════════════════════════════════════════════════════════════════════
 * THE DEFECT THIS EXISTS TO CATCH
 * ════════════════════════════════════════════════════════════════════════════════════
 * Lane K gave `task_update` a `type` param, a `type = $n` SET clause and a place in the
 * re-embed trigger set. `task_bulk_update` — the same edit, one tool over — had NEITHER
 * end: `type` was undeclared in the zod block (so strict mode rejected the call outright)
 * and `bulkUpdateTasks` had no SET clause for it. A task's KIND was write-once in bulk.
 *
 * THE TRAP, AND WHY IT IS THE ASSERTION THAT MATTERS. Adding the write WITHOUT adding
 * `type` to the re-embed trigger set is worse than not adding it at all: `type` is part of
 * the embed text, so a re-typed row keeps the vector it was embedded with under its OLD
 * type, forever, with nothing NULL for `services/reembedBackfill.ts` to notice. Search
 * silently degrades and no instrument anywhere reports it. So this file asserts the
 * invalidation as hard as it asserts the write, in BOTH directions:
 *   - a bulk `type` change NULLs the active embedding column;
 *   - a bulk edit of a field that is NOT in the embed text (status) does NOT.
 * The second is the specificity half (C3 — a guard that always says RED says nothing):
 * "null it always" would pass the first assertion and dump every status sweep into the
 * heal set.
 *
 * THE POPULATION. `task_bulk_update` is the whole subject; its sibling `task_update` is
 * already guarded by Lane K's own tests, and the two are compared here only for the enum
 * (they must accept the SAME set or a value legal in one is illegal in the other).
 *
 * Driven through the SAME public path the bridge uses (validate → routeExecutor) on the
 * real migrated disposable ci_* DB — no SQL shortcut past the tool contract. The embedding
 * COLUMN is derived from `activeEmbeddingColumn()`, never hardcoded, so this guard follows
 * an embedder flip instead of going quietly vacuous after one (C4).
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';

import { db } from '../config/database.js';
import { validateToolArguments } from '../middleware/validation.js';
import { routeExecutor } from '../routes/index.js';
import { activeEmbeddingColumn } from '../config/embeddingConfig.js';

const EMBED_COL = activeEmbeddingColumn();
const STAMP = Date.now();
const PROJ_NAME = `bulk-type-${STAMP}`;
let projectId: string;

async function viaPublicTool(toolName: string, rawArgs: any): Promise<any> {
  const validated = validateToolArguments(toolName, rawArgs);
  return routeExecutor(toolName, validated);
}

async function makeTask(type = 'general'): Promise<string> {
  const res = await db.query(
    `INSERT INTO tasks (project_id, title, type, priority, status)
     VALUES ($1, 'bulk-type fuse', $2, 'medium', 'todo') RETURNING id`,
    [projectId, type]
  );
  return res.rows[0].id;
}

/** Plant a non-NULL vector so "was it invalidated" is a real question, not a tautology. */
async function plantEmbedding(id: string): Promise<void> {
  const dims = (
    await db.query(
      `SELECT atttypmod AS dims FROM pg_attribute
        WHERE attrelid = 'tasks'::regclass AND attname = $1`,
      [EMBED_COL]
    )
  ).rows[0]?.dims;
  if (!dims || dims <= 0) {
    // C1 third state: refuse to pass because we could not read the column's width.
    throw new Error(
      `Could not read the vector width of tasks.${EMBED_COL}; refusing to assert ` +
        'invalidation against a column this guard cannot plant a value in.'
    );
  }
  const vec = `[${new Array(dims).fill(0.1).join(',')}]`;
  await db.query(`UPDATE tasks SET ${EMBED_COL} = $1::vector WHERE id = $2`, [vec, id]);
  const check = await db.query(
    `SELECT ${EMBED_COL} IS NULL AS is_null FROM tasks WHERE id = $1`,
    [id]
  );
  expect(check.rows[0].is_null, 'the planted embedding must be non-NULL before the edit').toBe(false);
}

async function readTask(id: string): Promise<{ type: string; embedIsNull: boolean }> {
  const res = await db.query(
    `SELECT type, ${EMBED_COL} IS NULL AS embed_is_null FROM tasks WHERE id = $1`,
    [id]
  );
  return { type: res.rows[0].type, embedIsNull: res.rows[0].embed_is_null };
}

describe('task_bulk_update accepts and writes `type`', () => {
  beforeAll(async () => {
    projectId = (
      await db.query(
        `INSERT INTO projects (name, description) VALUES ($1, 'bulk type fuse') RETURNING id`,
        [PROJ_NAME]
      )
    ).rows[0].id;
  });

  afterAll(async () => {
    await db.query(`DELETE FROM tasks WHERE project_id = $1`, [projectId]);
    await db.query(`DELETE FROM projects WHERE id = $1`, [projectId]);
  });

  test('the validator ACCEPTS `type` (it used to reject it under strict mode)', () => {
    const validated: any = validateToolArguments('task_bulk_update', {
      task_ids: ['00000000-0000-4000-8000-000000000001'],
      type: 'bug',
    });
    expect(validated.type).toBe('bug');
  });

  test('`type` ALONE is a legal bulk edit — the affordance is reachable, not just declared', () => {
    expect(() =>
      validateToolArguments('task_bulk_update', {
        task_ids: ['00000000-0000-4000-8000-000000000001'],
        type: 'refactor',
      })
    ).not.toThrow();
  });

  test('an out-of-enum type is REJECTED by the same enum task_update uses', () => {
    for (const tool of ['task_bulk_update', 'task_update']) {
      const args =
        tool === 'task_bulk_update'
          ? { task_ids: ['00000000-0000-4000-8000-000000000001'], type: 'not-a-type' }
          : { taskId: '00000000-0000-4000-8000-000000000001', type: 'not-a-type' };
      expect(() => validateToolArguments(tool, args), `${tool} must reject an unknown type`).toThrow();
    }
    // ...and every value one accepts, the other accepts. A value legal in single and
    // illegal in bulk is the same declared-but-unreachable defect from the other side.
    for (const t of ['feature', 'bug', 'bugfix', 'refactor', 'test', 'review', 'docs', 'documentation', 'devops', 'general']) {
      expect(() =>
        validateToolArguments('task_bulk_update', {
          task_ids: ['00000000-0000-4000-8000-000000000001'],
          type: t,
        })
      ).not.toThrow();
    }
  });

  test('a bulk re-type WRITES the column on every row', async () => {
    const a = await makeTask('general');
    const b = await makeTask('feature');

    const resp = await viaPublicTool('task_bulk_update', {
      projectId,
      task_ids: [a, b],
      type: 'bug',
    });
    expect(resp.isError).toBeFalsy();
    expect(resp.structuredContent.successfullyUpdated).toBe(2);

    expect((await readTask(a)).type).toBe('bug');
    expect((await readTask(b)).type).toBe('bug');
  });

  test('THE TRAP: a bulk re-type NULLs the active embedding (self-heal can see it)', async () => {
    const a = await makeTask('general');
    const b = await makeTask('general');
    await plantEmbedding(a);
    await plantEmbedding(b);

    const resp = await viaPublicTool('task_bulk_update', {
      projectId,
      task_ids: [a, b],
      type: 'docs',
    });
    expect(resp.isError).toBeFalsy();

    for (const id of [a, b]) {
      const row = await readTask(id);
      expect(row.type).toBe('docs');
      expect(
        row.embedIsNull,
        `tasks.${EMBED_COL} must be NULL after a re-type, or the row stays retrievable ` +
          'under its OLD type forever with nothing for the heal worker to notice'
      ).toBe(true);
    }
  });

  test('SPECIFICITY: a status-only bulk edit does NOT null the embedding', async () => {
    const a = await makeTask('general');
    await plantEmbedding(a);

    const resp = await viaPublicTool('task_bulk_update', {
      projectId,
      task_ids: [a],
      status: 'in_progress',
    });
    expect(resp.isError).toBeFalsy();

    const row = await readTask(a);
    expect(
      row.embedIsNull,
      'status is not in the embed text; nulling here would be a self-inflicted re-embed storm'
    ).toBe(false);
  });
});
