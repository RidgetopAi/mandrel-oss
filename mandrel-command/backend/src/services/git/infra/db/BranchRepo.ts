/**
 * Branch repository - database operations for git branches
 */

import { db as pool } from '../../../../database/connection';
import { GitBranch, BranchType } from '../../../../types/git';

/**
 * Map database row to GitBranch type
 */
export function mapRowToGitBranch(row: any): GitBranch {
  return {
    id: row.id,
    project_id: row.project_id,
    branch_name: row.branch_name,
    current_sha: row.current_sha,
    is_default: row.is_default || false,
    is_protected: row.is_protected || false,
    branch_type: row.branch_type as BranchType,
    upstream_branch: row.upstream_branch,
    commit_count: row.commit_count || 0,
    last_commit_date: row.last_commit_date ? new Date(row.last_commit_date) : new Date(),
    first_commit_date: row.first_commit_date ? new Date(row.first_commit_date) : new Date(),
    base_branch: row.base_branch,
    merge_target: row.merge_target,
    session_id: row.session_id,
    description: row.description,
    metadata: row.metadata || {},
    created_at: new Date(row.created_at),
    updated_at: new Date(row.updated_at)
  };
}

export class BranchRepo {
  /**
   * Get all branches for a project
   */
  static async getAll(project_id: string): Promise<GitBranch[]> {
    const result = await pool.query(`
      SELECT * FROM git_branches WHERE project_id = $1 ORDER BY updated_at DESC
    `, [project_id]);
    
    return result.rows.map(mapRowToGitBranch);
  }

  /**
   * Find branch by name
   */
  static async findByName(project_id: string, branch_name: string): Promise<GitBranch | null> {
    const result = await pool.query(
      'SELECT * FROM git_branches WHERE project_id = $1 AND branch_name = $2',
      [project_id, branch_name]
    );
    return result.rows.length > 0 ? mapRowToGitBranch(result.rows[0]) : null;
  }

  /**
   * Create or update a branch
   */
  static async upsert(
    project_id: string,
    branch_name: string,
    data: Partial<GitBranch>
  ): Promise<string> {
    const result = await pool.query(`
      INSERT INTO git_branches (
        project_id, branch_name, current_sha, is_default, is_protected,
        branch_type, upstream_branch, commit_count, last_commit_date,
        first_commit_date, base_branch, merge_target, metadata
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
      ON CONFLICT (project_id, branch_name) DO UPDATE SET
        current_sha = EXCLUDED.current_sha,
        is_default = EXCLUDED.is_default,
        is_protected = EXCLUDED.is_protected,
        branch_type = EXCLUDED.branch_type,
        commit_count = EXCLUDED.commit_count,
        last_commit_date = EXCLUDED.last_commit_date,
        metadata = EXCLUDED.metadata,
        updated_at = CURRENT_TIMESTAMP
      RETURNING id
    `, [
      project_id,
      branch_name,
      data.current_sha || '',
      data.is_default || false,
      data.is_protected || false,
      data.branch_type || 'feature',
      data.upstream_branch || null,
      data.commit_count || 0,
      data.last_commit_date || new Date(),
      data.first_commit_date || new Date(),
      data.base_branch || null,
      data.merge_target || null,
      JSON.stringify(data.metadata || {})
    ]);
    
    return result.rows[0].id;
  }
}
