/**
 * TokenTracker - Domain service for token usage tracking
 */

import { TokenStore, isEmptyDelta } from '../../state/index.js';
import { SessionRepo } from '../../infra/db/index.js';
import { logger } from '../../../../utils/logger.js';

export const TokenTracker = {
  /**
   * Record token usage for a session
   */
  record(sessionId: string, inputTokens: number, outputTokens: number): void {
    TokenStore.record(sessionId, inputTokens, outputTokens);

    logger.debug(`Token usage recorded`, {
      component: 'TokenTracker',
      operation: 'record',
      metadata: {
        sessionId: sessionId.substring(0, 8),
        input: inputTokens,
        output: outputTokens,
        total: inputTokens + outputTokens
      }
    });
  },

  /**
   * Get token usage for a session
   */
  get(sessionId: string): { input: number; output: number; total: number } {
    return TokenStore.get(sessionId);
  },

  /**
   * Take exclusive ownership of a session's un-flushed token DELTA.
   * See `OperationTracker.consumeActivityCounts` — `get()` is a peek, `consume()` is
   * the only safe read for a caller that is about to persist the value. Synchronous.
   */
  consume(sessionId: string): { input: number; output: number; total: number } {
    return TokenStore.consume(sessionId);
  },

  /**
   * Hand a consumed token delta BACK because persisting it failed. See
   * `TokenStore.restore`. Error path only — tokens have no child table, so a delta
   * dropped here is gone for good.
   */
  restore(sessionId: string, usage: { input: number; output: number; total: number }): void {
    TokenStore.restore(sessionId, usage);
  },

  /**
   * Clear token tracking for a session
   */
  clear(sessionId: string): void {
    TokenStore.clear(sessionId);
  },

  /**
   * Flush all pending token usage to database
   */
  async flushToDatabase(): Promise<{
    sessionsFlushed: number;
    totalTokensFlushed: number;
  }> {
    let sessionsFlushed = 0;
    let totalTokensFlushed = 0;

    try {
      // Snapshot-and-clear ATOMICALLY before the first await — same lost-update fix
      // as OperationTracker.flushToDatabase (the old `clearAll()` ran after the loop
      // and wiped tokens recorded during it).
      const allTokens = TokenStore.consumeAll();

      for (const [sessionId, usage] of allTokens.entries()) {
        // Same gate as the activity flush, and the same reason. This used to read
        // `usage.total > 0` — one field standing in for the whole object because it is
        // *currently* maintained as `input + output`. That is the identical implicit
        // coupling: a token field that is not folded into `total` (a cache-read counter,
        // say) would be consumed and then thrown away by this line. `isEmptyDelta` asks
        // the object, so it cannot fall behind the type.
        if (!isEmptyDelta(usage)) {
          await SessionRepo.addTokens(sessionId, usage.input, usage.output, usage.total);
          totalTokensFlushed += usage.total;
          sessionsFlushed++;
        }
      }

      logger.info(`Token usage flushed to database`, {
        component: 'TokenTracker',
        operation: 'flushToDatabase',
        metadata: { sessionsFlushed, totalTokensFlushed }
      });

      return { sessionsFlushed, totalTokensFlushed };

    } catch (error) {
      logger.error('Failed to flush tokens to database', error instanceof Error ? error : new Error('Unknown error'), {
        component: 'TokenTracker',
        operation: 'flushToDatabase'
      });

      return { sessionsFlushed, totalTokensFlushed };
    }
  }
};
