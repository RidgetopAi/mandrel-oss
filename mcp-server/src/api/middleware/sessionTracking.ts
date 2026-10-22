/**
 * Session Tracking Middleware
 * Automatically records session activities for MCP tool calls
 * Part of MCP → REST migration automation strategy
 */

import { SessionTracker } from '../../services/session/SessionTracker.js';
import { logger } from '../../utils/logger.js';

/**
 * Session Tracking Middleware
 * Provides helper functions to auto-track activities from MCP tools
 */
export class SessionTrackingMiddleware {
  /**
   * Auto-track context creation
   * Called after context_store MCP tool succeeds
   */
  static async trackContextStored(
    contextId: string,
    contextType: string,
    tags: string[],
    connectionId?: string
  ): Promise<void> {
    try {
      // Connection-scoped: track against THIS connection's session only.
      const activeSessionId = await SessionTracker.getActiveSession(connectionId);
      if (!activeSessionId) {
        logger.debug('No active session - skipping context_stored activity tracking');
        return;
      }

      await SessionTracker.recordActivity(activeSessionId, 'context_stored', {
        context_id: contextId,
        context_type: contextType,
        tags
      });

      logger.debug(`Tracked context_stored activity for session ${activeSessionId}`);
    } catch (error) {
      // Silent fail - don't break main operation
      const err = error as Error;
      logger.warn('Auto-track context_stored failed:', err);
    }
  }

  /**
   * Auto-track decision recording
   * Called after decision_record MCP tool succeeds
   */
  static async trackDecisionRecorded(
    decisionId: string,
    decisionType: string,
    impactLevel: string,
    connectionId?: string
  ): Promise<void> {
    try {
      // Connection-scoped: track against THIS connection's session only.
      const activeSessionId = await SessionTracker.getActiveSession(connectionId);
      if (!activeSessionId) {
        logger.debug('No active session - skipping decision_recorded activity tracking');
        return;
      }

      await SessionTracker.recordActivity(activeSessionId, 'decision_recorded', {
        decision_id: decisionId,
        decision_type: decisionType,
        impact_level: impactLevel
      });

      logger.debug(`Tracked decision_recorded activity for session ${activeSessionId}`);
    } catch (error) {
      // Silent fail - don't break main operation
      const err = error as Error;
      logger.warn('Auto-track decision_recorded failed:', err);
    }
  }

}

