/**
 * Sessions Foundation Phase 4 — Break 3 (tick scatter) CORE CONTRACT.
 * Proves the automation-actor "one session per UTC day + deterministic
 * rollover at the UTC day boundary" rule against a REAL Postgres (disposable CI DB).
 *
 * The rule is implemented in TWO lockstep places (both exercised here):
 *   - SessionRepo.newestOpenForActor(actor, sameUtcDayOnly) — the resolver's step (c) read;
 *   - SessionRepo.createForActorLocked's double-check under the advisory lock.
 * SessionLifecycleService.createSessionForActor sets sameUtcDayOnly =
 * (classifyActor(actor) === 'automation'), and the real `tick`/`deploy-smoke` actors classify
 * automation (proven in actorRegistry.unit.test.ts) — so tick gets EXACTLY ONE session per UTC
 * day and rolls a NEW one at 00:00 UTC.
 *
 * ISOLATION: to avoid colliding with the literal `tick`/`deploy-smoke` rows another test (or
 * real data) might create in the shared disposable DB, this test uses UNIQUE per-run actor
 * names and registers them as `automation` via MANDREL_ACTOR_REGISTRY_EXTRA (read LIVE by
 * classifyActor). That exercises the exact same automation-classification → same-UTC-day code
 * path the real tick actor takes.
 *
 * PROVES:
 *   (a) N action-gate ensures for an automation actor on the SAME UTC day → ONE session.
 *   (b) A session started "yesterday" (one second before today's 00:00 UTC) is NOT re-joined:
 *       newestOpenForActor(actor, true) → null, and a today action creates a NEW session (the
 *       rollover). With sameUtcDayOnly=false the SAME yesterday row IS returned — proving the
 *       exclusion is the UTC-day predicate, not openness/actor.
 *   (c) two distinct automation actors (tick-like / deploy-smoke-like) → DIFFERENT sessions
 *       (actor-scoped, never a shared header-less bucket).
 *
 * UTC boundary is anchored to `date_trunc('day', now() AT TIME ZONE 'UTC')` so the test is
 * deterministic regardless of the wall clock (no flake at real midnight).
 *
 * DB target: the disposable CI database (the CI gate / provision-test-db.sh). NEVER prod.
 */

import { describe, test, expect, afterAll, beforeAll, afterEach, vi } from 'vitest';

// Real UUIDs per created session (global setup mocks randomUUID with a counter).
vi.unmock('crypto');
vi.unmock('node:crypto');

import { db } from '../config/database.js';
import { SessionRepo } from '../services/session/infra/db/SessionRepo.js';
import { SessionLifecycleService } from '../services/session/domain/lifecycle/SessionLifecycleService.js';
import { ActiveSessionStore } from '../services/session/state/ActiveSessionStore.js';
import { SESSION_CONFIG } from '../config/sessionConfig.js';
import { classifyActor } from '../config/actorRegistry.js';

const STAMP = Date.now();

// Unique per-run automation actors (registered via env extra below).
const ACTOR_ONEDAY = `tick-oneday-${STAMP}`;
const ACTOR_YDAY = `tick-yday-${STAMP}`;
const ACTOR_ROLL = `tick-roll-${STAMP}`;
const ACTOR_TICK_SEP = `tick-sep-${STAMP}`;
const ACTOR_SMOKE_SEP = `deploy-smoke-sep-${STAMP}`;
const ALL_ACTORS = [ACTOR_ONEDAY, ACTOR_YDAY, ACTOR_ROLL, ACTOR_TICK_SEP, ACTOR_SMOKE_SEP];

let projectId: string;
const createdSessionIds: string[] = [];
let savedRegistryExtra: string | undefined;

function track(id: string): string {
  if (!createdSessionIds.includes(id)) createdSessionIds.push(id);
  return id;
}

/**
 * Insert an OPEN session directly, with an explicit started_at, for `actor`. Used to plant a
 * "yesterday" row deterministically (started_at anchored relative to today's UTC midnight).
 */
async function insertOpenSession(actor: string, startedAtSql: string): Promise<string> {
  const r = await db.query(
    `INSERT INTO sessions (project_id, agent_type, actor, status, started_at, last_activity_at)
     VALUES ($1, 'automation', $2, 'active', ${startedAtSql}, ${startedAtSql})
     RETURNING id`,
    [projectId, actor]
  );
  return track(r.rows[0].id);
}

const savedMode = SESSION_CONFIG.resolverMode;
afterEach(() => {
  SESSION_CONFIG.resolverMode = savedMode; // restore default 'legacy'
  ActiveSessionStore.clearAll();
});

beforeAll(async () => {
  // Register the unique test actors as `automation` (classifyActor reads this env LIVE).
  savedRegistryExtra = process.env.MANDREL_ACTOR_REGISTRY_EXTRA;
  const extra = ALL_ACTORS.map((a) => `${a}:automation`).join(',');
  process.env.MANDREL_ACTOR_REGISTRY_EXTRA = savedRegistryExtra
    ? `${savedRegistryExtra},${extra}`
    : extra;

  const r = await db.query(
    `INSERT INTO projects (name, description) VALUES ($1, $2) RETURNING id`,
    [`QA-TickRollover-${STAMP}`, 'Phase 4 tick one-session-per-UTC-day + rollover contract']
  );
  projectId = r.rows[0].id;
});

afterAll(async () => {
  if (savedRegistryExtra === undefined) delete process.env.MANDREL_ACTOR_REGISTRY_EXTRA;
  else process.env.MANDREL_ACTOR_REGISTRY_EXTRA = savedRegistryExtra;

  if (createdSessionIds.length > 0) {
    await db.query('DELETE FROM session_pins WHERE session_id = ANY($1::uuid[])', [createdSessionIds]);
    await db.query('DELETE FROM analytics_events WHERE session_id = ANY($1::uuid[])', [createdSessionIds]);
    await db.query('DELETE FROM sessions WHERE id = ANY($1::uuid[])', [createdSessionIds]);
  }
  await db.query('DELETE FROM sessions WHERE project_id = $1', [projectId]);
  await db.query('DELETE FROM projects WHERE id = $1', [projectId]);
  await db.end();
});

// Sanity: the env registration made our unique actors classify as automation (the trigger for
// the same-UTC-day rule). If this fails, (a)/(b) below would be testing the wrong code path.
describe('automation classification (env-registered test actors)', () => {
  test('the unique test actors classify as automation', () => {
    for (const a of ALL_ACTORS) expect(classifyActor(a)).toBe('automation');
  });
});

// ── (a) N tick actions same UTC day → ONE session ───────────────────────────────────────
describe('(a) tick — one session per UTC day', () => {
  test('N action-gate ensures for an automation actor on the same UTC day resolve to a SINGLE session', async () => {
    SESSION_CONFIG.resolverMode = 'actor';

    const ids: string[] = [];
    for (let i = 0; i < 6; i++) {
      const id = await SessionLifecycleService.ensureSessionForActor({
        actor: ACTOR_ONEDAY,
        connectionId: `tick-conn-${i}-${STAMP}`, // different physical connection each call
        projectId,
        creationReason: 'automatic-write',
      });
      track(id);
      ids.push(id);
    }
    expect(new Set(ids).size).toBe(1); // one session, not six — scatter is gone

    const count = await db.query(
      `SELECT count(*)::int AS n FROM sessions WHERE actor = $1 AND ended_at IS NULL`,
      [ACTOR_ONEDAY]
    );
    expect(count.rows[0].n).toBe(1);
  });
});

// ── (b) yesterday → today: the UTC rollover ─────────────────────────────────────────────
describe('(b) tick — rolls a NEW session at the UTC day boundary (does NOT re-join yesterday)', () => {
  test('newestOpenForActor: a yesterday-started open session is EXCLUDED under sameUtcDayOnly, INCLUDED without it', async () => {
    // Plant an OPEN session started one second BEFORE today's 00:00 UTC → guaranteed "yesterday"
    // relative to the predicate, regardless of the current wall-clock time.
    const yesterdayId = await insertOpenSession(
      ACTOR_YDAY,
      `((date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC') - interval '1 second')`
    );

    // Automation view (sameUtcDayOnly=true): yesterday's row is NOT a candidate → null.
    expect(await SessionRepo.newestOpenForActor(ACTOR_YDAY, true)).toBeNull();

    // No-day-limit view (sameUtcDayOnly=false): the SAME open row IS returned — proving the
    // exclusion above is the UTC-day predicate, not an openness/actor issue.
    expect(await SessionRepo.newestOpenForActor(ACTOR_YDAY, false)).toBe(yesterdayId);
  });

  test('a today action for an automation actor creates a NEW session and does NOT adopt yesterday’s open one', async () => {
    SESSION_CONFIG.resolverMode = 'actor';

    const yesterdayId = await insertOpenSession(
      ACTOR_ROLL,
      `((date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC') - interval '1 second')`
    );

    // The action gate for the automation actor today must MINT a fresh session (rollover),
    // never re-join yesterday's still-open row.
    const todayId = track(
      await SessionLifecycleService.ensureSessionForActor({
        actor: ACTOR_ROLL,
        connectionId: `tick-today-${STAMP}`,
        projectId,
        creationReason: 'automatic-write',
      })
    );

    expect(todayId).not.toBe(yesterdayId);

    // Today's session started on/after today's UTC midnight; yesterday's row is untouched
    // (still open, not adopted) — the two coexist, distinct.
    const rows = await db.query(
      `SELECT id::text AS id,
              started_at >= (date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC') AS is_today
         FROM sessions WHERE id = ANY($1::uuid[])`,
      [[yesterdayId, todayId]]
    );
    const byId = new Map(rows.rows.map((r: any) => [r.id, r.is_today]));
    expect(byId.get(yesterdayId)).toBe(false);
    expect(byId.get(todayId)).toBe(true);

    // A SECOND today action re-joins today's session (one-per-day still holds post-rollover).
    const todayId2 = track(
      await SessionLifecycleService.ensureSessionForActor({
        actor: ACTOR_ROLL,
        connectionId: `tick-today2-${STAMP}`,
        projectId,
        creationReason: 'automatic-write',
      })
    );
    expect(todayId2).toBe(todayId);
  });
});

// ── (c) tick vs deploy-smoke are separate automation actors ─────────────────────────────
describe('(c) automation actors are actor-scoped (tick ≠ deploy-smoke)', () => {
  test('two distinct automation actors on the same UTC day get DIFFERENT sessions', async () => {
    SESSION_CONFIG.resolverMode = 'actor';

    const tickId = track(
      await SessionLifecycleService.ensureSessionForActor({
        actor: ACTOR_TICK_SEP,
        connectionId: `sep-tick-${STAMP}`,
        projectId,
        creationReason: 'automatic-write',
      })
    );
    const smokeId = track(
      await SessionLifecycleService.ensureSessionForActor({
        actor: ACTOR_SMOKE_SEP,
        connectionId: `sep-smoke-${STAMP}`,
        projectId,
        creationReason: 'automatic-write',
      })
    );

    expect(tickId).not.toBe(smokeId); // never a shared header-less bucket
  });
});
