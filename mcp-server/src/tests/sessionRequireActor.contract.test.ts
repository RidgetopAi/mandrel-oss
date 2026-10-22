/**
 * Sessions Foundation Phase 4 — header-less TIGHTENING contract.
 * Proves the config-gated `requireActor` mechanism (Auditor review §4.3/§5
 * "header-less writes rejected", fail loud):
 *
 *   - DARK by default (SESSION_CONFIG.requireActor=false): a header-less write action creates
 *     an `anonymous`-stamped session EXACTLY as today (Phase 1 behavior unchanged) and bumps
 *     the sessions_created_anonymous_actor coverage counter — the deprecation SIGNAL to watch
 *     anonymous→0 BEFORE flipping requireActor on per-environment.
 *   - When ON: the action gate REJECTS a header-less write with a CLEAR error that NAMES the
 *     missing `X-Actor-ID` header, instead of silently minting an anonymous session. A write
 *     that DOES carry an actor is unaffected.
 *
 * Two layers exercised:
 *   1. the pure guard `actorRequirementError(toolName, actor)` (no DB) — the decision;
 *   2. the wired action gate via the REAL routeExecutor('context_store', …) + REAL Postgres —
 *      that the decision actually rejects/permits the whole tool call, and that the rejection
 *      text survives the central error sanitizer with 'X-Actor-ID' intact.
 *
 * DB target: the disposable CI database (the CI gate / provision-test-db.sh). NEVER prod.
 */

import { describe, test, expect, afterAll, beforeAll, afterEach, vi } from 'vitest';
import { patternEmbedding } from './helpers/embedGeometry.js';

// Real UUIDs per created session (global setup mocks randomUUID with a counter).
vi.unmock('crypto');
vi.unmock('node:crypto');

// Stub embeddings (native @xenova/transformers → sharp is unavailable in CI/sandbox);
// context_store still runs its FULL real DB write + session attribution path.
vi.mock('../services/embedding.js', () => ({
  embeddingService: {
    generateEmbedding: vi.fn(async () => ({
      embedding: patternEmbedding(),
    })),
  },
}));

import { db } from '../config/database.js';
import { routeExecutor, actorRequirementError } from '../routes/index.js';
import { ActiveSessionStore } from '../services/session/state/ActiveSessionStore.js';
import { SESSION_CONFIG } from '../config/sessionConfig.js';
import { monitoring } from '../utils/monitoring.js';

const STAMP = Date.now();
let projectId: string;

const savedRequireActor = SESSION_CONFIG.requireActor;
afterEach(() => {
  SESSION_CONFIG.requireActor = savedRequireActor; // restore default (false)
});

beforeAll(async () => {
  projectId = (
    await db.query(`INSERT INTO projects (name, description) VALUES ($1, $2) RETURNING id`, [
      `QA-RequireActor-${STAMP}`,
      'Phase 4 header-less tightening contract',
    ])
  ).rows[0].id;
});

afterAll(async () => {
  await db.query('DELETE FROM contexts WHERE project_id = $1', [projectId]);
  await db.query('DELETE FROM sessions WHERE project_id = $1', [projectId]);
  await db.query('DELETE FROM projects WHERE id = $1', [projectId]);
  await db.end();
});

function parseContextId(resp: any): string {
  const text: string = resp?.content?.[0]?.text ?? '';
  const m = text.match(/ID:\s*([0-9a-f-]{36})/i);
  if (!m) throw new Error(`Could not parse context id from response: ${text.slice(0, 200)}`);
  return m[1];
}

async function sessionActorForContext(contextId: string): Promise<string | null> {
  const r = await db.query(
    `SELECT s.actor FROM contexts c JOIN sessions s ON s.id = c.session_id WHERE c.id = $1`,
    [contextId]
  );
  return r.rows[0]?.actor ?? null;
}

// ── Layer 1: the pure guard (no DB) ─────────────────────────────────────────────────────
describe('actorRequirementError — the pure guard', () => {
  test('DARK by default: returns null even with NO actor (anonymous path unchanged)', () => {
    SESSION_CONFIG.requireActor = false;
    expect(actorRequirementError('context_store', undefined)).toBeNull();
    expect(actorRequirementError('context_store', '   ')).toBeNull();
    expect(actorRequirementError('context_store', 'coordinator')).toBeNull();
  });

  test('ON + no derivable actor: returns an Error naming the X-Actor-ID header', () => {
    SESSION_CONFIG.requireActor = true;
    for (const missing of [undefined, null as any, '', '   ']) {
      const err = actorRequirementError('context_store', missing);
      expect(err).toBeInstanceOf(Error);
      expect(err!.message).toContain('X-Actor-ID');
      expect(err!.message).toContain('context_store');
    }
  });

  test('ON + a derivable actor present: returns null (permitted)', () => {
    SESSION_CONFIG.requireActor = true;
    expect(actorRequirementError('context_store', 'tick')).toBeNull();
    expect(actorRequirementError('context_store', '  Coordinator  ')).toBeNull(); // normalizes non-blank
  });
});

// ── Layer 2: the wired action gate (real routeExecutor + real DB) ────────────────────────
describe('requireActor gate — via routeExecutor(context_store)', () => {
  test('DEFAULT (off): a header-less context_store SUCCEEDS and is attributed to an anonymous session (+counter moves)', async () => {
    SESSION_CONFIG.requireActor = false;
    const conn = `ra-off-${STAMP}`;
    await routeExecutor('project_switch', { project: projectId }, { connectionId: conn });

    const before = monitoring.getLatestMetric('sessions_created_anonymous_actor')?.value ?? 0;

    const resp = await routeExecutor(
      'context_store',
      { content: 'requireActor OFF: anonymous as today', type: 'completion', tags: ['phase4', 'off'] },
      { connectionId: conn } // NO actor
    );
    expect(resp.isError).not.toBe(true);

    const ctxId = parseContextId(resp);
    expect(await sessionActorForContext(ctxId)).toBe('anonymous');

    const after = monitoring.getLatestMetric('sessions_created_anonymous_actor')?.value ?? 0;
    expect(after).toBeGreaterThan(before); // deprecation signal fired
    ActiveSessionStore.clear(conn);
  });

  test('ON: a header-less context_store is REJECTED with a clear error naming X-Actor-ID, and writes NO context', async () => {
    SESSION_CONFIG.requireActor = true;
    const conn = `ra-on-${STAMP}`;
    await routeExecutor('project_switch', { project: projectId }, { connectionId: conn });

    const countBefore = (
      await db.query('SELECT count(*)::int AS n FROM contexts WHERE project_id = $1', [projectId])
    ).rows[0].n;

    const resp = await routeExecutor(
      'context_store',
      { content: 'requireActor ON: should be rejected', type: 'completion', tags: ['phase4', 'on'] },
      { connectionId: conn } // NO actor
    );

    expect(resp.isError).toBe(true);
    const text: string = resp?.content?.[0]?.text ?? '';
    expect(text).toContain('X-Actor-ID'); // fail loud: the client is told exactly what's missing

    const countAfter = (
      await db.query('SELECT count(*)::int AS n FROM contexts WHERE project_id = $1', [projectId])
    ).rows[0].n;
    expect(countAfter).toBe(countBefore); // the write did NOT happen
    ActiveSessionStore.clear(conn);
  });

  test('ON + an actor declared: the same context_store SUCCEEDS (only header-less writes are rejected)', async () => {
    SESSION_CONFIG.requireActor = true;
    const conn = `ra-on-actor-${STAMP}`;
    await routeExecutor('project_switch', { project: projectId }, { connectionId: conn });

    const resp = await routeExecutor(
      'context_store',
      { content: 'requireActor ON but actor present', type: 'completion', tags: ['phase4', 'on-actor'] },
      { connectionId: conn, actor: 'coordinator' }
    );
    expect(resp.isError).not.toBe(true);

    const ctxId = parseContextId(resp);
    expect(await sessionActorForContext(ctxId)).toBe('coordinator');
    ActiveSessionStore.clear(conn);
  });
});
