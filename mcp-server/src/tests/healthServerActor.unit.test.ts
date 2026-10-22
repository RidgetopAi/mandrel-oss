/**
 * /mcp/tools/* ACTOR DERIVATION — Sessions Foundation.
 *
 * The on-box bridge handler (HealthServer#handleMcpToolExpress) attributes a lazily-created
 * session to an ACTOR. Before this task it hardcoded `deriveActor(undefined, X-Actor-ID)` —
 * DISCARDING the verified OAuth `sub` that bridgeAuth() populates on req.oauthSubject when an
 * OAuth-enabled tenant authenticates. That drift attributed an OAuth-authed caller as
 * `anonymous`. The fix mirrors remoteMcpTransport#actorFor: read req.oauthSubject?.sub and let
 * deriveActor apply the ONE combining rule — which is FLAG-GATED since an earlier task:
 * sub-overrides-declared by default, sub-SCOPES-declared when composites are on.
 * Both modes are exercised below at this edge. NOTE THE SCOPE: the composite (sub-bearing)
 * cases drive actorFor directly with a fake req, because this harness has no OAuth, so
 * req.oauthSubject can never be populated over its real HTTP route. Real HTTP covers the
 * declared-header and anonymous branches in both modes. The end-to-end proof for a sub-bearing
 * composite lives in taskAtomicClaim.contract.test.ts (real routeExecutor, real Postgres,
 * asserted on the claim_actor column).
 *
 * Two layers of proof (no lying stubs):
 *   1. UNIT — HealthServer#actorFor directly, with a mocked req.oauthSubject, across all four
 *      derivation cases (oauth-only / oauth+header precedence / header-only / neither).
 *   2. INTEGRATION — the REAL POST /mcp/tools/:toolName route (bridge flag disabled for
 *      pass-through) with a capturing executor, proving the handler wires actorFor's result
 *      into the executor context for the declared-header and anonymous branches end-to-end.
 *
 * DB-free harness (mirrors bridgeAuth.test.ts): env stubbed in beforeAll, HealthServer imported
 * dynamically so config/database module-eval sees the env, restored in afterAll.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import * as http from 'node:http';

import { ACTOR_IDENTITY_ENV } from '@/config/actorIdentityConfig';
import type { McpExecutorContext } from '@/server/healthServer';

const TEST_ENV: Record<string, string> = {
  DATABASE_NAME: process.env.DATABASE_NAME || 'aidis_healthactor_test',
  DATABASE_USER: process.env.DATABASE_USER || 'test_user',
  DATABASE_PASSWORD: process.env.DATABASE_PASSWORD || 'test_pass',
  DATABASE_HOST: process.env.DATABASE_HOST || 'localhost',
  AIDIS_SKIP_DATABASE: process.env.AIDIS_SKIP_DATABASE || 'true',
  AIDIS_SKIP_BACKGROUND: process.env.AIDIS_SKIP_BACKGROUND || 'true',
  AIDIS_SKIP_STDIO: process.env.AIDIS_SKIP_STDIO || 'true',
};

// Deferred import (a static import is ESM-hoisted above the env setup; config/database throws
// when DATABASE_NAME is unset at import time).
type HealthServerCtor = typeof import('@/server/healthServer').HealthServer;

/** Minimal express.Request stand-in for actorFor: a header() lookup + optional oauthSubject. */
function fakeReq(opts: { sub?: string; actorId?: string }): unknown {
  return {
    oauthSubject: opts.sub !== undefined ? { sub: opts.sub } : undefined,
    header(name: string): string | undefined {
      return name.toLowerCase() === 'x-actor-id' ? opts.actorId : undefined;
    },
  };
}

describe('HealthServer#actorFor — /mcp/tools/* actor derivation', () => {
  let server: http.Server;
  let baseUrl: string;
  let health: any;
  let capturedContext: McpExecutorContext | undefined;

  beforeAll(async () => {
    for (const [key, value] of Object.entries(TEST_ENV)) vi.stubEnv(key, value);

    const { HealthServer } = (await import('@/server/healthServer')) as { HealthServer: HealthServerCtor };
    // Capturing executor: records the context the handler passes so we can assert context.actor.
    health = new HealthServer(async (_toolName: string, _args: unknown, context?: McpExecutorContext) => {
      capturedContext = context;
      return { content: [{ type: 'text', text: 'ok' }] };
    });
    const app = health.app as import('express').Application;
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    try {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    } finally {
      vi.unstubAllEnvs();
    }
  });

  afterEach(() => {
    capturedContext = undefined;
    // Restore the suite-wide pass-through baseline set in vitest.setup.ts.
    process.env.MCP_BRIDGE_AUTH_ENABLED = 'false';
  });

  // ── UNIT: the derivation method the handler calls, all four cases ─────────────────────────
  describe('unit — the shipped default (composites OFF): auth > declared > none', () => {
    it('OAuth path: oauthSubject.sub set, NO X-Actor-ID → actor is the verified sub (NOT anonymous)', () => {
      const actor = health.actorFor(fakeReq({ sub: 'oauth-user-123' }));
      expect(actor).toBe('oauth-user-123');
      expect(actor).not.toBeUndefined(); // would have been undefined (→ anonymous) pre-fix
    });

    it('SECURITY precedence: sub set AND X-Actor-ID present → the verified SUB wins (client header does not override)', () => {
      const actor = health.actorFor(fakeReq({ sub: 'oauth-user-123', actorId: 'attacker-declared' }));
      expect(actor).toBe('oauth-user-123');
      expect(actor).not.toBe('attacker-declared');
    });

    it('backward-compat: NO oauthSubject, X-Actor-ID present → actor is the declared header (unchanged)', () => {
      const actor = health.actorFor(fakeReq({ actorId: 'tick' }));
      expect(actor).toBe('tick');
    });

    it('backward-compat: neither oauthSubject nor X-Actor-ID → undefined (→ anonymous at stamp time, unchanged)', () => {
      expect(health.actorFor(fakeReq({}))).toBeUndefined();
    });
  });

  /**
   * THE MODE WE INTEND TO ENABLE, EXERCISED AT THE REAL EDGE.
   *
   * The unit tests in actorRegistry.unit.test.ts prove deriveActor in isolation; these prove the
   * EDGE actually reaches it with both halves — the verified `sub` off req.oauthSubject AND the
   * declared header — so enabling the flag really does produce per-agent actors on this surface
   * rather than silently continuing to collapse them. Without this, "the composite works" would
   * be a claim about a function, not about the server.
   */
  describe('unit — composites ENABLED: the sub SCOPES the declared handle at this edge', () => {
    const FLAG = ACTOR_IDENTITY_ENV.COMPOSITE_ENABLED;
    let savedFlag: string | undefined;

    beforeAll(() => {
      savedFlag = process.env[FLAG];
      process.env[FLAG] = 'true';
    });
    afterAll(() => {
      if (savedFlag === undefined) delete process.env[FLAG];
      else process.env[FLAG] = savedFlag;
    });

    it('sub + declared header → a server-assembled composite (the N-agents-one-human fix)', () => {
      expect(health.actorFor(fakeReq({ sub: 'operator@example.com', actorId: 'builder-a1b2c3d4' })))
        .toBe('operator@example.com/builder-a1b2c3d4');
    });

    it('N agents under ONE verified principal get N DISTINCT actors at this edge', () => {
      const actors = ['coordinator', 'builder-a1b2c3d4', 'tick'].map((h) =>
        health.actorFor(fakeReq({ sub: 'operator@example.com', actorId: h })),
      );
      expect(new Set(actors).size).toBe(3);
    });

    it('a declared header cannot forge another principal at this edge (delimiter stripped)', () => {
      const forged = health.actorFor(fakeReq({ sub: 'attacker@evil.com', actorId: 'victim@example.com/coordinator' }));
      expect(forged).not.toBe('victim@example.com/coordinator');
      expect(forged.startsWith('attacker@evil.com/')).toBe(true);
    });

    it('the degenerate cases are unchanged: sub-only → sub, header-only → header, neither → undefined', () => {
      expect(health.actorFor(fakeReq({ sub: 'oauth-user-123' }))).toBe('oauth-user-123');
      expect(health.actorFor(fakeReq({ actorId: 'tick' }))).toBe('tick');
      expect(health.actorFor(fakeReq({}))).toBeUndefined();
    });
  });

  // ── INTEGRATION: the REAL route wires actorFor's result into the executor context ─────────
  describe('integration — POST /mcp/tools/:toolName passes the derived actor to the executor', () => {
    const postTool = (tool: string, headers: Record<string, string> = {}) =>
      fetch(`${baseUrl}/mcp/tools/${tool}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify({ arguments: {} }),
      });

    it('declared X-Actor-ID (static-bearer path, no oauthSubject) → executor context.actor === header (unchanged)', async () => {
      process.env.MCP_BRIDGE_AUTH_ENABLED = 'false'; // pass-through, no credential required
      const res = await postTool('mandrel_ping', { 'X-Actor-ID': 'tick' });
      expect(res.status).toBe(200);
      expect(capturedContext?.actor).toBe('tick');
    });

    it('no X-Actor-ID and no oauthSubject → executor context.actor is undefined (→ anonymous, unchanged)', async () => {
      process.env.MCP_BRIDGE_AUTH_ENABLED = 'false';
      const res = await postTool('mandrel_ping');
      expect(res.status).toBe(200);
      expect(capturedContext?.actor).toBeUndefined();
    });

    /**
     * REAL HTTP, COMPOSITES ON (Reviewer N-d). The flag-ON unit cases above drive actorFor with
     * a fake req; this one goes over the wire through the real route, so the sanitation is proven
     * on the surface a client actually reaches — not just on the function.
     *
     * SCOPE, STATED PRECISELY: this harness has no OAuth, so `req.oauthSubject` is always absent
     * here and the sub-bearing composite branch is NOT reachable over real HTTP in this file. The
     * real-surface proof for THAT branch is taskAtomicClaim.contract.test.ts, which drives
     * routeExecutor against real Postgres and asserts on the claim_actor column in both modes.
     */
    it('composites ON: a delimiter-bearing X-Actor-ID is SANITIZED over the real route', async () => {
      process.env.MCP_BRIDGE_AUTH_ENABLED = 'false';
      const savedFlag = process.env[ACTOR_IDENTITY_ENV.COMPOSITE_ENABLED];
      process.env[ACTOR_IDENTITY_ENV.COMPOSITE_ENABLED] = 'true';
      try {
        const res = await postTool('mandrel_ping', { 'X-Actor-ID': 'victim@example.com/coordinator' });
        expect(res.status).toBe(200);
        expect(capturedContext?.actor).toBe('victim@example.com-coordinator');
        expect(capturedContext?.actor).not.toContain('/'); // cannot spell a composite over the wire
      } finally {
        if (savedFlag === undefined) delete process.env[ACTOR_IDENTITY_ENV.COMPOSITE_ENABLED];
        else process.env[ACTOR_IDENTITY_ENV.COMPOSITE_ENABLED] = savedFlag;
      }
    });
  });
});
