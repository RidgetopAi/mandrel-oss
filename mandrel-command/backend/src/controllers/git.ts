import { Response } from 'express';
import { AuthenticatedRequest } from '../types/auth';
import { db as pool } from '../database/connection';
import { logger } from '../config/logger';

/**
 * Git Controller
 * Handles git data push from local agents
 */

export interface GitPushFile {
  path: string;
  change_type: 'added' | 'modified' | 'deleted' | 'renamed';
  lines_added: number;
  lines_removed: number;
  old_path?: string;
}

export interface GitPushCommit {
  sha: string;
  message: string;
  author_name: string;
  author_email: string;
  author_date: string;
  branch?: string;
  files: GitPushFile[];
}

export interface GitPushStatsRequest {
  session_id: string;
  project_id: string;
  branch?: string;
  commits: GitPushCommit[];
}

export class GitController {
  /**
   * POST /git/push-stats - Receive git stats from local agent
   */
  static async pushStats(req: AuthenticatedRequest, res: Response): Promise<void> {
    const client = await pool.connect();
    
    try {
      // `project_id` is the SUBJECT of the payload — the project
      // these git stats belong to — not the viewer's current scope, so an X-Project-ID
      // header must not override it. Safe because the resolver authorizes EVERY candidate:
      // body.project_id is a PROJECT_SCOPE_SOURCE, so this value is already authorized for
      // this caller before the controller runs.
      // eslint-disable-next-line no-restricted-syntax -- payload subject, authorized as body.project_id
      const { session_id, project_id, commits } = req.body as GitPushStatsRequest;

      // Validation
      if (!session_id) {
        res.status(400).json({ success: false, error: 'session_id is required' });
        return;
      }
      if (!project_id) {
        res.status(400).json({ success: false, error: 'project_id is required' });
        return;
      }
      if (!commits || !Array.isArray(commits) || commits.length === 0) {
        res.status(400).json({ success: false, error: 'commits array is required and must not be empty' });
        return;
      }

      // Verify project exists
      const projectCheck = await client.query('SELECT id FROM projects WHERE id = $1', [project_id]);
      if (projectCheck.rows.length === 0) {
        res.status(404).json({ success: false, error: 'Project not found' });
        return;
      }

      await client.query('BEGIN');

      let commitsCreated = 0;
      let commitsSkipped = 0;
      let filesCreated = 0;
      let linksCreated = 0;

      for (const commit of commits) {
        // Validate commit sha format (40 hex chars)
        if (!commit.sha || !/^[a-f0-9]{40}$/i.test(commit.sha)) {
          logger.warn('Skipping invalid commit sha', { sha: commit.sha });
          commitsSkipped++;
          continue;
        }

        // Check if commit already exists
        const existingCommit = await client.query(
          'SELECT id FROM git_commits WHERE project_id = $1 AND commit_sha = $2',
          [project_id, commit.sha.toLowerCase()]
        );

        let commitId: string;

        if (existingCommit.rows.length > 0) {
          // Commit exists, use existing ID
          commitId = existingCommit.rows[0].id;
          commitsSkipped++;
        } else {
          // Calculate totals from files
          const totalFilesChanged = commit.files?.length || 0;
          const totalInsertions = commit.files?.reduce((sum, f) => sum + (f.lines_added || 0), 0) || 0;
          const totalDeletions = commit.files?.reduce((sum, f) => sum + (f.lines_removed || 0), 0) || 0;

          // Insert new commit
          const commitResult = await client.query(
            `INSERT INTO git_commits (
              project_id, commit_sha, message, 
              author_name, author_email, author_date,
              committer_name, committer_email, committer_date,
              branch_name, files_changed, insertions, deletions,
              discovered_by
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
            RETURNING id`,
            [
              project_id,
              commit.sha.toLowerCase(),
              commit.message || 'No message',
              commit.author_name || 'Unknown',
              commit.author_email || 'unknown@unknown.com',
              commit.author_date || new Date().toISOString(),
              commit.author_name || 'Unknown',
              commit.author_email || 'unknown@unknown.com',
              commit.author_date || new Date().toISOString(),
              commit.branch || null,
              totalFilesChanged,
              totalInsertions,
              totalDeletions,
              'agent-push'
            ]
          );

          commitId = commitResult.rows[0].id;
          commitsCreated++;

          // Insert file changes
          if (commit.files && commit.files.length > 0) {
            for (const file of commit.files) {
              await client.query(
                `INSERT INTO git_file_changes (
                  project_id, commit_id, file_path, old_file_path,
                  change_type, lines_added, lines_removed
                ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                [
                  project_id,
                  commitId,
                  file.path,
                  file.old_path || null,
                  file.change_type || 'modified',
                  file.lines_added || 0,
                  file.lines_removed || 0
                ]
              );
              filesCreated++;

              // Also upsert into session_files for UI display
              await client.query(
                `INSERT INTO session_files (session_id, file_path, lines_added, lines_deleted, source)
                 VALUES ($1, $2, $3, $4, 'git')
                 ON CONFLICT (session_id, file_path)
                 DO UPDATE SET
                   lines_added = session_files.lines_added + EXCLUDED.lines_added,
                   lines_deleted = session_files.lines_deleted + EXCLUDED.lines_deleted,
                   last_modified = NOW()`,
                [session_id, file.path, file.lines_added || 0, file.lines_removed || 0]
              );
            }
          }
        }

        // Create/update commit-session link
        const existingLink = await client.query(
          'SELECT id FROM commit_session_links WHERE commit_id = $1 AND session_id = $2',
          [commitId, session_id]
        );

        if (existingLink.rows.length === 0) {
          await client.query(
            `INSERT INTO commit_session_links (
              project_id, commit_id, session_id, 
              link_type, confidence_score, created_by
            ) VALUES ($1, $2, $3, $4, $5, $6)`,
            [project_id, commitId, session_id, 'contributed', 0.95, 'agent-push']
          );
          linksCreated++;
        }
      }

      // Update session-level aggregates from session_files
      await client.query(
        `UPDATE sessions SET
          files_modified_count = (SELECT COUNT(DISTINCT file_path) FROM session_files WHERE session_id = $1),
          lines_added = (SELECT COALESCE(SUM(lines_added), 0) FROM session_files WHERE session_id = $1),
          lines_deleted = (SELECT COALESCE(SUM(lines_deleted), 0) FROM session_files WHERE session_id = $1),
          lines_net = (SELECT COALESCE(SUM(lines_added - lines_deleted), 0) FROM session_files WHERE session_id = $1)
        WHERE id = $1`,
        [session_id]
      );

      await client.query('COMMIT');

      res.json({
        success: true,
        data: {
          commits_created: commitsCreated,
          commits_skipped: commitsSkipped,
          files_created: filesCreated,
          links_created: linksCreated,
          total_commits_processed: commits.length
        }
      });

    } catch (error) {
      await client.query('ROLLBACK');
      logger.error('Git push-stats error', { error });
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to process git stats'
      });
    } finally {
      client.release();
    }
  }

  /**
   * GET /git/session/:sessionId/stats - Get git stats for a session
   */
  static async getSessionGitStats(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { sessionId } = req.params;

      const result = await pool.query(
        `SELECT 
          COUNT(DISTINCT gc.id) as total_commits,
          COALESCE(SUM(gc.files_changed), 0) as total_files_changed,
          COALESCE(SUM(gc.insertions), 0) as total_insertions,
          COALESCE(SUM(gc.deletions), 0) as total_deletions
        FROM commit_session_links csl
        JOIN git_commits gc ON csl.commit_id = gc.id
        WHERE csl.session_id = $1`,
        [sessionId]
      );

      const stats = result.rows[0];

      // Get file breakdown
      const filesResult = await pool.query(
        `SELECT 
          gfc.file_path,
          gfc.change_type,
          gfc.lines_added,
          gfc.lines_removed
        FROM commit_session_links csl
        JOIN git_commits gc ON csl.commit_id = gc.id
        JOIN git_file_changes gfc ON gc.id = gfc.commit_id
        WHERE csl.session_id = $1
        ORDER BY (gfc.lines_added + gfc.lines_removed) DESC`,
        [sessionId]
      );

      res.json({
        success: true,
        data: {
          summary: {
            total_commits: parseInt(stats.total_commits) || 0,
            total_files_changed: parseInt(stats.total_files_changed) || 0,
            total_insertions: parseInt(stats.total_insertions) || 0,
            total_deletions: parseInt(stats.total_deletions) || 0,
            net_lines: (parseInt(stats.total_insertions) || 0) - (parseInt(stats.total_deletions) || 0)
          },
          files: filesResult.rows
        }
      });

    } catch (error) {
      logger.error('Get session git stats error', { error });
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get git stats'
      });
    }
  }
}

export default GitController;
