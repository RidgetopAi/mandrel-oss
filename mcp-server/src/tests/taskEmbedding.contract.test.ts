/**
 * TASK EMBEDDINGS — DB CONTRACT (tranche B of the smart_search
 * complete fix; parent 7b8a66f4). Migration 088 + the task write path + the backfill registry.
 *
 * Runs against the disposable migrated CI DB, because every claim below is a claim about what
 * the real schema and the real handler do.
 *
 * THE FOUR GUARDS (each has a named mutation that must turn it RED):
 *   G8  a task PERSISTS when the embedder is down     <- remove the try/catch around the embed
 *   G9  a 20k-char task still gets embedded           <- remove boundEmbeddingText
 *   G10 the registry covers tasks AND the worker heals <- remove the tasks spec from BACKFILL_TABLES
 *   G11 BOTH embedder columns exist on `tasks`        <- drop `embedding vector(1536)` from 088
 *
 * G11 is the one that encodes a CI trap rather than a product bug: the CI gate STAGE 1 pins
 * MANDREL_EMBEDDER=minilm and STAGE 1b re-runs the same suite under gemma. A migration that
 * added only the gemma column would pass every test written under gemma and take STAGE 1 RED
 * after work had been stacked on it. This guard fails under EITHER embedder, immediately.
 *
 * THE EMBEDDER IS MOCKED and its behaviour is chosen PER TEST (embedControl.mode) — the tests
 * here are about the handler's and the registry's behaviour when the embedder succeeds, fails,
 * or rejects an over-long input, and each of those three needs a different embedder. Nothing
 * about the product's own logic is mocked.
 *
 * COLUMN-AGNOSTIC by construction: every seed and assertion names ${activeEmbeddingColumn()}
 * and every vector is sized from activeEmbedder().dimensions, so the file is correct under
 * both gate stages.
 */
import { vi, describe, test, expect, beforeAll, afterAll } from 'vitest';

/**
 * The controllable embedder.
 *   'ok'       — returns a valid active-dimension unit vector.
 *   'down'     — throws, like an unreachable ollama daemon or a crashed local model.
 *   'strict'   — runs the REAL validateInput() first, so an over-long input throws EXACTLY as
 *                the production embedder does (services/embedding/validation.ts THROWS above
 *                EMBEDDING_MAX_TEXT_LENGTH; it does not truncate). This is what makes G9 a
 *                real guard instead of a test of its own mock.
 * `lastText` records what the product actually handed the embedder.
 */
const embedControl: { mode: 'ok' | 'down' | 'strict'; lastText: string | null } = {
  mode: 'ok',
  lastText: null,
};
vi.mock('../services/embedding.js', () => ({
  embeddingService: {
    generateEmbedding: vi.fn(async ({ text }: { text: string }) => {
      embedControl.lastText = text;
      if (embedControl.mode === 'down') {
        throw new Error('embedder unreachable (test injection)');
      }
      if (embedControl.mode === 'strict') {
        const [{ validateInput }, { EMBEDDING_MAX_TEXT_LENGTH }] = await Promise.all([
          import('../services/embedding/validation.js'),
          import('../config/embeddingConfig.js'),
        ]);
        validateInput(text, EMBEDDING_MAX_TEXT_LENGTH);
      }
      const { activeEmbedder } = await import('../config/embeddingConfig.js');
      const dims = activeEmbedder().dimensions;
      const v = new Array(dims).fill(0);
      v[0] = 1; // a unit vector — valid for the gemma dimension CHECK, non-degenerate
      return { embedding: v, dimensions: dims, model: 'task-embed-mock' };
    }),
  },
}));

import { db } from '../config/database.js';
import {
  activeEmbeddingColumn,
  activeEmbedder,
  embedders,
  EMBEDDING_MAX_TEXT_LENGTH,
} from '../config/embeddingConfig.js';
import { tasksHandler } from '../handlers/tasks.js';
import { BACKFILL_TABLES } from '../services/reembedBackfill.js';
import { ReembedWorker } from '../services/reembedWorker.js';
import { buildTaskEmbeddingText } from '../services/embedding/taskEmbeddingText.js';

const STAMP = Date.now();
let projectId = '';

/** Is the active embedding column NULL for this task? */
async function embeddingIsNull(taskId: string): Promise<boolean> {
  const r = await db.query(
    `SELECT ${activeEmbeddingColumn()} IS NULL AS is_null FROM tasks WHERE id = $1`,
    [taskId],
  );
  expect(r.rowCount, `task ${taskId} must still exist to ask about its embedding`).toBe(1);
  return r.rows[0].is_null;
}

beforeAll(async () => {
  projectId = (
    await db.query(
      `INSERT INTO projects (name, description) VALUES ($1, 'task embedding contract fixture') RETURNING id`,
      [`task-embed-${STAMP}`],
    )
  ).rows[0].id;
});

afterAll(async () => {
  ReembedWorker.stop();
  if (projectId) {
    try { await db.query('DELETE FROM tasks WHERE project_id=$1', [projectId]); } catch { /* ignore */ }
    try { await db.query('DELETE FROM sessions WHERE project_id=$1', [projectId]); } catch { /* ignore */ }
    try { await db.query('DELETE FROM projects WHERE id=$1', [projectId]); } catch { /* ignore */ }
  }
  await db.end();
});

// ────────────────────────────────────────────────────────────────────────────────────────
// G11 — BOTH embedder columns exist on `tasks` (encodes the CI STAGE 1 / STAGE 1b trap)
// ────────────────────────────────────────────────────────────────────────────────────────
describe('G11: `tasks` carries a column for EVERY registered embedder', () => {
  test('every embedder in the registry has its column on tasks, at its own dimension', async () => {
    const registry = embedders();
    const keys = Object.keys(registry);

    // THE VACUITY GUARD. A `for … of []` passes every assertion inside it. If the embedder
    // registry ever returns empty (a bad env read, a refactor), this test would silently
    // certify nothing — so the population is asserted before it is iterated. This is the
    // "probe the empty population" check, applied to the guard's own enumeration.
    expect(keys.length, 'embedder registry must be non-empty or this guard proves nothing')
      .toBeGreaterThanOrEqual(2);
    expect(keys, 'both gate stages (minilm=STAGE 1, gemma=STAGE 1b) must be covered')
      .toEqual(expect.arrayContaining(['minilm', 'gemma']));

    for (const key of keys) {
      const spec = registry[key];
      const col = await db.query(
        `SELECT format_type(a.atttypid, a.atttypmod) AS declared_type
           FROM pg_attribute a
          WHERE a.attrelid = 'tasks'::regclass
            AND a.attname  = $1
            AND a.attnum   > 0
            AND NOT a.attisdropped`,
        [spec.column],
      );
      expect(
        col.rowCount,
        `tasks.${spec.column} MISSING — embedder "${key}" cannot read or write task embeddings. ` +
          `Migration 088 must add a column for EVERY embedder, not just the one prod runs: ` +
          `the CI gate STAGE 1 pins minilm and STAGE 1b re-runs under gemma.`,
      ).toBe(1);
      expect(
        col.rows[0].declared_type,
        `tasks.${spec.column} must be vector(${spec.dimensions}) for embedder "${key}"`,
      ).toBe(`vector(${spec.dimensions})`);
    }
  });

  test('the gemma column carries a dimension CHECK (mirroring migration 056)', async () => {
    const c = await db.query(
      `SELECT 1 FROM pg_constraint
        WHERE conrelid = 'tasks'::regclass
          AND contype  = 'c'
          AND conname  = 'tasks_embedding_gemma_dimension_check'`,
    );
    expect(c.rowCount, 'tasks_embedding_gemma_dimension_check must exist (056 shape)').toBe(1);
  });
});

// ────────────────────────────────────────────────────────────────────────────────────────
// G8 — a task PERSISTS when the embedder is down (DEGRADE + PERSIST + ALERT)
// ────────────────────────────────────────────────────────────────────────────────────────
describe('G8: an embedder outage never costs a user their task', () => {
  test('createTask persists with a NULL embedding when the embedder throws', async () => {
    embedControl.mode = 'down';
    let task;
    try {
      task = await tasksHandler.createTask(
        projectId,
        'Task written while the embedder is down',
        'The embedder throws on this write; the task must still exist afterwards.',
        'general',
        'high',
        undefined,
        undefined,
        ['g8'],
      );
    } finally {
      embedControl.mode = 'ok';
    }

    // THE CLAIM: the row exists. If the embed were unwrapped, the throw would propagate out
    // of createTask, `task` would be undefined and this line would never be reached.
    expect(task?.id, 'createTask must return a persisted task even with the embedder down').toBeTruthy();

    const row = await db.query('SELECT id, title FROM tasks WHERE id = $1', [task!.id]);
    expect(row.rowCount, 'the task row must be in the database').toBe(1);
    expect(row.rows[0].title).toBe('Task written while the embedder is down');

    // AND the degradation is RECOVERABLE, not silent: NULL is the needs-reembed marker the
    // self-heal worker selects on. A non-NULL garbage vector here would look "embedded"
    // forever and never be revisited — which is why this assertion is as important as the
    // persistence one.
    expect(await embeddingIsNull(task!.id), 'a degraded write must leave NULL, the heal marker').toBe(true);
  });

  test('a task created while the embedder is UP is embedded (the unmutated control)', async () => {
    embedControl.mode = 'ok';
    const task = await tasksHandler.createTask(
      projectId,
      'Task written while the embedder is healthy',
      'Control row: proves the NULL above is caused by the outage, not by the write path never embedding at all.',
      'general',
      'medium',
      undefined,
      undefined,
      ['g8-control'],
    );
    expect(await embeddingIsNull(task.id), 'the happy path must embed inline').toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────────────────────────────
// G9 — a 20k-char task is still embedded (bounded, not thrown away)
// ────────────────────────────────────────────────────────────────────────────────────────
describe('G9: an over-long task is bounded, not dropped', () => {
  test('a 20,000-char description is truncated to the cap and the row IS embedded', async () => {
    embedControl.mode = 'strict'; // the REAL validateInput runs — unbounded text throws here
    embedControl.lastText = null;
    const HUGE = 20_000;
    let task;
    try {
      task = await tasksHandler.createTask(
        projectId,
        'Task with a very long description',
        'x'.repeat(HUGE),
        'general',
        'medium',
        undefined,
        undefined,
        ['g9'],
      );
    } finally {
      embedControl.mode = 'ok';
    }

    // The input really was over-long — otherwise the test proves nothing about bounding.
    expect(HUGE, 'the fixture must exceed the cap or this guard is vacuous')
      .toBeGreaterThan(EMBEDDING_MAX_TEXT_LENGTH);

    // 1. THE CONSEQUENCE FIRST, deliberately. This is the assertion that describes the harm:
    //    without the bound, the REAL validateInput throws, the handler degrades, and this
    //    column stays NULL — a long task drops out of semantic recall permanently (the
    //    self-heal worker just re-throws on it every sweep). Asserting it BEFORE the
    //    mechanism means the mutation probe's RED is about the outcome, not only about a
    //    string length.
    expect(await embeddingIsNull(task!.id), 'an over-long task must still end up embedded').toBe(false);

    // 2. And the mechanism: what the product handed the embedder was bounded to exactly the cap.
    expect(embedControl.lastText, 'the embedder must have been called').not.toBeNull();
    expect(
      embedControl.lastText!.length,
      'buildTaskEmbeddingText must bound its output to EMBEDDING_MAX_TEXT_LENGTH',
    ).toBe(EMBEDDING_MAX_TEXT_LENGTH);
  });

  test('buildTaskEmbeddingText is total on the empty/absent row (no throw, empty string)', () => {
    // The zero/absent population. A task with nothing in it must not throw here (that would
    // be an exception on a write path) and must not fabricate text either.
    expect(buildTaskEmbeddingText({})).toBe('');
    expect(buildTaskEmbeddingText({ type: null, priority: null, tags: [], title: '', description: null })).toBe('');
  });
});

// ────────────────────────────────────────────────────────────────────────────────────────
// G10 — the backfill registry covers tasks, and the self-heal worker heals them
// ────────────────────────────────────────────────────────────────────────────────────────
describe('G10: tasks are in the backfill registry and the worker heals them', () => {
  test('BACKFILL_TABLES contains a tasks spec that reads the task columns', () => {
    const spec = BACKFILL_TABLES.find((t) => t.key === 'tasks');
    expect(spec, 'BACKFILL_TABLES must register `tasks` — the CLI and the worker both iterate it').toBeDefined();
    expect(spec!.table).toBe('tasks');

    // The spec's text builder must be the SAME one the write path uses, asserted by RESULT
    // rather than by identity: a spec that read the wrong columns, or built text a different
    // way, would give a backfilled row a different vector than a freshly written one.
    const row = { type: 'feature', priority: 'high', tags: ['alpha'], title: 'T', description: 'D' };
    expect(spec!.buildText(row)).toBe(
      buildTaskEmbeddingText({ type: 'feature', priority: 'high', tags: ['alpha'], title: 'T', description: 'D' }),
    );
    expect(spec!.buildText(row).length, 'the spec must produce non-empty text for a populated row').toBeGreaterThan(0);
  });

  test('a self-heal sweep re-embeds a task whose active column is NULL', async () => {
    embedControl.mode = 'ok';
    const dims = activeEmbedder().dimensions;
    expect(dims, 'the active embedder must declare a dimension').toBeGreaterThan(0);

    const seeded = await db.query(
      `INSERT INTO tasks (project_id, title, description, type, priority, status, tags, ${activeEmbeddingColumn()})
       VALUES ($1, 'Task awaiting self-heal', 'seeded with a NULL vector', 'general', 'medium', 'todo', ARRAY['g10'], NULL)
       RETURNING id`,
      [projectId],
    );
    const taskId = seeded.rows[0].id;
    expect(await embeddingIsNull(taskId), 'pre-condition: the seeded task is NULL on the active column').toBe(true);

    const result = await ReembedWorker.runOnce();
    expect(result.skipped, 'the sweep must actually have run').toBe(false);

    // The worker reports per-table stats keyed by registry key — a `tasks` key can only be
    // present if the worker iterated a registry that contains it.
    expect(Object.keys(result.tables ?? {}), 'the sweep must report a tasks bucket').toContain('tasks');
    expect(await embeddingIsNull(taskId), 'the worker must have healed the task row').toBe(false);
  });
});
