/**
 * Sessions Foundation Phase 2b — ACTOR-MODE create/resolve contract tests.
 * Drives the REAL SessionLifecycleService.ensureSessionForActor /
 * createSessionForActor / getActiveSession (actor branch) + SessionRepo.createForActorLocked
 * + the session_status route against a REAL Postgres (disposable CI DB; migrations 062/063/064
 * applied). resolverMode is flipped to 'actor' per-test and restored after.
 *
 * PROVES (the four the auditor fixes + the guardrails, all load-bearing):
 *   D1  anonymous normalization BEFORE the resolver → N anonymous actions share ONE session.
 *   D2  a resolved 'interrupted' session is reactivated to 'active' by the gate.
 *   B   advisory-locked get-or-create: two DIFFERENT actors on the SAME connection each get
 *       their OWN session (connection_id NULL sidesteps the unique index); concurrent
 *       same-actor creates converge on ONE session.
 *   A   getActiveSession's DB-miss routes through resolveSession(actor) in actor mode → after a
 *       RAM wipe (simulated restart) session_status finds the actor's session, not blank.
 *   end-to-end actor mode: create → resolve(newest-open) → reactivate.
 *   legacy == pre-2b: the actor branch is INERT in legacy mode; actor-mode creates write
 *       connection_id NULL + created_via_connection, legacy creates the reverse.
 */

import { describe, test, expect, afterAll, beforeAll, afterEach } from 'vitest';

import { db } from '../config/database.js';
import { SessionTracker } from '../services/session/SessionTracker.js';
import { SessionLifecycleService } from '../services/session/domain/lifecycle/SessionLifecycleService.js';
import { ActiveSessionStore } from '../services/session/state/ActiveSessionStore.js';
import { sessionRoutes } from '../routes/session.routes.js';
import { SESSION_CONFIG } from '../config/sessionConfig.js';
import { ACTOR_ANONYMOUS } from '../config/actorRegistry.js';

const STAMP = Date.now();
let projectId: string;
const createdSessionIds: string[] = [];
const createdActors: string[] = [];

/** Track a session id for cleanup and return it. */
function track(id: string): string {
  if (!createdSessionIds.includes(id)) createdSessionIds.push(id);
  return id;
}

const savedMode = SESSION_CONFIG.resolverMode;
afterEach(() => {
  SESSION_CONFIG.resolverMode = savedMode; // default 'legacy'
  ActiveSessionStore.clearAll();
});

beforeAll(async () => {
  const r = await db.query(
    `INSERT INTO projects (name, description) VALUES ($1, $2) RETURNING id`,
    [`QA-Resolver-2b-${STAMP}`, 'Phase 2b actor-mode create/resolve contract test']
  );
  projectId = r.rows[0].id;
});

afterAll(async () => {
  if (createdActors.length > 0) {
    await db.query('DELETE FROM session_pins WHERE actor = ANY($1::text[])', [createdActors]);
  }
  if (createdSessionIds.length > 0) {
    await db.query('DELETE FROM session_pins WHERE session_id = ANY($1::uuid[])', [createdSessionIds]);
    await db.query('DELETE FROM analytics_events WHERE session_id = ANY($1::uuid[])', [createdSessionIds]);
    await db.query('DELETE FROM sessions WHERE id = ANY($1::uuid[])', [createdSessionIds]);
  }
  await db.query('DELETE FROM sessions WHERE project_id = $1', [projectId]);
  await db.query('DELETE FROM projects WHERE id = $1', [projectId]);
});

// ── D1: anonymous normalization → N anonymous actions share ONE session ─────────────────
describe('D1 — anonymous callers share ONE session (normalize before the resolver)', () => {
  test('N actorless ensureSessionForActor calls resolve to a single anonymous session', async () => {
    SESSION_CONFIG.resolverMode = 'actor';
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      // No actor + a DIFFERENT connection each time — legacy would mint 5; actor mode
      // normalizes to ACTOR_ANONYMOUS and shares ONE session via the resolver's newest-open
      // step. (Since an earlier change anonymous classifies 'agent', so that newest-open lookup is
      // NOT day-restricted — the sharing holds regardless of the UTC day boundary.)
      const id = await SessionLifecycleService.ensureSessionForActor({
        actor: undefined,
        connectionId: `anon-conn-${i}-${STAMP}`,
        projectId,
        creationReason: 'automatic-write',
      });
      track(id);
      ids.push(id);
    }
    const distinct = new Set(ids);
    expect(distinct.size).toBe(1); // ONE session, not five
    const row = await db.query('SELECT actor FROM sessions WHERE id = $1', [ids[0]]);
    expect(row.rows[0].actor).toBe(ACTOR_ANONYMOUS);
  });
});

// ── B: advisory-locked get-or-create ────────────────────────────────────────────────────
describe('B — advisory-locked actor create (connection_id NULL)', () => {
  test('two DIFFERENT actors on the SAME connection each get their OWN session (no unique-index violation)', async () => {
    SESSION_CONFIG.resolverMode = 'actor';
    const conn = `shared-conn-${STAMP}`;
    const actorX = `two-x-${STAMP}`;
    const actorY = `two-y-${STAMP}`;
    createdActors.push(actorX, actorY);

    const idX = track(await SessionLifecycleService.ensureSessionForActor({ actor: actorX, connectionId: conn, projectId , creationReason: 'automatic-write' }));
    const idY = track(await SessionLifecycleService.ensureSessionForActor({ actor: actorY, connectionId: conn, projectId , creationReason: 'automatic-write' }));

    expect(idX).not.toBe(idY);
    const rows = await db.query(
      'SELECT id, actor, connection_id, created_via_connection FROM sessions WHERE id = ANY($1::uuid[]) ORDER BY actor',
      [[idX, idY]]
    );
    // Both rows: connection_id NULL (sidesteps the partial unique index), telemetry preserved.
    for (const r of rows.rows) {
      expect(r.connection_id).toBeNull();
      expect(r.created_via_connection).toBe(conn);
    }
  });

  test('concurrent same-actor creates converge on ONE session (advisory lock + double-check)', async () => {
    SESSION_CONFIG.resolverMode = 'actor';
    const actor = `concurrent-${STAMP}`;
    createdActors.push(actor);

    // Fire many creates in parallel on distinct connections — all resolve nothing first
    // (brand-new actor), race into createForActorLocked; the advisory lock + double-check must
    // yield exactly one row.
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        SessionLifecycleService.ensureSessionForActor({ actor, connectionId: `cc-${i}-${STAMP}`, projectId, creationReason: 'automatic-write' })
      )
    );
    results.forEach(track);
    expect(new Set(results).size).toBe(1);

    const count = await db.query(
      `SELECT count(*)::int AS n FROM sessions WHERE actor = $1 AND ended_at IS NULL`,
      [actor]
    );
    expect(count.rows[0].n).toBe(1);
  });
});

// ── D2: resolved 'interrupted' session is reactivated by the gate ───────────────────────
describe('D2 — a resolved interrupted session is reactivated to active', () => {
  test('ensureSessionForActor flips an interrupted session back to active', async () => {
    SESSION_CONFIG.resolverMode = 'actor';
    const actor = `react-${STAMP}`;
    createdActors.push(actor);

    const first = track(await SessionLifecycleService.ensureSessionForActor({ actor, connectionId: `react-c1-${STAMP}`, projectId, creationReason: 'automatic-write' }));
    // Park it interrupted (as a graceful shutdown would) + wipe RAM (as a restart would).
    await db.query(`UPDATE sessions SET status = 'interrupted' WHERE id = $1`, [first]);
    ActiveSessionStore.clearAll();

    const again = await SessionLifecycleService.ensureSessionForActor({ actor, connectionId: `react-c2-${STAMP}`, projectId, creationReason: 'automatic-write' });
    expect(again).toBe(first); // resolved via newest-open (interrupted counts as open)

    const row = await db.query('SELECT status FROM sessions WHERE id = $1', [first]);
    expect(row.rows[0].status).toBe('active'); // reactivated
  });
});

// ── A: getActiveSession DB-miss routes through resolveSession(actor) ─────────────────────
describe('A — restart-resume in actor mode (getActiveSession + session_status)', () => {
  test('after a RAM wipe, getActiveSession(conn,{actor}) resolves the actor session (not connection)', async () => {
    SESSION_CONFIG.resolverMode = 'actor';
    const actor = `resume-${STAMP}`;
    createdActors.push(actor);
    const sid = track(await SessionLifecycleService.ensureSessionForActor({ actor, connectionId: `resume-c-${STAMP}`, projectId, creationReason: 'automatic-write' }));

    // Simulate a server restart: RAM wiped, so the row (connection_id NULL) is unmatchable by
    // findReattachable. A DIFFERENT connection id proves resolution is by ACTOR, not connection.
    ActiveSessionStore.clearAll();
    const resolved = await SessionTracker.getActiveSession(`some-other-conn-${STAMP}`, { actor });
    expect(resolved).toBe(sid);
  });

  test('session_status finds the actor session after a RAM wipe (end-to-end)', async () => {
    SESSION_CONFIG.resolverMode = 'actor';
    const actor = `status-${STAMP}`;
    createdActors.push(actor);
    const sid = track(await SessionLifecycleService.ensureSessionForActor({ actor, connectionId: `status-c-${STAMP}`, projectId, creationReason: 'automatic-write' }));

    ActiveSessionStore.clearAll(); // restart
    const resp = await sessionRoutes.handleStatus({}, { connectionId: `status-other-${STAMP}`, actor });
    expect(resp.structuredContent?.active).toBe(true);
    expect(resp.structuredContent?.session?.id).toBe(sid);
  });

  test('legacy mode: the same RAM-wipe scenario finds NOTHING (branch is INERT)', async () => {
    // Build the actor session in actor mode, then flip to legacy and prove the actor branch is
    // gated — legacy resolution is connection-keyed and cannot match a NULL-connection row.
    SESSION_CONFIG.resolverMode = 'actor';
    const actor = `legacy-inert-${STAMP}`;
    createdActors.push(actor);
    track(await SessionLifecycleService.ensureSessionForActor({ actor, connectionId: `li-c-${STAMP}`, projectId, creationReason: 'automatic-write' }));
    ActiveSessionStore.clearAll();

    SESSION_CONFIG.resolverMode = 'legacy';
    const resolved = await SessionTracker.getActiveSession(`li-other-${STAMP}`, { actor });
    expect(resolved).toBeNull(); // legacy never routes through the actor resolver
  });
});

// ── end-to-end: create → resolve(newest-open) → reactivate ──────────────────────────────
describe('actor mode end-to-end — create then resolve then reactivate', () => {
  test('second call resolves the same session (newest-open); no duplicate row', async () => {
    SESSION_CONFIG.resolverMode = 'actor';
    const actor = `e2e-${STAMP}`;
    createdActors.push(actor);

    const a = track(await SessionLifecycleService.ensureSessionForActor({ actor, connectionId: `e2e-1-${STAMP}`, projectId, creationReason: 'automatic-write' }));
    const b = await SessionLifecycleService.ensureSessionForActor({ actor, connectionId: `e2e-2-${STAMP}`, projectId, creationReason: 'automatic-write' });
    expect(b).toBe(a); // resolved, not re-created

    const n = await db.query(`SELECT count(*)::int AS n FROM sessions WHERE actor = $1`, [actor]);
    expect(n.rows[0].n).toBe(1);
  });
});

// ── legacy == pre-2b: create-path column contrast ───────────────────────────────────────
describe('legacy vs actor create — column contract', () => {
  test('actor create → connection_id NULL + created_via_connection set; legacy create → the reverse', async () => {
    // Actor-mode create.
    SESSION_CONFIG.resolverMode = 'actor';
    const actor = `col-actor-${STAMP}`;
    createdActors.push(actor);
    const actorSid = track(await SessionLifecycleService.ensureSessionForActor({ actor, connectionId: `col-conn-${STAMP}`, projectId, creationReason: 'automatic-write' }));
    const aRow = (await db.query('SELECT connection_id, created_via_connection, actor FROM sessions WHERE id = $1', [actorSid])).rows[0];
    expect(aRow.connection_id).toBeNull();
    expect(aRow.created_via_connection).toBe(`col-conn-${STAMP}`);
    expect(aRow.actor).toBe(actor);

    // Legacy create (the untouched startSession path the gate uses in legacy/shadow).
    SESSION_CONFIG.resolverMode = 'legacy';
    const legacyConn = `col-legacy-conn-${STAMP}`;
    const legacySid = track(await SessionTracker.startSession(
      projectId, undefined, undefined, undefined, undefined, undefined, undefined, legacyConn, `col-legacy-${STAMP}`
    ));
    const lRow = (await db.query('SELECT connection_id, created_via_connection FROM sessions WHERE id = $1', [legacySid])).rows[0];
    expect(lRow.connection_id).toBe(legacyConn); // legacy keeps connection_id as the key
    expect(lRow.created_via_connection).toBeNull(); // never written on the legacy path
  });
});
