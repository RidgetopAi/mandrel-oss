/**
 * Gemma embedder-swap CONTRACT test.
 *
 * Runs with MANDREL_EMBEDDER=gemma (set via vi.hoisted BEFORE any module reads it, so
 * embeddingConfig resolves activeEmbeddingColumn()='embedding_gemma'). Drives the REAL handler
 * paths against the freshly-migrated disposable CI DB (the CI gate migrates through 056,
 * which adds embedding_gemma). NEVER production/tenant.
 *
 * These assertions FAIL on the exact regressions Reviewer caught:
 *   A. store→search round-trip: store writes 768-d to the GEMMA column (legacy 1536-d
 *      column stays NULL); a semantic-only query retrieves it.
 *   B. PARAPHRASE-ONLY decision_search: a query sharing the target's CONCEPT but NO literal
 *      words still returns it — proving the admit gate uses the ACTIVE column, not the
 *      legacy `embedding` (which is NULL under gemma → the row would be DROPPED). [finding 1]
 *   C. --force --project=X SCOPE: backfill --force on project X does NOT touch project Y's
 *      rows — proving the WHERE force-term is grouped, not OR-leaking across projects. [finding 2]
 *   D. DIMENSION GUARD: a wrong-dimension vector is rejected by the column CHECK constraint.
 *
 * WHY MOCK THE EMBEDDER: CI has no Ollama daemon. A deterministic CONCEPT embedder proves
 * the WIRING (which column is written/read/admitted-on) — the class the bugs live in —
 * exactly as decisionSemanticSearch.contract.test.ts does. Live gemma 768-d output was
 * verified separately on the disposable DB. Vectors are 768-d to match the gemma column.
 */
import { vi, describe, test, expect, beforeAll, afterAll } from 'vitest';

// Select the gemma embedder BEFORE embeddingConfig (and everything downstream) is imported.
// Capture the PRIOR value so afterAll can restore it — otherwise activating gemma here
// LEAKS MANDREL_EMBEDDER=gemma into later test files in the single-fork run: their fresh
// embeddingConfig would resolve activeEmbeddingColumn()='embedding_gemma' (768-d) and reject the
// real minilm 1536-d writes ("expected 768 dimensions, not 1536"). Order-independence
// fix so the FULL suite is green in one shot (an earlier task gate; unblocks the rollout).
const PRIOR_EMBEDDER = vi.hoisted(() => {
  const previous = process.env.MANDREL_EMBEDDER;
  process.env.MANDREL_EMBEDDER = 'gemma';
  return previous;
});

// Geometry sourced from the registry (never a raw 768) — this file is the gemma-
// SPECIFIC contract: it self-pins gemma and verifies gemma's own column + dims.
const GEMMA_DIM = embedders().gemma.dimensions;

// Deterministic CONCEPT embedder: a unit vector whose direction encodes which concepts the
// text mentions. Crucially, DIFFERENT words map to the SAME concept dim — so a paraphrase
// that shares NO literal vocabulary with the target still lands near-parallel (high cosine),
// while trigram/ILIKE text matching between them stays ~0. This is what isolates "admitted
// by the embedding term" from "admitted by text overlap".
const CONCEPTS: Array<{ dim: number; words: string[] }> = [
  { dim: 0, words: ['bearer', 'token', 'credential', 'authentication', 'unauthenticated', 'login', 'signed', 'anonymous'] },
  { dim: 1, words: ['pgvector', 'postgres', 'database', 'index', 'sql', 'column', 'ivfflat'] },
  { dim: 2, words: ['hiking', 'lake', 'picnic', 'trail', 'mountain', 'outdoors'] },
  { dim: 3, words: ['embedder', 'embedding', 'gemma', 'minilm', 'vector', 'swap', 'model'] },
];
function conceptEmbedding(text: string): number[] {
  const v = new Array(GEMMA_DIM).fill(0);
  const lower = ` ${text.toLowerCase()} `;
  for (const c of CONCEPTS) if (c.words.some((w) => lower.includes(w))) v[c.dim] = 1;
  v[GEMMA_DIM - 1] = 0.001; // keep a no-concept vector normalizable/non-zero
  return v;
}

vi.mock('../services/embedding.js', () => ({
  embeddingService: {
    generateEmbedding: vi.fn(async ({ text }: { text: string }) => ({
      embedding: conceptEmbedding(text),
      dimensions: GEMMA_DIM,
      model: 'concept-mock-gemma',
    })),
  },
}));

import { db } from '../config/database.js';
import { activeEmbeddingColumn, embedders } from '../config/embeddingConfig.js';
import { contextHandler } from '../handlers/context.js';
import { decisionsHandler } from '../handlers/decisions.js';
import { backfillContexts } from '../services/reembedBackfill.js';

const STAMP = Date.now();
let projA = '';
let projB = '';

async function mkProject(name: string): Promise<string> {
  return (await db.query(`INSERT INTO projects (name, description) VALUES ($1,'gemma swap test') RETURNING id`, [name])).rows[0].id;
}

describe('gemma embedder swap (MANDREL_EMBEDDER=gemma)', () => {
  beforeAll(async () => {
    expect(activeEmbeddingColumn(), 'active column must be the gemma column').toBe(embedders().gemma.column);
    projA = await mkProject(`gemma-swap-A-${STAMP}`);
    projB = await mkProject(`gemma-swap-B-${STAMP}`);
  });

  afterAll(async () => {
    for (const p of [projA, projB]) {
      if (!p) continue;
      try { await db.query('DELETE FROM contexts WHERE project_id=$1', [p]); } catch { /* ignore */ }
      try { await db.query('DELETE FROM technical_decisions WHERE project_id=$1', [p]); } catch { /* ignore */ }
      try { await db.query('DELETE FROM sessions WHERE project_id=$1', [p]); } catch { /* ignore */ }
      try { await db.query('DELETE FROM projects WHERE id=$1', [p]); } catch { /* ignore */ }
    }
    // Restore MANDREL_EMBEDDER so gemma does not leak into later files (see the
    // capture at the top of this file). Without this, the single-fork suite fails.
    if (PRIOR_EMBEDDER === undefined) delete process.env.MANDREL_EMBEDDER;
    else process.env.MANDREL_EMBEDDER = PRIOR_EMBEDDER;
  });

  test('A: store writes 768-d to gemma column (legacy NULL) and semantic search retrieves it', async () => {
    const stored = await contextHandler.storeContext({
      projectId: projA, type: 'code',
      content: 'Runbook: how to swap the embedding model to gemma and rebuild the vector index.',
    } as any);

    const row = (await db.query(
      `SELECT vector_dims(embedding_gemma) AS g, (embedding IS NULL) AS legacy_null FROM contexts WHERE id=$1`, [stored.id]
    )).rows[0];
    expect(row.g).toBe(GEMMA_DIM);
    expect(row.legacy_null).toBe(true);

    // Add a distractor in a disjoint concept space.
    await contextHandler.storeContext({ projectId: projA, type: 'discussion', content: 'We went hiking by the lake and had a picnic.' } as any);

    const hits = await contextHandler.searchContext({ projectId: projA, query: 'change the vector model to gemma', limit: 3 } as any);
    expect(hits.length).toBeGreaterThan(0);
    expect(String(hits[0].id)).toBe(String(stored.id));
  });

  test('B: paraphrase-only decision_search returns the target (admit gate uses ACTIVE column) [finding 1]', async () => {
    // Target: auth concept via "bearer/token/anonymous/signed" — NO overlap with the query words.
    const dec = await decisionsHandler.recordDecision({
      projectId: projA, decisionType: 'security',
      title: 'Reject anonymous sessions lacking a signed bearer token',
      description: 'Deny inbound requests that omit a valid bearer token at the ingress.',
      rationale: 'Unsigned requests must fail shut.', impactLevel: 'critical',
    } as any);
    // Distractor decision in a different concept space (database).
    await decisionsHandler.recordDecision({
      projectId: projA, decisionType: 'architecture',
      title: 'Use pgvector ivfflat index on the postgres column',
      description: 'Store embeddings in a postgres column with an ivfflat index.',
      rationale: 'Fast approximate nearest-neighbour.', impactLevel: 'high',
    } as any);

    // Query shares the auth CONCEPT (authentication/credential/unauthenticated) but NOT the
    // target's literal words → admission can ONLY come from `embedding_gemma IS NOT NULL`.
    const results = await decisionsHandler.searchDecisions({ projectId: projA, query: 'authentication credential policy for unauthenticated callers', limit: 5 } as any);
    const ids = results.map((r: any) => String(r.id));
    expect(ids, 'paraphrase query must ADMIT + return the auth decision under gemma').toContain(String(dec.id));
    expect(String(results[0].id)).toBe(String(dec.id));
  });

  test('C: backfill --force --project=A does NOT touch project B rows [finding 2]', async () => {
    // A's row starts UN-embedded (NULL); B's row is ALREADY embedded with a SENTINEL vector.
    // The OR-precedence bug (`col IS NOT NULL OR project_id=$A`) would pull B in *because it
    // is non-null* and overwrite the sentinel — so the sentinel is exactly what detects it.
    const a = await contextHandler.storeContext({ projectId: projA, type: 'code', content: 'Project A row awaiting backfill.' } as any);
    const b = await contextHandler.storeContext({ projectId: projB, type: 'code', content: 'Project B already-embedded row.' } as any);
    const SENTINEL = `[${['1', ...new Array(GEMMA_DIM - 1).fill('0')].join(',')}]`; // distinct from any concept-mock output
    await db.query(`UPDATE contexts SET embedding_gemma=NULL WHERE id=$1`, [a.id]);
    await db.query(`UPDATE contexts SET embedding_gemma=$1::vector WHERE id=$2`, [SENTINEL, b.id]);

    // --force scoped to project A only.
    await backfillContexts(projA, { apply: true, force: true, batchSize: 32, allProjects: false, understandTarget: false });

    const aFilled = (await db.query(`SELECT embedding_gemma IS NOT NULL AS filled FROM contexts WHERE id=$1`, [a.id])).rows[0].filled;
    const bVec = (await db.query(`SELECT embedding_gemma::text AS v FROM contexts WHERE id=$1`, [b.id])).rows[0].v;
    expect(aFilled, 'project A row should be (re)embedded by --force --project=A').toBe(true);
    expect(bVec, 'project B sentinel must be UNCHANGED — no OR-precedence scope leak').toBe(SENTINEL);
  });

  test('D: dimension guard — a wrong-dim vector is rejected by the column CHECK', async () => {
    const ctx = await contextHandler.storeContext({ projectId: projA, type: 'code', content: 'dim guard row' } as any);
    const badVec = `[${new Array(300).fill(0.1).join(',')}]`; // 300-d, not 768
    await expect(
      db.query(`UPDATE contexts SET embedding_gemma=$1::vector WHERE id=$2`, [badVec, ctx.id])
    ).rejects.toThrow();
  });
});
