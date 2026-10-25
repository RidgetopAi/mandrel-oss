/**
 * THE HTTP ENVELOPE MUST AGREE WITH THE RESULT IT WRAPS.
 *
 * `/mcp/tools/*` wraps every tool result in a bespoke `{ success, result }` envelope. That
 * `success` was the LITERAL `true` (healthServer.ts) and never consulted the result, so every
 * error the executor catches and returns IN BAND — the actor-requirement rejection,
 * PROJECT_SCOPE_SWITCH_UNIDENTIFIED, PROJECT_AMBIENT_WRITE_UNIDENTIFIED, every
 * ProjectBindingError, every gateway action/validation rejection — reached the HTTP client as
 * `{"success":true,"result":{…,"isError":true}}`: the envelope asserting the exact opposite of
 * the payload it carried.
 *
 * THE SURFACE THIS GUARD ANCHORS ON is the real express app over real HTTP, not the executor —
 * the defect lived in the wrapper, so testing the thing being wrapped could not have seen it.
 *
 * THE POPULATION is the FORK: `executeMcpTool` splits flat-opId from gateway-`{action}`
 * BENEATH this envelope, so both surfaces must be exercised or half the traffic is unguarded.
 * The gateway's OWN rejections are the sharper half — they return `formatMcpError` directly
 * (routes/gateway.ts) WITHOUT passing through `routeExecutor`, so they carry NO
 * `structuredContent` at all. That is the case that proves `structuredContent.ok` cannot be the
 * predicate and `isError` is authoritative; §3 asserts it explicitly rather than describing it.
 *
 * THE HTTP STATUS, AND WHAT MOVED UNDER THIS FILE (the deferred half of the
 * same decision). This file used to say the status was deliberately not asserted to change,
 * on the reasoning that `200 + isError` is the correct MCP shape for a tool error. That is
 * still true, and it is still asserted below — for an ORDINARY tool error, where the tool RAN
 * and answered "not found" or "unknown action".
 *
 * It was never true for a POLICY REFUSAL, which arrives through the same in-band path and
 * looks identical from here: the actor-requirement rejection, the identity guards and the
 * binding gate all throw BEFORE dispatch, so the tool never ran, nothing was read or written,
 * and an identical retry is refused identically. Those now carry a 4xx. The ENVELOPE and the
 * BODY are unchanged — `success:false` and the full CallToolResult, byte for byte — which is
 * why every assertion in this file except one status literal is untouched.
 *
 * The two cases are asserted side by side below on purpose: getting the second half wrong,
 * and relabelling ordinary tool errors as client mistakes, would be worse than the bug fixed.
 */

import { describe, test, expect, beforeAll, afterAll, vi } from 'vitest';
import type express from 'express';
import type http from 'http';

vi.unmock('crypto');
vi.unmock('node:crypto');

// Embeddings stubbed (native @xenova/transformers → sharp unavailable in CI/sandbox).
// Geometry derived from the ACTIVE embedder, never written by hand.
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
import { SESSION_CONFIG } from '../config/sessionConfig.js';

const STAMP = Date.now();
const CONN = `envelope-conn-${STAMP}`;
const PROJ_NAME = `envelope-P-${STAMP}`;

let projectId: string;
let listener: http.Server;
let base: string;

interface Envelope {
  status: number;
  body: {
    success?: boolean;
    result?: { isError?: boolean; content?: Array<{ text?: string }>; structuredContent?: Record<string, unknown> };
    error?: string;
  };
}

async function post(
  tool: string,
  args: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<Envelope> {
  const res = await fetch(`${base}/mcp/tools/${tool}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Connection-ID': CONN, ...headers },
    body: JSON.stringify({ arguments: args }),
  });
  return { status: res.status, body: (await res.json()) as Envelope['body'] };
}

const textOf = (e: Envelope): string => e.body.result?.content?.[0]?.text ?? '';

describe('the /mcp/tools/* envelope agrees with the result it wraps', () => {
  beforeAll(async () => {
    // Real express app + real executor wiring, bound WITHOUT start(): no process lock, no
    // portManager, no stdio transport.
    const server = new MandrelMcpServer();
    const app = (server as any).healthServer.app as express.Application;
    listener = await new Promise<http.Server>((r) => {
      const l = app.listen(0, () => r(l));
    });
    const a = listener.address();
    base = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;

    projectId = (
      await db.query(
        `INSERT INTO projects (name, description) VALUES ($1, 'envelope/result agreement contract') RETURNING id`,
        [PROJ_NAME],
      )
    ).rows[0].id;
    const sw = await post('project_switch', { project: projectId });
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
    await new Promise<void>((r) => listener?.close(() => r()));
    await db.end();
  });

  // =====================================================================================
  // §1 THE FLAT opId PATH — /mcp/tools/<opId>
  // =====================================================================================
  describe('§1 flat opId path', () => {
    test('a NORMAL result still yields success:true (the fix is not "always false")', async () => {
      const res = await post('mandrel_ping', { message: 'envelope agreement' });
      expect(res.status).toBe(200);
      expect(res.body.result?.isError).toBeUndefined();
      expect(res.body.success).toBe(true);
    });

    test('the actor-requirement rejection yields success:false, not success:true', async () => {
      // The measured prod-shaped fixture: requireActor ON + no X-Actor-ID. The gate throws
      // inside ensureSessionForAction, routeExecutorInner catches it and returns
      // formatMcpError, so it NEVER reaches the express catch — which is exactly why the
      // hardcoded envelope covered it up.
      const prior = SESSION_CONFIG.requireActor;
      (SESSION_CONFIG as { requireActor: boolean }).requireActor = true;
      try {
        const res = await post('context_store', {
          content: 'envelope agreement fixture — must be REJECTED, never stored',
          type: 'completion',
        });
        // A POLICY REFUSAL, not a tool error: the actor gate throws before dispatch, so
        // context_store never ran and nothing was stored. 403 — authenticated, understood,
        // refused on policy; see routes/index.ts ActorRequirementError for why not 401.
        // Earlier this was 200: a refused write reported to the transport as a
        // completed one. The 200 fuse for an ordinary tool error is two tests down.
        expect(res.status).toBe(403);
        expect(textOf(res)).toContain('X-Actor-ID');
        expect(res.body.result?.isError).toBe(true);
        expect(res.body.success).toBe(false);
      } finally {
        (SESSION_CONFIG as { requireActor: boolean }).requireActor = prior;
      }
    });

    test('an in-band not-found rejection yields success:false, and STAYS 200', async () => {
      // A real routeExecutor-side error result: the id resolver's IdNotFoundError, returned
      // in band by idErrorResponse (utils/idResolver.ts) with isError:true. The id is
      // well-formed but absent, so nothing is deleted and the call has no side effect.
      //
      // THE OTHER DIRECTION OF THE ENVELOPE FIX, and the one that would be worse to get wrong. The
      // tool RAN and gave a well-formed answer to a well-formed question; that is a
      // successful MCP call carrying isError, and it must not become a 4xx just because the
      // answer is negative. If this ever reads 4xx, the refusal classification has leaked
      // into ordinary tool failures and every client's retry logic is now wrong.
      const res = await post('context_delete', { contextId: 'deadbeef' });
      expect(res.status).toBe(200);
      expect(res.body.result?.isError).toBe(true);
      expect(res.body.success).toBe(false);
    });
  });

  // =====================================================================================
  // §2 THE GATEWAY {action} PATH — /mcp/tools/<gateway> + {action}
  //    executeMcpTool forks here BENEATH the envelope; the flat tests above cannot reach it.
  // =====================================================================================
  describe('§2 gateway {action} path', () => {
    test('a NORMAL gateway result still yields success:true', async () => {
      const res = await post('discover', { action: 'ping' });
      expect(res.status).toBe(200);
      expect(res.body.result?.isError).toBeUndefined();
      expect(res.body.success).toBe(true);
    });

    test('an UNKNOWN gateway action yields success:false', async () => {
      const res = await post('task', { action: 'no_such_action_xyz' });
      expect(res.status).toBe(200);
      expect(textOf(res)).toContain('Unknown action');
      expect(res.body.result?.isError).toBe(true);
      expect(res.body.success).toBe(false);
    });

    test('a gateway VALIDATION rejection yields success:false', async () => {
      // The §4-pinned call in mcpErrorStatusMapping.contract.test.ts: an undeclared param on
      // the gateway form. That file pins status<500 + isError; this pins the envelope field
      // it says nothing about, so the two guards are complementary, not overlapping.
      //
      // The param is DERIVED, not typed in. It used to be the literal `notes`, and an earlier task
      // DECLARED `notes` on task_update — which made this call VALID and left this
      // test asserting a rejection that no longer happened. A guard whose subject can be
      // legalised by an unrelated change goes hollow with nobody touching it.
      const undeclared = undeclaredTaskUpdateParam();
      const res = await post('task', {
        action: 'update', taskId: '3802f00d', status: 'in_progress', [undeclared]: 'x',
      });
      expect(textOf(res)).toContain(`Unknown parameter(s): '${undeclared}'`);
      expect(res.body.result?.isError).toBe(true);
      expect(res.body.success).toBe(false);
    });
  });

  // =====================================================================================
  // §3 WHY `isError` AND NOT `structuredContent.ok`.
  // =====================================================================================
  describe('§3 the authoritative failure predicate', () => {
    test('a gateway-level rejection carries isError but NO structuredContent at all', async () => {
      // routes/gateway.ts returns formatMcpError DIRECTLY, bypassing routeExecutor and its
      // ensureStructuredContent seam. So `structuredContent?.ok === false` would read this
      // response — a real, reachable rejection — as a SUCCESS. This is the executable form of
      // "isError is authoritative"; if a future refactor makes the gateway route through the
      // seam, this test goes RED and the claim gets re-derived rather than inherited.
      const res = await post('task', { action: 'no_such_action_xyz' });
      expect(res.body.result?.isError).toBe(true);
      expect(res.body.result?.structuredContent).toBeUndefined();
      expect(res.body.success).toBe(false);
    });

    test('a routeExecutor error DOES carry structuredContent.ok=false, and it agrees', async () => {
      const res = await post('context_delete', { contextId: 'deadbeef' });
      expect(res.body.result?.isError).toBe(true);
      expect(res.body.result?.structuredContent?.ok).toBe(false);
      expect(res.body.success).toBe(false);
    });
  });

  // =====================================================================================
  // §4 THE INVARIANT ITSELF, over both surfaces at once.
  // =====================================================================================
  describe('§4 success === !isError, across the fork', () => {
    const calls: Array<[string, string, Record<string, unknown>]> = [
      ['flat / normal', 'mandrel_ping', { message: 'invariant' }],
      ['flat / in-band error', 'context_delete', { contextId: 'deadbeef' }],
      ['gateway / normal', 'discover', { action: 'ping' }],
      ['gateway / in-band error', 'task', { action: 'no_such_action_xyz' }],
    ];

    test.each(calls)('%s', async (_label, tool, args) => {
      const res = await post(tool, args);
      // A 200 envelope always carries a result; the express catch (non-200) is a different
      // shape and is pinned by mcpErrorStatusMapping.contract.test.ts §2/§3.
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(res.body.result?.isError !== true);
    });
  });
});
