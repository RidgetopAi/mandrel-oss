/**
 * Project resolution for sessions
 * Implements TS010 project inheritance hierarchy
 */

import { db } from '../../../../config/database.js';
import { randomUUID } from 'crypto';
import { projectHandler } from '../../../../handlers/project.js';
import { logger } from '../../../../utils/logger.js';
import { DEFAULT_PERSONAL_PROJECT_NAME } from '../../../../config/defaultProjectConfig.js';

/**
 * Resolve project for a new session using TS010 hierarchy:
 * 1. Current project (from project handler context)
 * 2. User's primary project
 * 3. System default project (aidis-bootstrap)
 * 4. Create personal project
 */
export async function resolveProjectForSession(sessionId: string = 'default-session'): Promise<string | null> {
  try {
    logger.info(`🔍 Resolving project for session ${sessionId} using TS010 hierarchy...`);

    // 1. Check current project from project handler context
    try {
      // PROJECT-SCOPE: effective — step 1 of the TS010 hierarchy is "the project this caller
      // is scoped to", which under a binding is the binding (it must beat the is_primary
      // fallback below — that fallback is exactly how the eval's orb landed in `daily log`).
      const currentProject = await projectHandler.getCurrentProject(sessionId);
      if (currentProject && currentProject.id && currentProject.id !== '00000000-0000-0000-0000-000000000000') {
        logger.info(`✅ Using current project: ${currentProject.name} (${currentProject.id})`);
        return currentProject.id;
      }
    } catch (error) {
      const err = error as Error;
      logger.info('⚠️  Could not access current project context', { metadata: { message: err.message } });
    }

    // 2. Check for user's primary project
    const primaryProjectSql = `
      SELECT id, name
      FROM projects 
      WHERE metadata->>'is_primary' = 'true'
      ORDER BY created_at DESC
      LIMIT 1
    `;

    const primaryResult = await db.query(primaryProjectSql);
    if (primaryResult.rows.length > 0) {
      const project = primaryResult.rows[0];
      logger.info(`✅ Using primary project: ${project.name} (${project.id})`);
      return project.id;
    }

    // 3. Check for system default project (aidis-bootstrap)
    const systemDefaultSql = `
      SELECT id, name
      FROM projects 
      WHERE name = 'aidis-bootstrap'
      ORDER BY created_at DESC
      LIMIT 1
    `;

    const systemDefaultResult = await db.query(systemDefaultSql);
    if (systemDefaultResult.rows.length > 0) {
      const project = systemDefaultResult.rows[0];
      logger.info(`✅ Using system default project: ${project.name} (${project.id})`);
      return project.id;
    }

    // 4. Create personal project as fallback
    logger.info('🔧 Creating personal project as fallback...');
    const newProjectId = randomUUID();
    const createProjectSql = `
      INSERT INTO projects (
        id, name, description, metadata, created_at
      ) VALUES ($1, $2, $3, $4, $5)
      RETURNING id
    `;

    const projectParams = [
      newProjectId,
      DEFAULT_PERSONAL_PROJECT_NAME,
      'Auto-created personal project for session management',
      JSON.stringify({
        auto_created: true,
        created_for: 'ts010_session_management',
        is_personal: true,
        created_by: 'aidis-session-tracker',
        ts010_fallback: true
      }),
      new Date()
    ];

    await db.query(createProjectSql, projectParams);
    logger.info(`✅ Created personal project: ${newProjectId}`);
    return newProjectId;

  } catch (error) {
    logger.error('❌ Failed to resolve project for session', error as Error);

    // Emergency fallback - try to find ANY project
    try {
      const anyProjectSql = `SELECT id FROM projects ORDER BY created_at DESC LIMIT 1`;
      const anyResult = await db.query(anyProjectSql);
      if (anyResult.rows.length > 0) {
        const projectId = anyResult.rows[0].id;
        logger.info(`⚠️  Emergency fallback to any project: ${projectId}`);
        return projectId;
      }
    } catch (fallbackError) {
      logger.error('❌ Emergency fallback also failed', fallbackError as Error);
    }

    logger.info('⚠️  No project resolution possible, returning null');
    return null;
  }
}
