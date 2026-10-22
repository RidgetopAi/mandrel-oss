/**
 * Session Data Flush Service
 * Periodically flushes in-memory session data (tokens, activities) to database
 * Ensures data persistence even if server crashes
 */

import { SessionTracker } from './session/SessionTracker.js';
import { logger } from '../utils/logger.js';
import { unrefTimer } from '../utils/unrefTimer.js';
import { SESSION_CONFIG } from '../config/sessionConfig.js';

// Flush cadence from SESSION_CONFIG (configs-not-hardcoded); default 30 s.
const FLUSH_INTERVAL_MS = SESSION_CONFIG.flushIntervalSec * 1000;

export class SessionFlushService {
  private static flushTimer: NodeJS.Timeout | null = null;
  private static isRunning: boolean = false;

  /**
   * Start the periodic flush service
   */
  static start(): void {
    if (this.isRunning) {
      logger.warn('Session flush service already running');
      return;
    }

    logger.info('Starting session data flush service', {
      component: 'SessionFlushService',
      operation: 'start',
      metadata: {
        intervalMs: FLUSH_INTERVAL_MS
      }
    });

    // Start periodic flush
    // unref'd — stop() still clears it; unref only removes its vote to
    // keep the process alive, which a short-lived process should never inherit.
    this.flushTimer = unrefTimer(setInterval(async () => {
      try {
        await this.performFlush();
      } catch (error) {
        logger.error('Error during periodic flush', error instanceof Error ? error : new Error('Unknown error'), {
          component: 'SessionFlushService',
          operation: 'periodicFlush'
        });
      }
    }, FLUSH_INTERVAL_MS));

    this.isRunning = true;

    logger.info('Session flush service started', {
      component: 'SessionFlushService',
      operation: 'started'
    });
  }

  /**
   * Stop the periodic flush service
   */
  static stop(): void {
    if (!this.isRunning) {
      return;
    }

    logger.info('Stopping session flush service', {
      component: 'SessionFlushService',
      operation: 'stop'
    });

    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }

    this.isRunning = false;

    logger.info('Session flush service stopped', {
      component: 'SessionFlushService',
      operation: 'stopped'
    });
  }

  /**
   * Perform the flush operation
   * Private method called by the timer
   */
  private static async performFlush(): Promise<void> {
    logger.debug('Performing periodic session data flush', {
      component: 'SessionFlushService',
      operation: 'performFlush'
    });

    // Flush tokens to database
    await SessionTracker.flushTokensToDatabase();

    // Flush activity counts to database
    await SessionTracker.flushActivityToDatabase();

    logger.debug('Periodic flush completed', {
      component: 'SessionFlushService',
      operation: 'performFlush'
    });
  }

  /**
   * Get service status
   */
  static getStatus(): { isRunning: boolean; intervalMs: number } {
    return {
      isRunning: this.isRunning,
      intervalMs: FLUSH_INTERVAL_MS
    };
  }
}
