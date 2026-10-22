/**
 * projectAccess — per-user/project AUTHORIZATION (the F-04 closure).
 *
 * ONE question, ONE place: "may THIS user scope work to THIS project?"
 *
 * ── THE MODEL ────────────────────────────────────────────────────────────────────────
 *   - role === 'admin'  → yes, every project. Admin is all-projects by definition; the
 *     admin set lives on admin_users.role and is NOT mirrored into the grant table
 *     (a mirrored copy is the list that drifts).
 *   - anyone else       → yes IFF a row exists in user_project_access (migration 075).
 *     DENY BY DEFAULT: no row, no access. Missing role, empty role, unknown role are
 *     all "not admin" and fall to the grant check (C3: the empty/absent population is
 *     the one that slips through a check written as a truthiness test).
 *
 * ── FAIL CLOSED ──────────────────────────────────────────────────────────────────────
 * A DB error here THROWS — it is never mapped onto "no" OR "yes" (C1: an instrument has
 * three states; "could not measure" must not share a value with either answer). Callers
 * (middleware/project.ts) turn the throw into a 500, never a silent allow.
 */

import { db as pool } from '../database/connection';
import { logger } from '../config/logger';

export interface ProjectAccessUser {
  id: string;
  role?: string | null;
}

export class ProjectAccessService {
  /** May `user` scope requests to `projectId`? See module doc for the model. */
  static async userHasProjectAccess(user: ProjectAccessUser, projectId: string): Promise<boolean> {
    if (user.role === 'admin') {
      return true;
    }
    const result = await pool.query(
      'SELECT 1 FROM user_project_access WHERE user_id = $1 AND project_id = $2',
      [user.id, projectId]
    );
    return (result.rowCount ?? 0) > 0;
  }

  /** All project ids granted to a user (admin callers should not need this — they hold all). */
  static async listAccessibleProjectIds(userId: string): Promise<string[]> {
    const result = await pool.query(
      'SELECT project_id FROM user_project_access WHERE user_id = $1 ORDER BY created_at',
      [userId]
    );
    return result.rows.map((r: { project_id: string }) => r.project_id);
  }

  /** Grant access (idempotent). `grantedBy` is attribution only, never authorization input. */
  static async grantAccess(userId: string, projectId: string, grantedBy?: string): Promise<void> {
    await pool.query(
      `INSERT INTO user_project_access (user_id, project_id, granted_by)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id, project_id) DO NOTHING`,
      [userId, projectId, grantedBy ?? null]
    );
    logger.info('[projectAccess] grant', { userId, projectId, grantedBy });
  }

  /** Revoke access (idempotent — revoking a non-existent grant is a no-op). */
  static async revokeAccess(userId: string, projectId: string): Promise<void> {
    await pool.query(
      'DELETE FROM user_project_access WHERE user_id = $1 AND project_id = $2',
      [userId, projectId]
    );
    logger.info('[projectAccess] revoke', { userId, projectId });
  }

  /**
   * Resolve a project reference (UUID or exact name) to its UUID, or null when it does
   * not resolve. Used by the /api/mcp passthrough to authz-check `arguments.projectId`
   * values that MCP tools accept by name. Fail closed at the CALLER: unresolvable → 403,
   * never "forward and hope".
   */
  static async resolveProjectId(ref: string): Promise<string | null> {
    const result = await pool.query(
      `SELECT id FROM projects WHERE id::text = $1 OR name = $1 LIMIT 1`,
      [ref]
    );
    return result.rows.length > 0 ? result.rows[0].id : null;
  }
}
