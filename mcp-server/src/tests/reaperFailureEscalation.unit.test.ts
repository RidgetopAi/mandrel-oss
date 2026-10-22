/**
 * reaperFailureEscalation.unit.test.ts — the idle reaper must FAIL LOUD.
 *
 * WHY THIS EXISTS
 *   The reaper is one whole-table UPDATE, so a single bad row aborts the ENTIRE sweep and
 *   NO session is reaped. Both callers swallow that into `.catch(logger.error)` and
 *   setInterval keeps firing, so a total, ongoing outage of a core guarantee used to look
 *   exactly like one noisy error line every 5 minutes — indistinguishable from routine
 *   noise, and `getStatus().isRunning` stayed `true` throughout.
 *
 *   This proves the escalation actually FIRES rather than merely being written down:
 *     - consecutive failures are counted;
 *     - at SESSION_CONFIG.reaperFailureAlertAfter a distinct REAPER-DOWN line is emitted;
 *     - a clock-domain violation is NAMED in that line (it is the failure mode that
 *       poisons the sweep indefinitely rather than transiently);
 *     - the streak RESETS on recovery, so the alert can fire again next outage.
 *
 * DB-free: `db.query` is stubbed to reject, so this is a pure control-flow contract.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

import { db } from '../config/database.js';
import { logger } from '../utils/logger.js';
import { SessionTimeoutService } from '../services/sessionTimeout.js';
import { SESSION_CONFIG } from '../config/sessionConfig.js';

/** checkTimeouts is private; the escalation lives there, so reach it deliberately. */
const checkTimeouts = () =>
  (SessionTimeoutService as unknown as { checkTimeouts: () => Promise<void> }).checkTimeouts();

/** Reset the module-level failure streak between tests. */
function resetStreak(): void {
  const svc = SessionTimeoutService as unknown as {
    consecutiveFailures: number;
    lastFailure: string | null;
  };
  svc.consecutiveFailures = 0;
  svc.lastFailure = null;
}

/**
 * The alert threshold, PINNED AS A LITERAL — deliberately NOT read from
 * SESSION_CONFIG.reaperFailureAlertAfter (a past incident rule 9).
 *
 * This test previously derived its loop count from the product's own constant, so it
 * WIDENED IN LOCKSTEP with the thing it was supposed to pin: raising the default from 3
 * to 500 left this suite fully GREEN while REAPER-DOWN moved to ~41 hours (500 sweeps x
 * 5 min) — the loudness guarantee this whole commit exists to add, silently degraded, by
 * its own guard. A guard that READS the constant cannot detect a change TO it.
 *
 * Pinning the literal makes widening a deliberate TWO-FILE diff (sessionConfig.ts AND
 * here) — a decision someone signs for, not a drift. If you are here because this went
 * RED: that is the guard working. Change both, on purpose.
 */
const PINNED_ALERT_AFTER = 3;

describe('idle reaper — failure escalation', () => {
  beforeEach(() => resetStreak());
  afterEach(() => {
    vi.restoreAllMocks();
    resetStreak();
  });

  test('the alert threshold is PINNED — widening it must be a two-file decision', () => {
    // The whole point of this file is that the reaper fails LOUDLY and SOON. That promise
    // is a function of this number, so the number is part of the contract, not a tunable
    // the guard should follow wherever it goes.
    expect(SESSION_CONFIG.reaperFailureAlertAfter).toBe(PINNED_ALERT_AFTER);
  });

  test('counts consecutive failures and emits ONE REAPER-DOWN line at the threshold', async () => {
    const threshold = PINNED_ALERT_AFTER;
    const err = new Error(
      'new row for relation "sessions" violates check constraint "reasonable_session_duration"'
    );
    vi.spyOn(db, 'query').mockRejectedValue(err);
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});

    for (let i = 0; i < threshold; i++) {
      await expect(checkTimeouts()).rejects.toThrow();
    }

    expect(SessionTimeoutService.getStatus().consecutiveFailures).toBe(threshold);

    const reaperDown = errorSpy.mock.calls.filter(c => String(c[0]).includes('REAPER-DOWN'));
    // Exactly one — an alert that repeats every sweep is noise again.
    expect(reaperDown).toHaveLength(1);
    // It must state the CONSEQUENCE, not just that something failed...
    expect(String(reaperDown[0][0])).toMatch(/NO idle session is being closed/);
    // ...and name the clock-domain cause when it is visible.
    expect(String(reaperDown[0][0])).toMatch(/ended_at < started_at/);

    // isRunning alone cannot distinguish "sweeping" from "wedged" — these can.
    expect(SessionTimeoutService.getStatus().lastFailure).toContain('reasonable_session_duration');
  });

  test('does not escalate before the threshold', async () => {
    const threshold = PINNED_ALERT_AFTER;
    vi.spyOn(db, 'query').mockRejectedValue(new Error('transient'));
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});

    for (let i = 0; i < threshold - 1; i++) {
      await expect(checkTimeouts()).rejects.toThrow();
    }

    expect(errorSpy.mock.calls.filter(c => String(c[0]).includes('REAPER-DOWN'))).toHaveLength(0);
  });

  test('a successful sweep clears the streak so the next outage can alert again', async () => {
    vi.spyOn(db, 'query').mockRejectedValueOnce(new Error('transient'));
    vi.spyOn(logger, 'error').mockImplementation(() => {});

    await expect(checkTimeouts()).rejects.toThrow();
    expect(SessionTimeoutService.getStatus().consecutiveFailures).toBe(1);

    // Next sweep succeeds (no rows reaped).
    vi.spyOn(db, 'query').mockResolvedValue({ rows: [] } as never);
    await checkTimeouts();

    expect(SessionTimeoutService.getStatus().consecutiveFailures).toBe(0);
    expect(SessionTimeoutService.getStatus().lastFailure).toBeNull();
  });
});
