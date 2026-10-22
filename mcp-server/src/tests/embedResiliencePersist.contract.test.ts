/**
 * EMBED-FAILURE RESILIENCE — persist-on-failure CONTRACT test.
 *
 * THE REGRESSION GUARD for the critical data-loss bug: context_store's embed call used to be
 * UNWRAPPED, so an embedder failure threw PAST the INSERT and the whole capture was LOST. This
 * test drives the REAL handlers against the disposable migrated CI DB with the embedder mocked
 * to THROW, and asserts that BOTH tables:
 *   - STILL persist the record (the write is never lost), and
 *   - leave the ACTIVE embedding column NULL (degraded — the self-heal worker will re-embed), and
 *   - call the shared onEmbedFailure() degrade helper (the alert fires).
 *
 * Against the OLD unwrapped context.ts, the context case FAILS: storeContext rejects and no row
 * exists. Under the fix it persists with NULL.
 *
 * COLUMN-AGNOSTIC: assertions query `${activeEmbeddingColumn()}` from config (not a literal 'embedding'),
 * so this test is correct under whichever embedder the suite is given.
 * The gemma-column plane is proven in embedResilienceGemma.contract.test.ts.
 */
import { vi, describe, test, expect, beforeAll, afterAll } from 'vitest';

// The embedder THROWS for every call — simulating a broken embedder (Ollama/Xenova down).
vi.mock('../services/embedding.js', () => ({
  embeddingService: {
    generateEmbedding: vi.fn(async () => {
      throw new Error('FORCED embedder failure (test): embedder unavailable');
    }),
  },
}));

// Spy the shared degrade helper so we can assert it fired WITHOUT shelling out to chat.
// (The real onEmbedFailure → alertSink.send path is proven in embedResilience.unit.test.ts.)
vi.mock('../services/embedResilience.js', () => ({
  onEmbedFailure: vi.fn(),
}));

import { db } from '../config/database.js';
import { activeEmbeddingColumn } from '../config/embeddingConfig.js';
import { contextHandler } from '../handlers/context.js';
import { decisionsHandler } from '../handlers/decisions.js';
import { onEmbedFailure } from '../services/embedResilience.js';

const STAMP = Date.now();
let projectId = '';

describe('embed-failure resilience: records persist with NULL embedding + helper fires', () => {
  beforeAll(async () => {
    projectId = (await db.query(
      `INSERT INTO projects (name, description) VALUES ($1, 'embed resilience persist test') RETURNING id`,
      [`embed-resilience-persist-${STAMP}`],
    )).rows[0].id;
  });

  afterAll(async () => {
    if (projectId) {
      try { await db.query('DELETE FROM contexts WHERE project_id=$1', [projectId]); } catch { /* ignore */ }
      try { await db.query('DELETE FROM technical_decisions WHERE project_id=$1', [projectId]); } catch { /* ignore */ }
      try { await db.query('DELETE FROM sessions WHERE project_id=$1', [projectId]); } catch { /* ignore */ }
      try { await db.query('DELETE FROM projects WHERE id=$1', [projectId]); } catch { /* ignore */ }
    }
    await db.end();
  });

  test('context_store with a failing embedder STILL persists the row (active column NULL) + fires the helper [SITE C — data-loss guard]', async () => {
    vi.mocked(onEmbedFailure).mockClear();

    const stored = await contextHandler.storeContext({
      projectId,
      type: 'code',
      content: 'A capture that must NEVER be lost even when the embedder is down.',
    } as any);

    // The row exists (the write was NOT lost — the whole point).
    expect(stored?.id, 'storeContext must return a persisted context even when embedding failed').toBeTruthy();

    const row = (await db.query(
      `SELECT content, (${activeEmbeddingColumn()} IS NULL) AS emb_null FROM contexts WHERE id=$1`,
      [stored.id],
    )).rows[0];
    expect(row, 'the context row must be present in the DB').toBeTruthy();
    expect(row.emb_null, `${activeEmbeddingColumn()} must be NULL on the degraded persist`).toBe(true);

    // The degrade helper fired for the CREATE on contexts.
    expect(onEmbedFailure).toHaveBeenCalledTimes(1);
    expect(vi.mocked(onEmbedFailure).mock.calls[0][0]).toMatchObject({ table: 'contexts', op: 'create' });
  });

  test('decision_record with a failing embedder STILL persists the row (active column NULL) + fires the helper [SITE A]', async () => {
    vi.mocked(onEmbedFailure).mockClear();

    const dec = await decisionsHandler.recordDecision({
      projectId,
      decisionType: 'architecture',
      title: 'A decision that must persist even with no embedding',
      description: 'The record is the moat; a missing embedding degrades search, it must not drop the record.',
      rationale: 'Never lose a record.',
      impactLevel: 'high',
    } as any);

    expect(dec?.id, 'recordDecision must return a persisted decision even when embedding failed').toBeTruthy();

    const row = (await db.query(
      `SELECT (${activeEmbeddingColumn()} IS NULL) AS emb_null FROM technical_decisions WHERE id=$1`,
      [dec.id],
    )).rows[0];
    expect(row, 'the decision row must be present in the DB').toBeTruthy();
    expect(row.emb_null, `${activeEmbeddingColumn()} must be NULL on the degraded persist`).toBe(true);

    expect(onEmbedFailure).toHaveBeenCalledTimes(1);
    expect(vi.mocked(onEmbedFailure).mock.calls[0][0]).toMatchObject({ table: 'technical_decisions', op: 'create' });
  });
});
