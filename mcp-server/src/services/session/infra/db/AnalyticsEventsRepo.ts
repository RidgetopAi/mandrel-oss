/**
 * AnalyticsEventsRepo - Database operations for analytics_events table
 */

import { db } from '../../../../config/database.js';
import { logger } from '../../../../utils/logger.js';

export const AnalyticsEventsRepo = {
  /**
   * Insert a session lifecycle event (start/end)
   */
  async insertSessionEvent(
    sessionId: string,
    eventType: 'session_start' | 'session_end',
    projectId?: string | null,
    metadata: Record<string, any> = {},
    durationMs?: number | null
  ): Promise<string | null> {
    try {
      const sql = `
        INSERT INTO analytics_events (
          actor, project_id, session_id, event_type, status, metadata, tags, duration_ms
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        RETURNING event_id
      `;

      const status = eventType === 'session_start' ? 'open' : 'closed';
      const tags = ['session', 'lifecycle'];

      const result = await db.query(sql, [
        'system',
        projectId || null,
        sessionId,
        eventType,
        status,
        JSON.stringify(metadata),
        tags,
        durationMs ?? null
      ]);

      return result.rows[0]?.event_id || null;

    } catch (error) {
      logger.error('Failed to insert session event', error instanceof Error ? error : new Error('Unknown error'), {
        component: 'AnalyticsEventsRepo',
        operation: 'insertSessionEvent',
        metadata: { sessionId, eventType }
      });
      return null;
    }
  },

  /**
   * Insert a general analytics event
   */
  async insert(
    actor: string,
    eventType: string,
    options: {
      projectId?: string | null;
      sessionId?: string | null;
      status?: string;
      metadata?: Record<string, any>;
      tags?: string[];
    } = {}
  ): Promise<string | null> {
    try {
      const sql = `
        INSERT INTO analytics_events (
          actor, project_id, session_id, event_type, status, metadata, tags
        ) VALUES ($1, $2, $3, $4, $5, $6, $7)
        RETURNING event_id
      `;

      const result = await db.query(sql, [
        actor,
        options.projectId || null,
        options.sessionId || null,
        eventType,
        options.status || 'completed',
        JSON.stringify(options.metadata || {}),
        options.tags || []
      ]);

      return result.rows[0]?.event_id || null;

    } catch (error) {
      logger.error('Failed to insert analytics event', error instanceof Error ? error : new Error('Unknown error'), {
        component: 'AnalyticsEventsRepo',
        operation: 'insert',
        metadata: { actor, eventType }
      });
      return null;
    }
  },

  /**
   * Update session end event
   */
  async updateSessionEnd(
    sessionId: string,
    metadata: Record<string, any>
  ): Promise<boolean> {
    try {
      const sql = `
        UPDATE analytics_events
        SET 
          status = 'closed',
          metadata = $2,
          resolved_at = NOW()
        WHERE session_id = $1 AND event_type = 'session_start'
      `;

      await db.query(sql, [sessionId, JSON.stringify(metadata)]);
      return true;

    } catch (error) {
      logger.error('Failed to update session end event', error instanceof Error ? error : new Error('Unknown error'), {
        component: 'AnalyticsEventsRepo',
        operation: 'updateSessionEnd',
        metadata: { sessionId }
      });
      return false;
    }
  }
};
