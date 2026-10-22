/**
 * Session Management Handler
 *
 * Provides session detail retrieval for the session view / status surfaces.
 *
 * NOTE (Phase 0 dead-code purge, the auditor review B1): the assignSessionToProject /
 * getSessionStatus / updateSessionDetails / createNewSession methods were DELETED — they
 * had zero production callers and createNewSession carried a second, drifted session-end
 * implementation (raw `ended_at=NOW()`, no status flip, no finalize) that was one refactor
 * away from being rewired. Only getSessionDetailsWithMeta remains (used by
 * session.routes.ts).
 */

import { db } from '../../../config/database.js';
import { logger } from '../../../utils/logger.js';

export class SessionManagementHandler {
  /**
   * Get session details with title and description
   */
  static async getSessionDetailsWithMeta(sessionId: string): Promise<{
    success: boolean;
    session?: any;
    message: string;
  }> {
    try {
      logger.info(`🔍 Getting detailed session info for: ${sessionId.substring(0, 8)}...`);

      const result = await db.query(`
        SELECT
          s.id,
          s.title,
          s.description,
          s.agent_type,
          s.started_at,
          s.ended_at,
          s.project_id,
          s.context_summary,
          s.updated_at,
          s.metadata,
          s.input_tokens,
          s.output_tokens,
          s.total_tokens,
          -- tasks_updated has no child table (an update leaves no per-session row), so
          -- it stays a counter column; it is correct now that the incrementing choke
          -- point is its only writer.
          s.tasks_updated,
          -- s.contexts_created is still selected, but ONLY to be reported separately as
          -- contexts_created_tracked (the raw counter, for debugging counter drift).
          -- It must never be the value a caller sees as "contexts in this session".
          s.contexts_created,
          s.session_goal,
          s.tags,
          s.lines_added,
          s.lines_deleted,
          s.lines_net,
          s.productivity_score,
          s.ai_model,
          s.files_modified_count,
          s.activity_count,
          p.name as project_name,
          COALESCE((SELECT COUNT(*) FROM contexts c WHERE c.session_id = s.id
                                                    AND c.archived_at IS NULL), 0) as contexts_count,
          COALESCE((SELECT COUNT(*) FROM technical_decisions td WHERE td.session_id = s.id
                                                                AND td.archived_at IS NULL), 0) as decisions_count,
          -- Tasks were read from the denormalized s.tasks_created / s.tasks_completed
          -- columns, which finish() zeroed on every session end. Derive them from the
          -- child table like contexts/decisions above.
          COALESCE((SELECT COUNT(*) FROM tasks t WHERE t.session_id = s.id
                                                 AND t.archived_at IS NULL), 0) as tasks_count,
          COALESCE((SELECT COUNT(*) FROM tasks t WHERE t.session_id = s.id
                                                 AND t.archived_at IS NULL AND t.status = 'completed'), 0) as tasks_completed_count
        FROM sessions s
        LEFT JOIN projects p ON s.project_id = p.id
        WHERE s.id = $1
      `, [sessionId]);

      if (result.rows.length === 0) {
        return {
          success: false,
          message: `Session ${sessionId} not found`
        };
      }

      const session = result.rows[0];
      const duration = session.ended_at
        ? new Date(session.ended_at).getTime() - new Date(session.started_at).getTime()
        : Date.now() - new Date(session.started_at).getTime();

      return {
        success: true,
        session: {
          id: session.id,
          title: session.title,
          description: session.description,
          type: session.agent_type,
          started_at: session.started_at,
          ended_at: session.ended_at,
          updated_at: session.updated_at,
          project_id: session.project_id,
          project_name: session.project_name || 'No project assigned',
          context_summary: session.context_summary,
          // SR-2: the query already selects session_goal + tags but the
          // mapped object dropped them, so session_status / the Session View "Session
          // Goal" field never saw the goal a user set via session_start. Surface them
          // (no extra query — these columns are already fetched above).
          session_goal: session.session_goal,
          tags: session.tags,
          duration_minutes: Math.round(duration / 60000),
          contexts_created: parseInt(session.contexts_count),
          decisions_created: parseInt(session.decisions_count),
          input_tokens: parseInt(session.input_tokens) || 0,
          output_tokens: parseInt(session.output_tokens) || 0,
          total_tokens: parseInt(session.total_tokens) || 0,
          tasks_created: parseInt(session.tasks_count) || 0,
          tasks_updated: parseInt(session.tasks_updated) || 0,
          tasks_completed: parseInt(session.tasks_completed_count) || 0,
          contexts_created_tracked: parseInt(session.contexts_created) || 0,
          metadata: session.metadata || {}
        },
        message: `Session details retrieved successfully`
      };

    } catch (error) {
      logger.error('❌ Session details error', error as Error);
      return {
        success: false,
        message: error instanceof Error ? error.message : 'Failed to get session details'
      };
    }
  }
}
