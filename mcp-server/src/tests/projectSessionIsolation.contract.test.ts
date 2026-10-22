/**
 * Per-Session Project Isolation Contract Test  (the executable fuse for b6c18866)
 *
 * ROOT BUG: `projectHandler.switchProject()` only mutated the in-memory
 * `sessionStates` map; it never updated the `sessions` DB row. So after an agent
 * switched project, the session's stored `project_id` diverged from the project its
 * newly-stored contexts landed in (contexts resolve their project from
 * `getCurrentProjectId(connectionId)`, which DID move). That divergence is the
 * cross-project misattribution: the dashboard read the session's stale project_id
 * while the contexts lived under the new project.
 *
 * THE FIX (handlers/project.ts `switchProject` -> `syncSessionProject`): when the
 * current project changes for a connection, ALSO
 *     UPDATE sessions SET project_id = $newProject WHERE id = <THAT connection's
 *     own active session>
 * resolved via ActiveSessionStore (connection-scoped). Strictly per-connection:
 * switching project on connection A must NOT touch connection B's session row.
 *
 * This test drives the REAL `projectHandler.switchProject` against a REAL Postgres,
 * with two distinct connections A and B switching to two distinct projects P1/P2.
 * It asserts:
 *   - A's sessions.project_id == P1 and A's context.project_id == P1 (no divergence)
 *   - B's sessions.project_id == P2 and B's context.project_id == P2
 *   - A's switch did NOT change B's session row (no global clobber / cross-contam)
 *   - the original bug can't recur: after a switch the session row's project equals
 *     where that connection's new contexts land.
 *
 * It would FAIL on pre-fix code (A/B session rows keep their seeded project_id, so
 * session.project_id != context.project_id) and PASSES after the fix.
 *
 * DB target: an isolated throwaway test database. Run via:
 *   DATABASE_HOST=127.0.0.1 DATABASE_PORT=15432 DATABASE_NAME=mandrel_isolation_test \
 *   DATABASE_USER=mandrel DATABASE_PASSWORD=*** \
 *   npx vitest run src/tests/projectSessionIsolation.contract.test.ts
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { db } from '../config/database.js';
import { projectHandler } from '../handlers/project.js';
import { ActiveSessionStore } from '../services/session/state/ActiveSessionStore.js';

// Two independent connections (these are the keys the project handler / ActiveSessionStore use)
const CONN_A = `contract-conn-A-${Date.now()}`;
const CONN_B = `contract-conn-B-${Date.now()}`;

let projectP1Id: string;
let projectP2Id: string;
let sessionAId: string;
let sessionBId: string;

const P1_NAME = `iso-P1-${Date.now()}`;
const P2_NAME = `iso-P2-${Date.now()}`;

/**
 * Mirrors how context_store resolves a context's project: from the CALLING
 * connection's current project (getCurrentProjectId(connectionId)). This is the
 * value the session row must stay in sync with.
 */
async function storeContextForConnection(connectionId: string): Promise<string> {
  const projectId = await projectHandler.getCurrentProjectId(connectionId);
  if (!projectId) throw new Error(`No current project for connection ${connectionId}`);
  const sessionId = ActiveSessionStore.get(connectionId);
  const res = await db.query(
    `INSERT INTO contexts (project_id, session_id, context_type, content)
     VALUES ($1, $2, 'completion', $3) RETURNING project_id`,
    [projectId, sessionId, `ctx for ${connectionId}`]
  );
  return res.rows[0].project_id;
}

describe('Per-session project isolation contract (b6c18866 fuse)', () => {
  beforeAll(async () => {
    // Two distinct projects P1, P2
    const p1 = await db.query(
      `INSERT INTO projects (name, description) VALUES ($1, 'isolation P1') RETURNING id`,
      [P1_NAME]
    );
    const p2 = await db.query(
      `INSERT INTO projects (name, description) VALUES ($1, 'isolation P2') RETURNING id`,
      [P2_NAME]
    );
    projectP1Id = p1.rows[0].id;
    projectP2Id = p2.rows[0].id;

    // Two distinct sessions A and B. Seed both onto P1 deliberately, so that B's row
    // moving (or not) is observable, and A's "divergence after switch" is observable.
    const sa = await db.query(
      `INSERT INTO sessions (project_id, agent_type, title) VALUES ($1, 'contract', 'sessionA') RETURNING id`,
      [projectP1Id]
    );
    const sb = await db.query(
      `INSERT INTO sessions (project_id, agent_type, title) VALUES ($1, 'contract', 'sessionB') RETURNING id`,
      [projectP1Id]
    );
    sessionAId = sa.rows[0].id;
    sessionBId = sb.rows[0].id;

    // Bind each DB session to its OWN connection (connection-scoped, as the bridge does)
    ActiveSessionStore.set(sessionAId, CONN_A);
    ActiveSessionStore.set(sessionBId, CONN_B);
  });

  afterAll(async () => {
    ActiveSessionStore.clear(CONN_A);
    ActiveSessionStore.clear(CONN_B);
    for (const sid of [sessionAId, sessionBId]) {
      try { await db.query('DELETE FROM contexts WHERE session_id = $1', [sid]); } catch { /* ignore */ }
      try { await db.query('DELETE FROM sessions WHERE id = $1', [sid]); } catch { /* ignore */ }
    }
    for (const pid of [projectP1Id, projectP2Id]) {
      try { await db.query('DELETE FROM contexts WHERE project_id = $1', [pid]); } catch { /* ignore */ }
      try { await db.query('DELETE FROM projects WHERE id = $1', [pid]); } catch { /* ignore */ }
    }
    await db.end();
  });

  test('switch syncs each connection\'s OWN session row, isolated from the other', async () => {
    // Connection A switches to P1 and stores a context.
    await projectHandler.switchProject(projectP1Id, CONN_A);
    const ctxAProject = await storeContextForConnection(CONN_A);

    // Connection B switches to P2 and stores a context.
    await projectHandler.switchProject(projectP2Id, CONN_B);
    const ctxBProject = await storeContextForConnection(CONN_B);

    // Read both session rows back from the DB.
    const rowA = (await db.query('SELECT project_id FROM sessions WHERE id = $1', [sessionAId])).rows[0];
    const rowB = (await db.query('SELECT project_id FROM sessions WHERE id = $1', [sessionBId])).rows[0];

    // A: session row == P1, and its context landed in P1 (no divergence — the bug).
    expect(rowA.project_id).toBe(projectP1Id);
    expect(ctxAProject).toBe(projectP1Id);
    expect(rowA.project_id).toBe(ctxAProject);

    // B: session row == P2, and its context landed in P2.
    expect(rowB.project_id).toBe(projectP2Id);
    expect(ctxBProject).toBe(projectP2Id);
    expect(rowB.project_id).toBe(ctxBProject);

    // Cross-contamination guard: A and B ended on DIFFERENT projects. B's switch to
    // P2 must NOT have moved A's session, and A's switch must NOT have moved B's.
    expect(rowA.project_id).not.toBe(rowB.project_id);
  });

  test('switching project on connection A does not clobber connection B\'s session', async () => {
    // Pin B onto P2, A onto P1 first.
    await projectHandler.switchProject(projectP2Id, CONN_B);
    await projectHandler.switchProject(projectP1Id, CONN_A);

    const bBefore = (await db.query('SELECT project_id FROM sessions WHERE id = $1', [sessionBId])).rows[0];
    expect(bBefore.project_id).toBe(projectP2Id);

    // Now flip A to P2 as well. B must remain exactly as it was — A's UPDATE is
    // scoped to A's session id only, never a global UPDATE.
    await projectHandler.switchProject(projectP2Id, CONN_A);

    const aAfter = (await db.query('SELECT project_id FROM sessions WHERE id = $1', [sessionAId])).rows[0];
    const bAfter = (await db.query('SELECT project_id FROM sessions WHERE id = $1', [sessionBId])).rows[0];

    expect(aAfter.project_id).toBe(projectP2Id);   // A moved
    expect(bAfter.project_id).toBe(projectP2Id);   // B unchanged (it was already P2)

    // And the inverse: flip A back to P1, B (on P2) must NOT follow.
    await projectHandler.switchProject(projectP1Id, CONN_A);
    const aFinal = (await db.query('SELECT project_id FROM sessions WHERE id = $1', [sessionAId])).rows[0];
    const bFinal = (await db.query('SELECT project_id FROM sessions WHERE id = $1', [sessionBId])).rows[0];
    expect(aFinal.project_id).toBe(projectP1Id);
    expect(bFinal.project_id).toBe(projectP2Id);   // proof: no global clobber
  });
});
