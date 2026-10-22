/**
 * Sessions Foundation Phase 3 — DORMANT lifecycle contract tests.
 * Drives the REAL SessionTimeoutService dormanter/closer sweeps + the actor-mode
 * lifecycle collapse against a REAL Postgres (disposable CI DB; migration 065 applied).
 * resolverMode is flipped per-test and restored after; the lifecycle windows are mutated on the
 * live SESSION_CONFIG (proving they are CONFIG-driven, not hardcoded) and restored.
 *
 * PROVES (the Phase 3 acceptance set, all load-bearing):
 *   idle→dormant (actor)       — dormanter demotes idle active/interrupted → dormant, ended_at NULL.
 *   dormant re-join (Break-2)  — same actor's next action re-joins the SAME dormant session, active.
 *   dormant→ended + FINALIZE    — closer past hardCap ends WITH productivity + session_end event.
 *   absolute 7d cap             — an active session older than absoluteCap is closed (finalized).
 *   interrupted→dormant collapse— actor-mode graceful shutdown parks 'dormant', not 'interrupted'.
 *   config windows honored      — the dormanter respects SESSION_CONFIG.idleDormantSec.
 *   LEGACY REGRESSION           — in legacy mode the dormanter/closer are INERT and the legacy
 *                                 idle==end reaper still terminalizes (status='inactive'+ended_at);
 *                                 no session ever becomes 'dormant'.
 */

import { describe, test, expect, afterAll, beforeAll, afterEach } from 'vitest';

import { db } from '../config/database.js';
import { SessionTimeoutService } from '../services/sessionTimeout.js';
import { SessionLifecycleService } from '../services/session/domain/lifecycle/SessionLifecycleService.js';
import { SessionTracker } from '../services/session/SessionTracker.js';
import { ActiveSessionStore } from '../services/session/state/ActiveSessionStore.js';
import { SESSION_CONFIG } from '../config/sessionConfig.js';

const STAMP = Date.now();
let projectId: string;
const createdSessionIds: string[] = [];
const createdActors: string[] = [];

function track(id: string): string {
  if (!createdSessionIds.includes(id)) createdSessionIds.push(id);
  return id;
}

/** Backdate a session's last_activity_at (and optionally started_at) by N seconds. */
async function backdate(sessionId: string, activityAgeSec: number, startedAgeSec?: number): Promise<void> {
  await db.query(
    `UPDATE sessions
       SET last_activity_at = CURRENT_TIMESTAMP - ($2 || ' seconds')::interval,
           started_at       = CURRENT_TIMESTAMP - (COALESCE($3, $2) || ' seconds')::interval
     WHERE id = $1`,
    [sessionId, String(activityAgeSec), startedAgeSec !== undefined ? String(startedAgeSec) : null]
  );
}

async function statusOf(sessionId: string): Promise<{ status: string; ended_at: Date | null; productivity_score: number | null }> {
  const r = await db.query('SELECT status, ended_at, productivity_score FROM sessions WHERE id = $1', [sessionId]);
  return r.rows[0];
}

const savedMode = SESSION_CONFIG.resolverMode;
const savedIdleDormant = SESSION_CONFIG.idleDormantSec;
const savedHardCap = SESSION_CONFIG.hardCapSec;
const savedAbsoluteCap = SESSION_CONFIG.absoluteCapSec;

afterEach(() => {
  SESSION_CONFIG.resolverMode = savedMode; // default 'legacy'
  SESSION_CONFIG.idleDormantSec = savedIdleDormant;
  SESSION_CONFIG.hardCapSec = savedHardCap;
  SESSION_CONFIG.absoluteCapSec = savedAbsoluteCap;
  ActiveSessionStore.clearAll();
});

beforeAll(async () => {
  const r = await db.query(
    `INSERT INTO projects (name, description) VALUES ($1, $2) RETURNING id`,
    [`QA-Dormant-P3-${STAMP}`, 'Phase 3 dormant lifecycle contract test']
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
  await db.query('DELETE FROM analytics_events WHERE session_id IN (SELECT id FROM sessions WHERE project_id = $1)', [projectId]);
  await db.query('DELETE FROM sessions WHERE project_id = $1', [projectId]);
  await db.query('DELETE FROM projects WHERE id = $1', [projectId]);
});

// ── idle → dormant (actor) ───────────────────────────────────────────────────────────────
describe('dormanter — idle active/interrupted → dormant (ended_at stays NULL)', () => {
  test('an active session idle past idleDormantSec is marked dormant, not ended', async () => {
    SESSION_CONFIG.resolverMode = 'actor';
    const actor = `dorm-${STAMP}`;
    createdActors.push(actor);
    const sid = track(await SessionLifecycleService.ensureSessionForActor({ actor, connectionId: `dc-${STAMP}`, projectId, creationReason: 'automatic-write' }));

    // Idle for 2h (> default idleDormantSec 3600s).
    await backdate(sid, 7200);
    const dormanted = await SessionTimeoutService.runDormanter();
    expect(dormanted).toBeGreaterThanOrEqual(1);

    const row = await statusOf(sid);
    expect(row.status).toBe('dormant');
    expect(row.ended_at).toBeNull(); // NOT a finalize — resumable
  });
});

// ── dormant re-join (the Break-2 fix) ────────────────────────────────────────────────────
describe('re-join — a dormant session is resumed by the same actor (Break-2 fix)', () => {
  test('next action by the same actor re-joins the SAME dormant session and flips it active', async () => {
    SESSION_CONFIG.resolverMode = 'actor';
    const actor = `rejoin-${STAMP}`;
    createdActors.push(actor);
    const first = track(await SessionLifecycleService.ensureSessionForActor({ actor, connectionId: `rj-c1-${STAMP}`, projectId, creationReason: 'automatic-write' }));

    // Go dormant (idle 2h) + wipe RAM (as a restart / long pause would).
    await backdate(first, 7200);
    await SessionTimeoutService.runDormanter();
    ActiveSessionStore.clearAll();
    expect((await statusOf(first)).status).toBe('dormant');

    // The Break-2 scenario: a >1h pause must NOT split the session. Same actor, DIFFERENT
    // connection → resolves the dormant session (dormant counts as OPEN) and reactivates it.
    const again = await SessionLifecycleService.ensureSessionForActor({ actor, connectionId: `rj-c2-${STAMP}`, projectId, creationReason: 'automatic-write' });
    expect(again).toBe(first); // SAME session — not a new one
    expect((await statusOf(first)).status).toBe('active'); // reactivated

    // And exactly one session exists for the actor (no split).
    const n = await db.query(`SELECT count(*)::int AS n FROM sessions WHERE actor = $1`, [actor]);
    expect(n.rows[0].n).toBe(1);
  });
});

// ── dormant → ended past hardCap, WITH full finalize ─────────────────────────────────────
describe('closer — dormant past hardCap → ended WITH finalize', () => {
  test('a dormant session idle past hardCapSec is finalized (status ended, productivity + session_end event)', async () => {
    SESSION_CONFIG.resolverMode = 'actor';
    const actor = `close-hard-${STAMP}`;
    createdActors.push(actor);
    const sid = track(await SessionLifecycleService.ensureSessionForActor({ actor, connectionId: `chc-${STAMP}`, projectId, creationReason: 'automatic-write' }));

    // Make it dormant and idle for 25h (> default hardCapSec 18000s = 5h), started 25h ago
    // (< 7d absolute cap, so this closes via the HARD cap, not the absolute one).
    await db.query(`UPDATE sessions SET status = 'dormant' WHERE id = $1`, [sid]);
    await backdate(sid, 90000, 90000);

    const closed = await SessionTimeoutService.runCloser();
    expect(closed).toBeGreaterThanOrEqual(1);

    const row = await statusOf(sid);
    expect(row.status).toBe('ended');       // A2: finish() terminalizes status
    expect(row.ended_at).not.toBeNull();     // finalized
    expect(row.productivity_score).not.toBeNull(); // productivity score computed (finalize ran)

    // session_end analytics event was emitted (the finalize path, not a bare SQL UPDATE).
    const ev = await db.query(
      `SELECT count(*)::int AS n FROM analytics_events WHERE session_id = $1 AND event_type = 'session_end'`,
      [sid]
    );
    expect(ev.rows[0].n).toBeGreaterThanOrEqual(1);
  });
});

// ── absolute 7d cap ──────────────────────────────────────────────────────────────────────
describe('closer — absolute cap backstop (since started_at)', () => {
  test('an ACTIVE session started past absoluteCapSec is closed even with recent activity', async () => {
    SESSION_CONFIG.resolverMode = 'actor';
    const actor = `close-abs-${STAMP}`;
    createdActors.push(actor);
    const sid = track(await SessionLifecycleService.ensureSessionForActor({ actor, connectionId: `cac-${STAMP}`, projectId, creationReason: 'automatic-write' }));

    // Started 8 days ago (> default absoluteCapSec 604800s = 7d) but active with RECENT activity
    // (60s ago) — so ONLY the absolute cap can catch it (hardCap needs status=dormant + old idle).
    await backdate(sid, 60, 8 * 86400);
    expect((await statusOf(sid)).status).toBe('active'); // still active before the sweep

    const closed = await SessionTimeoutService.runCloser();
    expect(closed).toBeGreaterThanOrEqual(1);

    const row = await statusOf(sid);
    expect(row.status).toBe('ended');
    expect(row.ended_at).not.toBeNull();
  });
});

// ── interrupted → dormant collapse (actor mode) ──────────────────────────────────────────
describe('collapse — actor-mode graceful shutdown parks dormant, not interrupted', () => {
  test('markAllInterrupted parks open sessions as dormant in actor mode', async () => {
    SESSION_CONFIG.resolverMode = 'actor';
    const actor = `collapse-${STAMP}`;
    createdActors.push(actor);
    const sid = track(await SessionLifecycleService.ensureSessionForActor({ actor, connectionId: `cl-${STAMP}`, projectId, creationReason: 'automatic-write' }));
    expect((await statusOf(sid)).status).toBe('active');

    await SessionTracker.markAllInterrupted(); // the shutdown path
    const row = await statusOf(sid);
    expect(row.status).toBe('dormant');  // collapsed to dormant (not 'interrupted')
    expect(row.ended_at).toBeNull();      // resumable
  });
});

// ── config windows honored from config ───────────────────────────────────────────────────
describe('config — the dormanter honors SESSION_CONFIG.idleDormantSec (not hardcoded)', () => {
  test('a session idle 2h is NOT dormanted when idleDormantSec is raised above its idle', async () => {
    SESSION_CONFIG.resolverMode = 'actor';
    const actor = `cfg-${STAMP}`;
    createdActors.push(actor);
    const sid = track(await SessionLifecycleService.ensureSessionForActor({ actor, connectionId: `cfgc-${STAMP}`, projectId, creationReason: 'automatic-write' }));
    await backdate(sid, 7200); // idle 2h

    // Window raised to 10h → 2h-idle session must NOT be demoted (proves the window drives it).
    SESSION_CONFIG.idleDormantSec = 36000;
    await SessionTimeoutService.runDormanter();
    expect((await statusOf(sid)).status).toBe('active'); // untouched — window not reached

    // Lower the window under its idle → now it IS demoted.
    SESSION_CONFIG.idleDormantSec = 60;
    await SessionTimeoutService.runDormanter();
    expect((await statusOf(sid)).status).toBe('dormant');
  });
});

// ── LEGACY REGRESSION — the dormant sweeps are INERT, the idle==end reaper is UNCHANGED ───
describe('legacy regression — actor sweeps inert + legacy idle==end reaper unchanged', () => {
  test('in legacy mode, runDormanter/runCloser do NOT touch a session that would qualify in actor mode', async () => {
    // Build the session in ACTOR mode so ensureSessionForActor is available, then flip to legacy.
    SESSION_CONFIG.resolverMode = 'actor';
    const actor = `legacy-inert-${STAMP}`;
    createdActors.push(actor);
    const sid = track(await SessionLifecycleService.ensureSessionForActor({ actor, connectionId: `lic-${STAMP}`, projectId, creationReason: 'automatic-write' }));
    await backdate(sid, 8 * 86400, 8 * 86400); // idle 8d + started 8d ago — would close in actor mode

    SESSION_CONFIG.resolverMode = 'legacy';
    const dormanted = await SessionTimeoutService.runDormanter();
    const closed = await SessionTimeoutService.runCloser();
    expect(dormanted).toBe(0); // self-gated inert
    expect(closed).toBe(0);    // self-gated inert

    const row = await statusOf(sid);
    expect(row.status).toBe('active');  // never demoted / finalized by the actor sweeps
    expect(row.ended_at).toBeNull();
    expect(row.status).not.toBe('dormant'); // legacy never produces 'dormant'
  });

  test('the legacy idle==end reaper still terminalizes an idle session (status inactive + ended_at)', async () => {
    SESSION_CONFIG.resolverMode = 'legacy';
    // Create via the legacy startSession path (connection-keyed).
    const sid = track(await SessionTracker.startSession(
      projectId, undefined, undefined, undefined, undefined, undefined, undefined, `legacy-reap-${STAMP}`, `legacy-reap-title-${STAMP}`
    ));
    await backdate(sid, 2 * 3600); // idle 2h (> default idleTimeoutSec 3600s)

    // manualCheck() runs the SAME timeout_inactive_sessions path as the periodic legacy reaper.
    const reaped = await SessionTimeoutService.manualCheck();
    expect(reaped).toBeGreaterThanOrEqual(1);

    const row = await statusOf(sid);
    expect(row.status).toBe('inactive'); // legacy shape: idle == end, status 'inactive'
    expect(row.ended_at).not.toBeNull(); // ended_at stamped (unchanged legacy behavior)
  });
});
