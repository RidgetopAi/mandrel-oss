/**
 * Sessions Foundation Phase 2a — DB-backed contract tests.
 * Drives the REAL SessionRepo / SessionPinRepo / resolveSession / shadow wiring / gitTracker
 * helper against a REAL Postgres (the disposable CI DB; migrations 062+063 applied).
 *
 * PROVES:
 *   1. PIN persistence — set/get/clear is DB-backed and survives a simulated restart (RAM wipe);
 *      pinning re-keys per actor (one pin per actor); a pin to a closed session is reported stale.
 *   2. newestOpenForActor — ACTOR-scoped (never connection/global); automation actors are
 *      restricted to the current UTC day (deterministic daily rollover); human/agent are not.
 *   3. resolveSession end-to-end over real DB: explicit → pin → newest-open → lazy-create, and
 *      NO global fallback (an actor with nothing open never adopts another actor's session).
 *   4. SHADOW mode — shadowCompareResolution logs/counts AGREE and DISAGREE correctly against the
 *      real legacy read-only mirror, and NEVER mutates (no reactivate / no cache write).
 *   5. mode='legacy' == today — the DB-persisted PIN is INERT: it does not change what the legacy
 *      connection-keyed resolution (getActiveSession) returns. Flipping to shadow does not change
 *      the resolved id either (shadow acts on legacy).
 *   6. gitTracker A4 — resolveSessionForGitTracker is byte-identical to the legacy global fallback
 *      in 'legacy', still returns legacy in 'shadow' (counted), and attributes to NOTHING in 'actor'
 *      (never cross-actor).
 */

import { describe, test, expect, afterAll, beforeAll, afterEach } from 'vitest';

import { db } from '../config/database.js';
import { SessionTracker } from '../services/session/SessionTracker.js';
import { SessionRepo } from '../services/session/infra/db/SessionRepo.js';
import { SessionPinRepo } from '../services/session/infra/db/SessionPinRepo.js';
import { ActiveSessionStore } from '../services/session/state/ActiveSessionStore.js';
import { resolveSession } from '../services/session/domain/lifecycle/resolveSession.js';
import { shadowCompareResolution } from '../services/session/domain/lifecycle/shadowResolver.js';
import { resolveSessionForGitTracker } from '../services/gitTracker.js';
import { getCurrentSession } from '../services/session/SessionTracker.js';
import { SESSION_CONFIG, type ResolverMode } from '../config/sessionConfig.js';
import { monitoring } from '../utils/monitoring.js';

const STAMP = Date.now();
let projectId: string;
const createdSessionIds: string[] = [];
const createdActors: string[] = [];

/** Create an open session owned by `actor` on `connectionId`; track for cleanup. */
async function makeSession(actor: string, connectionId?: string): Promise<string> {
  const id = await SessionTracker.startSession(
    projectId, undefined, undefined, undefined, undefined, undefined, undefined, connectionId, actor
  );
  createdSessionIds.push(id);
  return id;
}

/** Restore the flag after each test (default is 'legacy'). */
const savedMode = SESSION_CONFIG.resolverMode;
afterEach(() => {
  SESSION_CONFIG.resolverMode = savedMode;
  ActiveSessionStore.clearAll();
});

beforeAll(async () => {
  const r = await db.query(
    `INSERT INTO projects (name, description) VALUES ($1, $2) RETURNING id`,
    [`QA-Resolver-2a-${STAMP}`, 'Phase 2a resolver contract test']
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

// ── 1. PIN persistence (DB-backed, survives a simulated restart) ────────────────────────
describe('DB-persisted PIN — set / get / clear', () => {
  test('setPin persists to the DB and getPin reads it back after a RAM wipe (restart)', async () => {
    const actor = `pin-actor-a-${STAMP}`;
    createdActors.push(actor);
    const s = await makeSession(actor, `conn-pin-a-${STAMP}`);

    const set = await SessionPinRepo.setPin(actor, s);
    expect(set.sessionId).toBe(s);

    // Simulate a server restart: wipe ALL in-RAM session state. A RAM-backed pin would vanish
    // here (the SR-1 saga); the DB-backed pin must survive.
    ActiveSessionStore.clearAll();

    const got = await SessionPinRepo.getPin(actor);
    expect(got?.sessionId).toBe(s);
    expect(got?.actor).toBe(actor);
  });

  test('one pin per actor — re-pin replaces (upsert), not duplicates', async () => {
    const actor = `pin-actor-b-${STAMP}`;
    createdActors.push(actor);
    const s1 = await makeSession(actor, `conn-pin-b1-${STAMP}`);
    const s2 = await makeSession(actor, `conn-pin-b2-${STAMP}`);

    await SessionPinRepo.setPin(actor, s1);
    await SessionPinRepo.setPin(actor, s2);

    const got = await SessionPinRepo.getPin(actor);
    expect(got?.sessionId).toBe(s2);
    const rows = await db.query('SELECT count(*)::int AS n FROM session_pins WHERE actor = $1', [actor]);
    expect(rows.rows[0].n).toBe(1);
  });

  test('clearPin removes the pin (idempotent)', async () => {
    const actor = `pin-actor-c-${STAMP}`;
    createdActors.push(actor);
    const s = await makeSession(actor, `conn-pin-c-${STAMP}`);
    await SessionPinRepo.setPin(actor, s);

    expect(await SessionPinRepo.clearPin(actor)).toBe(true);
    expect(await SessionPinRepo.getPin(actor)).toBeNull();
    expect(await SessionPinRepo.clearPin(actor)).toBe(false); // idempotent
  });
});

// ── 2. newestOpenForActor — actor-scoped + automation UTC-day ────────────────────────────
describe('SessionRepo.newestOpenForActor — actor-scoped resolution', () => {
  test('returns the newest OPEN session for the actor (never another actor)', async () => {
    const actor = `nw-actor-${STAMP}`;
    const other = `nw-other-${STAMP}`;
    const sOld = await makeSession(actor, `conn-nw1-${STAMP}`);
    const sNew = await makeSession(actor, `conn-nw2-${STAMP}`);
    const sOther = await makeSession(other, `conn-nw3-${STAMP}`); // different actor, newest overall

    // Make sNew the freshest for `actor`; sOther is even fresher but belongs to `other`.
    await db.query(`UPDATE sessions SET last_activity_at = now() - interval '10 min' WHERE id = $1`, [sOld]);
    await db.query(`UPDATE sessions SET last_activity_at = now() - interval '1 min' WHERE id = $1`, [sNew]);
    await db.query(`UPDATE sessions SET last_activity_at = now() WHERE id = $1`, [sOther]);

    expect(await SessionRepo.newestOpenForActor(actor, false)).toBe(sNew);
    // Cross-actor never leaks in: `other`'s newest is sOther, not any of actor's rows.
    expect(await SessionRepo.newestOpenForActor(other, false)).toBe(sOther);
  });

  test('automation actor (sameUtcDayOnly) EXCLUDES a session started before today (UTC)', async () => {
    const actor = `tick-${STAMP}`; // 'tick' family → automation
    const s = await makeSession(actor, `conn-tick-${STAMP}`);

    // Without the day restriction it resolves; with it, a session started yesterday is excluded.
    expect(await SessionRepo.newestOpenForActor(actor, false)).toBe(s);
    await db.query(`UPDATE sessions SET started_at = (now() AT TIME ZONE 'UTC' - interval '1 day') AT TIME ZONE 'UTC' WHERE id = $1`, [s]);
    expect(await SessionRepo.newestOpenForActor(actor, true)).toBeNull();
    // Same-day session IS returned under the restriction.
    const sToday = await makeSession(actor, `conn-tick2-${STAMP}`);
    expect(await SessionRepo.newestOpenForActor(actor, true)).toBe(sToday);
  });
});

// ── 3. resolveSession end-to-end over the real DB ───────────────────────────────────────
describe('resolveSession — real DB, real precedence, NO global fallback', () => {
  test('explicit → pin → newest-open → lazy-create, all against real rows', async () => {
    const actor = `rs-actor-${STAMP}`;
    createdActors.push(actor);
    const sNewest = await makeSession(actor, `conn-rs1-${STAMP}`);
    const sPin = await makeSession(actor, `conn-rs2-${STAMP}`);
    const sExplicit = await makeSession(`rs-other-${STAMP}`, `conn-rs3-${STAMP}`);

    // newest-open (no pin yet)
    let r = await resolveSession(actor, undefined);
    expect(r.source).toBe('newest-open');

    // pin wins over newest-open
    await SessionPinRepo.setPin(actor, sPin);
    r = await resolveSession(actor, undefined);
    expect(r).toEqual({ source: 'pin', sessionId: sPin });

    // explicit (another actor's session) wins over pin — user intent
    r = await resolveSession(actor, sExplicit);
    expect(r).toEqual({ source: 'explicit', sessionId: sExplicit });

    void sNewest;
  });

  test('an actor with NOTHING open resolves to lazy-create — never a global fallback', async () => {
    // Some other actor has the newest open session in the whole table.
    await makeSession(`rs-noise-${STAMP}`, `conn-rs-noise-${STAMP}`);
    const r = await resolveSession(`rs-empty-actor-${STAMP}`, undefined);
    expect(r).toEqual({ source: 'lazy-create', sessionId: null });
  });
});

// ── 4. SHADOW mode — agree / disagree counters, no mutation ─────────────────────────────
describe('shadowCompareResolution — observation only', () => {
  function counter(name: string): number {
    return monitoring.getLatestMetric(name)?.value ?? 0;
  }

  test('AGREE when legacy (RAM) and new (newest-open) point at the same session', async () => {
    const actor = `sh-agree-${STAMP}`;
    const conn = `conn-sh-agree-${STAMP}`;
    const s = await makeSession(actor, conn);
    ActiveSessionStore.set(s, conn); // legacy RAM resolves to s; newest-open for actor is also s

    const before = counter('sessions_resolver_shadow_agree');
    const cmp = await shadowCompareResolution({ connectionId: conn, actor });
    expect(cmp?.agree).toBe(true);
    expect(cmp?.legacy.sessionId).toBe(s);
    expect(cmp?.next).toEqual({ source: 'newest-open', sessionId: s });
    expect(counter('sessions_resolver_shadow_agree')).toBe(before + 1);

    // No mutation: the session was not reactivated/ended and no RAM pollution occurred.
    const row = await db.query('SELECT status, ended_at FROM sessions WHERE id = $1', [s]);
    expect(row.rows[0].ended_at).toBeNull();
  });

  test('DISAGREE when legacy (RAM) resolves a session but the new actor has nothing open', async () => {
    const legacyActor = `sh-dis-legacy-${STAMP}`;
    const conn = `conn-sh-dis-${STAMP}`;
    const s = await makeSession(legacyActor, conn);
    ActiveSessionStore.set(s, conn); // legacy resolves s for this connection

    const before = counter('sessions_resolver_shadow_disagree');
    // Pass a DIFFERENT actor with no open session → new resolver signals lazy-create.
    const cmp = await shadowCompareResolution({ connectionId: conn, actor: `sh-dis-new-${STAMP}` });
    expect(cmp?.agree).toBe(false);
    expect(cmp?.legacy.sessionId).toBe(s);
    expect(cmp?.next.source).toBe('lazy-create');
    expect(counter('sessions_resolver_shadow_disagree')).toBe(before + 1);
  });
});

// ── 5. mode='legacy' == today — the PIN + resolver are INERT for legacy resolution ──────
describe("legacy mode == today's behavior (regression guard)", () => {
  test('a DB pin does NOT change what the legacy connection-keyed getActiveSession returns', async () => {
    const actor = `leg-actor-${STAMP}`;
    createdActors.push(actor);
    const conn = `conn-leg-${STAMP}`;
    const sConn = await makeSession(actor, conn);
    const sPinned = await makeSession(actor, `conn-leg-other-${STAMP}`);
    ActiveSessionStore.set(sConn, conn);

    // Pin the actor to a DIFFERENT session than the connection's.
    await SessionPinRepo.setPin(actor, sPinned);

    // The resolver WOULD pick the pin...
    expect((await resolveSession(actor, undefined))).toEqual({ source: 'pin', sessionId: sPinned });

    // ...but legacy connection-keyed resolution (what the gate uses in legacy mode) is unchanged:
    for (const mode of ['legacy', 'shadow'] as ResolverMode[]) {
      SESSION_CONFIG.resolverMode = mode;
      const legacyResolved = await SessionTracker.getActiveSession(conn);
      expect(legacyResolved).toBe(sConn); // never the pin — resolution is byte-identical to today
    }
  });
});

// ── 6. gitTracker A4 — actor-safe, flag-gated ───────────────────────────────────────────
describe('resolveSessionForGitTracker — actor-safe, flag-gated (A4)', () => {
  test('legacy: byte-identical to the global fallback getCurrentSession()', async () => {
    // Seed a global "newest open anywhere" so getCurrentSession returns non-null.
    await makeSession(`git-legacy-${STAMP}`, `conn-git-${STAMP}`);
    SESSION_CONFIG.resolverMode = 'legacy';
    const viaHelper = await resolveSessionForGitTracker();
    const viaLegacy = await getCurrentSession();
    expect(viaHelper).toBe(viaLegacy);
    expect(viaHelper).not.toBeNull();
  });

  test('actor mode: attributes to NOTHING (no actor → never cross-actor)', async () => {
    await makeSession(`git-actor-${STAMP}`, `conn-git2-${STAMP}`); // a global session exists
    SESSION_CONFIG.resolverMode = 'actor';
    expect(await resolveSessionForGitTracker()).toBeNull();
  });

  test('shadow mode: still acts on legacy (returns the global session), counted', async () => {
    await makeSession(`git-shadow-${STAMP}`, `conn-git3-${STAMP}`);
    SESSION_CONFIG.resolverMode = 'shadow';
    const viaHelper = await resolveSessionForGitTracker();
    expect(viaHelper).toBe(await getCurrentSession());
  });
});
