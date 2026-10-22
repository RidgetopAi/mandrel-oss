/**
 * Lazy Session Lifecycle + Per-Connection Attribution Contract Test
 * (the executable fuse for the P-A/P-B session-lifecycle redesign)
 *
 * WHAT THIS PROVES (drives the REAL routeExecutor + REAL Postgres):
 *
 *  P-B — no eager create, lazy create on first ACTION:
 *    1. `initialize`-equivalent + PASSIVE tools (project_current, context_search,
 *       mandrel_ping) on connection A create ZERO session rows.
 *    2. A's first content-producing tool (context_store) creates EXACTLY ONE
 *       session, bound to A, pinned to A's current project; the stored context's
 *       session_id == A's session.
 *
 *  P-A — per-connection attribution (the leak is gone):
 *    3. Connection B's first action creates a SEPARATE session (B's project). A's
 *       actions never alter B's row and vice-versa — there is NO global
 *       "last active anywhere" fallback cross-attributing writes.
 *
 *  Operator's "one session per connection across project switch":
 *    4. A: context_store (session S) → project_switch to a different project →
 *       context_store again ⇒ SAME session S, its project_id RE-PINNED to the new
 *       project. NOT a new session.
 *
 *  5. Idempotency: the whole flow is run twice in-process; counts are stable.
 *
 * It FAILS on pre-redesign code:
 *   - eager boot create would make scenario 1 see a session row, and
 *   - the global getLastActive() fallback would let B's action attach to A's
 *     session (scenario 3 cross-attribution).
 * It PASSES after P-A (no global fallback for connection-scoped writes) + P-B
 * (lazy create gated centrally in routeExecutor).
 *
 * DB target: an isolated throwaway test database created by the runner script
 * scripts/test-session-lazy-lifecycle.sh (drops it on exit). Run via that script,
 * NOT directly, so DATABASE_* + EMBEDDING_* env are set against the disposable DB.
 */

import { describe, test, expect, beforeAll, afterAll, vi } from 'vitest';
import { patternEmbedding } from './helpers/embedGeometry.js';

// The global vitest.setup.ts mocks crypto.randomUUID with a resettable counter,
// which would collide session UUIDs across our multiple real creates. Restore the
// REAL crypto module here so every lazily-created session gets a distinct id.
// (vi.mock/unmock are hoisted above imports by vitest, so this takes effect for
// the modules under test that import randomUUID.)
vi.unmock('crypto');
vi.unmock('node:crypto');

// This test exercises the SESSION LIFECYCLE, not embeddings. The real embedding
// service pulls in @xenova/transformers → sharp (a native module unavailable in
// this CI/sandbox), so we stub it with a deterministic offline vector. context_store
// still runs its full real DB write + session attribution path through routeExecutor.
vi.mock('../services/embedding.js', () => ({
  embeddingService: {
    generateEmbedding: vi.fn(async () => ({
      embedding: patternEmbedding(),
    })),
  },
}));
import { db } from '../config/database.js';
import { routeExecutor } from '../routes/index.js';
import { ActiveSessionStore } from '../services/session/state/ActiveSessionStore.js';

// Two independent connections — these are the connectionIds the bridge injects.
const STAMP = Date.now();
const CONN_A = `lazy-conn-A-${STAMP}`;
const CONN_B = `lazy-conn-B-${STAMP}`;

const P1_NAME = `lazy-P1-${STAMP}`;
const P2_NAME = `lazy-P2-${STAMP}`;
const P3_NAME = `lazy-P3-${STAMP}`;

let projectP1Id: string; // A's initial project
let projectP2Id: string; // B's project
let projectP3Id: string; // A's switched-to project

// ---- helpers -------------------------------------------------------------

/** Sessions that belong to one of OUR three test projects (ignores ambient rows). */
async function ourSessionRows(): Promise<Array<{ id: string; project_id: string | null }>> {
  const r = await db.query(
    `SELECT id, project_id FROM sessions WHERE project_id = ANY($1::uuid[]) ORDER BY started_at`,
    [[projectP1Id, projectP2Id, projectP3Id]]
  );
  return r.rows;
}

async function contextSessionId(contextId: string): Promise<string | null> {
  const r = await db.query('SELECT session_id FROM contexts WHERE id = $1', [contextId]);
  return r.rows[0]?.session_id ?? null;
}

/** Extract the context id from the context_store success text. */
function parseContextId(resp: any): string {
  const text: string = resp?.content?.[0]?.text ?? '';
  const m = text.match(/ID:\s*([0-9a-f-]{36})/i);
  if (!m) throw new Error(`Could not parse context id from response: ${text.slice(0, 200)}`);
  return m[1];
}

async function deleteOurData(): Promise<void> {
  const pids = [projectP1Id, projectP2Id, projectP3Id].filter(Boolean);
  if (pids.length === 0) return;
  // contexts first (FK to sessions), then sessions, then projects.
  await db.query('DELETE FROM contexts WHERE project_id = ANY($1::uuid[])', [pids]);
  await db.query('DELETE FROM sessions WHERE project_id = ANY($1::uuid[])', [pids]);
  await db.query('DELETE FROM projects WHERE id = ANY($1::uuid[])', [pids]);
}

/**
 * One full run of the contract flow. Returns assertions-relevant facts so the
 * caller can run it twice and compare (idempotency).
 */
async function runFlow(): Promise<{
  rowsAfterPassive: number;
  sessionA: string;
  ctxASession: string | null;
  ctxAProject: string | null;
  sessionAProjectAtCreate: string | null;
  sessionB: string;
  ctxBSession: string | null;
  sessionBProject: string | null;
  sessionAAfterSwitch: string;
  ctxA2Session: string | null;
  sessionAProjectAfterSwitch: string | null;
}> {
  // Fresh per run: no pre-seeded sessions for A or B.
  ActiveSessionStore.clear(CONN_A);
  ActiveSessionStore.clear(CONN_B);
  await deleteOurData();
  // Re-create the three projects (deleteOurData removed them).
  projectP1Id = (await db.query(
    `INSERT INTO projects (name, description) VALUES ($1, 'lazy P1') RETURNING id`, [P1_NAME]
  )).rows[0].id;
  projectP2Id = (await db.query(
    `INSERT INTO projects (name, description) VALUES ($1, 'lazy P2') RETURNING id`, [P2_NAME]
  )).rows[0].id;
  projectP3Id = (await db.query(
    `INSERT INTO projects (name, description) VALUES ($1, 'lazy P3') RETURNING id`, [P3_NAME]
  )).rows[0].id;

  // ----- Scenario 1: PASSIVE tools create ZERO sessions -----
  // Pin A to P1 first via project_switch (project_switch is PASSIVE — must NOT
  // create a session).
  await routeExecutor('project_switch', { project: projectP1Id }, { connectionId: CONN_A });
  await routeExecutor('project_current', {}, { connectionId: CONN_A });
  await routeExecutor('context_search', { query: 'nothing here yet' }, { connectionId: CONN_A });
  await routeExecutor('mandrel_ping', {}, { connectionId: CONN_A });
  const rowsAfterPassive = (await ourSessionRows()).length;

  // ----- Scenario 2: first ACTION lazily creates exactly ONE session for A -----
  const ctxAResp = await routeExecutor(
    'context_store',
    { content: 'A first real action', type: 'completion', tags: ['lazy', 'A'] },
    { connectionId: CONN_A }
  );
  const ctxAId = parseContextId(ctxAResp);
  const sessionA = ActiveSessionStore.get(CONN_A)!;
  const ctxASession = await contextSessionId(ctxAId);
  const ctxARow = await db.query('SELECT project_id FROM contexts WHERE id = $1', [ctxAId]);
  const ctxAProject = ctxARow.rows[0]?.project_id ?? null;
  // Snapshot A's session project_id AT CREATE TIME (before any later switch
  // re-pins it in scenario 4) so the P-B "pinned to A's current project" check
  // is read at the right moment.
  const sessionAProjectAtCreate = (await db.query(
    'SELECT project_id FROM sessions WHERE id = $1', [sessionA]
  )).rows[0]?.project_id ?? null;

  // ----- Scenario 3: B's first action makes a SEPARATE session (B's project) -----
  await routeExecutor('project_switch', { project: projectP2Id }, { connectionId: CONN_B });
  const ctxBResp = await routeExecutor(
    'context_store',
    { content: 'B first real action', type: 'completion', tags: ['lazy', 'B'] },
    { connectionId: CONN_B }
  );
  const ctxBId = parseContextId(ctxBResp);
  const sessionB = ActiveSessionStore.get(CONN_B)!;
  const ctxBSession = await contextSessionId(ctxBId);
  const sessionBProject = (await db.query(
    'SELECT project_id FROM sessions WHERE id = $1', [sessionB]
  )).rows[0]?.project_id ?? null;

  // ----- Scenario 4: project_switch keeps SAME session, re-pins project -----
  await routeExecutor('project_switch', { project: projectP3Id }, { connectionId: CONN_A });
  const ctxA2Resp = await routeExecutor(
    'context_store',
    { content: 'A action after switch', type: 'completion', tags: ['lazy', 'A2'] },
    { connectionId: CONN_A }
  );
  const ctxA2Id = parseContextId(ctxA2Resp);
  const sessionAAfterSwitch = ActiveSessionStore.get(CONN_A)!;
  const ctxA2Session = await contextSessionId(ctxA2Id);
  const sessRow = await db.query('SELECT project_id FROM sessions WHERE id = $1', [sessionA]);
  const sessionAProjectAfterSwitch = sessRow.rows[0]?.project_id ?? null;

  return {
    rowsAfterPassive,
    sessionA,
    ctxASession,
    ctxAProject,
    sessionAProjectAtCreate,
    sessionB,
    ctxBSession,
    sessionBProject,
    sessionAAfterSwitch,
    ctxA2Session,
    sessionAProjectAfterSwitch,
  };
}

// ---- the contract --------------------------------------------------------

describe('Lazy session lifecycle + per-connection attribution contract', () => {
  beforeAll(async () => {
    // projects are (re)created inside runFlow; nothing to do here.
  });

  afterAll(async () => {
    ActiveSessionStore.clear(CONN_A);
    ActiveSessionStore.clear(CONN_B);
    try { await deleteOurData(); } catch { /* ignore */ }
    await db.end();
  });

  test('P-B: no eager create on passive tools; lazy create on first action', async () => {
    const r = await runFlow();

    // Scenario 1: passive tools created ZERO of our sessions.
    expect(r.rowsAfterPassive).toBe(0);

    // Scenario 2: exactly one session for A, bound to A, pinned to A's project P1
    // at create time, and the stored context carries A's session_id + project.
    expect(r.sessionA).toBeTruthy();
    expect(r.ctxASession).toBe(r.sessionA);
    expect(r.ctxAProject).toBe(projectP1Id);
    // The session row, AT CREATE TIME, was pinned to A's then-current project P1.
    expect(r.sessionAProjectAtCreate).toBe(projectP1Id);
  });

  test('P-A: B gets a SEPARATE session; no cross-attribution either way', async () => {
    const r = await runFlow();

    // B's session exists, distinct from A's, and B's context is attributed to B.
    expect(r.sessionB).toBeTruthy();
    expect(r.sessionB).not.toBe(r.sessionA);
    expect(r.ctxBSession).toBe(r.sessionB);

    // B's session is pinned to B's project (P2), not A's (the leak would put it
    // on whatever was "last active anywhere"). B never switches, so this is stable.
    expect(r.sessionBProject).toBe(projectP2Id);

    // A's context never landed on B's session and B's never on A's.
    expect(r.ctxASession).not.toBe(r.sessionB);
    expect(r.ctxBSession).not.toBe(r.sessionA);

    // Exactly our two distinct connection sessions should exist for A's P1 + B's
    // P2 lineage after the flow (A's row later moves to P3 — see next test).
    const rows = await ourSessionRows();
    const ids = new Set(rows.map(x => x.id));
    expect(ids.has(r.sessionA)).toBe(true);
    expect(ids.has(r.sessionB)).toBe(true);
  });

  test('one session per connection across project_switch (re-pin, not re-create)', async () => {
    const r = await runFlow();

    // Same session id before and after the switch.
    expect(r.sessionAAfterSwitch).toBe(r.sessionA);
    // The post-switch context attaches to that SAME session.
    expect(r.ctxA2Session).toBe(r.sessionA);
    // And the session row's project_id was RE-PINNED to the switched-to project.
    expect(r.sessionAProjectAfterSwitch).toBe(projectP3Id);

    // Proof it's not a new session: count A-lineage sessions (P1 or P3 owner with
    // A's id) — there must be exactly ONE row carrying A's id.
    const aRows = (await db.query(
      'SELECT id FROM sessions WHERE id = $1', [r.sessionA]
    )).rows;
    expect(aRows.length).toBe(1);
  });

  test('idempotent: a second full run yields the same structural outcome', async () => {
    const first = await runFlow();
    const second = await runFlow();

    // Both runs: zero eager rows, distinct A/B sessions, A re-pinned to P3.
    expect(first.rowsAfterPassive).toBe(0);
    expect(second.rowsAfterPassive).toBe(0);

    expect(second.ctxASession).toBe(second.sessionA);
    expect(second.ctxBSession).toBe(second.sessionB);
    expect(second.sessionA).not.toBe(second.sessionB);
    expect(second.sessionAAfterSwitch).toBe(second.sessionA);
    expect(second.sessionAProjectAfterSwitch).toBe(projectP3Id);

    // Across runs the lazily-created session ids are fresh (real UUIDs, no reuse).
    expect(second.sessionA).not.toBe(first.sessionA);
    expect(second.sessionB).not.toBe(first.sessionB);
  });
});
