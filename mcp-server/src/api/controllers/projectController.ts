/**
 * Project Controller
 * REST API endpoints for project management
 */

import { Request, Response } from 'express';
import { db } from '../../config/database.js';
import { logger } from '../../utils/logger.js';

/**
 * Project Controller
 * Provides REST API endpoints for project management operations
 */
export class ProjectController {
  /**
   * Set a project as primary (default)
   * POST /api/v2/projects/:id/set-primary
   */
  async setPrimary(req: Request, res: Response): Promise<void> {
    const client = await db.connect();

    try {
      const { id } = req.params;

      if (!id) {
        res.status(400).json({
          success: false,
          error: 'Project ID is required'
        });
        return;
      }

      logger.info(`Setting project ${id} as primary`);

      // Start transaction for atomicity
      await client.query('BEGIN');

      // Verify project exists
      const projectCheck = await client.query(
        'SELECT id, name FROM projects WHERE id = $1',
        [id]
      );

      if (projectCheck.rows.length === 0) {
        await client.query('ROLLBACK');
        res.status(404).json({
          success: false,
          error: `Project with ID ${id} not found`
        });
        return;
      }

      // Clear is_primary flag from all other projects
      await client.query(
        `UPDATE projects
         SET metadata = metadata - 'is_primary'
         WHERE metadata->>'is_primary' = 'true'`
      );

      // Set new primary project
      const updateResult = await client.query(
        `UPDATE projects
         SET metadata = jsonb_set(
           COALESCE(metadata, '{}'::jsonb),
           '{is_primary}',
           'true'
         )
         WHERE id = $1
         RETURNING id, name, description, status, metadata, created_at, updated_at`,
        [id]
      );

      // Commit transaction
      await client.query('COMMIT');

      const project = updateResult.rows[0];

      logger.info(`Successfully set project ${project.name} (${project.id}) as primary`);

      // Invalidate session cache to force re-initialization with new primary project
      try {
        const { projectHandler } = await import('../../handlers/project.js');
        projectHandler.clearSessionCache();
        logger.info('Session cache cleared - sessions will re-initialize with new primary project');
      } catch (cacheError) {
        // Log error but don't fail the request - cache will be cleared on server restart
        const cacheErr = cacheError as Error;
        logger.warn('Failed to clear session cache', cacheErr);
      }

      res.json({
        success: true,
        data: {
          id: project.id,
          name: project.name,
          description: project.description,
          status: project.status,
          metadata: project.metadata,
          created_at: project.created_at,
          updated_at: project.updated_at,
          is_primary: true
        }
      });
    } catch (error) {
      await client.query('ROLLBACK');
      const err = error as Error;
      logger.error('Failed to set primary project', err);
      res.status(500).json({
        success: false,
        error: err.message || 'Unknown error occurred while setting primary project'
      });
    } finally {
      client.release();
    }
  }
}
