/**
 * Session-Rework SR-2 — explicit user-controlled session lifecycle MCP tools.
 * builds on SR-1 (model ctx a5e6620c).
 *
 * WHAT THIS PROVES — drives the REAL tools END TO END through routeExecutor (the same
 * dispatch the HTTP bridge calls), the REAL SessionLifecycleService + SessionRepo, and a
 * REAL Postgres. NO wall-clock sleeps; the per-connection identity is the SAME
 * X-Connection-ID the route layer threads everywhere (passed as context.connectionId).
 *
 *   session_start OPENS a new session for the connection AND ENDS the prior one
 *     (finalized: ended_at stamped), with EXACTLY ONE open row per connection held
 *     throughout — SR-1's one-active-per-connection invariant.
 *
 *   METADATA PERSISTED: title/goal/project passed to session_start are stamped on the
 *     session row (session_goal → Session View "Session Goal" field) and the project is
 *     resolved + attached.
 *
 *   session_end FINALIZES the connection's session (ended_at stamped) and is NO-OP-safe
 *     when none is active; the NEXT action tool (context_store) AUTO-STARTS a fresh
 *     session (the lazy action gate), proving "end → next action starts fresh".
 *
 *   session_status is a read-only, connection-scoped summary (active true/false).
 *
 *   CONNECTION ISOLATION: ending/starting on connection A never touches connection B's
 *     active session.
 *
 * DB target: the isolated throwaway test database (the CI gate provisions DATABASE_* +
 * EMBEDDING_*). Migration 050 (connection_id / partial unique index) must have run.
 */

import { describe, test, expect, afterAll, beforeAll } from 'vitest';

import { db } from '../config/database.js';
import { routeExecutor } from '../routes/index.js';
import { projectHandler } from '../handlers/project.js';
import { ActiveSessionStore } from '../services/session/state/ActiveSessionStore.js';

const STAMP = Date.now();
let projectId: string;
let projectName: string;
let altProjectName: string;
let altProjectId: string;

// Unique connection ids per run so parallel/repeat runs never collide.
const conn = (label: string) => `sr2-${label}-${STAMP}`;

/** Count OPEN rows (ended_at NULL, active|interrupted) for a connection id. */
async function openRowsForConn(connectionId: string): Promise<number> {
  const r = await db.query(
    `SELECT count(*)::int AS n FROM sessions
     WHERE connection_id = $1 AND ended_at IS NULL
       AND status::text IN ('active','interrupted')`,
    [connectionId]
  );
  return r.rows[0].n;
}

async function sessionRow(
  id: string
): Promise<{ status: string; ended_at: Date | null; session_goal: string | null; title: string | null; project_id: string | null } | null> {
  const r = await db.query(
    'SELECT status, ended_at, session_goal, title, project_id FROM sessions WHERE id = $1',
    [id]
  );
  return r.rows[0] ?? null;
}

/** Drive a tool through the real dispatcher for a given connection id. */
async function call(tool: string, args: any, connectionId: string) {
  return routeExecutor(tool, args, { connectionId });
}

async function cleanup(): Promise<void> {
  await db.query(
    `DELETE FROM contexts WHERE session_id IN (SELECT id FROM sessions WHERE connection_id LIKE $1)`,
    [`sr2-%-${STAMP}`]
  );
  await db.query(`DELETE FROM analytics_events WHERE session_id IN (SELECT id FROM sessions WHERE connection_id LIKE $1)`, [
    `sr2-%-${STAMP}`,
  ]);
  await db.query(`DELETE FROM sessions WHERE connection_id LIKE $1`, [`sr2-%-${STAMP}`]);
}

describe('SR-2: explicit user-controlled session lifecycle tools', () => {
  beforeAll(async () => {
    projectName = `sr2-proj-${STAMP}`;
    altProjectName = `sr2-alt-${STAMP}`;
    projectId = (
      await db.query(`INSERT INTO projects (name, description) VALUES ($1, 'SR-2 test') RETURNING id`, [projectName])
    ).rows[0].id;
    altProjectId = (
      await db.query(`INSERT INTO projects (name, description) VALUES ($1, 'SR-2 alt') RETURNING id`, [altProjectName])
    ).rows[0].id;
    // Pin the connection's current project so an unspecified-project start inherits it.
    projectHandler.setCurrentProject(projectId, conn('start'));
  });

  afterAll(async () => {
    ActiveSessionStore.clearAll();
    try {
      await cleanup();
      await db.query('DELETE FROM projects WHERE id = ANY($1)', [[projectId, altProjectId]]);
    } catch {
      /* ignore */
    }
    await db.end();
  });

  test('session_start opens a new session, ends the prior one, and holds one-active-per-connection', async () => {
    const c = conn('start');
    ActiveSessionStore.clear(c);

    // First start — opens S1 (no prior). With title/goal stamped.
    const r1 = await call('session_start', { title: 'first', goal: 'do the SR-2 thing' }, c);
    expect(r1.isError).not.toBe(true);
    const s1 = r1.structuredContent!.sessionId as string;
    expect(s1).toBeTruthy();
    expect(r1.structuredContent!.action).toBe('started');
    expect(r1.structuredContent!.endedSessionId).toBeNull();
    expect(await openRowsForConn(c)).toBe(1);

    // METADATA PERSISTED on S1.
    const row1 = await sessionRow(s1);
    expect(row1!.title).toBe('first');
    expect(row1!.session_goal).toBe('do the SR-2 thing');
    expect(row1!.project_id).toBe(projectId); // inherited connection project

    // Second start — must END S1 (finalize) and OPEN S2.
    const r2 = await call('session_start', { title: 'second' }, c);
    const s2 = r2.structuredContent!.sessionId as string;
    expect(s2).not.toBe(s1);
    expect(r2.structuredContent!.endedSessionId).toBe(s1);

    // S1 is finalized (ended_at stamped); exactly ONE open row remains (S2).
    expect((await sessionRow(s1))!.ended_at).not.toBeNull();
    expect(await openRowsForConn(c)).toBe(1);
    expect((await sessionRow(s2))!.ended_at).toBeNull();
  });

  test('session_start resolves + attaches an explicit project (by name)', async () => {
    const c = conn('project');
    ActiveSessionStore.clear(c);

    const r = await call('session_start', { goal: 'alt-project run', project: altProjectName }, c);
    const sid = r.structuredContent!.sessionId as string;
    const row = await sessionRow(sid);
    expect(row!.project_id).toBe(altProjectId);
    expect(row!.session_goal).toBe('alt-project run');
  });

  test('session_start with an unknown project fails fast WITHOUT mutating session state', async () => {
    const c = conn('badproject');
    ActiveSessionStore.clear(c);

    // Open a known-good session first.
    const good = await call('session_start', { title: 'keep me' }, c);
    const sid = good.structuredContent!.sessionId as string;

    // A bad project must error and must NOT end/replace the current session.
    const bad = await call('session_start', { project: `nope-${STAMP}` }, c);
    expect(bad.isError).toBe(true);

    // The original session is untouched (still open, still the active one).
    expect((await sessionRow(sid))!.ended_at).toBeNull();
    expect(await openRowsForConn(c)).toBe(1);
  });

  test('session_end finalizes the session, and the NEXT action auto-starts a fresh one', async () => {
    const c = conn('end');
    ActiveSessionStore.clear(c);

    const started = await call('session_start', { title: 'to be ended' }, c);
    const s1 = started.structuredContent!.sessionId as string;

    const ended = await call('session_end', {}, c);
    expect(ended.structuredContent!.action).toBe('ended');
    expect(ended.structuredContent!.sessionId).toBe(s1);
    expect((await sessionRow(s1))!.ended_at).not.toBeNull();
    expect(await openRowsForConn(c)).toBe(0); // none open after end

    // The NEXT content-producing action (context_store) must lazily AUTO-START a fresh
    // session — different id, open, attributed to this connection.
    projectHandler.setCurrentProject(projectId, c);
    const stored = await call('context_store', { content: 'after end auto-start', type: 'milestone' }, c);
    expect(stored.isError).not.toBe(true);
    expect(await openRowsForConn(c)).toBe(1);
    const freshId = (await db.query(
      `SELECT id FROM sessions WHERE connection_id = $1 AND ended_at IS NULL`,
      [c]
    )).rows[0].id as string;
    expect(freshId).not.toBe(s1);
  });

  test('session_end is a safe no-op when no session is active', async () => {
    const c = conn('noop');
    ActiveSessionStore.clear(c);

    const r = await call('session_end', {}, c);
    expect(r.isError).not.toBe(true);
    expect(r.structuredContent!.action).toBe('noop');
    expect(r.structuredContent!.sessionId).toBeNull();
  });

  test('session_status reflects the connection state (none → active)', async () => {
    const c = conn('status');
    ActiveSessionStore.clear(c);

    // No session yet → clean "none" state.
    const none = await call('session_status', {}, c);
    expect(none.structuredContent!.active).toBe(false);
    expect(none.structuredContent!.session).toBeNull();

    // After start → active with the summary record.
    const started = await call('session_start', { title: 'status check', goal: 'observe me' }, c);
    const sid = started.structuredContent!.sessionId as string;
    const active = await call('session_status', {}, c);
    expect(active.structuredContent!.active).toBe(true);
    expect(active.structuredContent!.session.id).toBe(sid);
    expect(active.structuredContent!.session.session_goal).toBe('observe me');
  });

  test('connection isolation: ending connection A leaves connection B active', async () => {
    const cA = conn('isoA');
    const cB = conn('isoB');
    ActiveSessionStore.clear(cA);
    ActiveSessionStore.clear(cB);

    const a = await call('session_start', { title: 'A' }, cA);
    const b = await call('session_start', { title: 'B' }, cB);
    const sA = a.structuredContent!.sessionId as string;
    const sB = b.structuredContent!.sessionId as string;
    expect(sA).not.toBe(sB);

    // End A only.
    await call('session_end', {}, cA);
    expect((await sessionRow(sA))!.ended_at).not.toBeNull();

    // B is untouched — still open, and status on B still reports it active.
    expect((await sessionRow(sB))!.ended_at).toBeNull();
    const statusB = await call('session_status', {}, cB);
    expect(statusB.structuredContent!.active).toBe(true);
    expect(statusB.structuredContent!.session.id).toBe(sB);
  });
});
