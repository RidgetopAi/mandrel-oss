/**
 * Correlation repository - database operations for commit-session links
 */

import { db as pool } from '../../../../database/connection';

export interface SessionLink {
  id: string;
  project_id: string;
  commit_id: string;
  session_id: string;
  link_type: string;
  confidence_score: number;
  time_proximity_minutes: number;
  author_match: boolean;
  metadata: any;
  created_at: Date;
  updated_at: Date;
}

export interface Correlation {
  session_id: string;
  confidence_score: number;
  time_proximity_minutes: number;
  author_match: boolean;
  link_type: string;
  content_similarity?: number;
}

export class CorrelationRepo {
  /**
   * Find existing session link
   */
  static async findExistingLink(commit_id: string, session_id: string): Promise<SessionLink | null> {
    const result = await pool.query(
      'SELECT * FROM commit_session_links WHERE commit_id = $1 AND session_id = $2',
      [commit_id, session_id]
    );
    return result.rows[0] || null;
  }

  /**
   * Create a new session link
   */
  static async createLink(commit_id: string, correlation: Correlation): Promise<void> {
    await pool.query(`
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
   * Update an existing session link
   */
  static async updateLink(link_id: string, correlation: Correlation): Promise<void> {
    await pool.query(`
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

  /**
   * Get sessions for correlation
   */
  static async getSessionsForProject(project_id: string): Promise<any[]> {
    // Single consolidated `sessions` table; the legacy `user_sessions` table
    // (and its `last_activity` column) no longer exist in any tenant schema.
    const result = await pool.query(`
      SELECT id, started_at, ended_at, agent_type
      FROM sessions
      WHERE project_id = $1
      ORDER BY started_at DESC
    `, [project_id]);
    return result.rows;
  }
}
