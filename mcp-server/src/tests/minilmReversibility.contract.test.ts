/**
 * MiniLM reversibility CONTRACT test.
 *
 * The gemma swap MUST be reversible: flipping MANDREL_EMBEDDER back to `minilm` restores
 * the incumbent path — store writes 1536-d to the LEGACY `embedding` column (gemma column
 * stays NULL) and search still retrieves. Runs with MANDREL_EMBEDDER=minilm set via
 * vi.hoisted before embeddingConfig loads. Real handler path, freshly-migrated CI DB.
 */
import { vi, describe, test, expect, beforeAll, afterAll } from 'vitest';

// Capture + restore MANDREL_EMBEDDER (see afterAll) so this file leaves the process
// env exactly as it found it — order-independent under the single-fork run.
const PRIOR_EMBEDDER = vi.hoisted(() => {
  const previous = process.env.MANDREL_EMBEDDER;
  process.env.MANDREL_EMBEDDER = 'minilm';
  return previous;
});

// Geometry sourced from the registry (never a raw 1536) — this file is the minilm-
// SPECIFIC contract: it self-pins minilm and verifies minilm's own column + dims.
const MINILM_DIM = embedders().minilm.dimensions;

const CONCEPTS: Array<{ dim: number; words: string[] }> = [
  { dim: 0, words: ['reversible', 'rollback', 'revert', 'incumbent', 'switch', 'back', 'minilm'] },
  { dim: 1, words: ['hiking', 'lake', 'picnic', 'trail', 'outdoors'] },
];
function conceptEmbedding(text: string): number[] {
  const v = new Array(MINILM_DIM).fill(0);
  const lower = ` ${text.toLowerCase()} `;
  for (const c of CONCEPTS) if (c.words.some((w) => lower.includes(w))) v[c.dim] = 1;
  v[MINILM_DIM - 1] = 0.001;
  return v;
}

vi.mock('../services/embedding.js', () => ({
  embeddingService: {
    generateEmbedding: vi.fn(async ({ text }: { text: string }) => ({
      embedding: conceptEmbedding(text),
      dimensions: MINILM_DIM,
      model: 'concept-mock-minilm',
    })),
  },
}));

import { db } from '../config/database.js';
import { activeEmbeddingColumn, embedders } from '../config/embeddingConfig.js';
import { contextHandler } from '../handlers/context.js';

const STAMP = Date.now();
let projId = '';

describe('MiniLM reversibility (MANDREL_EMBEDDER=minilm)', () => {
  beforeAll(async () => {
    expect(activeEmbeddingColumn(), 'active column must be the legacy column under minilm').toBe(embedders().minilm.column);
    projId = (await db.query(`INSERT INTO projects (name, description) VALUES ($1,'minilm reversibility test') RETURNING id`, [`minilm-rev-${STAMP}`])).rows[0].id;
  });

  afterAll(async () => {
    if (projId) {
      try { await db.query('DELETE FROM contexts WHERE project_id=$1', [projId]); } catch { /* ignore */ }
      try { await db.query('DELETE FROM sessions WHERE project_id=$1', [projId]); } catch { /* ignore */ }
      try { await db.query('DELETE FROM projects WHERE id=$1', [projId]); } catch { /* ignore */ }
    }
    if (PRIOR_EMBEDDER === undefined) delete process.env.MANDREL_EMBEDDER;
    else process.env.MANDREL_EMBEDDER = PRIOR_EMBEDDER;
  });

  test('store writes 1536-d to legacy column (gemma NULL) and search retrieves', async () => {
    const stored = await contextHandler.storeContext({
      projectId: projId, type: 'code',
      content: 'We can switch the embedder back to the incumbent minilm — the swap is reversible.',
    } as any);

    const row = (await db.query(
      `SELECT vector_dims(embedding) AS e, (embedding_gemma IS NULL) AS gemma_null FROM contexts WHERE id=$1`, [stored.id]
    )).rows[0];
    expect(row.e).toBe(MINILM_DIM);
    expect(row.gemma_null).toBe(true);

    await contextHandler.storeContext({ projectId: projId, type: 'discussion', content: 'A hiking trip by the lake with a picnic.' } as any);

    const hits = await contextHandler.searchContext({ projectId: projId, query: 'roll back to the incumbent model', limit: 3 } as any);
    expect(hits.length).toBeGreaterThan(0);
    expect(String(hits[0].id)).toBe(String(stored.id));
  });
});
