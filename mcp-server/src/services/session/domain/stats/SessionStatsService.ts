/**
 * SessionStatsService - Domain service for session statistics and analytics
 */

import { db } from '../../../../config/database.js';
import { logger } from '../../../../utils/logger.js';
import { SessionRepo, ActivityRepo } from '../../infra/db/index.js';
import { calculateBasicProductivity, calculateWeightedProductivity } from '../productivity/index.js';
import type { SessionStats } from '../../types.js';
import { DEPLOY_SMOKE_AGENT_TYPE } from '../../types.js';

export const SessionStatsService = {
  /**
   * Get session statistics for analytics
   */
  async getSessionStats(projectId?: string): Promise<SessionStats> {
    try {
      const projectFilter = projectId ? 'AND project_id = $1' : '';
      const params = projectId ? [projectId] : [];

      // Exclude deploy-smoke litter sessions. close the
      // class so these analytics_events read paths can't leak smoke if ever routed.
      // NULL agent_type rows are intentionally KEPT (the subquery only matches the
      // explicit marker). Constant single-sourced from session/types.ts.
      const excludeSmoke = `
        AND session_id NOT IN (
          SELECT id FROM sessions WHERE agent_type = '${DEPLOY_SMOKE_AGENT_TYPE}'
        )`;

      // Get total sessions count
      const totalSessionsSql = `
        SELECT COUNT(DISTINCT session_id) as total
        FROM analytics_events
        WHERE event_type = 'session_start' ${projectFilter} ${excludeSmoke}
      `;

      const totalResult = await db.query(totalSessionsSql, params);
      const totalSessions = parseInt(totalResult.rows[0].total) || 0;

      // Get average duration for completed sessions
      const avgDurationSql = `
        SELECT AVG(duration_ms) as avg_duration
        FROM analytics_events
        WHERE event_type = 'session_end' ${projectFilter} ${excludeSmoke}
      `;

      const avgResult = await db.query(avgDurationSql, params);
      const avgDuration = parseInt(avgResult.rows[0].avg_duration) || 0;

      // Calculate retention rate
      const completedSessionsSql = `
        SELECT COUNT(DISTINCT ae1.session_id) as completed
        FROM analytics_events ae1
        WHERE ae1.event_type = 'session_start' ${projectFilter}
        AND ae1.session_id NOT IN (
          SELECT id FROM sessions WHERE agent_type = '${DEPLOY_SMOKE_AGENT_TYPE}'
        )
        AND EXISTS (
          SELECT 1 FROM analytics_events ae2 
          WHERE ae2.session_id = ae1.session_id
          AND ae2.event_type NOT IN ('session_start', 'session_end')
        )
      `;

      const completedResult = await db.query(completedSessionsSql, params);
      const completedSessions = parseInt(completedResult.rows[0].completed) || 0;
      const retentionRate = totalSessions > 0 ? Math.round((completedSessions / totalSessions) * 100) / 100 : 0;

      // Get sessions by day for last 30 days
      const sessionsByDaySql = `
        SELECT 
          DATE(timestamp) as date,
          COUNT(DISTINCT session_id) as count
        FROM analytics_events
        WHERE event_type = 'session_start'
        AND timestamp >= NOW() - INTERVAL '30 days'
        ${projectFilter} ${excludeSmoke}
        GROUP BY DATE(timestamp)
        ORDER BY date DESC
      `;

      const dayResult = await db.query(sessionsByDaySql, params);
      const sessionsByDay = dayResult.rows.map((row: any) => ({
        date: row.date,
        count: parseInt(row.count)
      }));

      // Calculate overall productivity score
      const productivitySql = `
        SELECT AVG(productivity_score) as avg_productivity
        FROM sessions
        WHERE ended_at IS NOT NULL ${projectFilter}
          -- Exclude deploy-smoke litter sessions.
          AND agent_type IS DISTINCT FROM '${DEPLOY_SMOKE_AGENT_TYPE}'
      `;

      const productivityResult = await db.query(productivitySql, params);
      const productivityScore = Math.round((parseFloat(productivityResult.rows[0].avg_productivity) || 0) * 100) / 100;

      return {
        totalSessions,
        avgDuration,
        productivityScore,
        retentionRate,
        sessionsByDay
      };

    } catch (error) {
      logger.error('❌ Failed to get session stats', error as Error);
      throw error;
    }
  },

  /**
   * Calculate productivity score using configurable formula
   */
  async calculateProductivityScore(
    sessionId: string,
    configName: string = 'default'
  ): Promise<number> {
    try {
      const weights = await SessionRepo.getProductivityConfig(configName);

      if (!weights) {
        logger.warn(`Productivity config '${configName}' not found, using fallback calculation`, {
          component: 'SessionStatsService',
          operation: 'calculateProductivityScore'
        });
        return this.calculateProductivity(sessionId);
      }

      const sessionData = await SessionRepo.getSessionData(sessionId);
      if (!sessionData) {
        logger.warn(`Session ${sessionId} not found for productivity calculation`, {
          component: 'SessionStatsService',
          operation: 'calculateProductivityScore'
        });
        return 0;
      }

      const score = calculateWeightedProductivity(sessionData, weights);

      // Update session with calculated score
      await SessionRepo.updateProductivityScore(sessionId, score);

      logger.debug(`Productivity score calculated: ${score}`, {
        component: 'SessionStatsService',
        operation: 'calculateProductivityScore',
        metadata: { sessionId: sessionId.substring(0, 8), configName, score }
      });

      return score;

    } catch (error) {
      logger.error('Failed to calculate productivity score', error instanceof Error ? error : new Error('Unknown error'), {
        component: 'SessionStatsService',
        operation: 'calculateProductivityScore',
        metadata: { sessionId }
      });
      return 0;
    }
  },

  /**
   * Calculate basic productivity
   */
  async calculateProductivity(sessionId: string): Promise<number> {
    try {
      const sessionData = await SessionRepo.getSessionData(sessionId);

      if (!sessionData) {
        return 0;
      }

      const productivity = calculateBasicProductivity(sessionData);

      logger.info(`📊 Session ${sessionId.substring(0, 8)}... productivity: ${productivity.toFixed(2)}`);
      return productivity;

    } catch (error) {
      logger.error('❌ Failed to calculate productivity', error as Error);
      return 0;
    }
  },

  /**
   * Generate comprehensive session summary
   */
  async generateSessionSummary(sessionId: string): Promise<string> {
    try {
      const sessionResult = await db.query(`
        SELECT * FROM v_session_summaries WHERE id = $1
      `, [sessionId]);

      if (sessionResult.rows.length === 0) {
        return `❌ Session not found: ${sessionId}`;
      }

      const session = sessionResult.rows[0];
      const activities = await ActivityRepo.listBySession(sessionId, undefined, 5);

      const filesResult = await db.query(`
        SELECT file_path, lines_added, lines_deleted
        FROM session_files
        WHERE session_id = $1
        ORDER BY (lines_added + lines_deleted) DESC
        LIMIT 3
      `, [sessionId]);

      const decisionsCount = await SessionRepo.countDecisions(sessionId);

      const { formatSessionSummary } = await import('../../../../utils/sessionFormatters.js');
      return formatSessionSummary(session, activities, filesResult.rows, decisionsCount);

    } catch (error) {
      logger.error('Failed to generate session summary', error instanceof Error ? error : new Error('Unknown error'), {
        component: 'SessionStatsService',
        operation: 'generateSessionSummary',
        metadata: { sessionId }
      });
      throw error;
    }
  },

  /**
   * Get enhanced session statistics with grouping
   */
  async getSessionStatsEnhanced(options: {
    projectId?: string;
    period?: 'day' | 'week' | 'month' | 'all';
    groupBy?: 'project' | 'agent' | 'tag' | 'none';
    phase2Only?: boolean;
  } = {}): Promise<any> {
    try {
      const { projectId, period = 'all', groupBy: _groupBy = 'none', phase2Only = false } = options;

      // Calculate date filter
      let dateFilter = '';
      let dateParam: Date | null = null;
      if (period === 'day') {
        dateParam = new Date(Date.now() - 24 * 60 * 60 * 1000);
        dateFilter = 'AND s.started_at >= $2';
      } else if (period === 'week') {
        dateParam = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        dateFilter = 'AND s.started_at >= $2';
      } else if (period === 'month') {
        dateParam = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
        dateFilter = 'AND s.started_at >= $2';
      }

      const phase2Filter = phase2Only ? 'AND s.productivity_score IS NOT NULL' : '';

      const params: any[] = [];
      if (projectId) params.push(projectId);
      if (dateParam) params.push(dateParam);

      // Overall stats
      const overallStatsSQL = `
        SELECT
          COUNT(*) as total_sessions,
          ROUND(AVG(EXTRACT(EPOCH FROM (COALESCE(s.ended_at, NOW()) - s.started_at)) / 60)::numeric, 2) as avg_duration,
          ROUND(AVG(s.productivity_score)::numeric, 2) as avg_productivity,
          -- Task/context totals come from the CHILD TABLES, not the denormalized
          -- s.tasks_created / s.contexts_created columns, which finish() zeroed on
          -- every session end. Correlated subqueries per row rather
          -- than JOINs: two LEFT JOINs under one aggregate fan out cartesian-style and
          -- inflate BOTH counts.
          SUM((SELECT COUNT(*) FROM tasks t    WHERE t.session_id = s.id
                                               AND t.archived_at IS NULL)) as total_tasks_created,
          SUM((SELECT COUNT(*) FROM tasks t    WHERE t.session_id = s.id
                                               AND t.archived_at IS NULL
                                                 AND t.status = 'completed')) as total_tasks_completed,
          SUM((SELECT COUNT(*) FROM contexts c WHERE c.session_id = s.id
                                               AND c.archived_at IS NULL)) as total_contexts_created,
          SUM(COALESCE(s.lines_added, 0)) as total_loc_added,
          SUM(COALESCE(s.lines_deleted, 0)) as total_loc_deleted,
          SUM(COALESCE(s.lines_net, 0)) as total_net_loc,
          -- Tokens have NO child table and are therefore not recomputable — this column
          -- is the only durable record. Sessions zeroed by the pre-fix finish() have
          -- lost their token history permanently; no backfill exists (spec section 9).
          SUM(COALESCE(s.total_tokens, 0)) as total_tokens
        FROM sessions s
        WHERE ${projectId ? `s.project_id = $1` : 'TRUE'}
          ${dateFilter}
          ${phase2Filter}
          -- Exclude deploy-smoke litter sessions.
          AND s.agent_type IS DISTINCT FROM '${DEPLOY_SMOKE_AGENT_TYPE}'
      `;

      const overallResult = await db.query(overallStatsSQL, params);

      // Top tags query
      const topTagsSQL = `
        SELECT tag
        FROM sessions s, UNNEST(s.tags) as tag
        WHERE s.tags IS NOT NULL AND array_length(s.tags, 1) > 0
          ${projectId ? `AND s.project_id = $1` : ''}
          ${dateFilter.replace('s.started_at', 'started_at')}
          ${phase2Filter.replace('s.productivity_score', 'productivity_score')}
          -- Exclude deploy-smoke litter sessions.
          AND s.agent_type IS DISTINCT FROM '${DEPLOY_SMOKE_AGENT_TYPE}'
        GROUP BY tag
        ORDER BY COUNT(*) DESC
        LIMIT 10
      `;
      const topTagsResult = await db.query(topTagsSQL, params);

      return {
        overall: {
          totalSessions: parseInt(overallResult.rows[0].total_sessions),
          avgDuration: parseFloat(overallResult.rows[0].avg_duration) || null,
          avgProductivity: parseFloat(overallResult.rows[0].avg_productivity) || null,
          totalTasksCreated: parseInt(overallResult.rows[0].total_tasks_created),
          totalTasksCompleted: parseInt(overallResult.rows[0].total_tasks_completed),
          totalContextsCreated: parseInt(overallResult.rows[0].total_contexts_created),
          totalLOC: parseInt(overallResult.rows[0].total_net_loc),
          totalTokens: parseInt(overallResult.rows[0].total_tokens)
        },
        topTags: topTagsResult.rows.map(r => r.tag)
      };

    } catch (error) {
      logger.error('Failed to get enhanced session stats', error instanceof Error ? error : new Error('Unknown error'), {
        component: 'SessionStatsService',
        operation: 'getSessionStatsEnhanced',
        metadata: options
      });
      throw error;
    }
  }
};
