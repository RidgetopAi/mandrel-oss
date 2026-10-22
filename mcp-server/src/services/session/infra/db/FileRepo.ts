/**
 * FileRepo - Database operations for session_files table
 */

import { db } from '../../../../config/database.js';
import { logger } from '../../../../utils/logger.js';
import type { SessionFile } from '../../../../types/session.js';

export const FileRepo = {
  /**
   * Upsert a file modification record
   * 'git' source replaces values (absolute), 'tool'/'manual' adds values (incremental)
   */
  async upsert(
    sessionId: string,
    filePath: string,
    linesAdded: number,
    linesDeleted: number,
    source: 'tool' | 'git' | 'manual' = 'tool'
  ): Promise<string | null> {
    try {
      const sql = source === 'git'
        ? `
          INSERT INTO session_files (
            session_id, file_path, lines_added, lines_deleted, source, first_modified, last_modified
          ) VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
          ON CONFLICT (session_id, file_path)
          DO UPDATE SET
            lines_added = EXCLUDED.lines_added,
            lines_deleted = EXCLUDED.lines_deleted,
            source = EXCLUDED.source,
            last_modified = NOW()
          RETURNING id
        `
        : `
          INSERT INTO session_files (
            session_id, file_path, lines_added, lines_deleted, source, first_modified, last_modified
          ) VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
          ON CONFLICT (session_id, file_path)
          DO UPDATE SET
            lines_added = session_files.lines_added + EXCLUDED.lines_added,
            lines_deleted = session_files.lines_deleted + EXCLUDED.lines_deleted,
            last_modified = NOW()
          RETURNING id
        `;

      const result = await db.query(sql, [sessionId, filePath, linesAdded, linesDeleted, source]);
      return result.rows[0]?.id || null;

    } catch (error) {
      logger.error('Failed to upsert file modification', error instanceof Error ? error : new Error('Unknown error'), {
        component: 'FileRepo',
        operation: 'upsert',
        metadata: { sessionId, filePath, source }
      });
      return null;
    }
  },

  /**
   * Get all files modified in a session
   */
  async listBySession(sessionId: string): Promise<SessionFile[]> {
    try {
      const sql = `
        SELECT
          id, session_id, file_path, lines_added, lines_deleted,
          source, first_modified, last_modified
        FROM session_files
        WHERE session_id = $1
        ORDER BY last_modified DESC
      `;

      const result = await db.query(sql, [sessionId]);

      return result.rows.map(row => ({
        id: row.id,
        session_id: row.session_id,
        file_path: row.file_path,
        lines_added: row.lines_added,
        lines_deleted: row.lines_deleted,
        source: row.source,
        first_modified: row.first_modified,
        last_modified: row.last_modified
      }));

    } catch (error) {
      logger.error('Failed to list session files', error instanceof Error ? error : new Error('Unknown error'), {
        component: 'FileRepo',
        operation: 'listBySession',
        metadata: { sessionId }
      });
      return [];
    }
  },

  /**
   * Get aggregated file metrics for a session
   */
  async getAggregates(sessionId: string): Promise<{
    filesCount: number;
    linesAdded: number;
    linesDeleted: number;
    linesNet: number;
  }> {
    try {
      const sql = `
        SELECT
          COUNT(DISTINCT file_path) as files_count,
          COALESCE(SUM(lines_added), 0) as lines_added,
          COALESCE(SUM(lines_deleted), 0) as lines_deleted,
          COALESCE(SUM(lines_added - lines_deleted), 0) as lines_net
        FROM session_files
        WHERE session_id = $1
      `;

      const result = await db.query(sql, [sessionId]);
      const row = result.rows[0];

      return {
        filesCount: parseInt(row.files_count) || 0,
        linesAdded: parseInt(row.lines_added) || 0,
        linesDeleted: parseInt(row.lines_deleted) || 0,
        linesNet: parseInt(row.lines_net) || 0
      };

    } catch (error) {
      logger.error('Failed to get file aggregates', error instanceof Error ? error : new Error('Unknown error'), {
        component: 'FileRepo',
        operation: 'getAggregates',
        metadata: { sessionId }
      });
      return { filesCount: 0, linesAdded: 0, linesDeleted: 0, linesNet: 0 };
    }
  }
};
