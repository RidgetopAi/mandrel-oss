/**
 * `note` CONTEXT TYPE — the generic capture has a real home, and `fact` does not
 * (the auditor rec).
 *
 * THE DEFECT: in the Phase-3 eval 5/7 stores guessed `type: "fact"` — an invalid enum —
 * because no generic type existed. The fix is a real type, `note`, added to every copy of
 * the domain: config/contextTypes.ts (the zod enum + the handler's TS type), the DB CHECK
 * constraint (migration 100), mandrel-command's ContextTypeSchema. Deliberately NOT done, on
 * The auditor's call: aliasing `fact` → note server-side, or defaulting a missing type. Either one
 * lets a mislabel into durable memory silently.
 *
 * WHY THIS DRIVES THE REAL EXPRESS /mcp/tools SURFACE: the enum lives in validationMiddleware,
 * which runs in executeMcpTool — ONE LAYER ABOVE routeExecutor. A test that calls the handler
 * directly enters beneath the gate and cannot see a rejection. So this boots the real server's
 * express app (the same handleMcpToolExpress production mounts) and drives it over HTTP, the
 * way contextStoreLongContent.contract.test.ts does.
 *
 * WHAT IT PROVES, and the layer each assertion reads (C1 ladder: code enforcement < DB
 * constraint < observed values):
 *   1. type=note stores (HTTP 200), the row's context_type IS 'note' (observed value), and it
 *      round-trips through context_search with type filter 'note'.
 *   2. type=fact is REJECTED at the gate, and the error names `note` as the generic type —
 *      the model that guessed learns the answer in the same round trip.
 *   3. THE DB CONSTRAINT ITSELF accepts 'note' and rejects 'fact' via raw INSERT — this is
 *      the assertion that holds against a handler nobody has written yet.
 *   4. No default: a store with NO type is rejected, not stored as note.
 *
 * Embeddings are stubbed. DB target: the disposable migrated DB (never prod).
 */

import { describe, test, expect, beforeAll, afterAll, vi } from 'vitest';
import { embedDim, patternEmbedding } from './helpers/embedGeometry.js';
import type * as http from 'http';
import type express from 'express';

vi.unmock('crypto');
vi.unmock('node:crypto');

vi.mock('../services/embedding.js', () => ({
  embeddingService: {
    generateEmbedding: vi.fn(async () => ({
      embedding: patternEmbedding(),
      dimensions: embedDim(),
      model: 'stub-local',
    })),
  },
}));

import { db } from '../config/database.js';
import MandrelMcpServer from '../server/MandrelMcpServer.js';
import { CONTEXT_TYPES, GENERIC_CONTEXT_TYPE } from '../config/contextTypes.js';

const STAMP = Date.now();
const CONN = `notetype-conn-${STAMP}`;
const PROJ_NAME = `notetype-P-${STAMP}`;

let projectId: string;
let server: MandrelMcpServer;
let listener: http.Server;
let baseUrl: string;

interface ToolPost {
  status: number;
  body: { success: boolean; result?: any; error?: string };
}

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

/** The gate's rejection text, wherever the surface put it (error field or result text). */
function rejectionText(resp: ToolPost): string {
  return `${resp.body.error ?? ''} ${resp.body?.result?.content?.[0]?.text ?? ''}`;
}

describe('context type `note` — generic capture exists; `fact` is rejected, not aliased', () => {
  beforeAll(async () => {
    server = new MandrelMcpServer();
    const app = (server as any).healthServer.app as express.Application;
    listener = await new Promise<http.Server>((resolve) => {
      const l = app.listen(0, () => resolve(l));
    });
    const addr = listener.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    baseUrl = `http://127.0.0.1:${port}`;

    projectId = (await db.query(
      `INSERT INTO projects (name, description) VALUES ($1, 'note context type contract') RETURNING id`,
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

  test('the config names `note` as the generic type and it is in the domain', () => {
    expect(GENERIC_CONTEXT_TYPE).toBe('note');
    expect(CONTEXT_TYPES).toContain('note');
    expect(CONTEXT_TYPES).not.toContain('fact');
  });

  test('type=note stores over the real surface, the row reads context_type=note, and a type-filtered search finds it', async () => {
    const marker = `note-roundtrip-${STAMP}`;
    const resp = await postTool('context_store', {
      content: `A generic captured observation ${marker} with nothing more specific to be.`,
      type: 'note',
      tags: ['notetype-contract'],
    });
    expect(resp.status).toBe(200);
    expect(resp.body.success).toBe(true);

    const ctxId = parseContextId(resp);
    const row = await db.query('SELECT context_type FROM contexts WHERE id = $1', [ctxId]);
    expect(row.rows[0]?.context_type).toBe('note');

    const search = await postTool('context_search', { query: marker, type: 'note', limit: 5 });
    expect(search.status).toBe(200);
    expect(search.body.success).toBe(true);
    const text: string = search.body?.result?.content?.[0]?.text ?? '';
    expect(text).toContain(ctxId.slice(0, 8));
  });

  test('type=fact is REJECTED and the message names `note` as the generic type (no alias)', async () => {
    const before = (await db.query('SELECT count(*)::int AS n FROM contexts WHERE project_id = $1', [projectId])).rows[0].n;
    const resp = await postTool('context_store', {
      content: 'The eval model guessed this type; it must not be silently relabelled.',
      type: 'fact',
    });
    expect(resp.body.success).toBe(false);
    const msg = rejectionText(resp);
    // The allowed-values list ALSO contains "note", so `toContain('"note"')` would be hollow
    // (measured: a probe that deleted the hint stayed green against it). Pin the HINT
    // sentence — the part that tells the caller `note` is the answer, not merely an option.
    expect(msg).toMatch(/no "fact" type/);
    expect(msg).toMatch(/use "note"/);
    // Nothing was written — a rejected write is a rejected write.
    const after = (await db.query('SELECT count(*)::int AS n FROM contexts WHERE project_id = $1', [projectId])).rows[0].n;
    expect(after).toBe(before);
  });

  test('a store with NO type is rejected — the server never defaults to note', async () => {
    const resp = await postTool('context_store', { content: 'no type supplied at all' });
    expect(resp.body.success).toBe(false);
    const noteRows = (await db.query(
      `SELECT count(*)::int AS n FROM contexts WHERE project_id = $1 AND context_type = 'note' AND content = 'no type supplied at all'`,
      [projectId]
    )).rows[0].n;
    expect(noteRows).toBe(0);
  });

  test('the DB CHECK constraint accepts note and rejects fact (raw INSERT, beneath every handler)', async () => {
    const ok = await db.query(
      `INSERT INTO contexts (project_id, context_type, content) VALUES ($1, 'note', 'constraint probe') RETURNING id, context_type`,
      [projectId]
    );
    expect(ok.rows[0].context_type).toBe('note');

    let code: string | undefined;
    try {
      await db.query(
        `INSERT INTO contexts (project_id, context_type, content) VALUES ($1, 'fact', 'constraint probe')`,
        [projectId]
      );
    } catch (e: any) {
      code = e.code;
    }
    // 23514 = check_violation. The constraint name is asserted too so a different CHECK
    // failing cannot pass as this one.
    expect(code).toBe('23514');
    const def = await db.query(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = 'contexts'::regclass AND conname = 'contexts_context_type_check'`
    );
    expect(def.rows[0].def).toContain("'note'");
    expect(def.rows[0].def).not.toContain("'fact'");
  });
});
