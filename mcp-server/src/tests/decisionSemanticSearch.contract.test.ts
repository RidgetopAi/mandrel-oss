/**
 * Decision Semantic Search Contract Test (an earlier task — the MOAT findability fix)
 *
 * THE BUG (proven by the tool-use eval): decision_search MISSED a clearly-present
 * decision. `find_security_decision` failed 8 turns because technical_decisions had
 * NO embedding column — decision_search relied on trigram/ILIKE text matching, so a
 * semantically-equivalent query ('critical security decision', 'authentication')
 * that shared little literal vocabulary with the stored decision never surfaced it.
 *
 * THE FIX (this test drives the REAL public tool path → real migrated Postgres):
 *   1. MIGRATION APPLIED: technical_decisions.embedding (vector(1536)) exists on the
 *      freshly-migrated disposable DB.
 *   2. EMBED ON WRITE: decision_record stores a non-null embedding.
 *   3. SEMANTIC SEARCH: a query that shares the decision's CONCEPT but not its words
 *      surfaces the right decision and ranks it #1 over an unrelated decision —
 *      the exact query shape that failed in the eval. A `similarity` score is
 *      surfaced (consistent with context_search).
 *   4. RE-EMBED ON UPDATE: decision_update that changes a text field regenerates the
 *      embedding (the stored vector changes).
 *
 * WHY MOCK THE EMBEDDER HERE: in CI there is no local model / OpenAI key, and the
 * built-in mock is a per-text hash (semantically meaningless). To prove the SEMANTIC
 * RANKING WIRING — that decision_search orders by `1 - (embedding <=> queryVec)` and
 * surfaces the concept-matching row — we inject a deterministic CONCEPT embedder:
 * texts that share a concept (security/auth) get parallel vectors (high cosine),
 * unrelated texts get orthogonal vectors (low cosine). This isolates and proves the
 * infrastructure the bug was about (embedding column + vector ranking), exactly the
 * way smartSearchRetrieval.contract.test.ts stubs the embedder to exercise the real
 * DB path. Real-model semantics are a production concern, not a contract assertion.
 *
 * DB target: the disposable migrated ci_* DB from the CI gate — never production.
 */

import { describe, test, expect, beforeAll, afterAll, vi } from 'vitest';
import { embedDim, activeEmbeddingColumn } from './helpers/embedGeometry.js';

// Deterministic CONCEPT embedder: a unit vector whose direction encodes which
// concepts the text mentions. Texts sharing concepts → near-parallel → high cosine;
// disjoint concepts → near-orthogonal → low cosine. Sized to the ACTIVE column geometry (embedDim()).
const CONCEPTS: Array<{ dim: number; words: string[] }> = [
  { dim: 0, words: ['security', 'secure', 'auth', 'authentication', 'bearer', 'fail-closed', 'token', 'credential'] },
  { dim: 1, words: ['transport', 'mcp', 'remote', 'http', 'network'] },
  { dim: 2, words: ['critical', 'severe', 'high-impact'] },
  { dim: 3, words: ['indentation', 'tabs', 'spaces', 'format', 'style', 'lint'] },
  { dim: 4, words: ['database', 'postgres', 'sql', 'pgvector'] },
  { dim: 5, words: ['cache', 'caching', 'redis', 'memory'] },
];

function conceptEmbedding(text: string): number[] {
  const v = new Array(embedDim()).fill(0);
  const lower = ` ${text.toLowerCase()} `;
  for (const c of CONCEPTS) {
    if (c.words.some(w => lower.includes(w))) v[c.dim] = 1;
  }
  // Tiny constant so an all-zero vector (no concept hit) is still valid/normalizable.
  v[embedDim() - 1] = 0.001;
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map(x => x / norm);
}

vi.mock('../services/embedding.js', () => ({
  embeddingService: {
    generateEmbedding: vi.fn(async ({ text }: { text: string }) => ({
      embedding: conceptEmbedding(text),
      dimensions: embedDim(),
      model: 'concept-mock',
    })),
  },
}));

import { db } from '../config/database.js';
import { decisionsRoutes } from '../routes/decisions.routes.js';
import { validateToolArguments } from '../middleware/validation.js';
import { bindConnectionToProject } from './helpers/projectBinding.js';

const STAMP = Date.now();
const PROJ_NAME = `decision-semantic-search-${STAMP}`;

// ONE CONNECTION, BOUND TO THIS FILE'S PROJECT. `decision_record` and
// `decision_search` take an explicit `projectId`; `decision_update` and `decision_get` do
// NOT, so they resolved their project from the ambient ladder — whose last rung is
// `projects[0] ORDER BY updated_at DESC`, i.e. whichever project this DATABASE touched
// most recently. Every assertion in this file is about rows in PROJ_NAME, so the
// connection says so instead of letting row ordering answer.
const CONN = `decision-semantic-search-conn-${STAMP}`;
const CTX = { connectionId: CONN };

let projectId: string;

function textOf(resp: any): string {
  return resp?.content?.map((c: any) => c.text).join('\n') ?? '';
}
function idFromRecordText(text: string): string {
  const m = text.match(/\bID:\s*([0-9a-f-]{36})/i);
  expect(m, 'record response must include the decision UUID').toBeTruthy();
  return m![1];
}
async function viaPublicTool(
  toolName: string,
  rawArgs: any,
  handler: (a: any, ctx: typeof CTX) => Promise<any>,
) {
  const validated = validateToolArguments(toolName, rawArgs);
  return handler(validated, CTX);
}

describe('decision_search semantic findability (the eval find_security_decision case)', () => {
  let securityId: string;
  let unrelatedId: string;

  beforeAll(async () => {
    projectId = (await db.query(
      `INSERT INTO projects (name, description) VALUES ($1, 'decision semantic search fuse') RETURNING id`,
      [PROJ_NAME]
    )).rows[0].id;
    await bindConnectionToProject(CONN, PROJ_NAME);

    // The decision the eval failed to find — note the QUERY below shares the CONCEPT
    // (security/auth) but NOT the literal words, which is why text matching missed it.
    const sec = await viaPublicTool('decision_record', {
      decisionType: 'security',
      title: 'Fail-closed bearer auth on the remote MCP transport',
      description: 'Reject any request to the remote MCP endpoint that lacks a valid bearer token',
      rationale: 'A missing/invalid token must fail closed so the transport cannot be reached unauthenticated',
      impactLevel: 'critical',
      projectId,
    }, (a, c) => decisionsRoutes.handleRecord(a, c));
    securityId = idFromRecordText(textOf(sec));

    // An unrelated decision in a totally different concept space (code style).
    const unrel = await viaPublicTool('decision_record', {
      decisionType: 'code_style',
      title: 'Use tabs for indentation',
      description: 'Standardize on tabs over spaces for all source formatting',
      rationale: 'Consistent indentation style across the codebase',
      impactLevel: 'low',
      projectId,
    }, (a, c) => decisionsRoutes.handleRecord(a, c));
    unrelatedId = idFromRecordText(textOf(unrel));
  });

  afterAll(async () => {
    if (projectId) {
      try { await db.query('DELETE FROM technical_decisions WHERE project_id = $1', [projectId]); } catch { /* ignore */ }
      try { await db.query('DELETE FROM sessions WHERE project_id = $1', [projectId]); } catch { /* ignore */ }
      try { await db.query('DELETE FROM projects WHERE id = $1', [projectId]); } catch { /* ignore */ }
    }
    await db.end();
  });

  test('MIGRATION: technical_decisions.embedding column exists (vector, nullable)', async () => {
    const r = await db.query(`
      SELECT data_type, udt_name, is_nullable
      FROM information_schema.columns
      WHERE table_name = 'technical_decisions' AND column_name = 'embedding'
    `);
    expect(r.rows.length, 'embedding column must exist on technical_decisions').toBe(1);
    expect(r.rows[0].udt_name).toBe('vector');
    expect(r.rows[0].is_nullable).toBe('YES');
  });

  test('EMBED ON WRITE: decision_record stores a non-null embedding', async () => {
    const r = await db.query(
      `SELECT ${activeEmbeddingColumn()} IS NOT NULL AS has_embedding FROM technical_decisions WHERE id = $1`,
      [securityId]
    );
    expect(r.rows[0].has_embedding).toBe(true);
  });

  test('SEMANTIC: a concept-equivalent query (no shared words) surfaces the security decision #1', async () => {
    // This is the exact query shape that failed 8 turns in the eval. It shares ZERO
    // distinctive words with the stored title/description ("bearer", "MCP", "reject")
    // — it would NOT match on ILIKE — yet semantic ranking must surface it FIRST.
    const resp = await viaPublicTool(
      'decision_search',
      { query: 'critical security authentication decision', projectId },
      (a, c) => decisionsRoutes.handleSearch(a, c)
    );
    const results = (resp as any).data?.results ?? [];
    expect(results.length, 'semantic search must return candidates').toBeGreaterThan(0);

    // The security decision is found AND ranked first over the unrelated one.
    expect(results[0].id, 'the security decision must rank #1').toBe(securityId);
    const sec = results.find((r: any) => r.id === securityId);
    expect(sec, 'security decision must be present').toBeTruthy();

    // A similarity score is surfaced (consistent with context_search) and the
    // security decision out-scores the unrelated one.
    expect(typeof sec.similarity).toBe('number');
    const unrel = results.find((r: any) => r.id === unrelatedId);
    if (unrel && typeof unrel.similarity === 'number') {
      expect(sec.similarity).toBeGreaterThan(unrel.similarity);
    }
  });

  test('SEMANTIC: the single word "authentication" surfaces the security decision', async () => {
    const resp = await viaPublicTool(
      'decision_search',
      { query: 'authentication', projectId },
      (a, c) => decisionsRoutes.handleSearch(a, c)
    );
    const results = (resp as any).data?.results ?? [];
    expect(results[0]?.id).toBe(securityId);
  });

  test('RE-EMBED ON UPDATE: changing a text field regenerates the embedding', async () => {
    const before = await db.query(
      `SELECT ${activeEmbeddingColumn()}::text AS e FROM technical_decisions WHERE id = $1`,
      [securityId]
    );
    const beforeVec = before.rows[0].e;

    // problemStatement is a text field decision_update can change → must re-embed.
    // Inject caching/database concepts so the vector provably MOVES.
    await viaPublicTool('decision_update', {
      decisionId: securityId,
      problemStatement: 'caching layer and database token validation latency under load',
    }, (a, c) => decisionsRoutes.handleUpdate(a, c));

    const after = await db.query(
      `SELECT ${activeEmbeddingColumn()}::text AS e FROM technical_decisions WHERE id = $1`,
      [securityId]
    );
    expect(after.rows[0].e, 'embedding must still be present after update').toBeTruthy();
    expect(after.rows[0].e, 'embedding must change when the text changes').not.toBe(beforeVec);
  });
});
