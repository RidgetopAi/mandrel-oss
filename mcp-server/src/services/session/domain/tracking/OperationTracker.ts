/**
 * OperationTracker - Domain service for tracking session operations and activities
 */

import { ActivityCountStore, isEmptyDelta, type ActivityCounts } from '../../state/index.js';
import { SessionRepo, ActivityRepo, AnalyticsEventsRepo } from '../../infra/db/index.js';
import { logger } from '../../../../utils/logger.js';
import { noteSessionActivity } from '../../activityTouch.js';

export const OperationTracker = {
  /**
   * Record a general operation
   */
  async recordOperation(sessionId: string, operationType: string): Promise<void> {
    try {
      await AnalyticsEventsRepo.insert('system', operationType, {
        sessionId,
        status: 'completed',
        tags: ['operation', operationType]
      });

      // Update session activity timestamp — through the ONE helper, so
      // this shares the read path's throttle and bounded cache instead of being a second
      // unthrottled writer of the same column. Throttling LIVENESS does not throttle the
      // analytics event above: they are different facts and every operation is still
      // recorded.
      await noteSessionActivity(sessionId);

      logger.debug(`Operation recorded: ${operationType}`, {
        component: 'OperationTracker',
        operation: 'recordOperation',
        metadata: { sessionId: sessionId.substring(0, 8), operationType }
      });

    } catch (error) {
      logger.error('Failed to record operation', error instanceof Error ? error : new Error('Unknown error'), {
        component: 'OperationTracker',
        operation: 'recordOperation',
        metadata: { sessionId, operationType }
      });
    }
  },

  /**
   * Record task created
   */
  recordTaskCreated(sessionId: string): void {
    ActivityCountStore.incrementTasksCreated(sessionId);

    logger.debug('Task created recorded', {
      component: 'OperationTracker',
      operation: 'recordTaskCreated',
      metadata: { sessionId: sessionId.substring(0, 8) }
    });
  },

  /**
   * Record task updated
   */
  recordTaskUpdated(sessionId: string, isCompleted: boolean = false): void {
    ActivityCountStore.incrementTasksUpdated(sessionId, isCompleted);

    logger.debug('Task updated recorded', {
      component: 'OperationTracker',
      operation: 'recordTaskUpdated',
      metadata: { sessionId: sessionId.substring(0, 8), isCompleted }
    });
  },

  /**
   * Record context created
   */
  recordContextCreated(sessionId: string): void {
    ActivityCountStore.incrementContextsCreated(sessionId);

    logger.debug('Context created recorded', {
      component: 'OperationTracker',
      operation: 'recordContextCreated',
      metadata: { sessionId: sessionId.substring(0, 8) }
    });
  },

  /**
   * Take exclusive ownership of a session's un-flushed activity DELTA.
   *
   * The ONLY way to get at the in-memory counts. There is deliberately NO read-only
   * peek (`getActivityCounts` was deleted with its `SessionTracker` wrapper in an earlier task):
   * peeking and then persisting the value races the flush, which will
   * happily persist the same delta again — that is exactly how `finish()` came to
   * absolute-SET a delta over an accumulated total. Synchronous — call it BEFORE the
   * first `await` of whatever you are doing, and be ready to `restore` it if your
   * write fails.
   */
  consumeActivityCounts(sessionId: string): {
    tasks_created: number;
    tasks_updated: number;
    tasks_completed: number;
    contexts_created: number;
  } {
    return ActivityCountStore.consume(sessionId);
  },

  /**
   * Hand a consumed delta BACK because persisting it failed. See
   * `ActivityCountStore.restore`. Error path only.
   */
  restoreActivityCounts(sessionId: string, counts: ActivityCounts): void {
    ActivityCountStore.restore(sessionId, counts);
  },

  /**
   * Clear activity tracking for a session
   */
  clear(sessionId: string): void {
    ActivityCountStore.clear(sessionId);
  },

  /**
   * Record an activity event
   */
  async recordActivity(
    sessionId: string,
    activityType: string,
    activityData: Record<string, any> = {}
  ): Promise<void> {
    try {
      await ActivityRepo.insert(sessionId, activityType, activityData);
      await SessionRepo.updateActivityCount(sessionId);

      logger.debug(`Activity recorded: ${activityType}`, {
        component: 'OperationTracker',
        operation: 'recordActivity',
        metadata: { sessionId: sessionId.substring(0, 8), activityType }
      });

    } catch (error) {
      logger.error('Failed to record activity', error instanceof Error ? error : new Error('Unknown error'), {
        component: 'OperationTracker',
        operation: 'recordActivity',
        metadata: { sessionId, activityType }
      });
    }
  },

  /**
   * Flush all pending activity counts to database
   */
  async flushToDatabase(): Promise<{
    sessionsFlushed: number;
  }> {
    let sessionsFlushed = 0;

    try {
      // Snapshot-and-clear ATOMICALLY, before the first await. The previous shape
      // (`getAll()` → awaited loop → `clearAll()`) deleted every increment recorded
      // WHILE the loop was awaiting — a silent lost update. `consumeAll` takes
      // ownership of exactly what it will persist and leaves later increments alone.
      const allActivity = ActivityCountStore.consumeAll();

      for (const [sessionId, counts] of allActivity.entries()) {
        // Gate on the DELTA OBJECT, never on a hand-written field list. This condition
        // used to read `tasks_created || tasks_updated || contexts_created` — it omitted
        // `tasks_completed`, the fourth field, which it then passed to the write below.
        // `consumeAll()` has already deleted the delta from the store, so the skipped
        // branch DESTROYS it rather than deferring it. See `isEmptyDelta`.
        if (!isEmptyDelta(counts)) {
          await SessionRepo.applyActivityCounts(
            sessionId,
            counts.tasks_created,
            counts.tasks_updated,
            counts.tasks_completed,
            counts.contexts_created
          );
          sessionsFlushed++;
        }
      }

      logger.info(`Activity counts flushed to database`, {
        component: 'OperationTracker',
        operation: 'flushToDatabase',
        metadata: { sessionsFlushed }
      });

      return { sessionsFlushed };

    } catch (error) {
      logger.error('Failed to flush activity to database', error instanceof Error ? error : new Error('Unknown error'), {
        component: 'OperationTracker',
        operation: 'flushToDatabase'
      });

      return { sessionsFlushed };
    }
  }
};
