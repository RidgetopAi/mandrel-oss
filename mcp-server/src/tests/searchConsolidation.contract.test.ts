/**
 * SEARCH CONSOLIDATION contract test.
 *
 * Proves the canonical engine (contextHandler.searchContext) — the ONE matcher the
 * Command UI now proxies to — does what the consolidation promises:
 *   1. PARAPHRASE: a query sharing NO literal substring with the target still
 *      returns it (semantic, not ILIKE). This is the class the old Command "search"
 *      failed (it ran a literal matcher). [acceptance case 1]
 *   2. ADDITIVE sessionId filter narrows to one session (new param).
 *   3. ADDITIVE dateFrom filter excludes older rows (new param).
 *   4. The SEMANTIC branch's structuredContent rows now carry projectId + sessionId
 *      (consistency with the by-id / tags-only branches).
 *
 * WHY MOCK THE EMBEDDER: CI has no model download. A deterministic CONCEPT embedder
 * (different WORDS → same concept dim) proves the WIRING + the semantic property
 * (paraphrase with zero literal overlap lands near-parallel), exactly like
 * gemmaEmbedderSwap.contract.test.ts. Vectors are sized to the ACTIVE column geometry (the minilm
 * `embedding` column.
 */
import { vi, describe, test, expect, beforeAll, afterAll } from 'vitest';
import { activeEmbedder, activeEmbeddingColumn } from '../config/embeddingConfig.js';

// DERIVED from the active embedder (never a hardcoded 1536) so the SAME concept vectors run
// under either geometry — minilm's 1536-d `embedding` or gemma's 768-d `embedding_gemma`.
const DIM = activeEmbedder().dimensions;

// Concept dims: 0 = terminal-multiplexer, 1 = outdoors (decoy). DIFFERENT words map
// to the SAME dim, so a paraphrase that shares NO literal vocabulary with the target
// still lands near-parallel (high cosine) while ILIKE overlap between them is ~0.
const CONCEPTS: Array<{ dim: number; words: string[] }> = [
  { dim: 0, words: ['tmux', 'multiplexer', 'terminal', 'panes', 'attach', 'workspace', 'launch', 'window', 'detach'] },
  { dim: 1, words: ['hiking', 'trail', 'mountain', 'lake', 'outdoors', 'picnic'] },
];
function conceptVector(text: string): number[] {
  const v = new Array(DIM).fill(0);
  const lower = ` ${text.toLowerCase()} `;
  for (const c of CONCEPTS) if (c.words.some((w) => lower.includes(w))) v[c.dim] = 1;
  v[DIM - 1] = 0.001; // keep a no-concept vector normalizable/non-zero
  return v;
}
function pgVec(text: string): string {
  return `[${conceptVector(text).join(',')}]`;
}

vi.mock('../services/embedding.js', () => ({
  embeddingService: {
    generateEmbedding: vi.fn(async ({ text }: { text: string }) => ({
      embedding: conceptVector(text),
      dimensions: DIM,
      model: 'concept-mock-minilm',
    })),
  },
}));

import { db } from '../config/database.js';
import { contextHandler } from '../handlers/context.js';
import { contextRoutes } from '../routes/context.routes.js';

const STAMP = Date.now();
let projectId = '';
let sessionId = '';
const ids = {
  targetRecent: '',
  targetOld: '',
  targetNoSession: '',
  decoy: '',
};

// The paraphrase query shares ZERO 3+char words with the target content below.
const TARGET_CONTENT = 'Relaunch then reattach the panes';   // concept 0 (tmux) words: reattach→attach, panes
const PARAPHRASE_QUERY = 'start a terminal multiplexer';       // concept 0 words: terminal, multiplexer
const DECOY_CONTENT = 'A hiking trail by the mountain lake';   // concept 1

async function insertContext(
  id: string, content: string, createdAtSql: string, session: string | null,
): Promise<void> {
  await db.query(
    `INSERT INTO contexts (id, project_id, session_id, context_type, content, ${activeEmbeddingColumn()}, relevance_score, tags, created_at)
     VALUES ($1, $2, $3, 'planning', $4, $5::vector, 5.0, ARRAY[]::text[], ${createdAtSql})`,
    [id, projectId, session, content, pgVec(content)],
  );
}

describe('search consolidation (canonical engine)', () => {
  beforeAll(async () => {

    projectId = (await db.query(
      `INSERT INTO projects (name, description) VALUES ($1, 'search consolidation fuse') RETURNING id`,
      [`search-consolidation-${STAMP}`],
    )).rows[0].id;

    sessionId = (await db.query(
      `INSERT INTO sessions (project_id, agent_type, display_id) VALUES ($1, 'test', $2) RETURNING id`,
      [projectId, `sc-${STAMP}`],
    )).rows[0].id;

    ids.targetRecent = (await db.query(`SELECT gen_random_uuid() AS id`)).rows[0].id;
    ids.targetOld = (await db.query(`SELECT gen_random_uuid() AS id`)).rows[0].id;
    ids.targetNoSession = (await db.query(`SELECT gen_random_uuid() AS id`)).rows[0].id;
    ids.decoy = (await db.query(`SELECT gen_random_uuid() AS id`)).rows[0].id;

    // Recent target, in session S.
    await insertContext(ids.targetRecent, TARGET_CONTENT, 'now()', sessionId);
    // Old target (100 days), no session — for the dateFrom + sessionId filters.
    await insertContext(ids.targetOld, `${TARGET_CONTENT} (old)`, `now() - interval '100 days'`, null);
    // Recent target, no session.
    await insertContext(ids.targetNoSession, `${TARGET_CONTENT} (no session)`, 'now()', null);
    // Decoy (different concept) — must NOT match the paraphrase above a real floor.
    await insertContext(ids.decoy, DECOY_CONTENT, 'now()', sessionId);
  });

  afterAll(async () => {
    if (projectId) {
      try { await db.query('DELETE FROM contexts WHERE project_id = $1', [projectId]); } catch { /* ignore */ }
      try { await db.query('DELETE FROM sessions WHERE project_id = $1', [projectId]); } catch { /* ignore */ }
      try { await db.query('DELETE FROM projects WHERE id = $1', [projectId]); } catch { /* ignore */ }
    }
    await db.end();
  });

  test('PARAPHRASE: query with NO shared substring returns the target, not the decoy', async () => {
    // Sanity: the query really shares no 3+char word with the target content.
    const qWords = PARAPHRASE_QUERY.toLowerCase().split(/\s+/).filter((w) => w.length >= 3);
    const targetLower = TARGET_CONTENT.toLowerCase();
    expect(qWords.some((w) => targetLower.includes(w))).toBe(false);

    const results = await contextHandler.searchContext({
      query: PARAPHRASE_QUERY,
      projectId,
      minSimilarity: 50, // admits the concept-parallel target (~100), rejects the decoy (~0)
    });
    const gotIds = results.map((r) => r.id);
    expect(gotIds).toContain(ids.targetRecent);
    expect(gotIds).not.toContain(ids.decoy);
  });

  test('ADDITIVE sessionId filter narrows to the one session', async () => {
    const results = await contextHandler.searchContext({
      query: PARAPHRASE_QUERY, projectId, sessionId, minSimilarity: 50,
    });
    const gotIds = results.map((r) => r.id);
    expect(gotIds).toContain(ids.targetRecent); // in session S
    expect(gotIds).not.toContain(ids.targetNoSession); // session NULL → excluded
    expect(gotIds).not.toContain(ids.targetOld); // session NULL → excluded
  });

  test('ADDITIVE dateFrom filter excludes older rows', async () => {
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 3600 * 1000).toISOString();
    const results = await contextHandler.searchContext({
      query: PARAPHRASE_QUERY, projectId, dateFrom: tenDaysAgo, minSimilarity: 50,
    });
    const gotIds = results.map((r) => r.id);
    expect(gotIds).toContain(ids.targetRecent); // now → kept
    expect(gotIds).not.toContain(ids.targetOld); // 100 days ago → excluded
  });

  test('SEMANTIC branch structuredContent rows carry projectId + sessionId', async () => {
    const resp: any = await contextRoutes.handleSearch({
      query: PARAPHRASE_QUERY, projectId, minSimilarity: 50, response_format: 'detailed',
    });
    const rows = resp?.structuredContent?.results ?? [];
    expect(rows.length).toBeGreaterThan(0);
    const targetRow = rows.find((r: any) => r.id === ids.targetRecent);
    expect(targetRow).toBeDefined();
    expect(targetRow.projectId).toBe(projectId);
    expect(targetRow.sessionId).toBe(sessionId);
  });
});
