/**
 * TASK_CREATE LONG-DESCRIPTION REGRESSION CONTRACT TEST
 * — the executable fuse for the task_create ~2000-char description cap.
 *
 * THE BUG (measured on LIVE PROD 2026-07-17, before this fix shipped):
 *   POST /mcp/tools/task_create with a 3000-char description returned
 *     "Validation failed for task_create: 'description' is too big (maximum 2000 characters)."
 *   `tasks.description` is Postgres TEXT — UNBOUNDED. The 2000 was a magic number in
 *   middleware/validation.ts that had drifted from the column. It rejected an ACTIVE
 *   INCIDENT record three times in two minutes (forcing real diagnostic detail to be
 *   stripped to fit) and forced a spec out of a task and into a context — breaking the
 *   doctrine that the TASK is the spine of a thread. The validator was degrading our
 *   records at exactly the moment they were most valuable.
 *
 * THE FIX:
 *   Caps DERIVE from the column via config/fieldLimits.ts — `tasks.description` is TEXT,
 *   so it carries only the shared anti-abuse ceiling (the same philosophy contexts.content
 *   already shipped: a cap stops ABUSE, it does not police how much may legitimately be
 *   written). See tests/fieldLimits.schema.test.ts for the anti-drift machinery.
 *
 * WHY THIS TEST DRIVES THE REAL EXPRESS SURFACE (and is therefore not a no-op):
 *   The zod cap lives in validationMiddleware, which runs in MandrelMcpServer.executeMcpTool
 *   — ONE LAYER ABOVE routeExecutor. A test that called routeExecutor('task_create', …)
 *   directly would enter BENEATH the gate and stay green even with the old .max(2000) in
 *   place (a fuse that measures nothing). So this boots the REAL MandrelMcpServer, takes its
 *   REAL express app (the same handleMcpToolExpress mounted at POST /mcp/tools/:toolName in
 *   production) and drives it over real HTTP. With the OLD cap these calls fail at the gate;
 *   with the fix they return 200 and the FULL description round-trips out of Postgres.
 *   (Mutation-probed: reverting the cap to .max(2000) turns these RED.)
 *
 * DB target: the disposable migrated database created by the CI gate (dropped on exit).
 * NEVER the production `mandrel` DB.
 */

import { describe, test, expect, beforeAll, afterAll, vi } from 'vitest';
import { embedDim, patternEmbedding } from './helpers/embedGeometry.js';
import type * as http from 'http';
import type express from 'express';

// Restore REAL crypto so each lazily-created session gets a distinct UUID.
vi.unmock('crypto');
vi.unmock('node:crypto');

// Stub embeddings (native @xenova/transformers → sharp unavailable in CI/sandbox).
// Everything else — validation gate, express path, Postgres write — is real.
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
import { cap } from '../config/fieldLimits.js';

const STAMP = Date.now();
const CONN = `longdesc-conn-${STAMP}`;
const PROJ_NAME = `longdesc-P-${STAMP}`;

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

function parseTaskId(resp: ToolPost): string {
  const text: string = resp.body?.result?.content?.[0]?.text ?? '';
  const m = text.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
  if (!m) throw new Error(`Could not parse task id from response: ${JSON.stringify(resp).slice(0, 400)}`);
  return m[1];
}

/** Build a realistic incident-record-shaped description of exactly `len` chars. */
function makeDescription(len: number, marker: string): string {
  const head = `INCIDENT ${marker} — repro + diagnostic detail. `;
  const filler =
    'The validator rejected this record because a magic number in validation.ts had drifted ' +
    'from the tasks.description TEXT column, so the diagnostic detail had to be stripped to fit. ';
  let body = head;
  while (body.length < len) body += filler;
  return body.slice(0, len);
}

describe('task_create long-description cap regression (real express gate + real Postgres)', () => {
  beforeAll(async () => {
    server = new MandrelMcpServer();
    const app = (server as any).healthServer.app as express.Application;
    listener = await new Promise<http.Server>((resolve) => {
      const l = app.listen(0, () => resolve(l));
    });
    const addr = listener.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    baseUrl = `http://127.0.0.1:${port}`;

    projectId = (
      await db.query(
        `INSERT INTO projects (name, description) VALUES ($1, 'long task description repro') RETURNING id`,
        [PROJ_NAME]
      )
    ).rows[0].id;
    const sw = await postTool('project_switch', { project: projectId });
    expect(sw.status).toBe(200);
    expect(sw.body.success).toBe(true);
  }, 60000);

  afterAll(async () => {
    try {
      if (projectId) {
        await db.query('DELETE FROM tasks WHERE project_id = $1', [projectId]);
        await db.query('DELETE FROM sessions WHERE project_id = $1', [projectId]);
        await db.query('DELETE FROM projects WHERE id = $1', [projectId]);
      }
    } catch {
      /* ignore */
    }
    await new Promise<void>((resolve) => listener?.close(() => resolve()));
    await db.end();
  });

  test('THE FAILING CALL: a ~3000-char description is accepted and round-trips in FULL', async () => {
    const description = makeDescription(3000, `d3k-${STAMP}`);
    expect(description.length).toBe(3000);

    // THE FUSE: with the OLD .max(2000) this fails at the validation gate.
    const resp = await postTool('task_create', {
      title: 'Incident record with a 3000-char description',
      description,
    });
    expect(
      resp.body.error,
      'task_create rejected a 3000-char description — the 2000-char drift is back'
    ).toBeUndefined();
    expect(resp.status).toBe(200);
    expect(resp.body.success).toBe(true);

    // Stored in FULL — no silent truncation between the gate and the column.
    const taskId = parseTaskId(resp);
    const row = await db.query('SELECT description FROM tasks WHERE id = $1', [taskId]);
    expect(row.rows[0].description).toBe(description);
    expect(row.rows[0].description).toHaveLength(3000);
  }, 30000);

  test('a 25,000-char spec (a real spec, not a summary) is accepted and round-trips in FULL', async () => {
    // The second half of the bug: a spec was forced out of a task and into a context.
    const description = makeDescription(25_000, `d25k-${STAMP}`);
    const resp = await postTool('task_create', {
      title: 'Task carrying a full spec in its description',
      description,
    });
    expect(resp.status).toBe(200);
    expect(resp.body.success).toBe(true);

    const taskId = parseTaskId(resp);
    const row = await db.query('SELECT description FROM tasks WHERE id = $1', [taskId]);
    expect(row.rows[0].description).toHaveLength(25_000);
    expect(row.rows[0].description).toBe(description);
  }, 30000);

  test('task_update can EDIT a description to 3000 chars (create and update agree)', async () => {
    // The edit path carried the SAME 2000 drift — a task could not be curated to a length
    // it could be created with. Both now derive from the same registry entry.
    const created = await postTool('task_create', { title: 'Task to be expanded later' });
    expect(created.status).toBe(200);
    const taskId = parseTaskId(created);

    const description = makeDescription(3000, `upd-${STAMP}`);
    const upd = await postTool('task_update', { taskId, description });
    expect(upd.body.error).toBeUndefined();
    expect(upd.status).toBe(200);

    const row = await db.query('SELECT description FROM tasks WHERE id = $1', [taskId]);
    expect(row.rows[0].description).toHaveLength(3000);
  }, 30000);

  test('the anti-abuse ceiling is still REAL — above it, an actionable rejection (not a 22001)', async () => {
    const resp = await postTool('task_create', {
      title: 'Pathological payload',
      description: 'x'.repeat(cap('tasks.description') + 1),
    });
    expect(resp.body.success).toBe(false);
    expect(String(resp.body.error)).toMatch(/description/i);
  }, 30000);

  test('an over-length assignedTo fails ACTIONABLY at the gate, not as a raw Postgres 22001', async () => {
    // THE (b)-DIRECTION BUG: assignedTo was an unbounded z.string() over a varchar(200)
    // column with nothing truncating in between, so a 201-char assignee passed validation
    // and detonated in Postgres ("value too long for type character varying(200)" — verified
    // directly against the migrated schema) surfacing as a 500 with a driver error.
    const resp = await postTool('task_create', {
      title: 'Task with an absurd assignee',
      assignedTo: 'a'.repeat(201),
    });
    expect(resp.body.success).toBe(false);
    // The caller must be told WHICH field and WHAT the limit is — not handed a 22001.
    expect(String(resp.body.error)).toMatch(/assignedTo/i);
    expect(String(resp.body.error)).not.toMatch(/value too long for type/i);

    // And the boundary value still works.
    const ok = await postTool('task_create', {
      title: 'Task with a maximal assignee',
      assignedTo: 'a'.repeat(200),
    });
    expect(ok.status).toBe(200);
    expect(ok.body.success).toBe(true);
  }, 30000);
});
