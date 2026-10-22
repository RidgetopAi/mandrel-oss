/**
 * Correlation domain service
 * Handles commit-session correlation
 */

import { 
  CorrelateCommitsWithSessionsRequest, 
  CorrelateCommitsWithSessionsResponse 
} from '../../../../types/git';
import { CommitRepo } from '../../infra/db/CommitRepo';
import { CorrelationRepo, Correlation } from '../../infra/db/CorrelationRepo';
import { createServiceError } from '../../utils/errors';
import { logger } from '../../../../config/logger';

export class CorrelationService {
  /**
   * Correlate commits with sessions based on timing and context
   */
  static async correlateCommitsWithSessions(
    request: CorrelateCommitsWithSessionsRequest
  ): Promise<CorrelateCommitsWithSessionsResponse> {
    const { project_id, since, confidence_threshold = 0.3 } = request;
    const startTime = Date.now();
    
    try {
      logger.info(`🔗 CorrelationService.correlateCommitsWithSessions - Project: ${project_id}`);
      
      const commits = await CommitRepo.getCommitsForCorrelation(project_id, since);
      const sessions = await CorrelationRepo.getSessionsForProject(project_id);
      
      let linksCreated = 0;
      let linksUpdated = 0;
      let highConfidenceLinks = 0;
      const correlationStats = {
        author_matches: 0,
        time_proximity_matches: 0,
        content_similarity_matches: 0
      };
      
      for (const commit of commits) {
        const correlations = this.correlateCommit(commit, sessions, confidence_threshold);
        
        for (const correlation of correlations) {
          const existingLink = await CorrelationRepo.findExistingLink(commit.id, correlation.session_id);
          
          if (existingLink) {
            if (correlation.confidence_score > existingLink.confidence_score) {
              await CorrelationRepo.updateLink(existingLink.id, correlation);
              linksUpdated++;
            }
          } else {
            await CorrelationRepo.createLink(commit.id, correlation);
            linksCreated++;
          }
          
          if (correlation.confidence_score > 0.7) highConfidenceLinks++;
          if (correlation.author_match) correlationStats.author_matches++;
          if (correlation.time_proximity_minutes !== undefined && correlation.time_proximity_minutes < 60) {
            correlationStats.time_proximity_matches++;
          }
        }
      }
      
      const processingTime = Date.now() - startTime;
      logger.info(`✅ CorrelationService completed in ${processingTime}ms`);
      
      return {
        project_id,
        links_created: linksCreated,
        links_updated: linksUpdated,
        high_confidence_links: highConfidenceLinks,
        processing_time_ms: processingTime,
        correlation_stats: correlationStats
      };
    } catch (error) {
      throw createServiceError('CORRELATE_SESSIONS_FAILED', `Failed to correlate commits: ${error}`, request);
    }
  }

  /**
   * Correlate a single commit with sessions
   */
  private static correlateCommit(
    commit: any,
    sessions: any[],
    threshold: number
  ): Correlation[] {
    const correlations: Correlation[] = [];
    const commitDate = new Date(commit.author_date);
    
    for (const session of sessions) {
      const sessionStart = new Date(session.started_at);
      const sessionEnd = session.ended_at ? new Date(session.ended_at) : new Date();
      
      const timeProximity = this.calculateTimeProximity(commitDate, sessionStart, sessionEnd);
      
      if (timeProximity !== null && timeProximity <= 120) {
        let confidence = 0.3;
        
        if (timeProximity <= 30) confidence += 0.4;
        else if (timeProximity <= 60) confidence += 0.2;
        
        const authorMatch = false; // Placeholder
        if (authorMatch) confidence += 0.3;
        
        if (confidence >= threshold) {
          correlations.push({
            session_id: session.id,
            confidence_score: Math.min(confidence, 1.0),
            time_proximity_minutes: timeProximity,
            author_match: authorMatch,
            link_type: 'contributed'
          });
        }
      }
    }
    
    return correlations;
  }

  /**
   * Calculate time proximity between commit and session
   */
  private static calculateTimeProximity(
    commitDate: Date,
    sessionStart: Date,
    sessionEnd: Date
  ): number | null {
    const commitTime = commitDate.getTime();
    const startTime = sessionStart.getTime();
    const endTime = sessionEnd.getTime();
    
    if (commitTime >= startTime && commitTime <= endTime) return 0;
    
    const beforeStart = Math.abs(commitTime - startTime) / (1000 * 60);
    const afterEnd = Math.abs(commitTime - endTime) / (1000 * 60);
    
    return Math.min(beforeStart, afterEnd);
  }
}
