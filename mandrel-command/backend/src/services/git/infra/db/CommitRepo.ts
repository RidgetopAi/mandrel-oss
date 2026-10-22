/**
 * Commit repository - database operations for git commits
 */

import { db as pool } from '../../../../database/connection';
import { GitCommit, CommitType } from '../../../../types/git';

/**
 * Map database row to GitCommit type
 */
export function mapRowToGitCommit(row: any): GitCommit {
  return {
    id: row.id,
    project_id: row.project_id,
    commit_sha: row.commit_sha,
    short_sha: row.short_sha,
    message: row.message,
    author_name: row.author_name,
    author_email: row.author_email,
    author_date: new Date(row.author_date),
    committer_name: row.committer_name,
    committer_email: row.committer_email,
    committer_date: new Date(row.committer_date),
    branch_name: row.branch_name,
    parent_shas: row.parent_shas || [],
    is_merge_commit: row.is_merge_commit || false,
    files_changed: row.files_changed || 0,
    insertions: row.insertions || 0,
    deletions: row.deletions || 0,
    commit_type: row.commit_type as CommitType,
    tags: row.tags || [],
    metadata: row.metadata || {},
    created_at: new Date(row.created_at),
    updated_at: new Date(row.updated_at)
  };
}

export class CommitRepo {
  /**
   * Find commit by SHA
   */
  static async findBySha(project_id: string, commit_sha: string): Promise<GitCommit | null> {
    const result = await pool.query(
      'SELECT * FROM git_commits WHERE project_id = $1 AND commit_sha = $2',
      [project_id, commit_sha]
    );
    return result.rows.length > 0 ? mapRowToGitCommit(result.rows[0]) : null;
  }

  /**
   * Check if commit exists
   */
  static async exists(project_id: string, commit_sha: string): Promise<boolean> {
    const result = await pool.query(
      'SELECT id FROM git_commits WHERE project_id = $1 AND commit_sha = $2',
      [project_id, commit_sha]
    );
    return result.rows.length > 0;
  }

  /**
   * Get commit ID by SHA
   */
  static async getIdBySha(project_id: string, commit_sha: string): Promise<string | null> {
    const result = await pool.query(
      'SELECT id FROM git_commits WHERE project_id = $1 AND commit_sha = $2',
      [project_id, commit_sha]
    );
    return result.rows.length > 0 ? result.rows[0].id : null;
  }

  /**
   * Get recent commits within a time window
   */
  static async getRecentCommits(
    project_id: string,
    hours: number,
    options?: { branch?: string; author?: string }
  ): Promise<GitCommit[]> {
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
    
    const params: any[] = [project_id];
    let paramIndex = 2;
    
    if (options?.branch) {
      sql += ` AND branch_name = $${paramIndex++}`;
      params.push(options.branch);
    }
    
    if (options?.author) {
      sql += ` AND author_email = $${paramIndex++}`;
      params.push(options.author);
    }
    
    sql += ` ORDER BY author_date DESC`;
    
    const result = await pool.query(sql, params);
    return result.rows.map(mapRowToGitCommit);
  }

  /**
   * Store a new commit with metadata
   */
  static async create(
    project_id: string,
    commit: any,
    metadata: any,
    commitType: CommitType
  ): Promise<string> {
    const committerName = commit.committer_name || commit.author_name;
    const committerEmail = commit.committer_email || commit.author_email;
    const committerDate = commit.committer_date || commit.date;
    
    const result = await pool.query(`
      INSERT INTO git_commits (
        project_id, commit_sha, message, author_name, author_email, author_date,
        committer_name, committer_email, committer_date, branch_name,
        parent_shas, files_changed, insertions, deletions,
        commit_type, tags, metadata
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
      RETURNING id
    `, [
      project_id,
      commit.hash,
      commit.message,
      commit.author_name,
      commit.author_email,
      new Date(commit.date),
      committerName,
      committerEmail,
      new Date(committerDate),
      metadata.primary_branch,
      metadata.parent_shas,
      metadata.files_changed,
      metadata.insertions,
      metadata.deletions,
      commitType,
      metadata.message_analysis?.tags || [],
      JSON.stringify({
        body: commit.body,
        refs: commit.refs,
        branches: metadata.branches,
        tree_hash: metadata.tree_hash,
        commit_size: metadata.commit_size,
        message_analysis: metadata.message_analysis,
        merge_info: metadata.merge_info,
        gpg_signature: metadata.gpg_signature,
        commit_stats: metadata.commit_stats,
        processing_timestamp: metadata.processing_timestamp,
        is_merge_commit: metadata.is_merge_commit
      })
    ]);
    
    return result.rows[0].id;
  }

  /**
   * Get commits for correlation
   */
  static async getCommitsForCorrelation(
    project_id: string,
    since?: Date
  ): Promise<any[]> {
    let sql = `
      SELECT gc.*, p.name as project_name
      FROM git_commits gc
      JOIN projects p ON gc.project_id = p.id
      WHERE gc.project_id = $1
    `;
    const params: any[] = [project_id];
    
    if (since) {
      sql += ` AND gc.author_date >= $2`;
      params.push(since.toISOString());
    }
    
    sql += ` ORDER BY gc.author_date DESC`;
    
    const result = await pool.query(sql, params);
    return result.rows;
  }
}
