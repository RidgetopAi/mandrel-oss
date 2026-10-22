/**
 * Git Correlation Service for MCP Server
 * 
 * Provides session-to-commit correlation logic.
 * This service replaces the backend SessionDetailService.correlateSessionWithGit
 * import, making mcp-server self-contained as source of truth.
 * 
 * Phase 3 Architecture Consolidation
 */

import { db } from '../config/database.js';
import { logger } from '../utils/logger.js';

export interface CorrelationResult {
  success: boolean;
  linksCreated: number;
  linksUpdated: number;
  confidence: number;
  message: string;
}

export interface CommitCorrelation {
  session_id: string;
  confidence_score: number;
  time_proximity_minutes: number;
  author_match: boolean;
  link_type: string;
  content_similarity?: number;
}

export interface CorrelateCommitsRequest {
  project_id: string;
  since?: Date;
  confidence_threshold?: number;
}

export interface GetRecentCommitsRequest {
  project_id: string;
  hours: number;
  branch?: string;
  author?: string;
}

export interface GitCommit {
  id: string;
  project_id: string;
  commit_sha: string;
  short_sha: string;
  message: string;
  author_name: string;
  author_email: string;
  author_date: string;
  committer_name?: string;
  committer_email?: string;
  committer_date?: string;
  branch_name?: string;
  parent_shas?: string[];
  is_merge_commit?: boolean;
  files_changed?: number;
  insertions?: number;
  deletions?: number;
  commit_type?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
}

export interface GetRecentCommitsResponse {
  commits: GitCommit[];
  total_count: number;
  time_range_hours: number;
  branch_filter: string;
  author_filter: string;
}

export interface CorrelateCommitsResponse {
  project_id: string;
  links_created: number;
  links_updated: number;
  high_confidence_links: number;
  processing_time_ms: number;
  correlation_stats: {
    author_matches: number;
    time_proximity_matches: number;
    content_similarity_matches: number;
  };
}

/**
 * Git Correlation Service
 * Handles session↔commit correlation logic within mcp-server
 */
export class GitCorrelationService {
  
  /**
   * Correlate a single session with git commits
   * Main entry point for session-level correlation
   */
  static async correlateSessionWithGit(sessionId: string): Promise<CorrelationResult> {
    try {
      logger.info(`🔗 Correlating session ${sessionId.substring(0, 8)}... with git commits`);
      
      // Get session details (single consolidated `sessions` table)
      const sessionQuery = `
        SELECT project_id, started_at, ended_at
        FROM sessions
        WHERE id = $1
      `;
      
      const sessionResult = await db.query(sessionQuery, [sessionId]);
      
      if (sessionResult.rows.length === 0) {
        return {
          success: false,
          linksCreated: 0,
          linksUpdated: 0,
          confidence: 0,
          message: 'Session not found'
        };
      }
      
      const session = sessionResult.rows[0];
      
      if (!session.project_id) {
        return {
          success: false,
          linksCreated: 0,
          linksUpdated: 0,
          confidence: 0,
          message: 'Session not assigned to a project'
        };
      }
      
      // Run git correlation
      const correlationResult = await this.correlateCommitsWithSessions({
        project_id: session.project_id,
        since: new Date(session.started_at),
        confidence_threshold: 0.2 // Lower threshold for individual session correlation
      });
      
      return {
        success: true,
        linksCreated: correlationResult.links_created,
        linksUpdated: correlationResult.links_updated,
        confidence: correlationResult.high_confidence_links > 0 ? 0.8 : 0.4,
        message: `Correlation completed: ${correlationResult.links_created} new links, ${correlationResult.links_updated} updated`
      };
      
    } catch (error) {
      logger.error('Session git correlation error', error as Error);
      return {
        success: false,
        linksCreated: 0,
        linksUpdated: 0,
        confidence: 0,
        message: error instanceof Error ? error.message : 'Failed to correlate session with git'
      };
    }
  }

  /**
   * Correlate all commits in a project with sessions
   * Batch correlation for project-level analysis
   */
  static async correlateCommitsWithSessions(request: CorrelateCommitsRequest): Promise<CorrelateCommitsResponse> {
    const { project_id, since, confidence_threshold = 0.3 } = request;
    const startTime = Date.now();
    
    try {
      logger.info(`🔗 GitCorrelationService.correlateCommitsWithSessions - Project: ${project_id}`);
      
      // Get commits to correlate
      let commitSql = `
        SELECT gc.*, p.name as project_name
        FROM git_commits gc
        JOIN projects p ON gc.project_id = p.id
        WHERE gc.project_id = $1
      `;
      const params: (string | Date)[] = [project_id];
      
      if (since) {
        commitSql += ` AND gc.author_date >= $2`;
        params.push(since.toISOString());
      }
      
      commitSql += ` ORDER BY gc.author_date DESC`;
      
      const commitsResult = await db.query(commitSql, params);
      const commits = commitsResult.rows;
      
      // Get sessions for correlation (single consolidated `sessions` table)
      const sessionsResult = await db.query(`
        SELECT id, started_at, ended_at, agent_type
        FROM sessions
        WHERE project_id = $1
        ORDER BY started_at DESC
      `, [project_id]);
      const sessions = sessionsResult.rows;
      
      let linksCreated = 0;
      let linksUpdated = 0;
      let highConfidenceLinks = 0;
      const correlationStats = {
        author_matches: 0,
        time_proximity_matches: 0,
        content_similarity_matches: 0
      };
      
      // Process correlation for each commit
      for (const commit of commits) {
        const correlationResults = this.correlateCommitWithSessions(
          commit,
          sessions,
          confidence_threshold
        );
        
        for (const correlation of correlationResults) {
          const existingLink = await this.findExistingSessionLink(commit.id, correlation.session_id);
          
          if (existingLink) {
            // Update existing link if confidence improved
            if (correlation.confidence_score > existingLink.confidence_score) {
              await this.updateSessionLink(existingLink.id, correlation);
              linksUpdated++;
            }
          } else {
            // Create new link
            await this.createSessionLink(commit.id, correlation);
            linksCreated++;
          }
          
          if (correlation.confidence_score > 0.7) {
            highConfidenceLinks++;
          }
          
          // Update stats
          if (correlation.author_match) correlationStats.author_matches++;
          if (correlation.time_proximity_minutes !== undefined && correlation.time_proximity_minutes < 60) {
            correlationStats.time_proximity_matches++;
          }
          if (correlation.content_similarity && correlation.content_similarity > 0.5) {
            correlationStats.content_similarity_matches++;
          }
        }
      }
      
      const processingTime = Date.now() - startTime;
      logger.info(`✅ GitCorrelationService.correlateCommitsWithSessions completed in ${processingTime}ms`);
      
      return {
        project_id,
        links_created: linksCreated,
        links_updated: linksUpdated,
        high_confidence_links: highConfidenceLinks,
        processing_time_ms: processingTime,
        correlation_stats: correlationStats
      };
    } catch (error) {
      logger.error('Correlate commits with sessions error', error as Error);
      throw error;
    }
  }

  /**
   * Get recent commits for a project within a time window
   * Used for real-time activity tracking
   */
  static async getRecentCommits(request: GetRecentCommitsRequest): Promise<GetRecentCommitsResponse> {
    const { project_id, hours, branch, author } = request;
    
    try {
      logger.info(`🕒 GitCorrelationService.getRecentCommits - Project: ${project_id}, Hours: ${hours}`);
      
      let sql = `
        SELECT 
          id, project_id, commit_sha, short_sha, message, author_name, author_email,
          author_date, committer_name, committer_email, committer_date, branch_name,
          parent_shas, is_merge_commit, files_changed, insertions, deletions,
          commit_type, tags, metadata, created_at, updated_at
        FROM git_commits
        WHERE project_id = $1 
        AND author_date >= NOW() - INTERVAL '${hours} hours'
      `;
      
      const params: (string)[] = [project_id];
      let paramIndex = 2;
      
      if (branch) {
        sql += ` AND branch_name = $${paramIndex++}`;
        params.push(branch);
      }
      
      if (author) {
        sql += ` AND author_email = $${paramIndex++}`;
        params.push(author);
      }
      
      sql += ` ORDER BY author_date DESC`;
      
      const result = await db.query(sql, params);
      
      const commits: GitCommit[] = result.rows.map((row: Record<string, unknown>) => ({
        id: row.id as string,
        project_id: row.project_id as string,
        commit_sha: row.commit_sha as string,
        short_sha: row.short_sha as string,
        message: row.message as string,
        author_name: row.author_name as string,
        author_email: row.author_email as string,
        author_date: row.author_date as string,
        committer_name: row.committer_name as string | undefined,
        committer_email: row.committer_email as string | undefined,
        committer_date: row.committer_date as string | undefined,
        branch_name: row.branch_name as string | undefined,
        parent_shas: row.parent_shas as string[] | undefined,
        is_merge_commit: row.is_merge_commit as boolean | undefined,
        files_changed: row.files_changed as number | undefined,
        insertions: row.insertions as number | undefined,
        deletions: row.deletions as number | undefined,
        commit_type: row.commit_type as string | undefined,
        tags: row.tags as string[] | undefined,
        metadata: row.metadata as Record<string, unknown> | undefined,
      }));
      
      return {
        commits,
        total_count: commits.length,
        time_range_hours: hours,
        branch_filter: branch || '',
        author_filter: author || ''
      };
    } catch (error) {
      logger.error('Get recent commits error', error as Error);
      throw error;
    }
  }

  /**
   * Auto-correlate git commits when session ends
   */
  static async autoCorrelateOnSessionEnd(sessionId: string): Promise<void> {
    try {
      logger.info(`🔄 Auto-correlating session ${sessionId.substring(0, 8)}... on session end`);
      
      // Small delay to ensure all git operations are complete
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      await this.correlateSessionWithGit(sessionId);
      
    } catch (error) {
      logger.error('Auto-correlation on session end failed', error as Error);
      // Non-blocking error - log but don't throw
    }
  }

  /**
   * Correlate a single commit with all sessions in the project
   * Returns correlations that meet the confidence threshold
   */
  private static correlateCommitWithSessions(
    commit: { id: string; author_date: string },
    sessions: { id: string; started_at: string; ended_at?: string }[],
    threshold: number
  ): CommitCorrelation[] {
    const correlations: CommitCorrelation[] = [];
    const commitDate = new Date(commit.author_date);
    
    for (const session of sessions) {
      const sessionStart = new Date(session.started_at);
      const sessionEnd = session.ended_at ? new Date(session.ended_at) : new Date();
      
      // Calculate time proximity
      const timeProximity = this.calculateTimeProximity(commitDate, sessionStart, sessionEnd);
      
      if (timeProximity !== null && timeProximity <= 120) { // Within 2 hours
        let confidence = 0.3; // Base confidence
        
        // Boost confidence for time proximity
        if (timeProximity <= 30) confidence += 0.4; // Very close
        else if (timeProximity <= 60) confidence += 0.2; // Close
        
        // Check author match (would need to correlate with session user data)
        const authorMatch = false; // Placeholder - would need user correlation
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
   * Returns 0 if commit is during session, or minutes distance otherwise
   */
  private static calculateTimeProximity(
    commitDate: Date,
    sessionStart: Date,
    sessionEnd: Date
  ): number | null {
    const commitTime = commitDate.getTime();
    const startTime = sessionStart.getTime();
    const endTime = sessionEnd.getTime();
    
    if (commitTime >= startTime && commitTime <= endTime) {
      return 0; // Commit during session
    }
    
    // Calculate proximity to session
    const beforeStart = Math.abs(commitTime - startTime) / (1000 * 60); // minutes
    const afterEnd = Math.abs(commitTime - endTime) / (1000 * 60); // minutes
    
    return Math.min(beforeStart, afterEnd);
  }

  /**
   * Find existing session link for a commit
   */
  private static async findExistingSessionLink(
    commit_id: string,
    session_id: string
  ): Promise<{ id: string; confidence_score: number } | null> {
    const result = await db.query(
      'SELECT id, confidence_score FROM commit_session_links WHERE commit_id = $1 AND session_id = $2',
      [commit_id, session_id]
    );
    
    return result.rows[0] || null;
  }

  /**
   * Create a new session link for a commit
   */
  private static async createSessionLink(
    commit_id: string,
    correlation: CommitCorrelation
  ): Promise<void> {
    await db.query(`
      INSERT INTO commit_session_links (
        project_id, commit_id, session_id, link_type, confidence_score,
        time_proximity_minutes, author_match, metadata
      ) VALUES (
        (SELECT project_id FROM git_commits WHERE id = $1),
        $1, $2, $3, $4, $5, $6, $7
      )
    `, [
      commit_id,
      correlation.session_id,
      correlation.link_type,
      correlation.confidence_score,
      correlation.time_proximity_minutes,
      correlation.author_match,
      JSON.stringify({})
    ]);
  }

  /**
   * Update an existing session link with new correlation data
   */
  private static async updateSessionLink(
    link_id: string,
    correlation: CommitCorrelation
  ): Promise<void> {
    await db.query(`
      UPDATE commit_session_links 
      SET confidence_score = $2, time_proximity_minutes = $3, 
          author_match = $4, updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
    `, [
      link_id,
      correlation.confidence_score,
      correlation.time_proximity_minutes,
      correlation.author_match
    ]);
  }
}
