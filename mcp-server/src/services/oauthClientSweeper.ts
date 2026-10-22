/**
 * OAUTH DCR CLIENT TTL-SWEEP WORKER — the scheduled, single-flight
 * side of the DCR abuse-control mechanism. It DELETEs abandoned dynamically-registered OAuth
 * clients: rows in `oauthClient` older than OAUTH_CLIENT_CONFIG.ttlDays that were NEVER
 * consented and NEVER issued an access token (see sweepExpiredUnconsentedClients). Any client
 * a user actually consented to / used is ALWAYS spared, regardless of age.
 *
 * WHY: `auth.ts` keeps public DCR ON (Claude.ai self-registers). Without a sweep the
 * `oauthClient` table grows unbounded from abandoned/aborted registrations. This is the
 * cleanup half of the cap+rate-limit+TTL trio.
 *
 * SHAPE MIRRORS reembedWorker.ts (the codebase's established sweep pattern):
 *   • CONFIG-DRIVEN (configs-not-hardcoded): enabled / interval / ttlDays all from
 *     OAUTH_CLIENT_CONFIG — no magic numbers here.
 *   • SINGLE-FLIGHT: sweeps never overlap. `isSweeping` is set before a sweep and
 *     cleared in `finally` on EVERY exit path — a dead-locked flag would silently stop cleanup.
 *   • FAIL-SAFE: a sweep error is logged and swallowed; the timer keeps ticking so a transient
 *     DB blip self-recovers next sweep.
 *   • DARK BY DEFAULT for non-OAuth instances: `start()` no-ops unless OAuth is enabled AND the
 *     sweep is enabled — so a static-bearer-only instance (no `oauthClient` table) never runs it.
 */

import type { Pool } from 'pg';
import { db } from '../config/database.js';
import { logger } from '../utils/logger.js';
import { BETTER_AUTH_CONFIG } from '../config/betterAuthConfig.js';
import { OAUTH_CLIENT_CONFIG } from '../config/oauthClientConfig.js';
import { sweepExpiredUnconsentedClients } from './oauthClientGuard.js';

export interface OAuthSweepResult {
  /** True when this call was skipped because a sweep was already in flight (single-flight). */
  skipped: boolean;
  /** Number of abandoned clients deleted this sweep (0 when nothing to do or skipped). */
  deleted: number;
}

export class OAuthClientSweeper {
  private static intervalId: NodeJS.Timeout | null = null;
  private static isSweeping = false;
  private static isRunning = false;

  /**
   * Start the scheduled TTL-sweep. No-op (with a log) when OAuth is disabled or the sweep is
   * disabled by config, so a static-bearer-only deploy (no oauthClient table) never runs it and
   * a fully-dark deploy is one env flip. Runs one sweep immediately, then every interval.
   */
  static start(pool: Pool = db): void {
    if (!BETTER_AUTH_CONFIG.enabled) {
      logger.info('💤 OAuth DCR TTL-sweep not started — OAuth is disabled (static-bearer-only instance).');
      return;
    }
    if (!OAUTH_CLIENT_CONFIG.sweepEnabled) {
      logger.info('💤 OAuth DCR TTL-sweep DISABLED (MANDREL_OAUTH_DCR_SWEEP_ENABLED=false) — not started.');
      return;
    }
    if (this.isRunning) {
      logger.warn('⚠️  OAuth DCR TTL-sweep already running');
      return;
    }
    const intervalMs = OAUTH_CLIENT_CONFIG.sweepIntervalMinutes * 60 * 1000;
    logger.info(
      `🧹 Starting OAuth DCR TTL-sweep — every ${OAUTH_CLIENT_CONFIG.sweepIntervalMinutes} min, ` +
      `deleting never-consented/never-used clients older than ${OAUTH_CLIENT_CONFIG.ttlDays} day(s).`,
    );

    // Run once immediately so a backlog starts clearing at boot (not one interval later).
    this.runOnce(pool).catch((error) => logger.error('❌ Initial OAuth DCR sweep failed', error as Error));

    this.intervalId = setInterval(() => {
      this.runOnce(pool).catch((error) => logger.error('❌ Periodic OAuth DCR sweep failed', error as Error));
    }, intervalMs);
    // Do not keep the event loop alive solely for this timer.
    if (typeof this.intervalId.unref === 'function') this.intervalId.unref();

    this.isRunning = true;
    logger.info('✅ OAuth DCR TTL-sweep started');
  }

  /** Stop the worker and clear its timer. Idempotent. */
  static stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.isRunning = false;
    logger.info('🛑 OAuth DCR TTL-sweep stopped');
  }

  /**
   * Run ONE TTL-sweep. SINGLE-FLIGHT: if a sweep is already in flight this returns
   * `{ skipped: true, deleted: 0 }` immediately (never overlaps, never queues). The
   * `isSweeping` flag is cleared in `finally` on every path — success, skip-return, or throw.
   *
   * Exposed (not private) so it can be triggered/tested directly and so a future ops tool can
   * force an immediate cleanup. Uses the SAME query + config as the scheduled path.
   */
  static async runOnce(pool: Pool = db): Promise<OAuthSweepResult> {
    if (this.isSweeping) {
      logger.info('⏭️  OAuth DCR sweep skipped — a sweep is already in flight (single-flight).');
      return { skipped: true, deleted: 0 };
    }
    this.isSweeping = true;
    try {
      const deleted = await sweepExpiredUnconsentedClients(pool, OAUTH_CLIENT_CONFIG.ttlDays);
      if (deleted > 0) {
        logger.info(`🧹 OAuth DCR sweep deleted ${deleted} abandoned (never-consented, never-used) client(s).`);
      }
      return { skipped: false, deleted };
    } finally {
      // ALWAYS clear the flag — a stuck flag would permanently wedge cleanup.
      this.isSweeping = false;
    }
  }

  /** Introspection for status/tests. */
  static getStatus(): { isRunning: boolean; isSweeping: boolean; enabled: boolean } {
    return {
      isRunning: this.isRunning,
      isSweeping: this.isSweeping,
      enabled: BETTER_AUTH_CONFIG.enabled && OAUTH_CLIENT_CONFIG.sweepEnabled,
    };
  }
}
