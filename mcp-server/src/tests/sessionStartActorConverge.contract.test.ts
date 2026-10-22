/**
 * session_start ACTOR-MODE CONVERGE contract test.
 *
 * THE FUSE FOR THE BUG: session_start was the ONE session path never migrated onto the shared
 * actor resolver. In actor mode its route handler (sessionRoutes.handleStart) called the legacy
 * connection-keyed startSession WITHOUT the actor → every call stamped a fresh `anonymous`/NULL
 * row keyed on connection_id (never idempotent per actor), AND its end-prior step first resolved
 * the actor's REAL working session and finalized it — so session_start could actively KILL the
 * orb's working session + attribution. The existing sessionStartRoundTrip.contract.test.ts had
 * ZERO actor assertions (and tests a DIFFERENT surface — SessionAnalyticsHandler, the REST path),
 * so nothing guarded this.
 *
 * This drives the REAL sessionRoutes.handleStart (the MCP `session_start` tool) + the gateway
 * `session{action:start}` (same handler) against REAL Postgres (the CI gate disposable migrated DB),
 * flipping resolverMode='actor' per-test and restoring after. It proves the converge:
 *   (a) actor-mode session_start stamps the REAL actor (never 'anonymous'/NULL) + carries title/goal;
 *   (b) a 2nd session_start for the SAME actor resolves the SAME session — no new row (idempotency);
 *   (c) a WRITE (task_create) after session_start attaches to that SAME session;
 *   (d) REGRESSION: actor-mode session_start does NOT finalize the actor's existing working session;
 *   (f) the gateway surface routes through the SAME handleStart → same converge (one fix, both surfaces).
 *   legacy-mode: byte-identical — session_start still ends-prior + mints a connection-keyed session.
 *
 * Model: sessionResolverPhase2b.contract.test.ts (resolverMode flip + real DB + id-scoped cleanup).
 * Embeddings are irrelevant here (task_create needs none).
 */

import { describe, test, expect, afterAll, beforeAll, afterEach } from 'vitest';

import { db } from '../config/database.js';
import { SessionLifecycleService } from '../services/session/domain/lifecycle/SessionLifecycleService.js';
import { ActiveSessionStore } from '../services/session/state/ActiveSessionStore.js';
import { sessionRoutes } from '../routes/session.routes.js';
import { dispatchGateway } from '../routes/gateway.js';
import { tasksHandler } from '../handlers/tasks.js';
import { SESSION_CONFIG } from '../config/sessionConfig.js';
import { ACTOR_ANONYMOUS } from '../config/actorRegistry.js';

const STAMP = Date.now();
let projectId: string;
const createdSessionIds: string[] = [];
const createdActors: string[] = [];
const createdTaskIds: string[] = [];

/** Track a session id for cleanup and return it. */
function track(id: string): string {
  if (id && !createdSessionIds.includes(id)) createdSessionIds.push(id);
  return id;
}

/** Pull the sessionId a handleStart response reports (flat or gateway shape). */
function sidOf(resp: any): string {
  return resp?.structuredContent?.sessionId;
}

const savedMode = SESSION_CONFIG.resolverMode;
afterEach(() => {
  SESSION_CONFIG.resolverMode = savedMode; // default 'legacy'
  ActiveSessionStore.clearAll();
});

beforeAll(async () => {
  const r = await db.query(
    `INSERT INTO projects (name, description) VALUES ($1, $2) RETURNING id`,
    [`QA-SessionStartConverge-${STAMP}`, 'session_start actor-mode converge contract']
  );
  projectId = r.rows[0].id;
});

afterAll(async () => {
  if (createdTaskIds.length > 0) {
    await db.query('DELETE FROM tasks WHERE id = ANY($1::uuid[])', [createdTaskIds]);
  }
  if (createdActors.length > 0) {
    await db.query('DELETE FROM session_pins WHERE actor = ANY($1::text[])', [createdActors]);
  }
  if (createdSessionIds.length > 0) {
    await db.query('DELETE FROM session_pins WHERE session_id = ANY($1::uuid[])', [createdSessionIds]);
    await db.query('DELETE FROM analytics_events WHERE session_id = ANY($1::uuid[])', [createdSessionIds]);
    await db.query('DELETE FROM tasks WHERE session_id = ANY($1::uuid[])', [createdSessionIds]);
    await db.query('DELETE FROM sessions WHERE id = ANY($1::uuid[])', [createdSessionIds]);
  }
  await db.query('DELETE FROM tasks WHERE project_id = $1', [projectId]);
  await db.query('DELETE FROM sessions WHERE project_id = $1', [projectId]);
  await db.query('DELETE FROM projects WHERE id = $1', [projectId]);
});

// ── (a) actor-mode session_start stamps the REAL actor + carries title/goal ──────────────
describe('(a) actor-mode session_start stamps context.actor (never anonymous/NULL)', () => {
  test('the created session row carries the real actor + the title/goal', async () => {
    SESSION_CONFIG.resolverMode = 'actor';
    const actor = `converge-a-${STAMP}`;
    createdActors.push(actor);

    const resp = await sessionRoutes.handleStart(
      { title: 'Converge A', goal: 'stamp the actor' },
      { connectionId: `a-conn-${STAMP}`, actor }
    );
    const sid = track(sidOf(resp));

    expect(resp.structuredContent?.ok).toBe(true);
    // The converge guarantee: session_start never finalizes anything in actor mode.
    expect(resp.structuredContent?.endedSessionId).toBeNull();

    const row = (
      await db.query('SELECT actor, title, session_goal, ended_at, status FROM sessions WHERE id = $1', [sid])
    ).rows[0];
    expect(row).toBeTruthy();
    expect(row.actor).toBe(actor); // NOT 'anonymous', NOT NULL
    expect(row.actor).not.toBe(ACTOR_ANONYMOUS);
    expect(row.title).toBe('Converge A');
    expect(row.session_goal).toBe('stamp the actor');
    expect(row.ended_at).toBeNull(); // freshly opened, still live
  });
});

// ── (b) idempotency: a 2nd start for the same actor resolves the SAME session ─────────────
describe('(b) session_start is idempotent per actor — no duplicate row', () => {
  test('a second session_start for the same actor (fresh connection) returns the SAME session', async () => {
    SESSION_CONFIG.resolverMode = 'actor';
    const actor = `converge-b-${STAMP}`;
    createdActors.push(actor);

    const first = track(sidOf(await sessionRoutes.handleStart({}, { connectionId: `b1-${STAMP}`, actor })));

    // Simulate a fresh connection / restart: wipe RAM so resolution must go by ACTOR, not cache.
    ActiveSessionStore.clearAll();

    const second = track(sidOf(await sessionRoutes.handleStart({}, { connectionId: `b2-${STAMP}`, actor })));
    expect(second).toBe(first); // resolved via newest-open, NOT a new anonymous row

    const n = (
      await db.query(`SELECT count(*)::int AS n FROM sessions WHERE actor = $1 AND ended_at IS NULL`, [actor])
    ).rows[0].n;
    expect(n).toBe(1); // exactly ONE open session for this actor
  });
});

// ── (c) a write after session_start attaches to that same session ────────────────────────
describe('(c) a write (task_create) after session_start attaches to the SAME session', () => {
  test('task_create on a different connection attributes to the session_start session', async () => {
    SESSION_CONFIG.resolverMode = 'actor';
    const actor = `converge-c-${STAMP}`;
    createdActors.push(actor);

    const sid = track(sidOf(await sessionRoutes.handleStart({ title: 'work session' }, { connectionId: `c-start-${STAMP}`, actor })));

    // A write on a DIFFERENT connection but the SAME actor — the write path resolves the session
    // by actor (getActiveSession(conn,{actor}) → resolveSession), exactly like session_start did.
    ActiveSessionStore.clearAll();
    const task = await tasksHandler.createTask(
      projectId,
      `converge-task-${STAMP}`,
      undefined, 'general', 'medium', undefined, undefined, [], [], {},
      `c-write-${STAMP}`, // a fresh connection
      undefined,
      actor
    );
    createdTaskIds.push(task.id);

    expect(task.sessionId).toBe(sid); // the write joined the session_start session, no orphan row
  });
});

// ── (d) REGRESSION: session_start must NOT finalize the actor's working session ──────────
describe('(d) actor-mode session_start does NOT finalize the actor existing working session', () => {
  test('a live working session survives a subsequent session_start (endedSessionId null, still active)', async () => {
    SESSION_CONFIG.resolverMode = 'actor';
    const actor = `converge-d-${STAMP}`;
    createdActors.push(actor);

    // The actor's REAL working session (as the write path would have created it).
    const working = track(await SessionLifecycleService.ensureSessionForActor({ actor, connectionId: `d-work-${STAMP}`, projectId, creationReason: 'automatic-write' }));

    // Restart / new orb connection, then session_start — the OLD bug resolved `working` and
    // endSession()-finalized it BEFORE minting an empty anonymous row.
    ActiveSessionStore.clearAll();
    const resp = await sessionRoutes.handleStart({ title: 'resumed' }, { connectionId: `d-start-${STAMP}`, actor });

    // Converged behavior: resolves the SAME working session, ends NOTHING.
    expect(sidOf(resp)).toBe(working);
    expect(resp.structuredContent?.endedSessionId).toBeNull();

    // The money assertion — the working session is untouched: still open + active, not finalized.
    const row = (await db.query('SELECT ended_at, status FROM sessions WHERE id = $1', [working])).rows[0];
    expect(row.ended_at).toBeNull();
    expect(row.status).toBe('active');
  });
});

// ── (f) both surfaces: the gateway session{action:start} routes through the SAME handleStart ─
describe('(f) gateway session{action:start} converges identically (one fix, both surfaces)', () => {
  test('gateway session.start resolves the actor session and finalizes nothing', async () => {
    SESSION_CONFIG.resolverMode = 'actor';
    const actor = `converge-f-${STAMP}`;
    createdActors.push(actor);

    const working = track(await SessionLifecycleService.ensureSessionForActor({ actor, connectionId: `f-work-${STAMP}`, projectId, creationReason: 'automatic-write' }));
    ActiveSessionStore.clearAll();

    const resp = await dispatchGateway('session', { action: 'start' }, { connectionId: `f-start-${STAMP}`, actor });
    expect(resp.isError).not.toBe(true);
    expect(sidOf(resp)).toBe(working); // gateway → routeExecutor → same handleStart → same resolver
    expect(resp.structuredContent?.endedSessionId).toBeNull();
  });
});

// ── legacy byte-identical: session_start still ends-prior + mints a connection-keyed session ─
describe('legacy mode — session_start behavior is byte-identical (ends prior, new row)', () => {
  test('a second session_start on the same connection ends the prior session and opens a new one', async () => {
    SESSION_CONFIG.resolverMode = 'legacy';
    const actor = `converge-legacy-${STAMP}`;
    const conn = `legacy-conn-${STAMP}`;
    ActiveSessionStore.clear(conn);

    const first = track(sidOf(await sessionRoutes.handleStart({ title: 'first' }, { connectionId: conn, actor })));
    const resp2 = await sessionRoutes.handleStart({ title: 'second' }, { connectionId: conn, actor });
    const second = track(sidOf(resp2));

    // Legacy = a NEW session each start, finalizing the prior one (the untouched pre-fix path).
    expect(second).not.toBe(first);
    expect(resp2.structuredContent?.endedSessionId).toBe(first);

    const priorRow = (await db.query('SELECT ended_at FROM sessions WHERE id = $1', [first])).rows[0];
    expect(priorRow.ended_at).not.toBeNull(); // prior session was finalized (end-prior intact)
  });
});
