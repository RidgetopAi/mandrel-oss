/**
 * RE-EMBED SELF-HEAL WORKER — CONTRACT test.
 *
 * Proves the scheduled self-heal engine against the disposable migrated CI DB:
 *   1. HEAL: a row whose ACTIVE embedding column is NULL is re-embedded (column filled) by a
 *      single worker sweep — for BOTH contexts and technical_decisions.
 *   2. SINGLE-FLIGHT: while a sweep is in flight, a second runOnce() is SKIPPED
 *      (never overlaps, never queues) and the in-flight flag clears afterward so the next
 *      sweep runs normally.
 *
 * COLUMN-AGNOSTIC: seeds + assertions use `${activeEmbeddingColumn()}` from config, and the mock
 * embedder sizes its vector to the ACTIVE embedder's dimensions — so the test is correct under
 * whichever embedder the suite is given. The gemma column plane is proven in
 * embedResilienceGemma.contract.test.ts.
 */
import { vi, describe, test, expect, beforeAll, afterAll } from 'vitest';

// A controllable, WORKING embedder: returns a valid active-dimension unit vector, with an
// injectable delay so the single-flight test can hold a sweep in flight deterministically.
const embedControl = { delayMs: 0 };
vi.mock('../services/embedding.js', () => ({
  embeddingService: {
    generateEmbedding: vi.fn(async () => {
      const { activeEmbedder } = await import('../config/embeddingConfig.js');
      if (embedControl.delayMs > 0) await new Promise((r) => setTimeout(r, embedControl.delayMs));
      const dims = activeEmbedder().dimensions;
      const v = new Array(dims).fill(0);
      v[0] = 1; // unit vector, valid for the column CHECK
      return { embedding: v, dimensions: dims, model: 'worker-mock' };
    }),
  },
}));

import { db } from '../config/database.js';
import { activeEmbeddingColumn } from '../config/embeddingConfig.js';
import { ReembedWorker } from '../services/reembedWorker.js';

const STAMP = Date.now();
let projectId = '';

/** Insert a context row with a NULL active embedding (the needs-reembed marker). */
async function seedNullContext(content: string): Promise<string> {
  return (await db.query(
    `INSERT INTO contexts (project_id, context_type, content, ${activeEmbeddingColumn()})
     VALUES ($1, 'code', $2, NULL) RETURNING id`,
    [projectId, content],
  )).rows[0].id;
}

/** Insert a decision row with a NULL active embedding. */
async function seedNullDecision(title: string): Promise<string> {
  return (await db.query(
    `INSERT INTO technical_decisions
       (project_id, decision_type, title, description, rationale, ${activeEmbeddingColumn()})
     VALUES ($1, 'architecture', $2, 'desc', 'rationale', NULL) RETURNING id`,
    [projectId, title],
  )).rows[0].id;
}

describe('ReembedWorker self-heal (heals NULL active-column rows; single-flight)', () => {
  beforeAll(async () => {
    projectId = (await db.query(
      `INSERT INTO projects (name, description) VALUES ($1, 'reembed worker test') RETURNING id`,
      [`reembed-worker-${STAMP}`],
    )).rows[0].id;
  });

  afterAll(async () => {
    ReembedWorker.stop();
    if (projectId) {
      try { await db.query('DELETE FROM contexts WHERE project_id=$1', [projectId]); } catch { /* ignore */ }
      try { await db.query('DELETE FROM technical_decisions WHERE project_id=$1', [projectId]); } catch { /* ignore */ }
      try { await db.query('DELETE FROM sessions WHERE project_id=$1', [projectId]); } catch { /* ignore */ }
      try { await db.query('DELETE FROM projects WHERE id=$1', [projectId]); } catch { /* ignore */ }
    }
    await db.end();
  });

  test('a sweep re-embeds NULL active-column rows in BOTH tables (column filled)', async () => {
    embedControl.delayMs = 0;
    const ctxId = await seedNullContext('Row awaiting self-heal re-embed.');
    const decId = await seedNullDecision('Decision awaiting self-heal re-embed');

    // Pre-condition: both are NULL on the active column.
    const before = await db.query(
      `SELECT (SELECT ${activeEmbeddingColumn()} IS NULL FROM contexts WHERE id=$1) AS c_null,
              (SELECT ${activeEmbeddingColumn()} IS NULL FROM technical_decisions WHERE id=$2) AS d_null`,
      [ctxId, decId],
    );
    expect(before.rows[0].c_null).toBe(true);
    expect(before.rows[0].d_null).toBe(true);

    const result = await ReembedWorker.runOnce();
    expect(result.skipped).toBe(false);

    // Post-condition: MY rows are now embedded on the active column.
    const cFilled = (await db.query(`SELECT ${activeEmbeddingColumn()} IS NOT NULL AS f FROM contexts WHERE id=$1`, [ctxId])).rows[0].f;
    const dFilled = (await db.query(`SELECT ${activeEmbeddingColumn()} IS NOT NULL AS f FROM technical_decisions WHERE id=$1`, [decId])).rows[0].f;
    expect(cFilled, 'context row should be healed (active column no longer NULL)').toBe(true);
    expect(dFilled, 'decision row should be healed (active column no longer NULL)').toBe(true);
  });

  test('single-flight: an overlapping runOnce is SKIPPED while a sweep is in flight, then re-arms', async () => {
    // Force a slow sweep so the first call is still in flight when the second lands.
    embedControl.delayMs = 200;
    await seedNullContext('slow-heal row to keep the sweep busy');

    const first = ReembedWorker.runOnce();          // starts the sweep (in flight)
    // Give the first call a tick to enter the sweep and set the in-flight flag.
    await new Promise((r) => setTimeout(r, 20));
    const second = await ReembedWorker.runOnce();    // lands mid-sweep → must be skipped
    expect(second.skipped, 'a runOnce during an in-flight sweep must be skipped (single-flight)').toBe(true);

    const firstResult = await first;                 // the original sweep completes normally
    expect(firstResult.skipped).toBe(false);

    // The in-flight flag cleared in finally → a fresh sweep runs (not skipped).
    embedControl.delayMs = 0;
    const third = await ReembedWorker.runOnce();
    expect(third.skipped, 'after the sweep finished the flag must be clear (finally)').toBe(false);
  });
});
