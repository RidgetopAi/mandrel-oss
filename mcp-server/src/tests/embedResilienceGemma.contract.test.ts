/**
 * EMBED-FAILURE RESILIENCE — COLUMN-AGNOSTIC (gemma plane) CONTRACT test.
 *
 * The persist + worker tests do not flip MANDREL_EMBEDDER, so they run under whatever column
 * the suite is given. This file proves the SAME mechanism is correct under gemma's column by
 * running with
 * MANDREL_EMBEDDER=gemma → activeEmbeddingColumn()='embedding_gemma' (vector(768)) — the PROD plane.
 * If any code path hardcoded 'embedding', these assertions would fail under gemma.
 *
 *   1. DEGRADE+PERSIST+ALERT under gemma: a failing embedder still persists the context with a
 *      NULL `embedding_gemma`, and the REAL onEmbedFailure fires a chat alert whose body
 *      names `embedding_gemma` (the active column from config) — proving the alert is
 *      column-agnostic. The chat SINK is spied, so nothing is actually sent.
 *   2. HEAL under gemma: the worker re-embeds a NULL `embedding_gemma` row (768-d).
 *
 * Env flip is captured + restored (afterAll) so gemma does not leak into later files in the
 * single-fork run (mirrors gemmaEmbedderSwap.contract.test.ts).
 */
import { vi, describe, test, expect, beforeAll, afterAll, type MockInstance } from 'vitest';

// Select gemma BEFORE embeddingConfig (and anything downstream) is imported.
const PRIOR_EMBEDDER = vi.hoisted(() => {
  const previous = process.env.MANDREL_EMBEDDER;
  process.env.MANDREL_EMBEDDER = 'gemma';
  return previous;
});

// Controllable embedder: throw (simulate outage) or return a valid 768-d gemma vector.
const embedControl: { mode: 'ok' | 'throw' } = { mode: 'ok' };
vi.mock('../services/embedding.js', () => ({
  embeddingService: {
    generateEmbedding: vi.fn(async () => {
      if (embedControl.mode === 'throw') throw new Error('FORCED embedder failure (gemma test)');
      const { activeEmbedder } = await import('../config/embeddingConfig.js');
      const dims = activeEmbedder().dimensions; // 768 under gemma
      const v = new Array(dims).fill(0);
      v[0] = 1;
      return { embedding: v, dimensions: dims, model: 'gemma-mock' };
    }),
  },
}));

import { db } from '../config/database.js';
import { activeEmbeddingColumn, embedders } from '../config/embeddingConfig.js';
import { contextHandler } from '../handlers/context.js';
import { alertSink, resetAlertDedupe } from '../services/embedResilience.js';
import { RESILIENCE_CONFIG } from '../config/resilienceConfig.js';
import { ReembedWorker } from '../services/reembedWorker.js';

const STAMP = Date.now();
let projectId = '';
let sendSpy: MockInstance<(title: string, body: string) => boolean>;
let savedAlertEnabled: boolean;

describe('embed-failure resilience is column-agnostic (MANDREL_EMBEDDER=gemma)', () => {
  beforeAll(async () => {
    // Guard: this file only proves what it claims if gemma actually selected its column.
    expect(activeEmbeddingColumn(), 'active column must be the gemma column').toBe(embedders().gemma.column);
    projectId = (await db.query(
      `INSERT INTO projects (name, description) VALUES ($1, 'embed resilience gemma test') RETURNING id`,
      [`embed-resilience-gemma-${STAMP}`],
    )).rows[0].id;
    // EXPLICITLY ARM THE ALERT. `alertEnabled` now defaults to
    // `NODE_ENV === 'production'` and this suite runs under NODE_ENV=test, so the alert leg
    // of this case must state its premise instead of inheriting an always-on default.
    savedAlertEnabled = RESILIENCE_CONFIG.alertEnabled;
    RESILIENCE_CONFIG.alertEnabled = true;
    // Spy the chat sink so the REAL onEmbedFailure runs but nothing is actually sent.
    // send() now reports dispatch success (an earlier task ruling 4); the spy models success.
    sendSpy = vi.spyOn(alertSink, 'send').mockImplementation(() => true);
  });

  afterAll(async () => {
    RESILIENCE_CONFIG.alertEnabled = savedAlertEnabled;
    sendSpy?.mockRestore();
    ReembedWorker.stop();
    if (projectId) {
      try { await db.query('DELETE FROM contexts WHERE project_id=$1', [projectId]); } catch { /* ignore */ }
      try { await db.query('DELETE FROM technical_decisions WHERE project_id=$1', [projectId]); } catch { /* ignore */ }
      try { await db.query('DELETE FROM sessions WHERE project_id=$1', [projectId]); } catch { /* ignore */ }
      try { await db.query('DELETE FROM projects WHERE id=$1', [projectId]); } catch { /* ignore */ }
    }
    await db.end();
    // Restore the embedder selection so gemma does not leak into later files.
    if (PRIOR_EMBEDDER === undefined) delete process.env.MANDREL_EMBEDDER;
    else process.env.MANDREL_EMBEDDER = PRIOR_EMBEDDER;
  });

  test('degrade+persist+alert under gemma: NULL embedding_gemma + alert names the gemma column', async () => {
    resetAlertDedupe();
    sendSpy.mockClear();
    embedControl.mode = 'throw';

    const stored = await contextHandler.storeContext({
      projectId,
      type: 'code',
      content: 'gemma-plane capture that must persist even when the embedder is down.',
    } as any);
    expect(stored?.id).toBeTruthy();

    const embNull = (await db.query(
      `SELECT embedding_gemma IS NULL AS n FROM contexts WHERE id=$1`, [stored.id],
    )).rows[0].n;
    expect(embNull, 'embedding_gemma must be NULL on the degraded persist').toBe(true);

    // The REAL helper fired a (spied) alert whose body names the ACTIVE gemma column.
    expect(sendSpy).toHaveBeenCalledTimes(1);
    const [, body] = sendSpy.mock.calls[0] as [string, string];
    expect(body).toContain('Active column: embedding_gemma');
  });

  test('heal under gemma: the worker re-embeds a NULL embedding_gemma row (768-d)', async () => {
    embedControl.mode = 'ok';
    const id = (await db.query(
      `INSERT INTO contexts (project_id, context_type, content, embedding_gemma)
       VALUES ($1, 'code', 'gemma row awaiting self-heal', NULL) RETURNING id`,
      [projectId],
    )).rows[0].id;

    const result = await ReembedWorker.runOnce();
    expect(result.skipped).toBe(false);

    const row = (await db.query(
      `SELECT embedding_gemma IS NOT NULL AS filled, vector_dims(embedding_gemma) AS dims
         FROM contexts WHERE id=$1`, [id],
    )).rows[0];
    expect(row.filled, 'the NULL embedding_gemma row should be healed').toBe(true);
    // Width read from the registry, not written: this file PINS gemma, so name gemma's own
    // spec rather than the number it happens to hold today.
    expect(row.dims, 'healed vector must match the gemma geometry').toBe(embedders().gemma.dimensions);
  });
});
