/**
 * Session Analytics Handler
 * 
 * Provides comprehensive session analytics and statistics.
 * - Session statistics retrieval
 * - Session details lookup
 * - Session lifecycle (start/end)
 * - Operation recording
 */

import { logger } from '../../../utils/logger.js';
import { SessionTracker } from '../../../services/session/SessionTracker.js';
import { logEvent } from '../../../middleware/eventLogger.js';
import { SessionAnalyticsResult, SessionDetailsResult } from '../types.js';

export class SessionAnalyticsHandler {
  
  /**
   * Get comprehensive session statistics
   */
  static async getSessionStats(projectId?: string): Promise<SessionAnalyticsResult> {
    try {
      logger.info(`📊 Getting session statistics for project: ${projectId || 'all'}`);
      
      await logEvent({
        actor: 'ai',
        project_id: projectId,
        event_type: 'analytics_session_stats_request',
        status: 'open',
        tags: ['analytics', 'session', 'statistics']
      });
      
      const startTime = Date.now();
      const stats = await SessionTracker.getSessionStats(projectId);
      const duration = Date.now() - startTime;
      
      await logEvent({
        actor: 'ai',
        project_id: projectId,
        event_type: 'analytics_session_stats_completed',
        status: 'closed',
        duration_ms: duration,
        metadata: {
          total_sessions: stats.totalSessions,
          avg_duration: stats.avgDuration,
          productivity_score: stats.productivityScore
        },
        tags: ['analytics', 'session', 'statistics', 'completed']
      });
      
      logger.info(`✅ Session statistics retrieved in ${duration}ms`);
      logger.info(`   Sessions: ${stats.totalSessions}, Avg Duration: ${Math.round(stats.avgDuration/1000)}s`);
      logger.info(`   Productivity: ${stats.productivityScore}, Retention: ${stats.retentionRate}`);
      
      return {
        success: true,
        data: stats,
        timestamp: new Date().toISOString()
      };
      
    } catch (error) {
      logger.error('❌ Failed to get session statistics', error as Error);
      
      await logEvent({
        actor: 'ai',
        project_id: projectId,
        event_type: 'analytics_session_stats_error',
        status: 'error',
        metadata: {
          error: error instanceof Error ? error.message : 'Unknown error'
        },
        tags: ['analytics', 'session', 'statistics', 'error']
      });
      
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        timestamp: new Date().toISOString()
      };
    }
  }
  
  /**
   * Get detailed session information
   */
  static async getSessionDetails(sessionId: string): Promise<SessionDetailsResult> {
    try {
      logger.info(`🔍 Getting session details for: ${sessionId.substring(0, 8)}...`);
      
      await logEvent({
        actor: 'ai',
        session_id: sessionId,
        event_type: 'analytics_session_details_request',
        status: 'open',
        tags: ['analytics', 'session', 'details']
      });
      
      const startTime = Date.now();
      const sessionData = await SessionTracker.getSessionData(sessionId);
      const duration = Date.now() - startTime;
      
      if (!sessionData) {
        logger.warn(`⚠️  Session not found: ${sessionId}`);
        
        await logEvent({
          actor: 'ai',
          session_id: sessionId,
          event_type: 'analytics_session_details_not_found',
          status: 'error',
          duration_ms: duration,
          tags: ['analytics', 'session', 'details', 'not_found']
        });
        
        return {
          success: false,
          error: 'Session not found',
          timestamp: new Date().toISOString()
        };
      }
      
      await logEvent({
        actor: 'ai',
        session_id: sessionId,
        event_type: 'analytics_session_details_completed',
        status: 'closed',
        duration_ms: duration,
        metadata: {
          contexts_created: sessionData.contexts_created,
          decisions_created: sessionData.decisions_created,
          operations_count: sessionData.operations_count,
          productivity_score: sessionData.productivity_score,
          success_status: sessionData.success_status
        },
        tags: ['analytics', 'session', 'details', 'completed']
      });
      
      logger.info(`✅ Session details retrieved in ${duration}ms`);
      logger.info(`   Status: ${sessionData.success_status}, Operations: ${sessionData.operations_count}`);
      logger.info(`   Contexts: ${sessionData.contexts_created}, Decisions: ${sessionData.decisions_created}`);
      
      return {
        success: true,
        data: sessionData,
        timestamp: new Date().toISOString()
      };
      
    } catch (error) {
      logger.error('❌ Failed to get session details', error as Error);
      
      await logEvent({
        actor: 'ai',
        session_id: sessionId,
        event_type: 'analytics_session_details_error',
        status: 'error',
        metadata: {
          error: error instanceof Error ? error.message : 'Unknown error'
        },
        tags: ['analytics', 'session', 'details', 'error']
      });
      
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        timestamp: new Date().toISOString()
      };
    }
  }
  
  /**
   * Start a new session with analytics tracking
   */
  static async startSession(
    projectId?: string,
    title?: string,
    description?: string,
    sessionGoal?: string,
    tags?: string[],
    aiModel?: string,
    sessionType?: 'mcp-server' | 'AI Model',
    actor?: string
  ): Promise<SessionDetailsResult> {
    try {
      logger.info(`🚀 Starting new session for project: ${projectId || 'auto-detect'}`);
      if (title) logger.info(`   Title: ${title}`);
      if (sessionGoal) logger.info(`   Goal: ${sessionGoal}`);
      if (sessionType) logger.info(`   Type: ${sessionType}`);

      const startTime = Date.now();

      const sessionId = await SessionTracker.startSession(
        projectId,
        title,
        description,
        sessionGoal,
        tags,
        aiModel,
        sessionType,
        undefined, // connectionId — REST sessions have no connection concept
        actor,     // Phase 1: attribute the session to the derived actor
        // W3: the REST /api/v2/sessions/start route is a deliberate open.
        'explicit'
      );

      const duration = Date.now() - startTime;
      const sessionData = await SessionTracker.getSessionData(sessionId);

      await logEvent({
        actor: 'ai',
        project_id: projectId,
        session_id: sessionId,
        event_type: 'analytics_session_started',
        status: 'open',
        duration_ms: duration,
        metadata: {
          session_id: sessionId,
          project_id: projectId,
          title,
          session_goal: sessionGoal,
          tags,
          ai_model: aiModel
        },
        tags: ['analytics', 'session', 'start']
      });

      logger.info(`✅ Session started: ${sessionId.substring(0, 8)}... in ${duration}ms`);

      return {
        success: true,
        data: sessionData || undefined,
        timestamp: new Date().toISOString()
      };

    } catch (error) {
      logger.error('❌ Failed to start session', error as Error);

      await logEvent({
        actor: 'ai',
        project_id: projectId,
        event_type: 'analytics_session_start_error',
        status: 'error',
        metadata: {
          error: error instanceof Error ? error.message : 'Unknown error'
        },
        tags: ['analytics', 'session', 'start', 'error']
      });

      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        timestamp: new Date().toISOString()
      };
    }
  }
  
  /**
   * End a session with analytics tracking
   */
  static async endSession(sessionId: string): Promise<SessionDetailsResult> {
    try {
      logger.info(`🏁 Ending session: ${sessionId.substring(0, 8)}...`);
      
      const startTime = Date.now();
      const sessionData = await SessionTracker.endSession(sessionId);
      const duration = Date.now() - startTime;
      
      await logEvent({
        actor: 'ai',
        session_id: sessionId,
        event_type: 'analytics_session_ended',
        status: 'closed',
        duration_ms: duration,
        metadata: {
          session_duration_ms: sessionData.duration_ms,
          contexts_created: sessionData.contexts_created,
          decisions_created: sessionData.decisions_created,
          productivity_score: sessionData.productivity_score,
          success_status: sessionData.success_status
        },
        tags: ['analytics', 'session', 'end', 'completed']
      });
      
      logger.info(`✅ Session ended: ${sessionId.substring(0, 8)}... in ${duration}ms`);
      logger.info(`   Final productivity score: ${sessionData.productivity_score}`);
      logger.info(`   Status: ${sessionData.success_status}`);
      
      return {
        success: true,
        data: sessionData,
        timestamp: new Date().toISOString()
      };
      
    } catch (error) {
      logger.error('❌ Failed to end session', error as Error);
      
      await logEvent({
        actor: 'ai',
        session_id: sessionId,
        event_type: 'analytics_session_end_error',
        status: 'error',
        metadata: {
          error: error instanceof Error ? error.message : 'Unknown error'
        },
        tags: ['analytics', 'session', 'end', 'error']
      });
      
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        timestamp: new Date().toISOString()
      };
    }
  }
  
  /**
   * Get current active session information
   */
  static async getActiveSession(): Promise<SessionDetailsResult> {
    try {
      logger.info('🔍 Getting active session information');
      
      const startTime = Date.now();
      // Dashboard READ path (REST /sessions/active): no connection of its own,
      // wants the most-recent session anywhere → explicit global fallback.
      const activeSessionId = await SessionTracker.getActiveSession(undefined, { allowGlobalFallback: true });

      if (!activeSessionId) {
        logger.info('ℹ️  No active session found');
        
        return {
          success: false,
          error: 'No active session found',
          timestamp: new Date().toISOString()
        };
      }
      
      const sessionData = await SessionTracker.getSessionData(activeSessionId);
      const duration = Date.now() - startTime;
      
      await logEvent({
        actor: 'ai',
        session_id: activeSessionId,
        event_type: 'analytics_active_session_request',
        status: 'closed',
        duration_ms: duration,
        tags: ['analytics', 'session', 'active']
      });
      
      logger.info(`✅ Active session: ${activeSessionId.substring(0, 8)}... retrieved in ${duration}ms`);
      
      return {
        success: true,
        data: sessionData || undefined,
        timestamp: new Date().toISOString()
      };
      
    } catch (error) {
      logger.error('❌ Failed to get active session', error as Error);
      
      await logEvent({
        actor: 'ai',
        event_type: 'analytics_active_session_error',
        status: 'error',
        metadata: {
          error: error instanceof Error ? error.message : 'Unknown error'
        },
        tags: ['analytics', 'session', 'active', 'error']
      });
      
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        timestamp: new Date().toISOString()
      };
    }
  }
  
}
