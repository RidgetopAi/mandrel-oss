/**
 * SESSION BOUNDARY — the UTC-day crossing, against a REAL Postgres (an earlier decision
 * / ref:session-boundary). The DB half of the contract asserted purely in
 * sessionBoundary.unit.test.ts.
 *
 * THE BUG THIS LOCKS OUT: `anonymous` used to classify `automation`, which triggers the
 * same-UTC-day rollover — so an unconfigured CUSTOMER (for whom `anonymous` is their own agent
 * doing interactive work) had their session SPLIT at 00:00 UTC = 8pm EST, mid-work. Interactive
 * is now the DEFAULT; automation is the ENUMERATED opt-in.
 *
 * PROVES (real SQL, real rows):
 *   (a) an INTERACTIVE actor with an open session started YESTERDAY re-joins that SAME session
 *       across the UTC boundary — one sitting stays one session;
 *   (b) an ENUMERATED AUTOMATION actor with the identical yesterday row does NOT re-join it and
 *       mints a fresh one — the day-roll tick/cron/deploy-smoke depend on is intact;
 *   (c) (a) and (b) differ ONLY by classification — same planted row shape, same code path.
 *
 * ISOLATION (same rationale as sessionTickDailyRollover.contract.test.ts): SessionRepo's
 * actor lookups are ACTOR-scoped, not project-scoped, so asserting on the LITERAL `anonymous`
 * actor would race every other suite that creates anonymous rows in the shared disposable DB.
 * Instead:
 *   - the interactive actor is a UNIQUE UNREGISTERED name → it classifies via the SAME default
 *     ('agent') the literal `anonymous` now takes, which is precisely the unconfigured-customer
 *     population this change is about;
 *   - the automation actor is a UNIQUE name registered via MANDREL_ACTOR_REGISTRY_EXTRA (read
 *     LIVE by classifyActor), taking the identical automation path as the real `tick`.
 * The literal `anonymous`/`tick` → kind wiring itself is asserted (deterministically, with the
 * REAL classifier) in sessionBoundary.unit.test.ts + actorRegistry.unit.test.ts.
 *
 * UTC boundary is anchored to `date_trunc('day', now() AT TIME ZONE 'UTC')` so the test is
 * deterministic regardless of wall clock (no flake at real midnight).
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

/**
 * UNREGISTERED actors → classify 'agent' via the default kind, exactly as the literal
 * `anonymous` now does. This is the "unconfigured customer" population.
 */
const ACTOR_INTERACTIVE = `custagent-yday-${STAMP}`;
const ACTOR_INTERACTIVE_CMP = `custagent-cmp-${STAMP}`;
/** Registered automation (below) → the tick/cron/deploy-smoke path. */
const ACTOR_AUTOMATION = `tickalike-yday-${STAMP}`;

const AUTOMATION_ACTORS = [ACTOR_AUTOMATION];
const ALL_ACTORS = [ACTOR_INTERACTIVE, ACTOR_INTERACTIVE_CMP, ACTOR_AUTOMATION];

/** One second BEFORE today's 00:00 UTC → unambiguously "yesterday", whatever the wall clock. */
const YESTERDAY_SQL = `((date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC') - interval '1 second')`;

let projectId: string;
const createdSessionIds: string[] = [];
let savedRegistryExtra: string | undefined;

function track(id: string): string {
  if (!createdSessionIds.includes(id)) createdSessionIds.push(id);
  return id;
}

/** Plant an OPEN session for `actor` with an explicit started_at/last_activity_at. */
async function insertOpenSession(actor: string, startedAtSql: string): Promise<string> {
  const r = await db.query(
    `INSERT INTO sessions (project_id, agent_type, actor, status, started_at, last_activity_at)
     VALUES ($1, 'agent', $2, 'active', ${startedAtSql}, ${startedAtSql})
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
  // Register ONLY the automation actor as automation; the interactive ones stay unregistered so
  // they exercise the real default-kind path.
  savedRegistryExtra = process.env.MANDREL_ACTOR_REGISTRY_EXTRA;
  const extra = AUTOMATION_ACTORS.map((a) => `${a}:automation`).join(',');
  process.env.MANDREL_ACTOR_REGISTRY_EXTRA = savedRegistryExtra
    ? `${savedRegistryExtra},${extra}`
    : extra;

  const r = await db.query(
    `INSERT INTO projects (name, description) VALUES ($1, $2) RETURNING id`,
    [`QA-SessionBoundary-${STAMP}`, 'be2179a9 — interactive default does not roll at 00:00 UTC']
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
  await db.query('DELETE FROM session_pins WHERE actor = ANY($1::text[])', [ALL_ACTORS]);
  await db.query('DELETE FROM analytics_events WHERE session_id IN (SELECT id FROM sessions WHERE project_id = $1)', [projectId]);
  await db.query('DELETE FROM sessions WHERE project_id = $1', [projectId]);
  await db.query('DELETE FROM projects WHERE id = $1', [projectId]);
  await db.end();
});

// Sanity: the classifications this whole test depends on. If these are wrong, everything below
// would be exercising the wrong code path and silently prove nothing.
describe('classification preconditions', () => {
  test('the unregistered "customer agent" actors classify as agent (the same kind as anonymous)', () => {
    expect(classifyActor(ACTOR_INTERACTIVE)).toBe('agent');
    expect(classifyActor(ACTOR_INTERACTIVE_CMP)).toBe('agent');
    expect(classifyActor('anonymous')).toBe('agent'); // the literal fallback takes this same path
  });

  test('the env-registered actor classifies as automation (the tick path)', () => {
    expect(classifyActor(ACTOR_AUTOMATION)).toBe('automation');
  });
});

// ── (a) interactive: yesterday's session SURVIVES the UTC boundary ──────────────────────
describe('(a) an INTERACTIVE actor does NOT split at 00:00 UTC', () => {
  test('newestOpenForActor(actor, false) returns a YESTERDAY-started open session (it stays a candidate)', async () => {
    const yesterdayId = await insertOpenSession(ACTOR_INTERACTIVE, YESTERDAY_SQL);

    // The interactive view (sameUtcDayOnly=false — what an agent-classified actor gets):
    // yesterday's row IS returned.
    expect(await SessionRepo.newestOpenForActor(ACTOR_INTERACTIVE, false)).toBe(yesterdayId);

    // The automation view of the SAME row excludes it — proving the difference is purely the
    // UTC-day predicate (and therefore purely the classification that selects it).
    expect(await SessionRepo.newestOpenForActor(ACTOR_INTERACTIVE, true)).toBeNull();
  });

  test('a TODAY action re-joins yesterday’s open session — ONE session, not two (the customer-facing fix)', async () => {
    SESSION_CONFIG.resolverMode = 'actor';

    const yesterdayId = await insertOpenSession(ACTOR_INTERACTIVE_CMP, YESTERDAY_SQL);

    // The action gate today, for an interactive actor, must ADOPT yesterday's still-open
    // session rather than mint a new one. This is the 8pm-EST mid-work split, gone.
    const todayId = track(
      await SessionLifecycleService.ensureSessionForActor({
        actor: ACTOR_INTERACTIVE_CMP,
        connectionId: `cust-today-${STAMP}`,
        projectId,
        creationReason: 'automatic-write',
      })
    );

    expect(todayId).toBe(yesterdayId); // SAME session across the UTC boundary

    // And exactly ONE session exists for the actor — no split.
    const n = await db.query(`SELECT count(*)::int AS n FROM sessions WHERE actor = $1`, [
      ACTOR_INTERACTIVE_CMP,
    ]);
    expect(n.rows[0].n).toBe(1);
  });
});

// ── (b) automation: the day-roll is intact ──────────────────────────────────────────────
describe('(b) an ENUMERATED AUTOMATION actor STILL rolls at 00:00 UTC (unchanged)', () => {
  test('a today action does NOT adopt yesterday’s open session — it mints a new one', async () => {
    SESSION_CONFIG.resolverMode = 'actor';

    const yesterdayId = await insertOpenSession(ACTOR_AUTOMATION, YESTERDAY_SQL);

    const todayId = track(
      await SessionLifecycleService.ensureSessionForActor({
        actor: ACTOR_AUTOMATION,
        connectionId: `tickalike-today-${STAMP}`,
        projectId,
        creationReason: 'automatic-write',
      })
    );

    expect(todayId).not.toBe(yesterdayId); // rolled — a fresh session for the new UTC day

    // Yesterday's row is untouched (still open, not adopted); today's started on/after midnight.
    const rows = await db.query(
      `SELECT id::text AS id,
              started_at >= (date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC') AS is_today
         FROM sessions WHERE id = ANY($1::uuid[])`,
      [[yesterdayId, todayId]]
    );
    const byId = new Map(rows.rows.map((r: any) => [r.id, r.is_today]));
    expect(byId.get(yesterdayId)).toBe(false);
    expect(byId.get(todayId)).toBe(true);
  });
});
