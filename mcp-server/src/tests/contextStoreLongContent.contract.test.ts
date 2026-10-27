/**
 * Long-Content Context Store Regression Contract Test
 * (the executable fuse for the context_store ~10k-char-cap 500)
 *
 * THE BUG (LongMemEval rerun pain):
 *   context_store returned a 500 when `content` exceeded the ~10000-char Zod cap
 *   (`content: z.string().min(1).max(10000)` in middleware/validation.ts). The real
 *   failing turn was ~23,000 chars. A 500 on the HTTP surface (handleMcpToolExpress
 *   catches the thrown validation error → res.status(500)) means the user's content is
 *   rejected wholesale — silent data loss from the caller's point of view.
 *
 * THE FIX (store-full + embed-bounded — the operator's no-data-loss bar):
 *   The handler ALREADY does the right thing: it stores request.content.trim() in FULL
 *   (contexts.content is Postgres TEXT) and embeds only request.content.substring(0,1000)
 *   (handlers/context.ts), so the local embedding model's token limit is never reached
 *   regardless of stored length. The ONLY thing breaking long content was the arbitrary
 *   Zod .max(10000) gate. The fix removes that content cap (keeping a generous 5MB
 *   anti-abuse ceiling). Full content is accepted, stored, embedded, and retrievable.
 *
 * WHY THIS TEST DRIVES THE REAL EXPRESS /mcp/tools SURFACE (NOT routeExecutor):
 *   The Zod content cap lives in validationMiddleware, which runs in
 *   MandrelMcpServer.executeMcpTool (server/MandrelMcpServer.ts) — ONE LAYER ABOVE
 *   routeExecutor (routes/index.ts). routeExecutor itself never validates. So a test
 *   that calls routeExecutor('context_store', …) directly enters BENEATH the gate and
 *   can NEVER exercise the cap — it would stay green even with the old .max(10000) in
 *   place (a no-op fuse). To faithfully reproduce the customer-visible failure this test
 *   boots the REAL MandrelMcpServer, takes its REAL express app (the same
 *   handleMcpToolExpress that mounts at POST /mcp/tools/:toolName in production), and
 *   drives it over HTTP. handleMcpToolExpress → executeMcpTool → validationMiddleware →
 *   routeExecutor, exactly as production does. With the OLD cap the validation throw
 *   surfaces as HTTP 500 ("Validation failed … content"); with the FIX it returns HTTP
 *   200. That status flip IS the regression fuse — it goes RED if the cap is restored.
 *
 * WHAT THIS PROVES (real validation gate + real express 500 path + real Postgres):
 *   1. ~23,000-char content (the real failing turn size) returns HTTP 200 over the real
 *      /mcp/tools/context_store surface (PRE-FIX this 500'd at the Zod gate), an
 *      embedding is generated and persisted, and the FULL content round-trips unmodified
 *      in the DB (no truncation in storage).
 *   2. ~100,000-char content (very-long stress) returns HTTP 200 with the same
 *      guarantees — proves there is no hidden storage cap below the 5MB ceiling.
 *   3. The long content is RETRIEVABLE via context_search (it comes back as a result
 *      with its full content intact).
 *
 * Embeddings are stubbed (native @xenova/transformers → sharp unavailable in CI/sandbox).
 * Everything else is real: the booted server's validation middleware, the express 500
 * path, and the full Postgres write.
 *
 * DB target: the disposable migrated database created by the CI gate (dropped on exit).
 * NEVER the production `mandrel` DB.
 */

import { describe, test, expect, beforeAll, afterAll, vi } from 'vitest';
import { embedDim, activeEmbeddingColumn, patternEmbedding } from './helpers/embedGeometry.js';
import { randomUUID } from 'node:crypto';
import type * as http from 'http';
import type express from 'express';

// Restore REAL crypto so each lazily-created session gets a distinct UUID.
vi.unmock('crypto');
vi.unmock('node:crypto');

// Stub embeddings. We capture the text actually handed to the embedder so we can ASSERT
// the embed-bounded invariant: the model never sees more than the handler's bounded slice,
// no matter how large the stored content is.
const embedTexts: string[] = [];
vi.mock('../services/embedding.js', () => ({
  embeddingService: {
    generateEmbedding: vi.fn(async (req: { text: string }) => {
      embedTexts.push(req.text);
      return {
        embedding: patternEmbedding(),
        dimensions: embedDim(),
        model: 'stub-local',
      };
    }),
  },
}));

import { db } from '../config/database.js';
import MandrelMcpServer from '../server/MandrelMcpServer.js';

const STAMP = Date.now();
const CONN = `longcontent-conn-${STAMP}`;
const PROJ_NAME = `longcontent-P-${STAMP}`;

let projectId: string;

// Booted server + a short-lived listener on an ephemeral port. We bind the REAL express
// app (server.healthServer.app) directly — no process lock, no portManager — so we drive
// the genuine handleMcpToolExpress → executeMcpTool → validationMiddleware → routeExecutor
// path over real HTTP, faithfully reproducing the production 500 on a cap violation.
let server: MandrelMcpServer;
let listener: http.Server;
let baseUrl: string;

interface ToolPost {
  status: number;
  body: { success: boolean; result?: any; error?: string };
}

/** POST a tool through the REAL express surface, scoped to our connection/session. */
async function postTool(toolName: string, args: Record<string, unknown>): Promise<ToolPost> {
  const res = await fetch(`${baseUrl}/mcp/tools/${toolName}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Connection-ID': CONN },
    body: JSON.stringify({ arguments: args }),
  });
  const body = (await res.json()) as ToolPost['body'];
  return { status: res.status, body };
}

function parseContextId(resp: ToolPost): string {
  const text: string = resp.body?.result?.content?.[0]?.text ?? '';
  const m = text.match(/ID:\s*([0-9a-f-]{36})/i);
  if (!m) throw new Error(`Could not parse context id from response: ${JSON.stringify(resp).slice(0, 300)}`);
  return m[1];
}

/**
 * Build content of exactly `len` chars with a unique, searchable marker phrase near the
 * start so context_search can retrieve it deterministically, plus enough lexical variety
 * that it isn't a single repeated byte.
 */
function makeContent(len: number, marker: string): string {
  const head = `MARKER ${marker} — long-content regression payload. `;
  const filler =
    'The quick brown fox jumps over the lazy dog while the team debugs the embedding ' +
    'pipeline and stores a very long conversational turn into Mandrel context memory. ';
  let body = head;
  while (body.length < len) body += filler;
  return body.slice(0, len);
}

async function storedRow(contextId: string): Promise<{ content: string; embedding: unknown }> {
  const r = await db.query(`SELECT content, ${activeEmbeddingColumn()} AS embedding FROM contexts WHERE id = $1`, [contextId]);
  return { content: r.rows[0]?.content, embedding: r.rows[0]?.embedding };
}

describe('context_store long-content cap regression (real express 500 gate, store-full + embed-bounded)', () => {
  beforeAll(async () => {
    // Boot the real server (constructor wires up the express app + handlers) but DON'T
    // call start() — we don't want the process lock / portManager / stdio transport. We
    // just need the genuine express app and its executeMcpTool wiring.
    server = new MandrelMcpServer();
    const app = (server as any).healthServer.app as express.Application;
    listener = await new Promise<http.Server>((resolve) => {
      const l = app.listen(0, () => resolve(l));
    });
    const addr = listener.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    baseUrl = `http://127.0.0.1:${port}`;

    // Create the project directly, then switch THIS connection to it through the real
    // surface so the lazily-created session is scoped to our project.
    projectId = (await db.query(
      `INSERT INTO projects (name, description) VALUES ($1, 'long-content cap repro') RETURNING id`,
      [PROJ_NAME]
    )).rows[0].id;
    const sw = await postTool('project_switch', { project: projectId });
    expect(sw.status).toBe(200);
    expect(sw.body.success).toBe(true);
  }, 60000);

  afterAll(async () => {
    try {
      if (projectId) {
        await db.query('DELETE FROM contexts WHERE project_id = $1', [projectId]);
        await db.query('DELETE FROM sessions WHERE project_id = $1', [projectId]);
        await db.query('DELETE FROM projects WHERE id = $1', [projectId]);
      }
    } catch { /* ignore */ }
    await new Promise<void>((resolve) => listener?.close(() => resolve()));
    await db.end();
  });

  test('~23,000-char turn (the real failing size) returns HTTP 200, embeds, and round-trips full content — NO 500', async () => {
    const marker = `m23k-${STAMP}`;
    const content = makeContent(23_000, marker);
    expect(content.length).toBe(23_000);

    // THE FUSE: with the OLD .max(10000) cap, validationMiddleware throws inside
    // executeMcpTool and handleMcpToolExpress turns it into HTTP 500 ("Validation
    // failed … content") — this assertion goes RED. With the FIX (.max(5_000_000)) the
    // same call returns HTTP 200 success.
    const resp = await postTool('context_store', {
      content,
      type: 'completion',
      tags: ['longcontent', '23k'],
    });
    expect(resp.status).toBe(200);
    expect(resp.body.success).toBe(true);

    const ctxId = parseContextId(resp);
    const row = await storedRow(ctxId);

    // FULL content stored, byte-for-byte — no truncation in storage (no data loss).
    expect(row.content).toBe(content);
    expect(row.content.length).toBe(23_000);
    // An embedding was generated and persisted.
    expect(row.embedding).toBeTruthy();
    // Embed-bounded invariant: the embedder never received the full 23k content — only
    // the handler's bounded slice (header + <=1000 content chars). Proves we don't blow
    // the model's token limit even as stored content grows.
    const lastEmbed = embedTexts[embedTexts.length - 1];
    expect(lastEmbed.length).toBeLessThan(2_000);
  });

  test('~100,000-char content (very-long) returns HTTP 200, embeds, and round-trips full content — NO 500', async () => {
    const marker = `m100k-${STAMP}`;
    const content = makeContent(100_000, marker);
    expect(content.length).toBe(100_000);

    const resp = await postTool('context_store', {
      content,
      type: 'completion',
      tags: ['longcontent', '100k'],
    });
    expect(resp.status).toBe(200);
    expect(resp.body.success).toBe(true);

    const ctxId = parseContextId(resp);
    const row = await storedRow(ctxId);

    expect(row.content).toBe(content);
    expect(row.content.length).toBe(100_000);
    expect(row.embedding).toBeTruthy();
    const lastEmbed = embedTexts[embedTexts.length - 1];
    expect(lastEmbed.length).toBeLessThan(2_000);
  });

  test('long content is RETRIEVABLE via context_search with full content intact', async () => {
    // SELF-ISOLATED (order-independent): store THIS test's OWN long context with a
    // per-run-UNIQUE marker, then prove it is retrievable via context_search with its
    // FULL content intact. It must not depend on the two earlier store tests (23k/100k)
    // having run first — a within-file test-shuffle can reorder siblings so those markers
    // aren't in the DB yet ("expected … to contain m23k-…"), and other files must not
    // bleed in. Storing + searching this test's own content proves the retrieval contract
    // (searchable + full content round-trips) regardless of execution order. The 23k/100k
    // stores' own 200-status + full-DB-roundtrip guarantees stay covered by tests 1 & 2.
    const marker = `mret-${STAMP}-${randomUUID().slice(0, 8)}`;
    const content = makeContent(23_000, marker);

    const store = await postTool('context_store', {
      content,
      type: 'completion',
      tags: ['longcontent', 'retrieve'],
    });
    expect(store.status).toBe(200);
    expect(store.body.success).toBe(true);
    const ctxId = parseContextId(store);

    // Search uses the same stubbed embedding for every row, so vector similarity is flat;
    // retrieval here leans on the project filter + the result set containing our row.
    const resp = await postTool('context_search', {
      query: 'long-content regression payload',
      projectId,
      limit: 50,
    });
    expect(resp.status).toBe(200);
    expect(resp.body.success).toBe(true);

    const text: string = resp.body?.result?.content?.[0]?.text ?? '';
    expect(text).toContain(marker);

    // Belt: confirm directly in the DB that THIS row exists for this project with its
    // exact length — retrievable + complete (no truncation in storage).
    const row = await storedRow(ctxId);
    expect(row.content).toBe(content);
    expect(row.content.length).toBe(23_000);
  });
});
