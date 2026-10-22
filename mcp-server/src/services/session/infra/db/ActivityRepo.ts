/**
 * ActivityRepo - Database operations for session_activities table
 */

import { db } from '../../../../config/database.js';
import { logger } from '../../../../utils/logger.js';
import type { SessionActivity } from '../../../../types/session.js';

export const ActivityRepo = {
  /**
   * Insert a new activity record
   */
  async insert(
    sessionId: string,
    activityType: string,
    activityData: Record<string, any> = {}
  ): Promise<string | null> {
    try {
      const sql = `
        INSERT INTO session_activities (
          session_id, activity_type, activity_data, occurred_at
        ) VALUES ($1, $2, $3, NOW())
        RETURNING id
      `;

      const result = await db.query(sql, [sessionId, activityType, JSON.stringify(activityData)]);
      return result.rows[0]?.id || null;

    } catch (error) {
      logger.error('Failed to insert activity', error instanceof Error ? error : new Error('Unknown error'), {
        component: 'ActivityRepo',
        operation: 'insert',
        metadata: { sessionId, activityType }
      });
      return null;
    }
  },

  /**
   * Get activities for a session with optional type filtering
   */
  async listBySession(
    sessionId: string,
    activityType?: string,
    limit: number = 100
  ): Promise<SessionActivity[]> {
    try {
      const sql = activityType
        ? `SELECT id, session_id, activity_type, activity_data, occurred_at, created_at
           FROM session_activities
           WHERE session_id = $1 AND activity_type = $2
           ORDER BY occurred_at DESC
           LIMIT $3`
        : `SELECT id, session_id, activity_type, activity_data, occurred_at, created_at
           FROM session_activities
           WHERE session_id = $1
           ORDER BY occurred_at DESC
           LIMIT $2`;

      const params = activityType
        ? [sessionId, activityType, limit]
        : [sessionId, limit];

      const result = await db.query(sql, params);

      return result.rows.map(row => ({
        id: row.id,
        session_id: row.session_id,
        activity_type: row.activity_type,
        activity_data: row.activity_data,
        occurred_at: row.occurred_at,
        created_at: row.created_at
      }));

    } catch (error) {
      logger.error('Failed to list activities', error instanceof Error ? error : new Error('Unknown error'), {
        component: 'ActivityRepo',
        operation: 'listBySession',
        metadata: { sessionId }
      });
      return [];
    }
  },

  /**
   * Count activities for a session
   */
  async countBySession(sessionId: string): Promise<number> {
    try {
      const result = await db.query(
        'SELECT COUNT(*) as count FROM session_activities WHERE session_id = $1',
        [sessionId]
      );
      return parseInt(result.rows[0].count) || 0;
    } catch (error) {
      logger.error('Failed to count activities', error instanceof Error ? error : new Error('Unknown error'), {
        component: 'ActivityRepo',
        operation: 'countBySession',
        metadata: { sessionId }
      });
      return 0;
    }
  }
};
