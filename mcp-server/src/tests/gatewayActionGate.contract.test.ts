/**
 * GATEWAY ACTION-GATE MUTATION-PROBE — MCP-2026 rebuild PHASE 2 (risk a).
 *
 * GUARD-THE-GUARD (a past incident / guards-need-guarding). The gateway resolves (gateway,action)→opId
 * BEFORE the session ACTION-gate, and the gate stays keyed on the opId (context_store/task_create/
 * decision_record). This test drives the REAL gateway path end-to-end against REAL Postgres and
 * asserts, behaviorally, that the gate did NOT silently open or close:
 *
 *   P1  gateway `context.store` CREATES + ATTRIBUTES a session — the stored context's session_id
 *       is the connection's newly-created session. (If the gate were mis-keyed on the gateway
 *       name 'context' instead of the resolved opId 'context_store', ACTION_TOOLS.has('context')
 *       would be false → NO session → session_id NULL → this FAILS LOUD.)
 *   P2  a PASSIVE gateway call (`context.search`) creates ZERO sessions.
 *   P3  `session.start` does NOT pre-spawn via the gate: session_start ∉ ACTION_TOOLS, so exactly
 *       ONE session exists for the connection afterward (its own), never a pre-spawned second row.
 *
 * Runs inside the CI gate disposable migrated Postgres (Stage 1). Embeddings are stubbed offline.
 */

import { describe, test, expect, beforeAll, afterAll, vi } from 'vitest';
import { patternEmbedding } from './helpers/embedGeometry.js';

// Distinct session ids per real create (global setup mocks randomUUID with a counter).
vi.unmock('crypto');
vi.unmock('node:crypto');

// Stub embeddings (native transformers unavailable in CI); the DB write + session attribution
// path through the gateway still runs for real.
vi.mock('../services/embedding.js', () => ({
  embeddingService: {
    generateEmbedding: vi.fn(async () => ({ embedding: patternEmbedding() })),
  },
}));

import { db } from '../config/database.js';
import { dispatchGateway } from '../routes/gateway.js';
import { ActiveSessionStore } from '../services/session/state/ActiveSessionStore.js';

const STAMP = Date.now();
const CONN_STORE = `gw-gate-store-${STAMP}`;
const CONN_PASSIVE = `gw-gate-passive-${STAMP}`;
const CONN_SESSION = `gw-gate-session-${STAMP}`;
const PROJ = `gw-gate-proj-${STAMP}`;

let projId: string;

function contextIdFrom(resp: any): string {
  const text: string = resp?.content?.map((c: any) => c.text).join('\n') ?? '';
  const m = text.match(/ID:\s*([0-9a-f-]{36})/i);
  if (!m) throw new Error(`no context id in response: ${text.slice(0, 200)}`);
  return m[1];
}

async function sessionRowsForProject(): Promise<number> {
  const r = await db.query('SELECT count(*)::int AS n FROM sessions WHERE project_id = $1', [projId]);
  return r.rows[0].n;
}

beforeAll(async () => {
  projId = (
    await db.query(`INSERT INTO projects (name, description) VALUES ($1, 'gw gate') RETURNING id`, [PROJ])
  ).rows[0].id;
});

afterAll(async () => {
  for (const c of [CONN_STORE, CONN_PASSIVE, CONN_SESSION]) ActiveSessionStore.clear(c);
  await db.query('DELETE FROM contexts WHERE project_id = $1', [projId]);
  await db.query('DELETE FROM sessions WHERE project_id = $1', [projId]);
  await db.query('DELETE FROM projects WHERE id = $1', [projId]);
});

describe('ACTION-gate keyed on the RESOLVED opId (mutation-probe)', () => {
  test('P1: gateway context.store creates + attributes a session (gate keyed on context_store)', async () => {
    ActiveSessionStore.clear(CONN_STORE);
    await dispatchGateway('project', { action: 'switch', project: projId }, { connectionId: CONN_STORE });

    const resp = await dispatchGateway(
      'context',
      { action: 'store', content: 'gateway action-gate probe', type: 'completion' },
      { connectionId: CONN_STORE },
    );
    expect(resp.isError).not.toBe(true);

    const ctxId = contextIdFrom(resp);
    const createdSession = ActiveSessionStore.get(CONN_STORE);
    expect(createdSession, 'gateway context.store must lazily create a session').toBeTruthy();

    const attributed = (
      await db.query('SELECT session_id FROM contexts WHERE id = $1', [ctxId])
    ).rows[0]?.session_id;
    expect(attributed, 'the stored context must be attributed to the created session').toBe(createdSession);
  });

  test('P2: passive gateway context.search creates ZERO sessions', async () => {
    ActiveSessionStore.clear(CONN_PASSIVE);
    await dispatchGateway('project', { action: 'switch', project: projId }, { connectionId: CONN_PASSIVE });
    const before = await sessionRowsForProject();

    const resp = await dispatchGateway(
      'context',
      { action: 'search', query: 'nothing here' },
      { connectionId: CONN_PASSIVE },
    );
    expect(resp.isError).not.toBe(true);

    expect(ActiveSessionStore.get(CONN_PASSIVE)).toBeFalsy();
    expect(await sessionRowsForProject()).toBe(before); // no new session row
  });

  test('P3: gateway session.start does NOT pre-spawn via the gate (exactly one session)', async () => {
    ActiveSessionStore.clear(CONN_SESSION);
    await dispatchGateway('project', { action: 'switch', project: projId }, { connectionId: CONN_SESSION });
    const before = await sessionRowsForProject();

    const resp = await dispatchGateway('session', { action: 'start' }, { connectionId: CONN_SESSION });
    expect(resp.isError).not.toBe(true);

    // session_start opens exactly ONE session; a pre-spawn would have created a second row
    // (lazily created, then finalized-and-replaced) → +2. Assert +1.
    expect(await sessionRowsForProject()).toBe(before + 1);
  });
});
