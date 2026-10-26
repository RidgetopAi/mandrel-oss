/**
 * Background Services Orchestrator
 * Manages lifecycle of all background services
 */

import { logger } from '../utils/logger.js';
import { getQueueManager, shutdownQueue } from './queueManager.js';
import { startGitTracking, stopGitTracking } from './gitTracker.js';

// Check if background services should be skipped (for testing)
const SKIP_BACKGROUND_SERVICES = process.env.AIDIS_SKIP_BACKGROUND === 'true';

/**
 * Background Services Orchestrator
 * Manages lifecycle of all background services
 */
export class BackgroundServices {
  private servicesStarted: boolean = false;

  /**
   * Start all background services
   */
  async startAll(): Promise<void> {
    if (SKIP_BACKGROUND_SERVICES) {
      logger.info('🧪 Skipping background services (AIDIS_SKIP_BACKGROUND=true)');
      return;
    }

    logger.info('Starting background services...');

    try {
      // Initialize BullMQ queue system (replaces timer-based polling)
      logger.info('🚀 Starting BullMQ queue system...');
      try {
        await getQueueManager();
        logger.info('✅ Queue system initialized successfully');
      } catch (error) {
        logger.warn('⚠️  Failed to initialize queue system', { metadata: { error } });
        logger.warn('   Background services will be disabled');
      }

      // Initialize real-time git tracking (file watching only)
      logger.info('⚡ Starting real-time git tracking...');
      try {
        await startGitTracking({
          enableFileWatching: true,
          enablePeriodicPolling: false, // Disabled: polling moved to queue
          pollingIntervalMs: 30000, // Still used by queue system
          correlationDelayMs: 5000   // 5 seconds delay after detection
        });
        logger.info('✅ Git tracking initialized successfully');
      } catch (error) {
        logger.warn('⚠️  Failed to initialize git tracking', { metadata: { error } });
        logger.warn('   Git correlation will be manual only');
      }

      // Initialize session timeout service (1h idle-timeout sweep; window =
      // SESSION_CONFIG.idleTimeoutSec, default 3600s)
      logger.info('⏱️  Starting session timeout service...');
      try {
        const { SessionTimeoutService } = await import('./sessionTimeout.js');
        SessionTimeoutService.start();
        logger.info('✅ Session timeout service initialized successfully');
      } catch (error) {
        logger.warn('⚠️  Failed to initialize session timeout service', { metadata: { error } });
        logger.warn('   Session timeouts will not be automatic');
      }

      // Initialize session data flush service (30-second periodic flush)
      logger.info('💾 Starting session data flush service...');
      try {
        const { SessionFlushService } = await import('./sessionFlush.js');
        SessionFlushService.start();
        logger.info('✅ Session flush service initialized successfully');
      } catch (error) {
        logger.warn('⚠️  Failed to initialize session flush service', { metadata: { error } });
        logger.warn('   Session data will only flush on shutdown');
      }

      // Initialize the re-embed self-heal worker: a scheduled, single-flight
      // sweep that re-embeds rows whose ACTIVE embedding column is NULL (from a live embed
      // failure OR a tenant backfill). Self-gates on MANDREL_REEMBED_WORKER_ENABLED (config).
      logger.info('🩹 Starting re-embed self-heal worker...');
      try {
        const { ReembedWorker } = await import('./reembedWorker.js');
        ReembedWorker.start();
        logger.info('✅ Re-embed self-heal worker initialized successfully');
      } catch (error) {
        logger.warn('⚠️  Failed to initialize re-embed self-heal worker', { metadata: { error } });
        logger.warn('   NULL-embedding rows will not self-heal automatically');
      }

      // Expired better-auth session sweep: self-gates on OAuth enabled + config.
      try {
        const { AuthSessionSweeper } = await import('./authSessionSweeper.js');
        AuthSessionSweeper.start();
      } catch (error) {
        logger.warn('⚠️  Failed to initialize auth session sweep', { metadata: { error } });
      }

      // Initialize the OAuth DCR client TTL-sweep: a scheduled, single-flight
      // sweep that deletes abandoned (never-consented, never-used) self-registered OAuth clients
      // older than the configured TTL. Self-gates: no-op unless OAuth is enabled AND the sweep is
      // enabled (config) — so a static-bearer-only instance (no oauthClient table) never runs it.
      logger.info('🧹 Starting OAuth DCR client TTL-sweep...');
      try {
        const { OAuthClientSweeper } = await import('./oauthClientSweeper.js');
        OAuthClientSweeper.start();
        logger.info('✅ OAuth DCR TTL-sweep initialized successfully');
      } catch (error) {
        logger.warn('⚠️  Failed to initialize OAuth DCR TTL-sweep', { metadata: { error } });
        logger.warn('   Abandoned OAuth clients will not be swept automatically');
      }

      // Initialize the edge-provenance declared-rate alarm: a scheduled,
      // single-flight check that pages when DECLARED-class edge minting falls below the
      // config floor over the rolling window — the instrument the 2026-07-28 dead-mechanism
      // incident lacked. Self-gates on MANDREL_PROVENANCE_ALARM_ENABLED (production-only
      // default, same gate as the embed alert).
      logger.info('📉 Starting edge-provenance declared-rate alarm...');
      try {
        const { ProvenanceAlarmWorker } = await import('./provenanceAlarm.js');
        ProvenanceAlarmWorker.start();
        logger.info('✅ Edge-provenance alarm initialized successfully');
      } catch (error) {
        logger.warn('⚠️  Failed to initialize edge-provenance alarm', { metadata: { error } });
        logger.warn('   A dead declared-edge minting mechanism will not page automatically');
      }

      // Start the process monitoring timers. These used to start as an
      // IMPORT-TIME side effect of utils/monitoring.ts, which meant every test process and
      // every one-off script that touched the product graph started them too. Starting is
      // now explicit and lives here, with every other background timer.
      logger.info('📊 Starting background monitoring...');
      try {
        const { startMonitoring } = await import('../utils/monitoring.js');
        startMonitoring();
        logger.info('✅ Background monitoring initialized successfully');
      } catch (error) {
        logger.warn('⚠️  Failed to initialize background monitoring', { metadata: { error } });
        logger.warn('   System metrics and health checks will not be collected');
      }

      this.servicesStarted = true;
      logger.info('✅ All background services started');

    } catch (error) {
      logger.error('Error starting background services:', error as Error);
      throw error;
    }
  }

  /**
   * Stop all background services
   */
  async stopAll(): Promise<void> {
    if (SKIP_BACKGROUND_SERVICES || !this.servicesStarted) {
      return;
    }

    logger.info('Stopping background services...');

    try {
      // Stop queue system first (it manages background jobs)
      logger.info('🚀 Stopping queue system...');
      try {
        await shutdownQueue();
        logger.info('✅ Queue system stopped gracefully');
      } catch (error) {
        logger.warn('⚠️  Failed to stop queue system', { metadata: { error } });
      }

      // Stop git tracking
      logger.info('⚡ Stopping git tracking...');
      try {
        await stopGitTracking();
        logger.info('✅ Git tracking stopped gracefully');
      } catch (error) {
        logger.warn('⚠️  Failed to stop git tracking', { metadata: { error } });
      }

      // Stop session timeout service
      logger.info('⏱️  Stopping session timeout service...');
      try {
        const { SessionTimeoutService } = await import('./sessionTimeout.js');
        SessionTimeoutService.stop();
        logger.info('✅ Session timeout service stopped gracefully');
      } catch (error) {
        logger.warn('⚠️  Failed to stop session timeout service', { metadata: { error } });
      }

      // Stop session flush service
      logger.info('💾 Stopping session flush service...');
      try {
        const { SessionFlushService } = await import('./sessionFlush.js');
        SessionFlushService.stop();
        logger.info('✅ Session flush service stopped gracefully');
      } catch (error) {
        logger.warn('⚠️  Failed to stop session flush service', { metadata: { error } });
      }

      // Stop re-embed self-heal worker
      logger.info('🩹 Stopping re-embed self-heal worker...');
      try {
        const { ReembedWorker } = await import('./reembedWorker.js');
        ReembedWorker.stop();
        logger.info('✅ Re-embed self-heal worker stopped gracefully');
      } catch (error) {
        logger.warn('⚠️  Failed to stop re-embed self-heal worker', { metadata: { error } });
      }

      // Stop edge-provenance declared-rate alarm
      logger.info('📉 Stopping edge-provenance alarm...');
      try {
        const { ProvenanceAlarmWorker } = await import('./provenanceAlarm.js');
        ProvenanceAlarmWorker.stop();
        logger.info('✅ Edge-provenance alarm stopped gracefully');
      } catch (error) {
        logger.warn('⚠️  Failed to stop edge-provenance alarm', { metadata: { error } });
      }

      try {
        const { AuthSessionSweeper } = await import('./authSessionSweeper.js');
        AuthSessionSweeper.stop();
      } catch (error) {
        logger.warn('⚠️  Failed to stop auth session sweep', { metadata: { error } });
      }

      // Stop OAuth DCR TTL-sweep
      logger.info('🧹 Stopping OAuth DCR client TTL-sweep...');
      try {
        const { OAuthClientSweeper } = await import('./oauthClientSweeper.js');
        OAuthClientSweeper.stop();
        logger.info('✅ OAuth DCR TTL-sweep stopped gracefully');
      } catch (error) {
        logger.warn('⚠️  Failed to stop OAuth DCR TTL-sweep', { metadata: { error } });
      }

      // Stop the process monitoring timers.
      logger.info('📊 Stopping background monitoring...');
      try {
        const { stopMonitoring } = await import('../utils/monitoring.js');
        stopMonitoring();
        logger.info('✅ Background monitoring stopped gracefully');
      } catch (error) {
        logger.warn('⚠️  Failed to stop background monitoring', { metadata: { error } });
      }

      this.servicesStarted = false;
      logger.info('✅ All background services stopped');

    } catch (error) {
      logger.error('Error stopping background services:', error as Error);
    }
  }
}

export const backgroundServices = new BackgroundServices();
