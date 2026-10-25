/**
 * Session Timeout Service (idle reaper + Phase 3 dormant lifecycle)
 * SR-1: Automatic 1-hour (configurable) timeout for idle sessions.
 *
 * TWO REGIMES, gated on the PROCESS-LEVEL SESSION_CONFIG.resolverMode (Phase 3, the auditor
 * review §4.2 / §5 "Lifecycle"):
 *
 *   legacy | shadow (DEFAULT) — UNCHANGED idle==end reaper. A single sweep every
 *     SESSION_CONFIG.reaperSweepIntervalSec calls timeout_inactive_sessions (active|interrupted
 *     idle past idleTimeoutSec → status='inactive' + ended_at stamped) and evicts matching RAM
 *     entries (the stale-but-ended fix). BYTE-IDENTICAL to pre-Phase-3.
 *
 *   actor — idle == DORMANT, not end. The single reaper SPLITS into two sweeps:
 *     • dormanter (every dormanterSweepIntervalSec): active|interrupted idle past idleDormantSec
 *       → status='dormant' (ended_at STAYS NULL — resumable; NOT a finalize). A returning actor
 *       re-joins it (the Break-2 fix).
 *     • closer (every closerSweepIntervalSec): dormant past hardCapSec (idle-based) OR any open
 *       session past absoluteCapSec (since started_at) → status='ended' via the APP finalize path
 *       (SessionLifecycleService.endSession — productivity + session_end analytics + git file
 *       sync), fixing review A3's unfinalized-reap shape.
 *
 * All windows are read from SESSION_CONFIG (configs-not-hardcoded) and passed to the DB
 * functions as INTERVALs — never hardcoded in SQL.
 */

import { db } from '../config/database.js';
import { logger } from '../utils/logger.js';
import { unrefTimer } from '../utils/unrefTimer.js';
import {
  SESSION_CONFIG,
  idleTimeoutInterval,
  idleDormantInterval,
  hardCapInterval,
  absoluteCapInterval,
} from '../config/sessionConfig.js';
import { ActiveSessionStore } from './session/state/ActiveSessionStore.js';
import { SessionLifecycleService } from './session/domain/lifecycle/SessionLifecycleService.js';

/**
 * The one failure mode that poisons the sweep INDEFINITELY rather than transiently: a
 * session row with ended_at < started_at (app-clock vs DB-clock skew) trips this CHECK,
 * and because the reaper is a single whole-table UPDATE the whole sweep aborts forever
 * after.
 *
 * Defined ONCE, here, because it now has TWO readers — the REAPER-DOWN log line and the
 * health surface's `lastFailureClass`. Two inlined copies of this regex is exactly the
 * drift class this workstream exists to kill (a rule is only as strong as the
 * weakest place it is written).
 */
const CLOCK_DOMAIN_VIOLATION = /reasonable_session_duration/;

/**
 * How a failed sweep is described on the PUBLIC health surface.
 *
 * Deliberately a bounded enum, NOT the raw driver message: `lastFailure` is a Postgres
 * error string, and a CHECK violation can carry row content with it. The health endpoint
 * is reachable by anything that can reach :8080, so it publishes this CLASSIFICATION and
 * the raw text stays where it already was — the server log. Actionable without leaking a
 * row.
 */
export type ReaperFailureClass = 'clock-domain' | 'other';

/** Classify a raw sweep-failure message for publication. Single reader of the regex. */
export function classifyReaperFailure(message: string | null): ReaperFailureClass | null {
  if (message === null) return null;
  return CLOCK_DOMAIN_VIOLATION.test(message) ? 'clock-domain' : 'other';
}

/** The exact JSON body served by GET /health/reaper. */
export interface ReaperHealthPayload {
  status: 'healthy' | 'unhealthy';
  down: boolean;
  isRunning: boolean;
  consecutiveFailures: number;
  alertAfter: number;
  lastFailureClass: ReaperFailureClass | null;
  checksPerformed: number;
  timestamp: string;
}

/**
 * Build the /health/reaper body. Lives HERE, not inline in the route, for one reason:
 * the acceptance test for an external reaper monitor has to parse the payload the endpoint
 * REALLY emits. If the test hand-rolled an equivalent body it would prove only that the
 * script can parse the test's own idea of the contract — the classic probe that mutates
 * nothing and reports a perfect result. One builder, two callers: the route
 * and the end-to-end test.
 *
 * The raw `lastFailure` text is deliberately absent — see the route's comment.
 */
export function buildReaperHealthPayload(): ReaperHealthPayload {
  const status = SessionTimeoutService.getStatus();
  return {
    status: status.down ? 'unhealthy' : 'healthy',
    down: status.down,
    // Published because it is the trap this guard exists for: it stays TRUE while every
    // sweep fails, so it must never be read as "the reaper works".
    isRunning: status.isRunning,
    consecutiveFailures: status.consecutiveFailures,
    alertAfter: status.reaperFailureAlertAfter,
    lastFailureClass: status.lastFailureClass,
    checksPerformed: status.checksPerformed,
    timestamp: new Date().toISOString()
  };
}

export class SessionTimeoutService {
  private static intervalId: NodeJS.Timeout | null = null;
  // Phase 3 actor-mode sweep handles (dormanter + closer run on their own cadences).
  private static dormanterIntervalId: NodeJS.Timeout | null = null;
  private static closerIntervalId: NodeJS.Timeout | null = null;
  // Legacy sweep cadence from SESSION_CONFIG (configs-not-hardcoded); default 5 min.
  private static readonly CHECK_INTERVAL_MS = SESSION_CONFIG.reaperSweepIntervalSec * 1000;
  private static isRunning = false;

  /**
   * Start the session lifecycle service. Legacy/shadow → the single idle==end reaper (every
   * reaperSweepIntervalSec). Actor → the dormanter + closer sweeps on their own cadences. The
   * regime is chosen ONCE at start() from the process-level resolverMode (fixed by env at boot).
   */
  static start(): void {
    if (this.isRunning) {
      logger.warn('⚠️  Session timeout service already running');
      return;
    }

    // ── ACTOR MODE: idle == dormant. Two sweeps replace the single idle reaper. ──────────
    if (SESSION_CONFIG.resolverMode === 'actor') {
      logger.info('🕐 Starting session lifecycle sweeps (actor mode: dormanter + closer)...');
      logger.info(
        `   Dormanter: every ${SESSION_CONFIG.dormanterSweepIntervalSec}s — active/interrupted ` +
        `idle past ${SESSION_CONFIG.idleDormantSec}s → dormant (ended_at NULL)`
      );
      logger.info(
        `   Closer: every ${SESSION_CONFIG.closerSweepIntervalSec}s — dormant past ` +
        `${SESSION_CONFIG.hardCapSec}s (or any open past ${SESSION_CONFIG.absoluteCapSec}s) → ended (finalized)`
      );

      // Run both once immediately.
      this.runDormanter().catch(error => logger.error('❌ Initial dormanter sweep failed', error as Error));
      this.runCloser().catch(error => logger.error('❌ Initial closer sweep failed', error as Error));

      // unref'd: these sweeps are the server's work, not a reason for a
      // process to stay alive. stop() still clears them; unref only removes the vote.
      this.dormanterIntervalId = unrefTimer(setInterval(() => {
        this.runDormanter().catch(error => logger.error('❌ Periodic dormanter sweep failed', error as Error));
      }, SESSION_CONFIG.dormanterSweepIntervalSec * 1000));

      this.closerIntervalId = unrefTimer(setInterval(() => {
        this.runCloser().catch(error => logger.error('❌ Periodic closer sweep failed', error as Error));
      }, SESSION_CONFIG.closerSweepIntervalSec * 1000));

      this.isRunning = true;
      logger.info('✅ Session lifecycle sweeps started (actor mode)');
      return;
    }

    // ── LEGACY / SHADOW MODE: the single idle==end reaper, UNCHANGED. ────────────────────
    logger.info(`🕐 Starting session timeout service...`);
    logger.info(`   Check interval: ${this.CHECK_INTERVAL_MS / 1000}s`);
    logger.info(`   Idle timeout: ${SESSION_CONFIG.idleTimeoutSec}s (${idleTimeoutInterval()})`);

    // Run initial check immediately
    this.checkTimeouts().catch(error => {
      logger.error('❌ Initial timeout check failed', error as Error);
    });

    // Schedule periodic checks
    this.intervalId = unrefTimer(setInterval(() => {
      this.checkTimeouts().catch(error => {
        logger.error('❌ Periodic timeout check failed', error as Error);
      });
    }, this.CHECK_INTERVAL_MS));

    this.isRunning = true;
    logger.info('✅ Session timeout service started');
  }

  /**
   * Stop the session timeout service (clears every sweep handle — legacy + actor).
   */
  static stop(): void {
    if (!this.isRunning) {
      logger.warn('⚠️  Session timeout service not running');
      return;
    }

    for (const handle of [this.intervalId, this.dormanterIntervalId, this.closerIntervalId]) {
      if (handle) clearInterval(handle);
    }
    this.intervalId = null;
    this.dormanterIntervalId = null;
    this.closerIntervalId = null;

    this.isRunning = false;
    logger.info('🛑 Session timeout service stopped');
  }

  /**
   * Phase 3 DORMANTER (actor mode only) — demote active/interrupted sessions idle past
   * SESSION_CONFIG.idleDormantSec to 'dormant' (ended_at STAYS NULL; resumable). NOT a finalize.
   * SELF-GATED on the process-level resolverMode so a stray/direct call in legacy/shadow is inert
   * (returns 0) — this is the regression-proof gate. RAM entries are intentionally LEFT in place:
   * a dormant session is not dead (existsActive treats dormant as OPEN), and the next action by
   * the same actor reactivates it. Returns the count demoted.
   */
  static async runDormanter(): Promise<number> {
    if (SESSION_CONFIG.resolverMode !== 'actor') return 0; // gate: inert unless actor mode
    try {
      const result = await db.query(
        `SELECT * FROM dormant_idle_sessions($1::INTERVAL)`,
        [idleDormantInterval()]
      );
      const dormantedCount = result.rows.length;
      if (dormantedCount > 0) {
        logger.info(
          `💤 Dormanter: marked ${dormantedCount} idle session(s) dormant ` +
          `(ended_at NULL, resumable) after ${SESSION_CONFIG.idleDormantSec}s idle.`
        );
      }
      return dormantedCount;
    } catch (error) {
      logger.error('❌ Dormanter sweep failed', error as Error);
      return 0;
    }
  }

  /**
   * Phase 3 CLOSER (actor mode only) — finalize sessions past their cap. Finds ids via the
   * read-only find_sessions_to_close(hardCap, absoluteCap) then FINALIZES each through the app
   * path (SessionLifecycleService.endSession → git file sync + productivity score + session_end
   * analytics event + RAM/token/activity clear), so every closed row has ONE shape (review A3).
   * Per-session try/catch: one failure never aborts the sweep. SELF-GATED on resolverMode
   * (inert in legacy/shadow). Returns the count finalized.
   */
  static async runCloser(): Promise<number> {
    if (SESSION_CONFIG.resolverMode !== 'actor') return 0; // gate: inert unless actor mode
    try {
      const result = await db.query(
        `SELECT session_id, reason FROM find_sessions_to_close($1::INTERVAL, $2::INTERVAL)`,
        [hardCapInterval(), absoluteCapInterval()]
      );
      let closed = 0;
      for (const row of result.rows) {
        try {
          await SessionLifecycleService.endSession(row.session_id); // FULL finalize (app path)
          closed++;
          logger.info(
            `🏁 Closer finalized session ${String(row.session_id).substring(0, 8)}... (${row.reason}).`
          );
        } catch (error) {
          logger.error(
            `❌ Closer failed to finalize session ${row.session_id}`,
            error as Error
          );
        }
      }
      if (result.rows.length > 0) {
        logger.info(`🏁 Closer: finalized ${closed}/${result.rows.length} capped session(s).`);
      }
      return closed;
    } catch (error) {
      logger.error('❌ Closer sweep failed', error as Error);
      return 0;
    }
  }

  /**
   * Check for timed-out sessions and mark them as inactive
   * Uses database function for efficient processing
   */
  private static async checkTimeouts(): Promise<void> {
    try {
      const startTime = Date.now();

      // Call database function to timeout sessions (sweeps active AND interrupted
      // past the configured window). Window comes from SESSION_CONFIG, not hardcoded.
      const result = await db.query(
        `SELECT * FROM timeout_inactive_sessions($1::INTERVAL)`,
        [idleTimeoutInterval()]
      );

      const timedOutCount = result.rows.length;
      const duration = Date.now() - startTime;

      if (timedOutCount > 0) {
        // SR-1: EVICT the in-RAM entries for every reaped session so a now-dead id
        // is never routed/returned again (the stale-but-ended fix).
        const reapedIds = result.rows.map((r: any) => r.session_id);
        const evicted = ActiveSessionStore.evictBySessionIds(reapedIds);
        logger.info(`⏱️  Timed out ${timedOutCount} idle session(s); evicted ${evicted} RAM entr(ies) (${duration}ms)`);
        result.rows.forEach((row: any) => {
          logger.info(`   - ${row.session_id.substring(0, 8)}...`);
        });
      } else {
        // Only log every ~6 hours to reduce noise (72 checks = 6 hours at 5min intervals)
        if (this.checkCount++ % 72 === 0) {
          logger.info(`✅ Session timeout check: 0 timeouts (${duration}ms)`);
        }
      }
      // A sweep completed — the reaper is alive again. Clear any failure streak.
      if (this.consecutiveFailures > 0) {
        logger.info(
          `✅ Idle reaper RECOVERED after ${this.consecutiveFailures} consecutive failed sweep(s)`
        );
        this.consecutiveFailures = 0;
        this.lastFailure = null;
      }
    } catch (error) {
      // WHY THIS IS ESCALATED: the reaper is ONE whole-table UPDATE, so a
      // single bad row aborts the ENTIRE sweep and NOTHING is reaped — and both callers
      // swallow this into `.catch(logger.error)` while setInterval keeps firing. Without an
      // escalation, a total, ongoing outage of a core guarantee looks exactly like one noisy
      // line every 5 minutes. We count consecutive failures and, at the configured
      // threshold, emit ONE distinctly-greppable CRITICAL line naming the consequence.
      const err = error as Error;
      this.consecutiveFailures++;
      this.lastFailure = err.message;

      logger.error('❌ Failed to check session timeouts', err);

      if (this.consecutiveFailures === SESSION_CONFIG.reaperFailureAlertAfter) {
        // Name the known cause when we can see it — a clock-domain CHECK violation is the
        // one failure mode that poisons the sweep indefinitely rather than transiently.
        const clockDomainHint = CLOCK_DOMAIN_VIOLATION.test(err.message)
          ? ' CAUSE: a session row has ended_at < started_at (app-clock vs DB-clock skew).' +
            ' The reaper cannot close ANY session until it is resolved.'
          : '';
        logger.error(
          `🚨 REAPER-DOWN: ${this.consecutiveFailures} consecutive failed sweeps — ` +
            `NO idle session is being closed.${clockDomainHint}`,
          err
        );
      }
      throw error;
    }
  }

  // Counter for periodic logging
  private static checkCount = 0;
  /** Consecutive failed sweeps; drives the REAPER-DOWN escalation. Reset on any success. */
  private static consecutiveFailures = 0;
  /** Message of the most recent sweep failure, or null when the last sweep succeeded. */
  private static lastFailure: string | null = null;

  /**
   * Get service status
   */
  static getStatus(): {
    isRunning: boolean;
    checkIntervalMs: number;
    idleTimeoutSec: number;
    checksPerformed: number;
    consecutiveFailures: number;
    lastFailure: string | null;
    reaperFailureAlertAfter: number;
    lastFailureClass: ReaperFailureClass | null;
    down: boolean;
  } {
    return {
      isRunning: this.isRunning,
      checkIntervalMs: this.CHECK_INTERVAL_MS,
      idleTimeoutSec: SESSION_CONFIG.idleTimeoutSec,
      checksPerformed: this.checkCount,
      // `isRunning` only says the INTERVAL is scheduled — it stays true while every sweep
      // fails. These two are what distinguish "sweeping" from "wedged" for any future
      // health surface.
      consecutiveFailures: this.consecutiveFailures,
      lastFailure: this.lastFailure,
      // --- The alerting seam -------------------------------------
      // The DOWN decision is made HERE, once, and published as a boolean, so the
      // out-of-process alerter (an external reaper monitor) consumes a VERDICT and never
      // re-derives the rule. A shell script holding its own copy of the threshold is a
      // second place the rule is written, and the copies would agree right up until
      // someone tuned one of them.
      reaperFailureAlertAfter: SESSION_CONFIG.reaperFailureAlertAfter,
      lastFailureClass: classifyReaperFailure(this.lastFailure),
      // EDGE vs LEVEL, one threshold. The REAPER-DOWN log line fires on `===` (exactly
      // once, when the streak crosses) because it is an event; `down` is `>=` because it
      // is a STATE — an alerter that polls every few minutes must still see DOWN on the
      // 9th consecutive failure, not just the 3rd. Same constant, so they cannot drift;
      // reaperHealthSurface.unit.test.ts pins that they agree on the crossing sweep.
      down: this.consecutiveFailures >= SESSION_CONFIG.reaperFailureAlertAfter
    };
  }

  /**
   * Manually trigger a timeout check (for testing/debugging). Same code path as the
   * periodic check: reaps idle sessions (active + interrupted) past the configured
   * window AND evicts their in-RAM entries. Returns the count reaped.
   */
  static async manualCheck(): Promise<number> {
    logger.info('🔍 Running manual timeout check...');
    const result = await db.query(
      `SELECT * FROM timeout_inactive_sessions($1::INTERVAL)`,
      [idleTimeoutInterval()]
    );

    const timedOutCount = result.rows.length;
    if (timedOutCount > 0) {
      const reapedIds = result.rows.map((r: any) => r.session_id);
      ActiveSessionStore.evictBySessionIds(reapedIds);
    }
    logger.info(`   Timed out ${timedOutCount} session(s)`);

    return timedOutCount;
  }

  /**
   * Find sessions that would be timed out (read-only query for monitoring)
   */
  static async findTimedOutSessions(): Promise<Array<{
    session_id: string;
    project_id: string | null;
    agent_type: string;
    started_at: Date;
    last_activity_at: Date;
    inactive_duration: string;
  }>> {
    const result = await db.query(
      `SELECT * FROM find_timed_out_sessions($1::INTERVAL)`,
      [idleTimeoutInterval()]
    );

    return result.rows;
  }
}

/**
 * Helper function to start timeout service (for convenience)
 */
export function startSessionTimeoutService(): void {
  SessionTimeoutService.start();
}

/**
 * Helper function to stop timeout service (for convenience)
 */
export function stopSessionTimeoutService(): void {
  SessionTimeoutService.stop();
}