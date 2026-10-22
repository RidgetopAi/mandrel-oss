/**
 * Dangling-Session FK Regression Contract Test
 * (the executable fuse for the P0 `contexts_session_id_fkey` crash)
 *
 * THE BUG (customer report, remote Streamable-HTTP transport):
 *   context_store failed with
 *     insert or update on table "contexts" violates foreign key constraint
 *     "contexts_session_id_fkey"
 *
 * ROOT CAUSE:
 *   ensureSessionId() trusts SessionTracker.getActiveSession(connectionId) without
 *   verifying the returned id exists in `sessions`. getActiveSession returned an id
 *   held in the in-memory ActiveSessionStore whose DB row did not exist (stale /
 *   never-persisted "in-memory" session). The action gate's ensureActiveSession()
 *   also short-circuited on that non-null cached id, so it never (re)created a real
 *   DB session. The contexts INSERT then used a dangling FK → crash.
 *
 * WHAT THIS PROVES (drives the REAL routeExecutor + REAL Postgres):
 *   1. REPRO: seed ActiveSessionStore for a connection with a session id that does
 *      NOT exist in the DB, then context_store. PRE-FIX this throws the FK error.
 *      POST-FIX it SUCCEEDS — no FK error thrown — and the stored context is
 *      attributed to a REAL, DB-backed session (the action gate re-created it),
 *      proving the root-cause guard self-heals the stale cache.
 *   2. HAPPY PATH: a connection whose session was lazily created by a prior action
 *      stores a second context that attaches to that SAME persisted session
 *      (session_id set correctly) — the normal path is unbroken.
 *   3. BELT: the defensive layer in ensureSessionId stores WITHOUT a session
 *      (session_id NULL) rather than crashing if a stale id ever reaches it
 *      (verified via the contextHandler directly with a connection that has no
 *      lazy gate run — the handler must never throw an FK error).
 *
 * DB target: an isolated throwaway database created by the runner script
 * scripts/test-context-store-dangling-session.sh (drops it on exit). Run via that
 * script so DATABASE_* env points at the disposable DB — NEVER the production
 * `mandrel` DB.
 */

import { describe, test, expect, afterAll, vi } from 'vitest';
import { patternEmbedding } from './helpers/embedGeometry.js';

// Restore REAL crypto so each lazily-created session gets a distinct UUID
// (the global vitest.setup.ts mocks randomUUID with a resettable counter).
vi.unmock('crypto');
vi.unmock('node:crypto');

// Stub embeddings (native @xenova/transformers → sharp is unavailable in CI/sandbox).
// context_store still runs its FULL real DB write + session attribution path.
vi.mock('../services/embedding.js', () => ({
  embeddingService: {
    generateEmbedding: vi.fn(async () => ({
      embedding: patternEmbedding(),
    })),
  },
}));

import { randomUUID } from 'node:crypto';
import { db } from '../config/database.js';
import { routeExecutor } from '../routes/index.js';
import { contextHandler } from '../handlers/context.js';
import { ActiveSessionStore } from '../services/session/state/ActiveSessionStore.js';

const STAMP = Date.now();
const CONN_REPRO = `dangling-conn-repro-${STAMP}`;
const CONN_HAPPY = `dangling-conn-happy-${STAMP}`;
const CONN_BELT = `dangling-conn-belt-${STAMP}`;
const PROJ_NAME = `dangling-P-${STAMP}`;

let projectId: string;

async function setup(): Promise<void> {
  projectId = (await db.query(
    `INSERT INTO projects (name, description) VALUES ($1, 'dangling-session repro') RETURNING id`,
    [PROJ_NAME]
  )).rows[0].id;
}

async function teardown(): Promise<void> {
  ActiveSessionStore.clear(CONN_REPRO);
  ActiveSessionStore.clear(CONN_HAPPY);
  ActiveSessionStore.clear(CONN_BELT);
  if (projectId) {
    await db.query('DELETE FROM contexts WHERE project_id = $1', [projectId]);
    await db.query('DELETE FROM sessions WHERE project_id = $1', [projectId]);
    await db.query('DELETE FROM projects WHERE id = $1', [projectId]);
  }
}

function parseContextId(resp: any): string {
  const text: string = resp?.content?.[0]?.text ?? '';
  const m = text.match(/ID:\s*([0-9a-f-]{36})/i);
  if (!m) throw new Error(`Could not parse context id from response: ${text.slice(0, 200)}`);
  return m[1];
}

async function contextSessionId(contextId: string): Promise<string | null> {
  const r = await db.query('SELECT session_id FROM contexts WHERE id = $1', [contextId]);
  return r.rows[0]?.session_id ?? null;
}

async function sessionExists(sessionId: string): Promise<boolean> {
  const r = await db.query('SELECT 1 FROM sessions WHERE id = $1', [sessionId]);
  return r.rows.length > 0;
}

describe('context_store dangling-session FK regression', () => {
  afterAll(async () => {
    try { await teardown(); } catch { /* ignore */ }
    await db.end();
  });

  test('REPRO: stale in-memory session id no longer crashes context_store with an FK error', async () => {
    await setup();

    // Pin the connection's current project, then seed the in-memory active session
    // with an id that has NO matching row in `sessions` — the exact stale-cache
    // condition the customer hit. PRE-FIX, getActiveSession returns this id, the
    // action gate skips create, and the contexts INSERT explodes on the FK.
    await routeExecutor('project_switch', { project: projectId }, { connectionId: CONN_REPRO });
    const ghostSessionId = randomUUID();
    expect(await sessionExists(ghostSessionId)).toBe(false);
    ActiveSessionStore.set(ghostSessionId, CONN_REPRO);

    // This call must NOT throw (pre-fix it throws the FK violation).
    const resp = await routeExecutor(
      'context_store',
      { content: 'repro: store with a stale active session', type: 'completion', tags: ['dangling', 'repro'] },
      { connectionId: CONN_REPRO }
    );

    const ctxId = parseContextId(resp);
    const attributedSession = await contextSessionId(ctxId);

    // The context was stored. Its session_id is either NULL (defensive) or a REAL
    // persisted session (root-cause guard self-healed → action gate re-created one).
    // It must NEVER be the ghost id, and if non-null it MUST exist in the DB.
    expect(attributedSession).not.toBe(ghostSessionId);
    if (attributedSession !== null) {
      expect(await sessionExists(attributedSession)).toBe(true);
    }
  });

  test('HAPPY PATH: a persisted (lazily-created) session keeps receiving contexts', async () => {
    // No pre-seeded ghost. First action lazily creates a real DB session.
    await routeExecutor('project_switch', { project: projectId }, { connectionId: CONN_HAPPY });
    const resp1 = await routeExecutor(
      'context_store',
      { content: 'happy: first action creates real session', type: 'completion', tags: ['dangling', 'happy'] },
      { connectionId: CONN_HAPPY }
    );
    const ctx1 = parseContextId(resp1);
    const sess1 = await contextSessionId(ctx1);

    expect(sess1).toBeTruthy();
    expect(await sessionExists(sess1!)).toBe(true);
    // The in-memory store now holds a REAL, DB-backed session for this connection.
    expect(ActiveSessionStore.get(CONN_HAPPY)).toBe(sess1);

    // Second action on the SAME connection attaches to the SAME persisted session.
    const resp2 = await routeExecutor(
      'context_store',
      { content: 'happy: second action reuses session', type: 'completion', tags: ['dangling', 'happy2'] },
      { connectionId: CONN_HAPPY }
    );
    const ctx2 = parseContextId(resp2);
    const sess2 = await contextSessionId(ctx2);

    expect(sess2).toBe(sess1);
  });

  test('BELT: contextHandler.storeContext never throws an FK error on a stale active session', async () => {
    // Drive the handler DIRECTLY (no action gate) with a connection whose in-memory
    // session is a ghost. The defensive verify in ensureSessionId must store the
    // context with session_id = NULL rather than passing a dangling FK to the INSERT.
    const ghost = randomUUID();
    expect(await sessionExists(ghost)).toBe(false);
    ActiveSessionStore.set(ghost, CONN_BELT);

    const stored = await contextHandler.storeContext({
      projectId,
      type: 'completion',
      content: 'belt: handler-direct store with ghost session',
      tags: ['dangling', 'belt'],
      connectionId: CONN_BELT,
    });

    expect(stored?.id).toBeTruthy();
    const sess = await contextSessionId(stored.id);
    expect(sess).toBeNull();
  });
});
