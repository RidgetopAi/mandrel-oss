/**
 * Smart Search + Base Retrieval Contract Test
 * (the executable fuse for the smart_search dead-table bug)
 *
 * THE BUG:
 *   src/handlers/smartSearch.ts had a `naming` branch that ran
 *       SELECT ... FROM naming_registry WHERE project_id = $1 ...
 *   but `naming_registry` was PERMANENTLY dropped in
 *   database/migrations/034_drop_naming_registry.sql (feature replaced by
 *   dependency tracking). Every smart_search therefore fired a doomed query that
 *   threw, and the error was swallowed by the function's outer try/catch — a
 *   silent failure on every call, plus a guaranteed-broken source that could
 *   never return a result.
 *
 * THE FIX:
 *   The dead `naming` branch was deleted from smartSearch() (no query may target a
 *   non-existent table; no silent catch hiding a known-broken query). The other
 *   three sources smart_search touches — contexts, technical_decisions,
 *   code_components — were verified to still exist against the real migrated schema
 *   and are retained.
 *
 * WHAT THIS PROVES (drives the REAL handlers against a REAL migrated Postgres):
 *   1. DEAD TABLE GONE: smart_search executes with NO SQL referencing
 *      `naming_registry`, and the migrated schema confirms that table does not
 *      exist. (db.query is spied so we can assert on every statement actually run.)
 *   2. LIVE SOURCES WORK: with seeded data, smart_search returns results whose
 *      `source` values come only from the live sources (semantic_search /
 *      text_matching / decision_search / code_analysis) — never 'naming_registry'.
 *   3. BASE RETRIEVAL GREEN: each of the four base retrieval tools —
 *      context_search (semantic + lexical), context_get_recent, smart_search,
 *      get_recommendations — runs without error and returns sensible output.
 *
 * Embeddings are stubbed (native @xenova/transformers → sharp is unavailable in
 * CI/sandbox); the full real DB read/write path still runs.
 *
 * DB target: the disposable migrated database provisioned by the CI gate
 * (DATABASE_* env points at the throwaway ci_* DB, dropped on exit) — NEVER the
 * production `mandrel` DB.
 */

import { describe, test, expect, beforeAll, afterAll, vi } from 'vitest';
import { embedDim, patternEmbedding } from './helpers/embedGeometry.js';

// Stub embeddings: deterministic active-dimensional vector, no native sharp/transformers load.
// The handlers still run their FULL real DB queries.
vi.mock('../services/embedding.js', () => ({
  embeddingService: {
    generateEmbedding: vi.fn(async () => ({
      embedding: patternEmbedding(),
      dimensions: embedDim(),
      model: 'mock',
    })),
  },
}));

import { db } from '../config/database.js';
import { contextHandler } from '../handlers/context.js';
import { decisionsHandler } from '../handlers/decisions.js';
import { smartSearchHandler } from '../handlers/smartSearch.js';

const STAMP = Date.now();
const PROJ_NAME = `smartsearch-retrieval-${STAMP}`;

let projectId: string;

async function tableExists(name: string): Promise<boolean> {
  const r = await db.query(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = $1
     ) AS present`,
    [name]
  );
  return r.rows[0].present === true;
}

describe('smart_search dead-table fix + base retrieval contract', () => {
  beforeAll(async () => {
    projectId = (await db.query(
      `INSERT INTO projects (name, description) VALUES ($1, 'smart search retrieval fuse') RETURNING id`,
      [PROJ_NAME]
    )).rows[0].id;

    // Seed each live source so smart_search has something to return from EACH.
    // contexts (semantic + lexical):
    for (const content of [
      'Implemented the smart search retrieval pipeline cleanly across live sources',
      'The retrieval path queries contexts, decisions and code components',
    ]) {
      await contextHandler.storeContext({ projectId, type: 'completion', content });
    }

    // technical_decisions (decision_search source):
    await decisionsHandler.recordDecision({
      projectId,
      decisionType: 'architecture',
      impactLevel: 'high',
      title: 'Use pgvector for retrieval',
      description: 'Retrieval uses pgvector semantic similarity over contexts',
      rationale: 'Zero external cost and good recall for retrieval',
    });

    // code_components (code_analysis source):
    await db.query(
      `INSERT INTO code_components
         (project_id, file_path, name, component_type, signature, documentation, complexity_score, is_exported, tags)
       VALUES ($1, 'src/handlers/smartSearch.ts', 'smartSearch', 'function',
               'smartSearch(projectId, query)', 'runs retrieval across live sources', 5, true, ARRAY['retrieval'])`,
      [projectId]
    );
  });

  afterAll(async () => {
    if (projectId) {
      try { await db.query('DELETE FROM contexts WHERE project_id = $1', [projectId]); } catch { /* ignore */ }
      try { await db.query('DELETE FROM technical_decisions WHERE project_id = $1', [projectId]); } catch { /* ignore */ }
      try { await db.query('DELETE FROM code_components WHERE project_id = $1', [projectId]); } catch { /* ignore */ }
      try { await db.query('DELETE FROM sessions WHERE project_id = $1', [projectId]); } catch { /* ignore */ }
      try { await db.query('DELETE FROM projects WHERE id = $1', [projectId]); } catch { /* ignore */ }
    }
    await db.end();
  });

  test('the dropped naming_registry table really is gone from the migrated schema', async () => {
    expect(await tableExists('naming_registry')).toBe(false);
    // Sanity: the three live sources DO still exist (so retaining them is correct).
    expect(await tableExists('contexts')).toBe(true);
    expect(await tableExists('technical_decisions')).toBe(true);
    expect(await tableExists('code_components')).toBe(true);
  });

  test('smart_search runs cleanly, queries NO dropped table, returns live-source results', async () => {
    // Capture EVERY SQL statement smart_search runs — across BOTH access paths it
    // uses: pool-level db.query() (contexts via contextHandler, decisions) AND
    // pooled-client client.query() from db.connect() (code_components; the deleted
    // naming branch also used a pooled client). Both spies call through to the REAL
    // implementations so the search still executes for real.
    const executed: string[] = [];
    const record = (arg0: any) => {
      const sql = typeof arg0 === 'string' ? arg0 : arg0?.text ?? '';
      executed.push(String(sql));
    };

    const realQuery = db.query.bind(db);
    const querySpy = vi.spyOn(db, 'query').mockImplementation(((...args: any[]) => {
      record(args[0]);
      return (realQuery as any)(...args);
    }) as any);

    const realConnect = db.connect.bind(db);
    const connectSpy = vi.spyOn(db, 'connect').mockImplementation((async (...args: any[]) => {
      const client: any = await (realConnect as any)(...args);
      const realClientQuery = client.query.bind(client);
      client.query = (...qargs: any[]) => {
        record(qargs[0]);
        return realClientQuery(...qargs);
      };
      return client;
    }) as any);

    let results;
    try {
      results = await smartSearchHandler.smartSearch(projectId, 'retrieval', undefined, 10);
    } finally {
      querySpy.mockRestore();
      connectSpy.mockRestore();
    }

    // (1) Not a single statement may target the dropped table.
    const offending = executed.filter(s => /naming_registry/i.test(s));
    expect(offending).toEqual([]);

    // (2) smart_search returned results (the doomed branch no longer suppresses output).
    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBeGreaterThan(0);

    // (3) No result may carry the removed 'naming_registry' source or 'naming' type.
    const sources = new Set(results.map(r => r.source));
    const types = new Set(results.map(r => r.type));
    expect(sources.has('naming_registry')).toBe(false);
    expect(types.has('naming' as any)).toBe(false);

    // (4) Results come from the live sources we kept.
    const allowedSources = new Set(['semantic_search', 'text_matching', 'decision_search']);
    for (const s of sources) {
      expect(allowedSources.has(s)).toBe(true);
    }
  });

  test('base retrieval: context_search returns without error', async () => {
    const r = await contextHandler.searchContext({ projectId, query: 'retrieval pipeline', limit: 5 });
    expect(Array.isArray(r)).toBe(true);
    expect(r.length).toBeGreaterThan(0);
    // similarity is computed (number, not NaN) on the baseline/lexical path.
    expect(typeof r[0].similarity).toBe('number');
    expect(Number.isNaN(r[0].similarity)).toBe(false);
  });

  test('base retrieval: context_get_recent returns newest-first without error', async () => {
    const r = await contextHandler.getRecentContext(projectId, 5);
    expect(Array.isArray(r)).toBe(true);
    expect(r.length).toBeGreaterThan(0);
    // Chronological ordering: each createdAt <= the previous one.
    for (let i = 1; i < r.length; i++) {
      expect(new Date(r[i].createdAt).getTime()).toBeLessThanOrEqual(new Date(r[i - 1].createdAt).getTime());
    }
  });

  test('base retrieval: get_recommendations returns without error', async () => {
    // architecture recommendations pull from contexts + technical_decisions only
    // (no dropped-table access). Must not throw.
    const r = await smartSearchHandler.getRecommendations(projectId, 'building retrieval', 'architecture');
    expect(Array.isArray(r)).toBe(true);
  });
});
