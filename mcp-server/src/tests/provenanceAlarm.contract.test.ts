/**
 * DECLARED-RATE ALARM — mutation probe + control (acceptance 3 & 4).
 *
 * C3 discipline, all three assertions, against the PRODUCTION invocation path — every leg
 * calls ProvenanceAlarmWorker.runOnce(), the exact method the scheduled interval invokes
 * (provenanceAlarm.ts start()); there is no /tmp harness and no reimplemented query:
 *
 *   MUTATION (a window with ZERO declared edges): the world is broken on purpose — the
 *     evaluation window is placed entirely inside a span in which no declared edge was
 *     minted (we mint nothing and wait out the window; the LANDED check asserts the
 *     measured declaredCount === 0, so the mutation cannot have silently no-oped).
 *     → the alarm FIRES: alertSink.send observed.
 *   CONTROL (a normal window): a declared edge minted through the production tag path
 *     sits inside the window, floor 1 → the alarm is SILENT and the verdict says so.
 *
 * CLASSIFIER (acceptance 4): both legs additionally assert the verdict's declaredCount —
 * an SQL count(*)::int — because the verdict is evaluateDeclaredFloor(declaredCount, floor),
 * an integer comparison. Nothing here (or in the product) parses log prose for the verdict.
 *
 * THE SPY: alertSink is embedResilience's exported sink object; swapping `.send` is the
 * documented ESM-live-binding-safe seam ("tests can replace `.send` with a spy WITHOUT
 * shelling out") — the same seam the embed-alert tests use. No chat is ever touched.
 *
 * TIMING: vitest runs files single-fork (vitest.config.ts fileParallelism:false), so no
 * other suite can mint an edge during this file's ~2s quiet span.
 */

import { describe, test, expect, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { db } from '../config/database.js';
import { alertSink, NOTIFY_CREDS_ENV_VAR } from '../services/embedResilience.js';
import { logger } from '../utils/logger.js';
import { PROVENANCE_CONFIG } from '../config/provenanceConfig.js';
import { RESILIENCE_CONFIG } from '../config/resilienceConfig.js';
import {
  ProvenanceAlarmWorker,
  evaluateDeclaredFloor,
  evaluateDeadSources,
  resetProvenanceAlarmDedupe,
} from '../services/provenanceAlarm.js';
import { countDeclaredInWindow } from '../services/provenanceMeter.js';

/** Pins the dead-source leg OFF for the declared-floor legs (no source can clear an
 *  impossible activity bar), so each leg's spy assertions observe ONLY its own alerts. */
const DEAD_SOURCE_LEG_OFF = { sourceActivePerWeek: 10_000_000 };
import { autoMintFromTags } from '../services/links.js';
import { EDGE_MINT_VIA } from '../config/edgeProvenanceConfig.js';

const STAMP = Date.now();
const projectIds: string[] = [];

/** ~1.2 seconds, expressed in days — the fractional-window seam countDeclaredInWindow
 *  documents for exactly this fixture. */
const TINY_WINDOW_DAYS = 1.2 / 86400;

async function freshProject(label: string): Promise<string> {
  const id = (
    await db.query(
      `INSERT INTO projects (name, description) VALUES ($1, 'provenance alarm fixture') RETURNING id`,
      [`provalarm-${label}-${STAMP}`]
    )
  ).rows[0].id;
  projectIds.push(id);
  return id;
}

/** Mint one DECLARED edge through the production tag path (context.routes.ts's exact call). */
async function mintDeclaredEdge(projectId: string): Promise<void> {
  const task = (
    await db.query(
      `INSERT INTO tasks (project_id, title, type, priority, status)
       VALUES ($1, 'alarm control target', 'general', 'medium', 'todo') RETURNING id::text AS id`,
      [projectId]
    )
  ).rows[0].id;
  const ctx = (
    await db.query(
      `INSERT INTO contexts (project_id, context_type, content) VALUES ($1, 'discussion', 'alarm control source')
       RETURNING id::text AS id`,
      [projectId]
    )
  ).rows[0].id;
  const res = await autoMintFromTags({
    fromId: ctx,
    fromType: 'context',
    tags: [`task:${task.slice(0, 8)}`],
    projectId,
    createdBy: 'auto:context_store',
  });
  expect(res.minted).toBe(1);
}

/**
 * Fixture for the dead-source leg: mint `count` edges stamped `source`, dated `agoInterval`
 * in the past (links.created_at is set explicitly — the DB accepts it; DEFAULT now() only
 * fills absence). One fresh context per edge against a shared task keeps the
 * UNIQUE(from_id,to_id,edge_type) constraint satisfied.
 */
async function insertBackdatedSourceEdges(
  projectId: string,
  source: string,
  count: number,
  agoInterval: string
): Promise<void> {
  const task = (
    await db.query(
      `INSERT INTO tasks (project_id, title, type, priority, status)
       VALUES ($1, 'dead-source fixture target', 'general', 'medium', 'todo') RETURNING id::text AS id`,
      [projectId]
    )
  ).rows[0].id;
  for (let i = 0; i < count; i++) {
    const ctx = (
      await db.query(
        `INSERT INTO contexts (project_id, context_type, content)
         VALUES ($1, 'discussion', $2) RETURNING id::text AS id`,
        [projectId, `dead-source fixture ${source} ${i}`]
      )
    ).rows[0].id;
    // SK4: mint_via is NOT NULL. This suite measures the dead-SOURCE leg,
    // whose grain is created_by (the mechanism stamp) — a different question from
    // declared-vs-guessed — so the via is a constant here and varying it would measure
    // nothing this suite is about.
    await db.query(
      `INSERT INTO links (from_id, from_type, to_id, to_type, edge_type, project_id, created_by, mint_via, created_at)
       VALUES ($1, 'context', $2, 'task', 'informs', $3, $4, $5, now() - $6::interval)`,
      [ctx, task, projectId, source, EDGE_MINT_VIA.tag, agoInterval]
    );
  }
}

/** Install a spy on the shared alert sink; returns the calls array and a restore fn.
 *  `dispatchResult` models the sink's return: true = dispatched (default), false = the
 *  delivery path is broken (notify script unresolved) — Reviewer ruling 4's case. */
function spyOnAlertSink(
  dispatchResult: boolean = true
): { calls: Array<{ title: string; body: string }>; restore: () => void } {
  const calls: Array<{ title: string; body: string }> = [];
  const original = alertSink.send;
  alertSink.send = (title: string, body: string): boolean => {
    calls.push({ title, body });
    return dispatchResult;
  };
  return { calls, restore: () => void (alertSink.send = original) };
}

// Delivery needs an operator-supplied notify script (MANDREL_EMBED_ALERT_NOTIFY_SCRIPT). Every
// test here runs with a no-op one, so a leg that expects 'undeliverable' is RED for the reason
// it names (the creds file), never because no script is configured.
const NOTIFY_DIR = mkdtempSync(join(tmpdir(), 'p0-notify-'));
const NOTIFY_SCRIPT = join(NOTIFY_DIR, 'notify.sh');
writeFileSync(NOTIFY_SCRIPT, 'notify() { :; }\n');
const SAVED_NOTIFY_SCRIPT = RESILIENCE_CONFIG.alertNotifyScript;

beforeEach(() => {
  resetProvenanceAlarmDedupe();
  RESILIENCE_CONFIG.alertNotifyScript = NOTIFY_SCRIPT;
});

afterAll(async () => {
  RESILIENCE_CONFIG.alertNotifyScript = SAVED_NOTIFY_SCRIPT;
  rmSync(NOTIFY_DIR, { recursive: true, force: true });
  for (const id of projectIds) {
    await db.query(`DELETE FROM projects WHERE id = $1`, [id]);
  }
});

describe('evaluateDeclaredFloor — the structured classifier (acceptance 4)', () => {
  test('fires strictly below the floor; the boundary is healthy; zero always fires', () => {
    expect(evaluateDeclaredFloor(0, 10)).toBe(true);
    expect(evaluateDeclaredFloor(9, 10)).toBe(true);
    expect(evaluateDeclaredFloor(10, 10)).toBe(false);
    expect(evaluateDeclaredFloor(400, 10)).toBe(false);
  });
});

describe('evaluateDeadSources — the structured dead-source classifier', () => {
  test('dead = exactly inWindow 0; retired sources are suppressed but reported', () => {
    const rows = [
      { source: 'a', peakWeekly: 90, inWindow: 0 },
      { source: 'b', peakWeekly: 40, inWindow: 1 }, // one edge is alive, not dead
      { source: 'c', peakWeekly: 25, inWindow: 0 },
    ];
    const { dead, retiredSuppressed } = evaluateDeadSources(rows, ['c']);
    expect(dead).toEqual([{ source: 'a', peakWeekly: 90, inWindow: 0 }]);
    expect(retiredSuppressed).toEqual([{ source: 'c', peakWeekly: 25, inWindow: 0 }]);
  });
});

describe('ProvenanceAlarmWorker.runOnce — the production invocation path (acceptance 3)', () => {
  test('MUTATION: a window with ZERO declared edges → the alarm FIRES via the shared sink', async () => {
    // Place the whole evaluation window inside a quiet span: wait longer than the tiny
    // window so any edge minted before this test falls outside it.
    await new Promise((r) => setTimeout(r, 2000));

    // MUTATION LANDED: the broken world is real — the meter itself measures 0 declared
    // edges in the window (the same structured count the verdict is computed from).
    expect(await countDeclaredInWindow(TINY_WINDOW_DAYS)).toBe(0);

    const spy = spyOnAlertSink();
    try {
      const result = await ProvenanceAlarmWorker.runOnce(db, {
        windowDays: TINY_WINDOW_DAYS,
        declaredFloor: 1,
        ...DEAD_SOURCE_LEG_OFF,
      });
      // GUARD WENT RED: verdict fired from the structured zero, and the alert was sent.
      expect(result).toMatchObject({
        skipped: false,
        measured: true,
        verdict: { declaredCount: 0, floor: 1, fired: true },
      });
      expect(spy.calls.length).toBe(1);
      expect(spy.calls[0].title).toContain('declared-edge rate BELOW FLOOR');
    } finally {
      spy.restore();
    }
  });

  test('CONTROL: a normal window (declared edge present) → the alarm is SILENT', async () => {
    const projectId = await freshProject('control');
    await mintDeclaredEdge(projectId); // in-window by construction (window = 1 day)

    const spy = spyOnAlertSink();
    try {
      const result = await ProvenanceAlarmWorker.runOnce(db, {
        windowDays: 1,
        declaredFloor: 1,
        ...DEAD_SOURCE_LEG_OFF,
      });
      expect(result.skipped).toBe(false);
      if (result.skipped || !result.measured) throw new Error('control leg could not measure');
      // The structured count includes our production-path edge; the integer comparison
      // says healthy; no alert crossed the sink.
      expect(result.verdict.declaredCount).toBeGreaterThanOrEqual(1);
      expect(result.verdict.fired).toBe(false);
      expect(spy.calls.length).toBe(0);
    } finally {
      spy.restore();
    }
  });

  test('MUTATION (dead-source leg): a historically-active source at ZERO in-window → DEAD alert', async () => {
    const projectId = await freshProject('deadsource');
    // Fixture: 25 edges from a mechanism that ran hot 8 days ago (inside the 8-week
    // lookback, one busy week >= the 20/wk bar) and has minted NOTHING since — outside
    // the 7-day window by construction.
    await insertBackdatedSourceEdges(projectId, 'auto:probe_dead_mechanism', 25, '8 days');

    const spy = spyOnAlertSink();
    try {
      const result = await ProvenanceAlarmWorker.runOnce(db, {
        windowDays: 7,
        declaredFloor: 0, // silence leg 1 (count < 0 is impossible) — isolate this leg
        sourceActivePerWeek: 20,
        sourceLookbackWeeks: 8,
      });
      if (result.skipped || !result.measured) throw new Error('dead-source mutation leg could not measure');
      // MUTATION LANDED + GUARD RED, from the STRUCTURED row: the verdict carries the
      // measured integers (peak 25/wk, 0 in window), and the alert crossed the sink.
      const dead = result.verdict.deadSources.find((d) => d.source === 'auto:probe_dead_mechanism');
      expect(dead).toEqual({ source: 'auto:probe_dead_mechanism', peakWeekly: 25, inWindow: 0 });
      const deadCalls = spy.calls.filter((c) => c.title.includes('mint source DEAD'));
      expect(deadCalls.length).toBe(1);
      expect(deadCalls[0].title).toContain('auto:probe_dead_mechanism');
      expect(deadCalls[0].body).toContain('peak 25/wk');
    } finally {
      spy.restore();
      // Remove the dead fixture so later legs' whole-sink silence assertions stay valid.
      await db.query(`DELETE FROM projects WHERE id = $1`, [projectId]);
    }
  });

  test('CONTROL (dead-source leg): the source stays active → SILENT, through the same invocation', async () => {
    const projectId = await freshProject('livesource');
    // Same historical shape as the mutation — but the mechanism is still minting: one
    // edge lands inside the current window.
    await insertBackdatedSourceEdges(projectId, 'auto:probe_live_mechanism', 25, '8 days');
    await insertBackdatedSourceEdges(projectId, 'auto:probe_live_mechanism', 1, '0 seconds');

    const spy = spyOnAlertSink();
    try {
      const result = await ProvenanceAlarmWorker.runOnce(db, {
        windowDays: 7,
        declaredFloor: 0,
        sourceActivePerWeek: 20,
        sourceLookbackWeeks: 8,
      });
      if (result.skipped || !result.measured) throw new Error('dead-source control leg could not measure');
      // The source is measured (active) and alive (inWindow >= 1) — no dead verdict, no alert.
      expect(result.verdict.deadSources).toEqual([]);
      expect(spy.calls.length).toBe(0);
    } finally {
      spy.restore();
      await db.query(`DELETE FROM projects WHERE id = $1`, [projectId]);
    }
  });

  test('RETIRED source: dead but named in retiredSources → suppressed AND reported, never paged', async () => {
    const projectId = await freshProject('retiredsource');
    await insertBackdatedSourceEdges(projectId, 'auto:probe_retired_mechanism', 25, '8 days');

    const spy = spyOnAlertSink();
    try {
      const result = await ProvenanceAlarmWorker.runOnce(db, {
        windowDays: 7,
        declaredFloor: 0,
        sourceActivePerWeek: 20,
        sourceLookbackWeeks: 8,
        retiredSources: ['auto:probe_retired_mechanism'],
      });
      if (result.skipped || !result.measured) throw new Error('retired-source leg could not measure');
      expect(result.verdict.deadSources).toEqual([]);
      // Suppressed is NOT invisible: the verdict still reports the retirement.
      expect(result.verdict.retiredSuppressed).toEqual([
        { source: 'auto:probe_retired_mechanism', peakWeekly: 25, inWindow: 0 },
      ]);
      expect(spy.calls.length).toBe(0);
    } finally {
      spy.restore();
      await db.query(`DELETE FROM projects WHERE id = $1`, [projectId]);
    }
  });

  test('DEDUPE (Reviewer ruling 4): a FAILED dispatch does not consume the slot — the next run retries; a SUCCESSFUL one does', async () => {
    // Fire condition for every runOnce below: zero declared edges in a ~1.2s window
    // after a 2s quiet span (same fixture as the mutation leg above).
    await new Promise((r) => setTimeout(r, 2000));
    const fireArgs = { windowDays: TINY_WINDOW_DAYS, declaredFloor: 1, ...DEAD_SOURCE_LEG_OFF };

    // ── BROKEN DELIVERY: sink reports not-dispatched → slot stays free → retry attempts.
    const failing = spyOnAlertSink(false);
    try {
      const r1 = await ProvenanceAlarmWorker.runOnce(db, fireArgs);
      if (r1.skipped || !r1.measured) throw new Error('dedupe leg 1 could not measure');
      expect(r1.alertOutcomes).toEqual([{ kind: 'fired', outcome: 'undeliverable' }]);
      const r2 = await ProvenanceAlarmWorker.runOnce(db, fireArgs);
      if (r2.skipped || !r2.measured) throw new Error('dedupe leg 2 could not measure');
      expect(r2.alertOutcomes).toEqual([{ kind: 'fired', outcome: 'undeliverable' }]);
      // TWO delivery attempts: the undelivered page did not eat the once-per-window slot.
      expect(failing.calls.length).toBe(2);
    } finally {
      failing.restore();
    }

    // ── HEALTHY DELIVERY: first send consumes the slot; the second run inside the TTL
    // is deduped (raised, verdict still fired, but not re-sent).
    resetProvenanceAlarmDedupe();
    const succeeding = spyOnAlertSink(true);
    try {
      const r3 = await ProvenanceAlarmWorker.runOnce(db, fireArgs);
      if (r3.skipped || !r3.measured) throw new Error('dedupe leg 3 could not measure');
      expect(r3.alertOutcomes).toEqual([{ kind: 'fired', outcome: 'sent' }]);
      const r4 = await ProvenanceAlarmWorker.runOnce(db, fireArgs);
      if (r4.skipped || !r4.measured) throw new Error('dedupe leg 4 could not measure');
      expect(r4.alertOutcomes).toEqual([{ kind: 'fired', outcome: 'deduped' }]);
      expect(succeeding.calls.length).toBe(1);
    } finally {
      succeeding.restore();
    }
  });

  test('ROUND-3 runtime leg: creds path set but UNREADABLE → outcome undeliverable, sink never invoked, slot free', async () => {
    const savedEnv = process.env[NOTIFY_CREDS_ENV_VAR];
    process.env[NOTIFY_CREDS_ENV_VAR] = '/nonexistent-p0-round3/notify-creds.env';
    const spy = spyOnAlertSink(true);
    try {
      await new Promise((r) => setTimeout(r, 2000)); // quiet span → fire condition
      const result = await ProvenanceAlarmWorker.runOnce(db, {
        windowDays: TINY_WINDOW_DAYS,
        declaredFloor: 1,
        ...DEAD_SOURCE_LEG_OFF,
      });
      if (result.skipped || !result.measured) throw new Error('round-3 runtime leg could not measure');
      // The measured silent-death mode is closed: the chain is checked BEFORE dispatch,
      // so the outcome is 'undeliverable' (not a lying 'sent') and the sink never runs.
      expect(result.alertOutcomes).toEqual([{ kind: 'fired', outcome: 'undeliverable' }]);
      expect(spy.calls.length).toBe(0);
    } finally {
      spy.restore();
      if (savedEnv === undefined) delete process.env[NOTIFY_CREDS_ENV_VAR];
      else process.env[NOTIFY_CREDS_ENV_VAR] = savedEnv;
    }
  });

  test('ROUND-3 startup leg: start() ERRORs when creds unreadable, silent about delivery when readable', async () => {
    const savedEnabled = PROVENANCE_CONFIG.alarmEnabled;
    const savedEnv = process.env[NOTIFY_CREDS_ENV_VAR];
    const errors: string[] = [];
    const originalError = logger.error;
    logger.error = ((message: string): void => {
      errors.push(message);
    }) as typeof logger.error;
    const sinkSpy = spyOnAlertSink(true); // the initial runOnce must never reach a real sink
    const tmp = mkdtempSync(join(tmpdir(), 'p0-creds-'));
    try {
      PROVENANCE_CONFIG.alarmEnabled = true;

      // RED: enabled + creds path set but unreadable → the structured startup ERROR.
      process.env[NOTIFY_CREDS_ENV_VAR] = '/nonexistent-p0-round3/notify-creds.env';
      ProvenanceAlarmWorker.start(db);
      ProvenanceAlarmWorker.stop();
      expect(
        errors.some((m) => m.includes('CANNOT DELIVER') && m.includes('/nonexistent-p0-round3/notify-creds.env'))
      ).toBe(true);

      // GREEN: same start path, creds readable → no CANNOT DELIVER error.
      errors.length = 0;
      const credsFile = join(tmp, 'notify-creds.env');
      writeFileSync(credsFile, '# readable dummy creds fixture (no real values)\n');
      process.env[NOTIFY_CREDS_ENV_VAR] = credsFile;
      ProvenanceAlarmWorker.start(db);
      ProvenanceAlarmWorker.stop();
      expect(errors.some((m) => m.includes('CANNOT DELIVER'))).toBe(false);

      // Let the two boot-time runOnce() calls settle while the sink spy is still
      // installed, so no real dispatch can race the restore below.
      await new Promise((r) => setTimeout(r, 500));
    } finally {
      logger.error = originalError;
      sinkSpy.restore();
      PROVENANCE_CONFIG.alarmEnabled = savedEnabled;
      if (savedEnv === undefined) delete process.env[NOTIFY_CREDS_ENV_VAR];
      else process.env[NOTIFY_CREDS_ENV_VAR] = savedEnv;
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('HUNG METER QUERY: a server-side hang THROWS within the query timeout and reaches could-not-measure — the alarm pages instead of going blind', async () => {
    // A REAL hang, not a mock: an ACCESS EXCLUSIVE lock on `links` blocks the meter's
    // SELECT (ACCESS SHARE) indefinitely — the exact shape that wedged the latch forever
    // before the fix. The per-query timeout (meterQueryTimeoutMs, narrowed here the way
    // other legs narrow floor/window) must turn that into a throw → CNM branch.
    const cfg = PROVENANCE_CONFIG as { meterQueryTimeoutMs: number };
    const savedTimeout = cfg.meterQueryTimeoutMs;
    cfg.meterQueryTimeoutMs = 500;
    const locker = await db.connect();
    const spy = spyOnAlertSink();
    const HUNG = Symbol('runOnce never returned');
    try {
      await locker.query('BEGIN');
      await locker.query('LOCK TABLE links IN ACCESS EXCLUSIVE MODE');

      // declaredFloor 0 + dead-source leg off: even if a pre-fix hung run resumes after
      // the ROLLBACK below, its verdict cannot fire — no alert can escape this fixture.
      const result = await Promise.race([
        ProvenanceAlarmWorker.runOnce(db, { windowDays: 1, declaredFloor: 0, ...DEAD_SOURCE_LEG_OFF }),
        new Promise<typeof HUNG>((r) => setTimeout(() => r(HUNG), 4000)),
      ]);

      // WITHOUT the query timeout this is HUNG (the pre-fix blindness); WITH it, the hang
      // is a measured:false run that PAGED through the existing could-not-measure path.
      expect(result).not.toBe(HUNG);
      expect(result).toMatchObject({ skipped: false, measured: false });
      expect(spy.calls.length).toBe(1);
      expect(spy.calls[0].title).toContain('COULD NOT MEASURE');
    } finally {
      spy.restore();
      await locker.query('ROLLBACK').catch(() => {});
      locker.release();
      cfg.meterQueryTimeoutMs = savedTimeout;
    }

    // RECOVERY: the latch is free — the very next runOnce measures (never {skipped:true}).
    const after = await ProvenanceAlarmWorker.runOnce(db, { windowDays: 1, declaredFloor: 0, ...DEAD_SOURCE_LEG_OFF });
    expect(after.skipped).toBe(false);
    if (after.skipped) throw new Error('unreachable');
    expect(after.measured).toBe(true);
  });

  test('WATCHDOG: a wedged latch is surfaced (wedged alert) and cleared — runOnce is not {skipped:true} forever', async () => {
    // Wedge the latch for real: a pool whose query NEVER settles (it also ignores
    // query_timeout, modelling a hang the statement timeout cannot bound — the
    // belt-and-suspenders case). This runOnce holds the latch permanently.
    const never = new Promise<never>(() => {});
    const hangingPool = { query: () => never } as unknown as typeof db;
    const spy = spyOnAlertSink();
    try {
      void ProvenanceAlarmWorker.runOnce(hangingPool, { windowDays: 1, declaredFloor: 0 });
      await new Promise((r) => setTimeout(r, 100));

      // INSIDE the bound: single-flight skip, exactly as designed (control for the bound).
      const inside = await ProvenanceAlarmWorker.runOnce(db, { windowDays: 1, declaredFloor: 0, ...DEAD_SOURCE_LEG_OFF });
      expect(inside).toEqual({ skipped: true });

      // PAST the bound (fractional minutes — the same override seam windowDays uses;
      // 0.001 min = 60ms, and the latch has been held >=100ms): the watchdog must page,
      // clear the latch, and let THIS run measure. Pre-fix this was {skipped:true}.
      const takeover = await ProvenanceAlarmWorker.runOnce(db, {
        windowDays: 1,
        declaredFloor: 0,
        ...DEAD_SOURCE_LEG_OFF,
        checkWatchdogMinutes: 0.001,
      });
      expect(takeover.skipped).toBe(false);
      if (takeover.skipped || !takeover.measured) throw new Error('watchdog takeover run could not measure');
      // Not a silent reset: the run result carries the wedged outcome and the alert
      // crossed the sink.
      expect(takeover.alertOutcomes).toContainEqual({ kind: 'wedged', outcome: 'sent' });
      const wedgedCalls = spy.calls.filter((c) => c.title.includes('WEDGED'));
      expect(wedgedCalls.length).toBe(1);

      // And the latch is healthy afterwards: a subsequent runOnce measures normally.
      const after = await ProvenanceAlarmWorker.runOnce(db, { windowDays: 1, declaredFloor: 0, ...DEAD_SOURCE_LEG_OFF });
      expect(after.skipped).toBe(false);
    } finally {
      spy.restore();
    }
  });

  test('COULD NOT MEASURE is its own branch — never silence, never "0 declared" (C1)', async () => {
    const brokenPool = {
      query: () => Promise.reject(new Error('synthetic meter outage')),
    } as unknown as typeof db;

    const spy = spyOnAlertSink();
    try {
      const result = await ProvenanceAlarmWorker.runOnce(brokenPool, {
        windowDays: 1,
        declaredFloor: 1,
      });
      expect(result).toMatchObject({ skipped: false, measured: false });
      // A blind alarm announces its blindness — with a DIFFERENT alert than below-floor.
      expect(spy.calls.length).toBe(1);
      expect(spy.calls[0].title).toContain('COULD NOT MEASURE');
    } finally {
      spy.restore();
    }
  });
});
