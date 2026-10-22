/**
 * reaperHealthSurface.unit.test.ts — the ALERTING SEAM contract.
 *
 * WHY THIS EXISTS
 *   bc8e4c7e built REAPER-DOWN *detection* and proved it fires. But it fires into
 *   `logger.error`, which is only loud to someone already reading logs. The page is
 *   delivered out-of-process by an external monitor, and the two halves meet at
 *   GET /health/reaper — i.e. at buildReaperHealthPayload().
 *
 *   That payload is now load-bearing: if `down` stops flipping, or drifts away from the
 *   threshold the detector escalates on, the alerter goes quiet and NOTHING says so. The
 *   log line would still be perfect. So the seam needs its own guard.
 *
 * WHAT IS PINNED HERE
 *   1. `down` flips at the threshold, as a LEVEL (>=), not just on the crossing sweep.
 *   2. `down` and the REAPER-DOWN log line agree on the sweep where the streak crosses —
 *      the anti-drift assertion for edge-vs-level sharing one constant.
 *   3. The threshold is pinned as a LITERAL (a past incident rule 9 — a guard that READS the
 *      product's constant widens in lockstep with it and pins nothing).
 *   4. The raw driver message is NOT published (it can carry row content).
 *
 * DB-free: `db.query` is stubbed to reject, so this is a pure control-flow contract.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

import { db } from '../config/database.js';
import { logger } from '../utils/logger.js';
import {
  SessionTimeoutService,
  buildReaperHealthPayload,
  classifyReaperFailure
} from '../services/sessionTimeout.js';
import { SESSION_CONFIG } from '../config/sessionConfig.js';

/** checkTimeouts is private; the escalation lives there, so reach it deliberately. */
const checkTimeouts = () =>
  (SessionTimeoutService as unknown as { checkTimeouts: () => Promise<void> }).checkTimeouts();

function resetStreak(): void {
  const svc = SessionTimeoutService as unknown as {
    consecutiveFailures: number;
    lastFailure: string | null;
  };
  svc.consecutiveFailures = 0;
  svc.lastFailure = null;
}

/**
 * PINNED AS A LITERAL — deliberately NOT read from SESSION_CONFIG. Same reasoning as
 * reaperFailureEscalation.unit.test.ts: raising the default to 500 would move the page to
 * ~41 hours after the outage starts, and a guard that derives its expectation from the
 * constant would stay green through exactly that. Widening is a two-file decision.
 */
const PINNED_ALERT_AFTER = 3;

/** The clock-domain CHECK — the failure mode that poisons the sweep indefinitely. */
const CLOCK_DOMAIN_ERR =
  'new row for relation "sessions" violates check constraint "reasonable_session_duration"';

describe('reaper health surface — the alerting seam', () => {
  beforeEach(() => resetStreak());
  afterEach(() => {
    vi.restoreAllMocks();
    resetStreak();
  });

  test('publishes the threshold, and it is the PINNED value', () => {
    expect(SESSION_CONFIG.reaperFailureAlertAfter).toBe(PINNED_ALERT_AFTER);
    expect(buildReaperHealthPayload().alertAfter).toBe(PINNED_ALERT_AFTER);
  });

  test('healthy reaper publishes down=false — the anti-vacuous control', () => {
    const payload = buildReaperHealthPayload();
    expect(payload.down).toBe(false);
    expect(payload.status).toBe('healthy');
    expect(payload.consecutiveFailures).toBe(0);
    expect(payload.lastFailureClass).toBeNull();
  });

  test('down stays false BELOW the threshold', async () => {
    vi.spyOn(db, 'query').mockRejectedValue(new Error('transient'));
    vi.spyOn(logger, 'error').mockImplementation(() => {});

    for (let i = 0; i < PINNED_ALERT_AFTER - 1; i++) {
      await expect(checkTimeouts()).rejects.toThrow();
    }

    // Assert the mutation LANDED before believing the verdict.
    expect(buildReaperHealthPayload().consecutiveFailures).toBe(PINNED_ALERT_AFTER - 1);
    expect(buildReaperHealthPayload().down).toBe(false);
  });

  test('down flips true AT the threshold, on the same sweep REAPER-DOWN is logged', async () => {
    vi.spyOn(db, 'query').mockRejectedValue(new Error(CLOCK_DOMAIN_ERR));
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});

    for (let i = 0; i < PINNED_ALERT_AFTER - 1; i++) {
      await expect(checkTimeouts()).rejects.toThrow();
    }
    // One short: the log has not escalated, and the surface agrees.
    expect(errorSpy.mock.calls.filter(c => String(c[0]).includes('REAPER-DOWN'))).toHaveLength(0);
    expect(buildReaperHealthPayload().down).toBe(false);

    // The crossing sweep: BOTH must flip together. This is the edge-vs-level anti-drift
    // assertion — the log fires on `===`, the surface reports `>=`, one constant.
    await expect(checkTimeouts()).rejects.toThrow();
    expect(errorSpy.mock.calls.filter(c => String(c[0]).includes('REAPER-DOWN'))).toHaveLength(1);

    const payload = buildReaperHealthPayload();
    expect(payload.down).toBe(true);
    expect(payload.status).toBe('unhealthy');
    expect(payload.consecutiveFailures).toBe(PINNED_ALERT_AFTER);
    expect(payload.lastFailureClass).toBe('clock-domain');
  });

  test('down STAYS true past the threshold — a poller must not miss the crossing sweep', async () => {
    vi.spyOn(db, 'query').mockRejectedValue(new Error(CLOCK_DOMAIN_ERR));
    vi.spyOn(logger, 'error').mockImplementation(() => {});

    // The alerter polls every few minutes and the reaper sweeps every 5; it will routinely
    // observe the streak WELL past the crossing. If `down` were an edge (===), the page
    // would depend on a poll landing on exactly the right sweep.
    for (let i = 0; i < PINNED_ALERT_AFTER + 5; i++) {
      await expect(checkTimeouts()).rejects.toThrow();
    }

    expect(buildReaperHealthPayload().consecutiveFailures).toBe(PINNED_ALERT_AFTER + 5);
    expect(buildReaperHealthPayload().down).toBe(true);
  });

  test('recovery clears down, so the next outage pages again', async () => {
    vi.spyOn(db, 'query').mockRejectedValue(new Error('transient'));
    vi.spyOn(logger, 'error').mockImplementation(() => {});
    for (let i = 0; i < PINNED_ALERT_AFTER; i++) {
      await expect(checkTimeouts()).rejects.toThrow();
    }
    expect(buildReaperHealthPayload().down).toBe(true);

    vi.spyOn(db, 'query').mockResolvedValue({ rows: [] } as never);
    await checkTimeouts();

    const payload = buildReaperHealthPayload();
    expect(payload.down).toBe(false);
    expect(payload.consecutiveFailures).toBe(0);
    expect(payload.lastFailureClass).toBeNull();
  });

  test('the RAW driver message is never published — only a bounded class', async () => {
    // A CHECK violation can carry row content, and this surface is reachable by anything
    // that can reach :8080. The raw text stays in the log, where it already was.
    vi.spyOn(db, 'query').mockRejectedValue(new Error(CLOCK_DOMAIN_ERR));
    vi.spyOn(logger, 'error').mockImplementation(() => {});
    await expect(checkTimeouts()).rejects.toThrow();

    const payload = buildReaperHealthPayload();
    const serialized = JSON.stringify(payload);

    // The service still holds it (the log needs it)...
    expect(SessionTimeoutService.getStatus().lastFailure).toContain('reasonable_session_duration');
    // ...but no part of it reaches the wire.
    expect(serialized).not.toContain('reasonable_session_duration');
    expect(serialized).not.toContain('violates check constraint');
    expect(Object.keys(payload)).not.toContain('lastFailure');
    expect(payload.lastFailureClass).toBe('clock-domain');
  });

  test('classifier: clock-domain vs other vs none', () => {
    expect(classifyReaperFailure(null)).toBeNull();
    expect(classifyReaperFailure(CLOCK_DOMAIN_ERR)).toBe('clock-domain');
    expect(classifyReaperFailure('connection terminated unexpectedly')).toBe('other');
  });

  test('a RUNNING reaper still reports unhealthy while every sweep fails', async () => {
    // The whole trap this work exists for: `isRunning` only says the interval is
    // scheduled, and it stays TRUE throughout a total outage. Force it true so the test
    // asserts the real-world shape (running AND wedged) rather than whatever the class
    // happened to be left as — otherwise `down` could be tracking isRunning and this
    // would never notice.
    const svc = SessionTimeoutService as unknown as { isRunning: boolean };
    const prev = svc.isRunning;
    svc.isRunning = true;
    try {
      vi.spyOn(db, 'query').mockRejectedValue(new Error(CLOCK_DOMAIN_ERR));
      vi.spyOn(logger, 'error').mockImplementation(() => {});
      for (let i = 0; i < PINNED_ALERT_AFTER; i++) {
        await expect(checkTimeouts()).rejects.toThrow();
      }

      const payload = buildReaperHealthPayload();
      expect(payload.isRunning).toBe(true);
      expect(payload.down).toBe(true);
      expect(payload.status).toBe('unhealthy');
    } finally {
      svc.isRunning = prev;
    }
  });
});
