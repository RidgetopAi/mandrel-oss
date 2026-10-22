/**
 * session_pin MCP tool — END-TO-END contract test (Sessions Foundation Phase 2a).
 * Drives the REAL tool through routeExecutor (the same dispatch
 * the HTTP bridge calls), threading context.actor + context.connectionId, against a REAL
 * Postgres.
 *
 * PROVES:
 *   - set (explicit sessionId) persists a pin scoped to the caller's ACTOR;
 *   - set with NO sessionId defaults to the connection's current active session;
 *   - get reports the pin + whether the pinned session is still open;
 *   - clear removes it (idempotent);
 *   - an actorless call is REJECTED (fail loud — the pin key is the actor, never a tool arg);
 *   - set REJECTS a non-open / unknown session id;
 *   - INERT: setting a pin does not spawn a session (session_pin is not an action tool).
 */

import { describe, test, expect, afterAll, beforeAll } from 'vitest';

import { db } from '../config/database.js';
import { routeExecutor } from '../routes/index.js';
import { SessionTracker } from '../services/session/SessionTracker.js';

const STAMP = Date.now();
let projectId: string;
const createdSessionIds: string[] = [];
const actor = `pin-tool-actor-${STAMP}`;

async function pin(args: any, ctx: { connectionId?: string; actor?: string }) {
  return routeExecutor('session_pin', args, ctx);
}

async function makeSession(connectionId: string): Promise<string> {
  const id = await SessionTracker.startSession(
    projectId, undefined, undefined, undefined, undefined, undefined, undefined, connectionId, actor
  );
  createdSessionIds.push(id);
  return id;
}

beforeAll(async () => {
  const r = await db.query(
    `INSERT INTO projects (name, description) VALUES ($1, $2) RETURNING id`,
    [`QA-PinTool-2a-${STAMP}`, 'Phase 2a session_pin tool test']
  );
  projectId = r.rows[0].id;
});

afterAll(async () => {
  await db.query('DELETE FROM session_pins WHERE actor = $1', [actor]);
  if (createdSessionIds.length > 0) {
    await db.query('DELETE FROM session_pins WHERE session_id = ANY($1::uuid[])', [createdSessionIds]);
    await db.query('DELETE FROM analytics_events WHERE session_id = ANY($1::uuid[])', [createdSessionIds]);
    await db.query('DELETE FROM sessions WHERE id = ANY($1::uuid[])', [createdSessionIds]);
  }
  await db.query('DELETE FROM sessions WHERE project_id = $1', [projectId]);
  await db.query('DELETE FROM projects WHERE id = $1', [projectId]);
});

describe('session_pin tool — set / get / clear (actor-scoped)', () => {
  test('set with explicit sessionId persists a pin for the actor; get reports it', async () => {
    const s = await makeSession(`conn-pintool-1-${STAMP}`);

    const setResp = await pin({ action: 'set', sessionId: s }, { actor, connectionId: `conn-pintool-1-${STAMP}` });
    expect(setResp.isError).not.toBe(true);
    expect(setResp.structuredContent).toMatchObject({ ok: true, action: 'set', actor });
    expect(setResp.structuredContent?.pin.sessionId).toBe(s);

    // Persisted in the DB.
    const row = await db.query('SELECT session_id FROM session_pins WHERE actor = $1', [actor]);
    expect(row.rows[0].session_id).toBe(s);

    const getResp = await pin({ action: 'get' }, { actor });
    expect(getResp.structuredContent).toMatchObject({ ok: true, action: 'get', pinned: true, open: true });
    expect(getResp.structuredContent?.pin.sessionId).toBe(s);
  });

  test('set with NO sessionId defaults to the connection current active session', async () => {
    const conn = `conn-pintool-2-${STAMP}`;
    const s = await makeSession(conn);
    // getActiveSession resolves via RAM/connection; startSession cached it under conn.

    const resp = await pin({ action: 'set' }, { actor, connectionId: conn });
    expect(resp.isError).not.toBe(true);
    expect(resp.structuredContent?.pin.sessionId).toBe(s);
  });

  test('clear removes the pin (idempotent)', async () => {
    const resp1 = await pin({ action: 'clear' }, { actor });
    expect(resp1.structuredContent).toMatchObject({ ok: true, action: 'clear', removed: true });
    const resp2 = await pin({ action: 'clear' }, { actor });
    expect(resp2.structuredContent).toMatchObject({ ok: true, action: 'clear', removed: false });
    const getResp = await pin({ action: 'get' }, { actor });
    expect(getResp.structuredContent).toMatchObject({ pinned: false, pin: null });
  });
});

describe('session_pin tool — guardrails', () => {
  test('rejects a call with NO derivable actor (fail loud)', async () => {
    const resp = await pin({ action: 'get' }, {});
    expect(resp.isError).toBe(true);
    expect(JSON.stringify(resp.content)).toMatch(/actor identity/i);
  });

  test('set rejects a non-open / unknown session id', async () => {
    const bogus = '00000000-0000-0000-0000-000000000000';
    const resp = await pin({ action: 'set', sessionId: bogus }, { actor, connectionId: `conn-pintool-x-${STAMP}` });
    expect(resp.isError).toBe(true);
    expect(JSON.stringify(resp.content)).toMatch(/not an open session/i);
  });

  test('set with no sessionId and no active session errors clearly', async () => {
    const resp = await pin({ action: 'set' }, { actor, connectionId: `conn-pintool-empty-${STAMP}` });
    expect(resp.isError).toBe(true);
    expect(JSON.stringify(resp.content)).toMatch(/no active session/i);
  });
});
