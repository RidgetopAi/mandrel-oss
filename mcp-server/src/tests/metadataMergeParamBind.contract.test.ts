/**
 * metadataMergeSql parameter-binding Contract Test
 *
 * THE HARDENING THIS LOCKS IN:
 *   metadataMergeSql builds the "delete these keys" step of the shallow jsonb merge. It
 *   used to emit the null-key list as a HAND-ROLLED, quote-escaped SQL literal
 *   (`ARRAY['k','k']::text[]`). Injection-safe in practice (jsonb keys, quotes doubled),
 *   but a built literal is exactly the pattern that rots into an injection the day the
 *   escaping drifts. It is now BOUND as a `$n::text[]` parameter — the driver handles
 *   quoting; nothing is string-concatenated.
 *
 * THE GUARDS (FAIL before via a wrong signature; PASS after):
 *   1. UNIT: the SQL fragment references a BOUND param for the null-key list (`$n::text[]`),
 *      never an inline `ARRAY[...]` literal, and returns the keys as a params entry.
 *   2. BEHAVIOR (real DB, via task_update): shallow merge still works — set/overwrite/
 *      preserve — and an explicit null DELETES a key.
 *   3. SAFETY (real DB): a key whose NAME contains quotes / SQL metacharacters / braces is
 *      set and then deleted safely — no injection, no error, siblings untouched, table intact.
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';

import { db } from '../config/database.js';
import { validateToolArguments } from '../middleware/validation.js';
import { routeExecutor } from '../routes/index.js';
import { metadataMergeSql } from '../utils/metadataMerge.js';

const STAMP = Date.now();
const PROJ_NAME = `metamerge-${STAMP}`;
let projectId: string;

async function viaPublicTool(toolName: string, rawArgs: any): Promise<any> {
  const validated = validateToolArguments(toolName, rawArgs);
  return routeExecutor(toolName, validated);
}

// STAGE PINNED TO 'draft' (an earlier task clause 10): a bare INSERT naming no `stage` is
// backfilled to 'ready' by the tasks_sync_stage_status trigger (status='todo' ->
// stage='ready'), which the completeness gate now correctly refuses a metadata-only write
// against (ready, no punch fields) — not what this file's param-binding tests exercise.
async function makeTask(metadata: Record<string, any>): Promise<string> {
  const r = await db.query(
    `INSERT INTO tasks (project_id, title, type, priority, status, stage, metadata)
     VALUES ($1, 'm', 'general', 'medium', 'todo', 'draft', $2::jsonb) RETURNING id`,
    [projectId, JSON.stringify(metadata)]
  );
  return r.rows[0].id;
}
async function metaOf(id: string): Promise<Record<string, any>> {
  const r = await db.query(`SELECT metadata FROM tasks WHERE id = $1`, [id]);
  return r.rows[0].metadata;
}

describe('metadataMergeSql parameter-binding', () => {
  beforeAll(async () => {
    projectId = (
      await db.query(`INSERT INTO projects (name, description) VALUES ($1, 'meta merge fuse') RETURNING id`, [PROJ_NAME])
    ).rows[0].id;
  });
  afterAll(async () => {
    await db.query(`DELETE FROM tasks WHERE project_id = $1`, [projectId]);
    await db.query(`DELETE FROM projects WHERE id = $1`, [projectId]);
  });

  test('UNIT: null-key deletion binds a $n::text[] param — no inline ARRAY literal', () => {
    const { expr, params } = metadataMergeSql('metadata', 5, { a: 1, gone: null });
    // Bound param for the delete list, at $6 (paramIdx+1), cast to text[].
    expect(expr).toContain('$5::jsonb');
    expect(expr).toContain('$6::text[]');
    expect(expr).not.toMatch(/ARRAY\[/); // NO hand-rolled literal
    // params: [mergeJson, nullKeysArray]
    expect(params.length).toBe(2);
    expect(params[1]).toEqual(['gone']);
  });

  test('UNIT: no null keys → single param, no delete step', () => {
    const { expr, params } = metadataMergeSql('metadata', 3, { a: 1, b: 2 });
    expect(expr).toContain('$3::jsonb');
    expect(expr).not.toContain('::text[]');
    expect(params.length).toBe(1);
  });

  test('BEHAVIOR: shallow merge preserves untouched keys, overwrites, and null deletes', async () => {
    const id = await makeTask({ origin: 'orig', keep: 'kept', drop: 'bye' });
    const resp = await viaPublicTool('task_update', {
      projectId, taskId: id,
      metadata: { origin: 'edited', added: 'new', drop: null },
    });
    expect(resp.isError).toBeFalsy();
    const m = await metaOf(id);
    expect(m).toEqual({ origin: 'edited', keep: 'kept', added: 'new' }); // drop removed, keep preserved
  });

  test('SAFETY: a key name with quotes / SQL metachars / braces set + deleted safely', async () => {
    const nastyKey = `x'); DROP TABLE tasks; --{"a":1}`;
    const id = await makeTask({ safe: 'yes', [nastyKey]: 'boom' });

    // Confirm it was stored as a plain key.
    let m = await metaOf(id);
    expect(m[nastyKey]).toBe('boom');

    // Delete ONLY the nasty key via explicit null — the param binding must handle it.
    const resp = await viaPublicTool('task_update', {
      projectId, taskId: id, metadata: { [nastyKey]: null, alsoSet: 'ok' },
    });
    expect(resp.isError).toBeFalsy();

    m = await metaOf(id);
    expect(m).toEqual({ safe: 'yes', alsoSet: 'ok' }); // nasty key gone, sibling intact

    // The tasks table obviously still exists (the "DROP TABLE" was inert data, not SQL).
    const stillThere = await db.query(`SELECT count(*)::int AS c FROM tasks WHERE project_id = $1`, [projectId]);
    expect(stillThere.rows[0].c).toBeGreaterThan(0);
  });
});
