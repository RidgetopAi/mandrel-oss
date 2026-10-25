/**
 * JSON-RPC error code → HTTP status contract.
 *
 * THE DEFECT (measured against prod, two calls differing only by one undeclared param):
 *   POST /mcp/tools/task_update {"taskId":"3802f00d","status":"in_progress","notes":"x"} → 500
 *   POST /mcp/tools/task_update {"taskId":"3802f00d","status":"in_progress"}             → 200
 *   500 body: `MCP error -32602: Input validation failed: … Unknown parameter(s): 'notes'.`
 *
 *   NOTE ON THE SUBJECT PARAM: `notes` is no longer undeclared — an earlier task made it the
 *   append affordance on task_update, which is the right fix for a different defect. The
 *   blocks below therefore DERIVE an undeclared param from the live schema (see
 *   UNDECLARED_PARAM). The classification contract under test is unchanged; only the
 *   example moved, and it can no longer be legalised out from under these tests.
 *
 *   -32602 is literally JSON-RPC "Invalid params" — a CLIENT error reported as a SERVER
 *   error. Every well-behaved HTTP client treats 5xx as retryable and 4xx as terminal, so a
 *   500 tells a retrying agent SDK to retry — forever — a request that can never succeed,
 *   and inflates the 5xx rate we alert on. Recurrence of the class already documented in
 *   contextStoreLongContent.contract.test.ts ("catches the thrown validation error →
 *   res.status(500)"). See utils/mcpErrorStatus.ts for the full rationale.
 *
 * WHY THE TESTS ARE SHAPED THE WAY THEY ARE (each block proves a DIFFERENT thing):
 *
 *   §1 FAIL-CLOSED (the single most important property). An UNRECOGNISED error must still
 *      be 500 — never 2xx/4xx, which would silently swallow a real fault and hide it from
 *      the exact alerting this fix protects. Asserted directly on the values that
 *      historically slip through a guard: absent / zero / empty-string / NaN / Infinity /
 *      null / a STRING code (`'23505'` is a real Postgres error's code shape) / an
 *      unmapped number. A past incident rule 7.
 *
 *   §2 THE SEAM COVERS BOTH SURFACES, STRUCTURALLY. A stub executor that THROWS is driven
 *      through the real express app under BOTH a flat opId name (`task_update`) and a
 *      gateway name (`task`). Both land in the ONE catch in handleMcpToolExpress and get
 *      the identical classification — that is what "one classification point covers every
 *      tool on both surfaces" MEANS, and it is proven rather than asserted from a comment.
 *      A stub is used ON PURPOSE here: with the real executor the gateway path can never
 *      reach this catch (see §4), so only an injected throw can exercise the seam under a
 *      gateway name at all.
 *
 *   §3 THE REPORTED DEFECT, END TO END, REAL EXECUTOR, REAL DB. The exact two prod bodies
 *      over the genuine handleMcpToolExpress → executeMcpTool → validationMiddleware path.
 *      This is the regression fuse for the actual customer-visible bug.
 *
 *   §4 MEASURED REALITY OF THE GATEWAY PATH, PINNED. dispatchGateway catches its own
 *      validation error and returns a 200 + isError response, so the gateway name NEVER
 *      emitted the 500 and its status is UNCHANGED by this fix. That is correct behaviour,
 *      not a bug — but it is pinned here so a future refactor that lets a gateway validation
 *      error escape as a raw throw cannot silently reintroduce a 5xx on a client mistake.
 *
 *   §5 THE MESSAGE AND STRICT MODE ARE NOT WEAKENED. The whole point is that ONLY the status
 *      code changed. If a future "fix" relaxes strict mode or drops the actionable text to
 *      make a 4xx look tidier, this goes RED.
 *
 * WHAT MOVED UNDER THIS FILE LATER. Everything asserted here still holds and
 * still passes unchanged — but this file covers only the THROWN half of the status question.
 * The other half, a refusal returned IN BAND (which is how every project-binding and
 * caller-identity refusal actually reaches the client), was measured at 200 and is fixed and
 * guarded in policyRefusalStatus.contract.test.ts. §4 below pins the gateway path at
 * `200 + isError`, and that is still right for an ordinary tool error — read it as "the tool
 * ran and answered", not as "in-band means 200".
 *
 * DB target: the disposable migrated database provisioned by the CI gate (dropped on
 * exit). NEVER the production `mandrel` DB.
 */

import { describe, test, expect, beforeAll, afterAll, vi } from 'vitest';
import type * as http from 'http';
import type express from 'express';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import {
  httpStatusForError,
  UNCLASSIFIED_ERROR_STATUS,
  CLASSIFIED_JSONRPC_CODES,
} from '../utils/mcpErrorStatus.js';

// Restore REAL crypto so each lazily-created session gets a distinct UUID.
vi.unmock('crypto');
vi.unmock('node:crypto');

// Embeddings stubbed (native @xenova/transformers → sharp unavailable in CI/sandbox).
// Geometry derived from the ACTIVE embedder, never written by hand — an async factory so the
// helper resolves at use rather than at the hoisted vi.mock call.
vi.mock('../services/embedding.js', async () => {
  const { embedDim } = await import('./helpers/embedGeometry.js');
  return {
    embeddingService: {
      generateEmbedding: vi.fn(async () => ({
        embedding: new Array(embedDim()).fill(0.01),
        dimensions: embedDim(),
        model: 'stub-local',
      })),
    },
  };
});

import { db } from '../config/database.js';
import { undeclaredTaskUpdateParam } from './helpers/undeclaredParam.js';
import MandrelMcpServer from '../server/MandrelMcpServer.js';
import { HealthServer } from '../server/healthServer.js';

const STAMP = Date.now();
const CONN = `errstatus-conn-${STAMP}`;
const PROJ_NAME = `errstatus-P-${STAMP}`;

// The exact prod-reported request bodies, stated ONCE so §3/§4/§5 cannot drift apart.
const TASK_ID = '3802f00d';

/**
 * The undeclared param these blocks send, DERIVED from the live zod schema rather than
 * typed in.
 *
 * It was the literal string `notes` — the param from the prod report — until an earlier task
 * DECLARED `notes` on task_update (it is now the append affordance). The moment it was
 * declared, four tests in this file stopped exercising the strict-mode rejection they exist
 * to guard: the request became VALID, and a guard whose subject can be legalised by an
 * unrelated change is a guard that goes hollow without anyone touching it.
 *
 * So the subject is now read off `validationSchemas.task_update`: the first candidate the
 * schema does NOT declare. Declaring one of these in future re-points the guard instead of
 * disarming it, and declaring ALL of them fails loudly here rather than silently passing.
 */
const UNDECLARED_PARAM: string = undeclaredTaskUpdateParam();

const BODY_WITH_UNDECLARED_PARAM = { taskId: TASK_ID, status: 'in_progress', [UNDECLARED_PARAM]: 'x' };
const BODY_CLEAN = { taskId: TASK_ID, status: 'in_progress' };

let projectId: string;
let realServer: MandrelMcpServer;
let realListener: http.Server;
let realBase: string;

interface ToolPost {
  status: number;
  body: { success: boolean; result?: any; error?: string; type?: string };
}

async function postTo(base: string, toolName: string, args: Record<string, unknown>): Promise<ToolPost> {
  const res = await fetch(`${base}/mcp/tools/${toolName}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Connection-ID': CONN },
    body: JSON.stringify({ arguments: args }),
  });
  return { status: res.status, body: (await res.json()) as ToolPost['body'] };
}

const postReal = (tool: string, args: Record<string, unknown>) => postTo(realBase, tool, args);

// ---------------------------------------------------------------------------------------
// §2 harness: the REAL express app wired to a stub executor that throws whatever the test
// asks for. Lets us exercise the seam under BOTH a flat opId and a gateway tool name — the
// only way to reach the catch under a gateway name at all (see §4).
// ---------------------------------------------------------------------------------------
let thrown: unknown;
let stubListener: http.Server;
let stubBase: string;

describe('MCP error-code → HTTP status classification', () => {
  beforeAll(async () => {
    // --- stub-executor app (no DB needed) ---
    const stubHealth = new HealthServer(async () => {
      throw thrown;
    });
    const stubApp = (stubHealth as any).app as express.Application;
    stubListener = await new Promise<http.Server>((r) => {
      const l = stubApp.listen(0, () => r(l));
    });
    const sa = stubListener.address();
    stubBase = `http://127.0.0.1:${typeof sa === 'object' && sa ? sa.port : 0}`;

    // --- real server (real validation + real DB), bound WITHOUT start(): no process lock,
    // no portManager, no stdio transport — just the genuine express app + executor wiring.
    realServer = new MandrelMcpServer();
    const realApp = (realServer as any).healthServer.app as express.Application;
    realListener = await new Promise<http.Server>((r) => {
      const l = realApp.listen(0, () => r(l));
    });
    const ra = realListener.address();
    realBase = `http://127.0.0.1:${typeof ra === 'object' && ra ? ra.port : 0}`;

    projectId = (
      await db.query(
        `INSERT INTO projects (name, description) VALUES ($1, 'error-status mapping contract') RETURNING id`,
        [PROJ_NAME]
      )
    ).rows[0].id;
    const sw = await postReal('project_switch', { project: projectId });
    expect(sw.status).toBe(200);
  }, 60000);

  afterAll(async () => {
    try {
      if (projectId) {
        await db.query('DELETE FROM contexts WHERE project_id = $1', [projectId]);
        await db.query('DELETE FROM tasks WHERE project_id = $1', [projectId]);
        await db.query('DELETE FROM sessions WHERE project_id = $1', [projectId]);
        await db.query('DELETE FROM projects WHERE id = $1', [projectId]);
      }
    } catch {
      /* ignore */
    }
    await new Promise<void>((r) => stubListener?.close(() => r()));
    await new Promise<void>((r) => realListener?.close(() => r()));
    await db.end();
  });

  // =====================================================================================
  // §1 FAIL CLOSED — the single most important property.
  // =====================================================================================
  describe('§1 fail-closed default: anything unrecognised is 500', () => {
    // Every value that historically slips through a guard. `0` and `''` are the ones a
    // falsy/`??` check silently mishandles; a STRING code is what a real Postgres or Node
    // syscall error actually carries.
    const unrecognised: Array<[string, unknown]> = [
      ['a plain Error (no code at all)', new Error('boom')],
      ['code absent', { message: 'no code field' }],
      ['code = 0', Object.assign(new Error('zero'), { code: 0 })],
      ['code = -0', Object.assign(new Error('neg zero'), { code: -0 })],
      ["code = '' (empty string)", Object.assign(new Error('empty'), { code: '' })],
      ['code = NaN', Object.assign(new Error('nan'), { code: NaN })],
      ['code = Infinity', Object.assign(new Error('inf'), { code: Infinity })],
      ['code = null', Object.assign(new Error('null'), { code: null })],
      ['code = undefined', Object.assign(new Error('undef'), { code: undefined })],
      ["code = '23505' (Postgres unique-violation shape)", Object.assign(new Error('pg'), { code: '23505' })],
      ["code = 'ECONNREFUSED' (Node syscall shape)", Object.assign(new Error('sys'), { code: 'ECONNREFUSED' })],
      ["code = '-32602' (the RIGHT code as a STRING, not a number)", Object.assign(new Error('str'), { code: '-32602' })],
      ['code = -32099 (an unmapped number in the JSON-RPC reserved range)', Object.assign(new Error('x'), { code: -32099 })],
      ['code = 12345 (an arbitrary unmapped number)', Object.assign(new Error('x'), { code: 12345 })],
      ['error is null', null],
      ['error is undefined', undefined],
      ['error is a string', 'just a string'],
      // A prototype-chain name must never resolve to a status.
      ["code = 'toString'", Object.assign(new Error('proto'), { code: 'toString' })],
    ];

    test.each(unrecognised)('%s → 500', (_label, err) => {
      expect(httpStatusForError(err)).toBe(500);
    });

    test('the declared fail-closed default IS 500 (not merely a coincidence of the cases above)', () => {
      expect(UNCLASSIFIED_ERROR_STATUS).toBe(500);
    });

    test('no classified code maps to a success or redirect status', () => {
      // Belt over the compiler: HttpErrorStatus already forbids a 2xx, so this goes RED if
      // someone WIDENS that union rather than reasoning about it (a past incident rule 8: a guard
      // that reads the product's own type would widen in lockstep — so the floor is pinned
      // to the literal 400 here, not derived).
      for (const code of CLASSIFIED_JSONRPC_CODES) {
        const status = httpStatusForError({ code });
        expect(status).toBeGreaterThanOrEqual(400);
        expect(status).toBeLessThan(600);
      }
      expect(CLASSIFIED_JSONRPC_CODES.length).toBeGreaterThan(0);
    });
  });

  // =====================================================================================
  // §1b the classification table itself.
  // =====================================================================================
  describe('§1b explicit classifications', () => {
    test('-32602 InvalidParams → 400 (THE reported defect)', () => {
      expect(httpStatusForError(new McpError(ErrorCode.InvalidParams, 'bad params'))).toBe(400);
    });
    test('-32600 InvalidRequest → 400', () => {
      expect(httpStatusForError(new McpError(ErrorCode.InvalidRequest, 'bad request'))).toBe(400);
    });
    test('-32700 ParseError → 400', () => {
      expect(httpStatusForError(new McpError(ErrorCode.ParseError, 'bad json'))).toBe(400);
    });
    test('-32601 MethodNotFound → 404', () => {
      expect(httpStatusForError(new McpError(ErrorCode.MethodNotFound, 'no such method'))).toBe(404);
    });
    test('-32603 InternalError → 500 (a genuine internal fault STAYS 5xx)', () => {
      expect(httpStatusForError(new McpError(ErrorCode.InternalError, 'real fault'))).toBe(500);
    });
    test('-32000 ConnectionClosed and -32001 RequestTimeout → 500 (server-side conditions)', () => {
      expect(httpStatusForError(new McpError(ErrorCode.ConnectionClosed, 'closed'))).toBe(500);
      expect(httpStatusForError(new McpError(ErrorCode.RequestTimeout, 'timeout'))).toBe(500);
    });
  });

  // =====================================================================================
  // §2 THE SEAM COVERS BOTH SURFACES — same catch, same classification, either tool name.
  // =====================================================================================
  describe('§2 the ONE catch in handleMcpToolExpress classifies identically for a FLAT opId and a GATEWAY name', () => {
    // 'task_update' is a flat opId; 'task' is a gateway tool name. Both are dispatched
    // through the same handleMcpToolExpress → mcpToolExecutor path, so both must land in
    // the same catch and get the same status.
    const surfaces: Array<[string, string, Record<string, unknown>]> = [
      ['flat opId', 'task_update', BODY_WITH_UNDECLARED_PARAM],
      ['gateway name', 'task', { action: 'update', ...BODY_WITH_UNDECLARED_PARAM }],
    ];

    const expectations: Array<[string, () => unknown, number]> = [
      ['McpError -32602 InvalidParams', () => new McpError(ErrorCode.InvalidParams, 'strict mode: unknown param'), 400],
      ['McpError -32600 InvalidRequest', () => new McpError(ErrorCode.InvalidRequest, 'invalid request'), 400],
      ['McpError -32601 MethodNotFound', () => new McpError(ErrorCode.MethodNotFound, 'no such tool'), 404],
      ['McpError -32603 InternalError', () => new McpError(ErrorCode.InternalError, 'genuine fault'), 500],
      ['a plain Error (unclassified)', () => new Error('genuine unexpected fault'), 500],
      ['an unmapped numeric code (-32099)', () => Object.assign(new Error('weird'), { code: -32099 }), 500],
      ['a zero code', () => Object.assign(new Error('zero'), { code: 0 }), 500],
    ];

    for (const [surfaceLabel, toolName, args] of surfaces) {
      for (const [errLabel, makeErr, expected] of expectations) {
        test(`${surfaceLabel} (${toolName}) + ${errLabel} → ${expected}`, async () => {
          thrown = makeErr();
          const res = await postTo(stubBase, toolName, args);
          expect(res.status).toBe(expected);
          expect(res.body.success).toBe(false);
        });
      }
    }

    test('a NON-throwing call on either name is untouched (200) — the fix only classifies FAILURES', async () => {
      const passThrough = new HealthServer(async (toolName: string) => ({
        content: [{ type: 'text', text: `ok:${toolName}` }],
        structuredContent: { ok: true },
      }));
      const app = (passThrough as any).app as express.Application;
      const l = await new Promise<http.Server>((r) => {
        const s = app.listen(0, () => r(s));
      });
      try {
        const addr = l.address();
        const base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
        expect((await postTo(base, 'task_update', BODY_CLEAN)).status).toBe(200);
        expect((await postTo(base, 'task', { action: 'update', ...BODY_CLEAN })).status).toBe(200);
      } finally {
        await new Promise<void>((r) => l.close(() => r()));
      }
    });
  });

  // =====================================================================================
  // §3 THE REPORTED DEFECT, END TO END — real validation, real executor, real DB.
  // =====================================================================================
  describe('§3 the exact prod-reported bodies over the REAL /mcp/tools surface', () => {
    test('task_update WITH an undeclared param → 400 (was 500)', async () => {
      const res = await postReal('task_update', BODY_WITH_UNDECLARED_PARAM);
      // THE FUSE. Pre-fix this was 500 — measured. A 5xx here tells a retrying agent client
      // to retry a request that can never succeed, and inflates our incident signal.
      expect(res.status).toBe(400);
      expect(res.status).not.toBe(500);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('-32602');
    });

    test('task_update WITHOUT it → still not a 4xx from this seam (the control)', async () => {
      // The control call from the prod report: identical but for the one undeclared param.
      // It does not throw, so it never reaches the classification seam at all.
      const res = await postReal('task_update', BODY_CLEAN);
      expect(res.status).toBe(200);
    });

    test('an unknown TOOL name is a client error, not a 5xx', async () => {
      const res = await postReal('no_such_tool_xyz', {});
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
    });
  });

  // =====================================================================================
  // §4 THE GATEWAY PATH'S MEASURED REALITY, PINNED.
  // =====================================================================================
  describe('§4 the gateway path returns its validation error in-band (200 + isError) — pinned', () => {
    test('gateway task({action:"update", …, <undeclared>}) does NOT 5xx', async () => {
      const res = await postReal('task', { action: 'update', ...BODY_WITH_UNDECLARED_PARAM });
      // dispatchGateway catches validateToolArguments itself and returns formatMcpError, so
      // this never reached the express catch and was never a 500. Pinned so a refactor that
      // lets the throw escape cannot silently reintroduce a 5xx on a client mistake — and
      // even if it did escape, §2 proves the seam would classify it 400 rather than 500.
      expect(res.status).toBeLessThan(500);
      const text: string = res.body?.result?.content?.[0]?.text ?? '';
      expect(res.body.result?.isError).toBe(true);
      expect(text).toContain(`Unknown parameter(s): '${UNDECLARED_PARAM}'`);
    });
  });

  // =====================================================================================
  // §5 THE MESSAGE AND STRICT MODE ARE NOT WEAKENED — only the status code moved.
  // =====================================================================================
  describe('§5 strict-mode validation and its actionable message are intact', () => {
    test('the 400 still carries the full strict-mode diagnostic', async () => {
      const res = await postReal('task_update', BODY_WITH_UNDECLARED_PARAM);
      const msg = res.body.error ?? '';
      expect(msg).toContain(`Unknown parameter(s): '${UNDECLARED_PARAM}'`);
      expect(msg).toContain('rejects undeclared params');
      expect(msg).toContain('strict mode');
    });

    test('strict mode still REJECTS the undeclared param (it is not accepted with a 200)', async () => {
      // The failure mode a lazy "fix" would take: stop rejecting so there is no error to
      // classify. The call must still FAIL — just with an honest status.
      const res = await postReal('task_update', BODY_WITH_UNDECLARED_PARAM);
      expect(res.body.success).toBe(false);
      expect(res.status).not.toBe(200);
    });
  });
});
