/**
 * File change repository - database operations for git file changes
 */

import { db as pool } from '../../../../database/connection';
import { GitFileChange, FileChangeType } from '../../../../types/git';
import { logger } from '../../../../config/logger';

/**
 * Map database row to GitFileChange type
 */
export function mapRowToGitFileChange(row: any): GitFileChange {
  return {
    id: row.id,
    project_id: row.project_id,
    commit_id: row.commit_id,
    file_path: row.file_path,
    old_file_path: row.old_file_path,
    change_type: row.change_type as FileChangeType,
    lines_added: row.lines_added || 0,
    lines_removed: row.lines_removed || 0,
    is_binary: row.is_binary || false,
    is_generated: row.is_generated || false,
    file_size_bytes: row.file_size_bytes,
    metadata: row.metadata || {},
    created_at: new Date(row.created_at)
  };
}

export class ChangeRepo {
  /**
   * Get file changes for a commit
   */
  static async getByCommitId(project_id: string, commit_id: string): Promise<GitFileChange[]> {
    const result = await pool.query(
      `SELECT * FROM git_file_changes WHERE project_id = $1 AND commit_id = $2`,
      [project_id, commit_id]
    );
    return result.rows.map(mapRowToGitFileChange);
  }

  /**
   * Store a file change
   */
  static async create(fileChange: GitFileChange, enhancedMetadata?: any): Promise<GitFileChange> {
    const result = await pool.query(`
      INSERT INTO git_file_changes (
        project_id, commit_id, file_path, old_file_path, change_type,
        lines_added, lines_removed, is_binary, is_generated, file_size_bytes, metadata
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      RETURNING id, created_at
    `, [
      fileChange.project_id,
      fileChange.commit_id,
      fileChange.file_path,
      fileChange.old_file_path,
      fileChange.change_type,
      fileChange.lines_added,
      fileChange.lines_removed,
      fileChange.is_binary,
      fileChange.is_generated,
      fileChange.file_size_bytes,
      JSON.stringify({
        ...fileChange.metadata,
        enhanced_metadata: enhancedMetadata ? {
          commit_context: enhancedMetadata.message_analysis,
          is_merge_commit: enhancedMetadata.is_merge_commit
        } : null
      })
    ]);
    
    return {
      ...fileChange,
      id: result.rows[0].id,
      created_at: new Date(result.rows[0].created_at)
    };
  }

  /**
   * Store multiple file changes
   */
  static async createMany(
    fileChanges: GitFileChange[],
    enhancedMetadata?: any
  ): Promise<GitFileChange[]> {
    const storedChanges: GitFileChange[] = [];
    
    for (const fileChange of fileChanges) {
      try {
        const stored = await this.create(fileChange, enhancedMetadata);
        storedChanges.push(stored);
      } catch (error) {
        logger.error(`Failed to store file change for ${fileChange.file_path}`, { error });
      }
    }
    
    return storedChanges;
  }
}
