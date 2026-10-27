/**
 * SESSION BOUNDARY — the "a session ends when you stop working" contract
 * (an earlier decision / ref:session-boundary). NO DB, NO network — pure config + the resolver's
 * day-rule branch driven by the REAL actorRegistry classifier.
 *
 * WHAT THIS LOCKS (the two values this change turns on, and the reasoning behind them):
 *   1. hardCapSec DEFAULT = 18000 (5h), still env-overridable — the total-inactivity boundary
 *      ("dormant at 1h + 4h more"), replacing the old 24h that welded two sittings together.
 *   2. `anonymous` is INTERACTIVE (agent) → its newest-open lookup is NOT day-restricted, so an
 *      unconfigured caller's session SURVIVES 00:00 UTC. Enumerated automation (tick / cron /
 *      deploy-smoke) KEEPS the same-UTC-day rollover — that is their only boundary.
 *   3. Every threshold reaches the sweep as a CONFIG-DERIVED bind param — no hardcoded duration
 *      in the SQL path (configs-not-hardcoded).
 *
 * WHY THE LITERAL ACTORS ARE PROVEN HERE (and not against the DB): SessionRepo.newestOpenForActor
 * is ACTOR-scoped, not project-scoped, so a real-DB assertion on the literal `anonymous`/`tick`
 * rows would race every other suite that creates them in the shared disposable DB (the same
 * hazard sessionTickDailyRollover.contract.test.ts documents and dodges with unique per-run
 * actors). Here the classifier is REAL and only the DB ports are stubbed — so the literal
 * `anonymous`→no-day-limit and literal `tick`→day-limit wiring is asserted with zero flake. The
 * real-SQL half (that the day predicate genuinely includes/excludes a yesterday row) is covered
 * by sessionTickDailyRollover.contract + sessionBoundaryUtcRollover.contract.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { classifyActor } from '../config/actorRegistry.js';
import {
  resolveSession,
  type ResolveSessionPorts,
} from '../services/session/domain/lifecycle/resolveSession.js';

const HARD_CAP_KEY = 'MANDREL_SESSION_HARD_CAP_SEC';

/** Re-import sessionConfig fresh under `value` (the knob is read once at module load). */
async function loadHardCap(value: string | undefined): Promise<number> {
  vi.resetModules();
  const saved = process.env[HARD_CAP_KEY];
  if (value === undefined) delete process.env[HARD_CAP_KEY];
  else process.env[HARD_CAP_KEY] = value;
  try {
    const mod = await import('../config/sessionConfig.js');
    return mod.SESSION_CONFIG.hardCapSec;
  } finally {
    if (saved === undefined) delete process.env[HARD_CAP_KEY];
    else process.env[HARD_CAP_KEY] = saved;
  }
}

afterEach(() => {
  vi.resetModules();
});

// ── 1. The 5h boundary ──────────────────────────────────────────────────────────────────
describe('SESSION_CONFIG.hardCapSec — the 5h total-inactivity boundary', () => {
  it('DEFAULTS to 18000 (5h) — a sitting ends when you stop working, not on the calendar', async () => {
    expect(await loadHardCap(undefined)).toBe(18000);
  });

  it('is NOT the old 24h default (regression guard for an earlier decision)', async () => {
    expect(await loadHardCap(undefined)).not.toBe(86400);
  });

  it('is still overridable via MANDREL_SESSION_HARD_CAP_SEC (configs-not-hardcoded)', async () => {
    expect(await loadHardCap('900')).toBe(900);
    expect(await loadHardCap('86400')).toBe(86400); // an operator can still choose the old value
  });

  it('falls back to the 18000 default on garbage/empty (fail safe, never a surprise window)', async () => {
    for (const v of ['bogus', '', '-1', '0', '1.5']) {
      expect(await loadHardCap(v)).toBe(18000);
    }
  });

  it('stays ORDERED against the other lifecycle windows: idleDormant < hardCap < absoluteCap', async () => {
    vi.resetModules();
    const { SESSION_CONFIG } = await import('../config/sessionConfig.js');
    // The model is dormant-then-close: dormancy must precede the close, and the absolute
    // backstop must outlive both, or the lifecycle is incoherent.
    expect(SESSION_CONFIG.idleDormantSec).toBeLessThan(SESSION_CONFIG.hardCapSec);
    expect(SESSION_CONFIG.hardCapSec).toBeLessThan(SESSION_CONFIG.absoluteCapSec);
  });
});

// ── 3. Thresholds reach the SQL as config-derived bind params ───────────────────────────
describe('lifecycle thresholds are CONFIG-DRIVEN into the sweep/SQL path (no hardcoded durations)', () => {
  it('the INTERVAL literals are derived from SESSION_CONFIG, not baked in', async () => {
    vi.resetModules();
    const { SESSION_CONFIG, hardCapInterval, absoluteCapInterval, idleDormantInterval } =
      await import('../config/sessionConfig.js');

    // Shipped defaults reach SQL as the configured seconds.
    expect(hardCapInterval()).toBe('18000 seconds');

    // And they TRACK the config: mutate it and the interval follows (proving the helper reads
    // config at call time rather than embedding a constant).
    const saved = SESSION_CONFIG.hardCapSec;
    try {
      SESSION_CONFIG.hardCapSec = 4242;
      expect(hardCapInterval()).toBe('4242 seconds');
    } finally {
      SESSION_CONFIG.hardCapSec = saved;
    }

    expect(absoluteCapInterval()).toBe(`${SESSION_CONFIG.absoluteCapSec} seconds`);
    expect(idleDormantInterval()).toBe(`${SESSION_CONFIG.idleDormantSec} seconds`);
  });

  it('runCloser passes the CONFIG-derived caps to find_sessions_to_close as bind params', async () => {
    vi.resetModules();

    // Stub the DB + the finalize path: we are asserting the ARGUMENTS the sweep sends, not SQL
    // execution (the real-SQL behavior is covered by sessionDormantLifecycle.contract).
    const query = vi.fn(async () => ({ rows: [] as unknown[] }));
    vi.doMock('../config/database.js', () => ({ db: { query } }));

    const { SESSION_CONFIG } = await import('../config/sessionConfig.js');
    const { SessionTimeoutService } = await import('../services/sessionTimeout.js');

    const savedMode = SESSION_CONFIG.resolverMode;
    const savedHardCap = SESSION_CONFIG.hardCapSec;
    try {
      SESSION_CONFIG.resolverMode = 'actor'; // the closer is self-gated on actor mode
      SESSION_CONFIG.hardCapSec = 18000;
      await SessionTimeoutService.runCloser();

      // ASSERT ON THE CALL THAT MATTERS, NOT ON THE TOTAL CALL COUNT.
      //
      // `vi.doMock('../config/database.js')` replaces that module for the WHOLE registry, so
      // this spy sees every db.query any module in the graph makes — not just runCloser's.
      // One of them WAS a BACKGROUND TIMER: utils/monitoring.ts started a 60s health-check
      // interval as an IMPORT-TIME side effect, it was never cleared, and its callback did
      // `const { db } = await import('../config/database.js'); await db.query('SELECT 1')`.
      // `../services/sessionTimeout.js` imports it transitively (via SessionLifecycleService),
      // so that tick resolved the MOCKED module and landed on this spy. an earlier Task and
      // an earlier change made that start explicit, so that particular tick is gone — but the reasoning
      // below is why this assertion is shaped the way it is, and it holds against ANY other
      // module in a registry-wide mock's graph, which is the general case.
      //
      // MEASURED, deterministically: mock this module, import sessionTimeout in a fresh
      // registry, advance fake timers 60s -> the spy records exactly `["SELECT 1"]`. In a real
      // run the tick fires on wall-clock time unrelated to this test, so it only occasionally
      // lands inside the few milliseconds of the `await` above — which is precisely the
      // "expected spy to be called 1 times, but got 2 times" flake this line produced: 2 REDs
      // in 21 clean-gate runs (2026-08-01/02) plus 1 in 20 locally, on healthy code.
      //
      // THIS IS NOT A LOOSENED CHECK. The contract in this test's own name is "runCloser passes
      // the CONFIG-derived caps to find_sessions_to_close as bind params". A total-call count
      // asserts something else entirely — that nothing else in the process touches the database
      // — which was never intended, is not this test's business, and is unfalsifiable against
      // background noise. Selecting the sweep's own call and requiring EXACTLY ONE of them keeps
      // everything the contract needs, including "runCloser did not issue the sweep twice".
      const sweepCalls = query.mock.calls.filter((c) =>
        String((c as unknown as [string])[0]).includes('find_sessions_to_close')
      );
      expect(sweepCalls).toHaveLength(1);
      const [sql, params] = sweepCalls[0] as unknown as [string, unknown[]];

      // The caps arrive as PARAMS ($1/$2), so no duration is embedded in the statement text.
      expect(params).toEqual(['18000 seconds', `${SESSION_CONFIG.absoluteCapSec} seconds`]);
      expect(sql).toContain('find_sessions_to_close');
      expect(sql).not.toMatch(/\d+\s*(seconds|hours|days)/i); // no literal interval in the SQL
    } finally {
      SESSION_CONFIG.resolverMode = savedMode;
      SESSION_CONFIG.hardCapSec = savedHardCap;
      vi.doUnmock('../config/database.js');
    }
  });
});

// ── 2. The day-rule, driven by the REAL classifier ──────────────────────────────────────
/**
 * Ports whose `classify` is the REAL actorRegistry classifier — so these tests exercise the
 * genuine literal-actor → day-rule wiring. Only the DB reads are stubbed.
 */
function makeRealClassifyPorts(overrides: Partial<ResolveSessionPorts> = {}): ResolveSessionPorts {
  return {
    existsActive: vi.fn(async () => false),
    getPin: vi.fn(async () => null),
    newestOpenForActor: vi.fn(async () => null),
    classify: (actor) => classifyActor(actor), // REAL — not a stub
    ...overrides,
  };
}

const SID_YESTERDAY = '44444444-4444-4444-4444-444444444444';

describe('anonymous (the unconfigured customer) does NOT roll at the UTC day boundary', () => {
  /**
   * THE BEHAVIOR OPERATOR CARES ABOUT MOST. An unconfigured tenant caller mid-work at 8pm EST
   * (= 00:00 UTC) must keep ONE session. `sameUtcDayOnly=false` is exactly "yesterday's open
   * session is still a candidate" — proven against real SQL in sessionBoundaryUtcRollover.contract.
   */
  it('an anonymous actor with an open session started YESTERDAY resolves to that SAME session', async () => {
    const newestOpenForActor = vi.fn(async () => SID_YESTERDAY); // the yesterday-started row
    const ports = makeRealClassifyPorts({ newestOpenForActor });

    const r = await resolveSession('anonymous', undefined, ports);

    // The session is RE-JOINED, not split — no new session, no lazy-create.
    expect(r).toEqual({ source: 'newest-open', sessionId: SID_YESTERDAY });
    // …because the lookup was NOT restricted to today (the day boundary is not applied).
    expect(newestOpenForActor).toHaveBeenCalledWith('anonymous', false);
  });

  it('a header-LESS caller (no actor at all) normalizes to anonymous and likewise does not day-roll', async () => {
    const newestOpenForActor = vi.fn(async () => SID_YESTERDAY);
    const ports = makeRealClassifyPorts({ newestOpenForActor });

    // resolveSession only reaches the actor-scoped steps with a derivable actor; the gate stamps
    // ACTOR_ANONYMOUS, which is what a header-less tenant caller resolves as.
    await resolveSession('  ANONYMOUS  ', undefined, ports); // raw/odd-cased → normalized
    expect(newestOpenForActor).toHaveBeenCalledWith('anonymous', false);
  });

  it('an unknown/unregistered actor (a customer’s own agent name) also does not day-roll', async () => {
    const newestOpenForActor = vi.fn(async () => SID_YESTERDAY);
    const ports = makeRealClassifyPorts({ newestOpenForActor });

    await resolveSession('some-customers-bot', undefined, ports);
    // Agrees with the anonymous path above — the two classify identically (no drift).
    expect(newestOpenForActor).toHaveBeenCalledWith('some-customers-bot', false);
  });
});

describe('enumerated automation STILL rolls at the UTC day boundary (unchanged)', () => {
  /**
   * tick/cron/deploy-smoke run hourly and never go 5h idle, so the idle closer would never fire
   * on them — the day-roll is their ONLY boundary. This change must not touch that.
   */
  it.each(['tick', 'cron', 'deploy-smoke'])(
    '%s queries newest-open with sameUtcDayOnly=TRUE (day-roll preserved)',
    async (actor) => {
      const newestOpenForActor = vi.fn(async () => null);
      const ports = makeRealClassifyPorts({ newestOpenForActor });

      await resolveSession(actor, undefined, ports);
      expect(newestOpenForActor).toHaveBeenCalledWith(actor, true);
    }
  );

  it('tick with ONLY a yesterday-started open session does NOT resolve it — a new one is signalled', async () => {
    // The DB honors the same-UTC-day predicate: yesterday's row is not a candidate → null.
    const newestOpenForActor = vi.fn(async (_actor: string, sameUtcDayOnly: boolean) =>
      sameUtcDayOnly ? null : SID_YESTERDAY
    );
    const ports = makeRealClassifyPorts({ newestOpenForActor });

    const r = await resolveSession('tick', undefined, ports);

    // lazy-create = "the gate mints today's tick session" — the rollover.
    expect(r).toEqual({ source: 'lazy-create', sessionId: null });
    expect(newestOpenForActor).toHaveBeenCalledWith('tick', true);
  });

  it('the SAME yesterday row WOULD have resolved for an anonymous actor — the ONLY difference is the day rule', async () => {
    // Same ports, same planted row: tick → lazy-create (above), anonymous → re-join. This
    // isolates the classification as the single variable driving the split.
    const newestOpenForActor = vi.fn(async (_actor: string, sameUtcDayOnly: boolean) =>
      sameUtcDayOnly ? null : SID_YESTERDAY
    );
    const ports = makeRealClassifyPorts({ newestOpenForActor });

    const r = await resolveSession('anonymous', undefined, ports);
    expect(r).toEqual({ source: 'newest-open', sessionId: SID_YESTERDAY });
  });
});
