/**
 * AIDIS Event Logging Middleware
 * 
 * This middleware captures all AIDIS operations into the analytics_events table.
 * It provides the foundation for comprehensive analytics tracking across all
 * system operations including context storage, decision recording, and more.
 * 
 * Features:
 * - Automatic session ID generation and tracking
 * - Project context integration
 * - Error handling that doesn't break existing functionality
 * - Comprehensive event metadata collection
 * - Integration with existing database connection patterns
 */

import { db } from '../config/database.js';
import { projectHandler } from '../handlers/project.js';
import { randomUUID } from 'crypto';
import { logger } from '../utils/logger.js';

export interface AnalyticsEvent {
  actor: 'human' | 'ai' | 'system';
  project_id?: string;
  session_id?: string;
  context_id?: string;
  event_type: string;
  payload?: any;
  status?: 'open' | 'closed' | 'error';
  duration_ms?: number;
  tags?: string[];
  ai_model_used?: string;
  prompt_tokens?: number;
  completion_tokens?: number;
  feedback?: number;
  metadata?: any;
}

/**
 * Session management for tracking related events
 */
class SessionManager {
  private static currentSessionId: string | null = null;
  
  static generateSessionId(): string {
    this.currentSessionId = randomUUID();
    logger.info(`🔄 Generated new session ID: ${this.currentSessionId.substring(0, 8)}...`);
    return this.currentSessionId;
  }
  
  static getCurrentSessionId(): string {
    if (!this.currentSessionId) {
      this.currentSessionId = this.generateSessionId();
    }
    return this.currentSessionId;
  }
  
  static setSessionId(sessionId: string): void {
    this.currentSessionId = sessionId;
  }
}

/**
 * Core event logging function
 */
export async function logEvent(event: AnalyticsEvent): Promise<string> {
  try {
    logger.info(`📊 Logging event: ${event.event_type} by ${event.actor}`);
    
    // Ensure we have a session ID
    const sessionId = event.session_id || SessionManager.getCurrentSessionId();
    
    // Get current project if not specified
    let projectId = event.project_id;
    if (!projectId) {
      try {
        await projectHandler.initializeSession();
        // PROJECT-SCOPE: effective — an analytics event is attributed to the project the call
        // was scoped to; under a binding that is the bound project.
        const currentProject = await projectHandler.getCurrentProject();
        projectId = currentProject?.id;
      } catch (error) {
        logger.warn('⚠️  Could not get current project for event logging', { metadata: { error } });
        // Continue without project_id - some events might not need it
      }
    }
    
    // Insert event into database
    const sql = `
      INSERT INTO analytics_events (
        actor, project_id, session_id, context_id, event_type, payload,
        status, duration_ms, tags, ai_model_used, prompt_tokens,
        completion_tokens, feedback, metadata
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
      RETURNING event_id, timestamp
    `;
    
    const params = [
      event.actor,
      projectId,
      sessionId,
      event.context_id || null,
      event.event_type,
      event.payload ? JSON.stringify(event.payload) : null,
      event.status || null,
      event.duration_ms || null,
      event.tags || [],
      event.ai_model_used || null,
      event.prompt_tokens || null,
      event.completion_tokens || null,
      event.feedback || null,
      event.metadata ? JSON.stringify(event.metadata) : null
    ];
    
    const result = await db.query(sql, params);
    const eventId = result.rows[0].event_id;
    const timestamp = result.rows[0].timestamp;
    
    logger.info(`✅ Event logged: ${eventId.substring(0, 8)}... at ${timestamp}`);
    return eventId;
    
  } catch (error) {
    logger.error('❌ Failed to log event', error as Error);
    // Don't throw - we don't want logging failures to break functionality
    return 'error';
  }
}

/**
 * Specialized function for logging context-related events
 */
export async function logContextEvent(
  contextId: string, 
  eventType: string, 
  payload: any,
  actor: 'human' | 'ai' | 'system' = 'ai'
): Promise<string> {
  return logEvent({
    actor,
    context_id: contextId,
    event_type: `context_${eventType}`,
    payload,
    status: 'closed',
    tags: ['context', eventType]
  });
}

/**
 * Specialized function for logging decision-related events  
 */
export async function logDecisionEvent(
  decisionId: string,
  eventType: string,
  payload: any,
  actor: 'human' | 'ai' | 'system' = 'ai'
): Promise<string> {
  return logEvent({
    actor,
    event_type: `decision_${eventType}`,
    payload: {
      decision_id: decisionId,
      ...payload
    },
    status: 'closed',
    tags: ['decision', eventType]
  });
}

/**
 * Log hierarchical memory search queries with detailed observability data
 * Instance #49: Oracle Priority 1 - Observability before expansion
 */
export async function logHierarchicalMemorySearch(data: {
  query: string;
  mode: 'recency' | 'balanced' | 'baseline';
  intentKeywordsMatched: string[];
  results: any[];
  queryLatencyMs: number;
  filters: any;
  projectId?: string;
  hierarchicalEnabled: boolean;
}): Promise<string> {

  // Calculate ages in days
  const calculateAgeDays = (createdAt: Date): number => {
    return Math.round((Date.now() - new Date(createdAt).getTime()) / (1000 * 60 * 60 * 24));
  };

  const top1AgeDays = data.results[0] ? calculateAgeDays(data.results[0].createdAt) : null;
  const top5AgesDays = data.results.slice(0, 5).map(r => calculateAgeDays(r.createdAt));

  // Check if "too old" for recency query (>30 days for recency-focused mode)
  const isTooOld = data.mode === 'recency' && top1AgeDays !== null && top1AgeDays > 30;

  // Extract score components from top result
  const topResultScores = data.results[0] ? {
    similarity: data.results[0].similarity,
    recency_score: data.results[0].recency_score,
    importance_score: data.results[0].importance_score,
    type_weight: data.results[0].type_weight,
    combined_score: data.results[0].combined_score
  } : null;

  // Determine weights used based on mode
  const weightsUsed = data.mode === 'recency' ? {
    recency_weight: 0.90,
    similarity_weight: 0.05,
    importance_weight: 0.025,
    type_weight: 0.025
  } : data.mode === 'balanced' ? {
    recency_weight: 0.25,
    similarity_weight: 0.25,
    importance_weight: 0.25,
    type_weight: 0.25
  } : {
    recency_weight: 0.0,
    similarity_weight: 1.0,
    importance_weight: 0.0,
    type_weight: 0.0
  };

  return logEvent({
    actor: 'ai',
    project_id: data.projectId,
    event_type: 'hierarchical_memory_search',
    payload: {
      query: data.query,
      mode: data.mode,
      intent_keywords_matched: data.intentKeywordsMatched,
      is_recency_query: data.mode === 'recency',
      results_count: data.results.length,
      top_1_age_days: top1AgeDays,
      top_5_ages_days: top5AgesDays,
      query_latency_ms: data.queryLatencyMs,
      top_result_scores: topResultScores,
      is_too_old: isTooOld,
      filters: {
        projectId: data.filters.projectId,
        type: data.filters.type,
        tags: data.filters.tags,
        minSimilarity: data.filters.minSimilarity
      }
    },
    metadata: {
      hierarchical_enabled: data.hierarchicalEnabled,
      weights_used: weightsUsed
    },
    duration_ms: data.queryLatencyMs,
    status: 'closed',
    tags: ['hierarchical_memory', 'search', data.mode, 'observability']
  });
}

/**
 * Export session manager for external access
 */
// SessionManager is internal, not exported
