/**
 * AUTH SESSION SWEEP (N3 from Reviewer on an earlier task): deletes
 * expired better-auth "session" rows. Every dashboard sign-in creates one (7-day lifetime) and
 * nothing else removes it after expiry, so the table grows with every sign-in forever.
 *
 * Deleting an expired session is safe: it can no longer authenticate anything.
 * auth_tokens.auth_session_id cascades (the dashboard session dies with it), and the oauth
 * token tables' sessionId is set null (migration 052/109).
 *
 * Shape mirrors oauthClientSweeper.ts: config-driven (DASHBOARD_AUTH_CONFIG), single-flight with
 * the flag cleared in `finally`, fail-safe (an error is logged and the timer keeps ticking),
 * and dark unless OAuth is enabled (no "session" table is in use otherwise).
 */

import type { Pool } from 'pg';
import { db } from '../config/database.js';
import { logger } from '../utils/logger.js';
import { BETTER_AUTH_CONFIG } from '../config/betterAuthConfig.js';
import { DASHBOARD_AUTH_CONFIG } from '../config/dashboardAuthConfig.js';

/** Delete every better-auth session whose "expiresAt" is in the past. Returns rows deleted. */
export async function deleteExpiredAuthSessions(pool: Pick<Pool, 'query'>): Promise<number> {
  const res = await pool.query('DELETE FROM "session" WHERE "expiresAt" < now()');
  return res.rowCount ?? 0;
}

export class AuthSessionSweeper {
  private static intervalId: NodeJS.Timeout | null = null;
  private static isSweeping = false;
  private static isRunning = false;

  static start(pool: Pool = db): void {
    if (!BETTER_AUTH_CONFIG.enabled) {
      logger.info('💤 Auth session sweep not started — OAuth is disabled.');
      return;
    }
    if (!DASHBOARD_AUTH_CONFIG.sessionSweepEnabled) {
      logger.info('💤 Auth session sweep DISABLED (MANDREL_DASHBOARD_SESSION_SWEEP_ENABLED=false) — not started.');
      return;
    }
    if (this.isRunning) {
      logger.warn('⚠️  Auth session sweep already running');
      return;
    }
    const intervalMs = DASHBOARD_AUTH_CONFIG.sessionSweepIntervalMinutes * 60 * 1000;
    logger.info(`🧹 Starting auth session sweep — every ${DASHBOARD_AUTH_CONFIG.sessionSweepIntervalMinutes} min.`);
    this.runOnce(pool).catch((error) => logger.error('❌ Initial auth session sweep failed', error as Error));
    this.intervalId = setInterval(() => {
      this.runOnce(pool).catch((error) => logger.error('❌ Periodic auth session sweep failed', error as Error));
    }, intervalMs);
    if (typeof this.intervalId.unref === 'function') this.intervalId.unref();
    this.isRunning = true;
  }

  static stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.isRunning = false;
  }

  /** One single-flight sweep; `skipped` when one is already in flight. */
  static async runOnce(pool: Pool = db): Promise<{ skipped: boolean; deleted: number }> {
    if (this.isSweeping) return { skipped: true, deleted: 0 };
    this.isSweeping = true;
    try {
      const deleted = await deleteExpiredAuthSessions(pool);
      if (deleted > 0) logger.info(`🧹 Auth session sweep deleted ${deleted} expired session(s).`);
      return { skipped: false, deleted };
    } finally {
      this.isSweeping = false;
    }
  }
}
