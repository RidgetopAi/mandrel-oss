import { Request, Response } from 'express';
import { AuthenticatedRequest } from '../types/auth';
// every read below took its project scope by DESTRUCTURING `project_id`
// out of req.query — eight sites, none of which appeared in the original defect list
// because a name-based scan cannot see a destructuring pattern. The eslint AST rule
// (no-restricted-syntax) found them. The value was already authorized upstream
// (query.project_id is a PROJECT_SCOPE_SOURCE), but reading it raw lets a controller
// disagree with the authorized winner, so they all go through the one accessor now.
import { resolveListScope, scopeWhere, type ProjectListScope } from '../services/projectListScope';
import { SessionAnalyticsService } from '../services/sessionAnalytics';
import { SessionDetailService } from '../services/sessionDetail';
import { db as pool } from '../database/connection';
import type { UpdateSessionData } from '../validation/schemas';
import { logger } from '../config/logger';
import { normalizeAiModel } from '../config/aiModels';
import { parseActorParam } from '../config/sessionActor';
import { resolveAggTimeZone } from '../config/analyticsTime';
import { resolveRangeDays, resolveRowLimit } from '../config/analyticsRange';
import {
  contextCountSql,
  taskCountSql,
  completedTaskCountSql,
  decisionCountSql,
} from '../services/sessionCounts';

export class SessionController {
  /**
   * GET /sessions/:id - Get comprehensive session details with contexts, decisions, tasks
   */
  static async getSessionDetail(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const session = await SessionDetailService.getSessionDetail(id);

      if (!session) {
        res.status(404).json({
          success: false,
          error: 'Session not found'
        });
        return;
      }

      res.json({
        success: true,
        data: { session }
      });
    } catch (error) {
      logger.error('Get session detail error', { error });
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get session details'
      });
    }
  }

  /**
   * GET /sessions/analytics - Get session analytics
   */
  static async getSessionAnalytics(req: Request, res: Response): Promise<void> {
    try {
      const { actor } = req.query;
      // Optional "who" slice — validated/normalized (invalid values are dropped, not 500).
      const actorFilter = parseActorParam(actor);
      // Viewer-local day bucketing for the "today" counter; default UTC.
      const tz = resolveAggTimeZone(req.query.tz);

      const analytics = await SessionAnalyticsService.getSessionAnalytics(
        await resolveListScope(req as AuthenticatedRequest),
        actorFilter,
        tz
      );

      res.json({
        success: true,
        data: analytics
      });
    } catch (error) {
      logger.error('Get session analytics error', { error });
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get session analytics'
      });
    }
  }

  /**
   * GET /sessions/trends - Get session trends over time
   */
  static async getSessionTrends(req: Request, res: Response): Promise<void> {
    try {
      const { actor } = req.query;
      // Through the SAME clamp the sibling reads use (`getContextsByActor` :126,
      // `getTokenUsagePatterns`). It was a raw `parseInt(days)`, so `?days=abc` reached
      // the service as NaN and — because that value was spliced into the SQL text as
      // `INTERVAL 'NaN days'` — raised in Postgres and 500'd the hero chart AND all four
      // KPI tiles, while `contexts-by-actor` on the same render clamped to 30d and drew
      // fine. Two panels under one range label, showing two different windows.
      const numDays = resolveRangeDays(req.query.days);
      // Optional "who" slice — filter/group the time series by actor.
      const actorFilter = parseActorParam(actor);
      // Bucket per-day in the viewer's tz (an earlier task — Calendar/Dashboard); default UTC.
      const tz = resolveAggTimeZone(req.query.tz);

      const trends = await SessionAnalyticsService.getSessionTrends(
        await resolveListScope(req as AuthenticatedRequest),
        numDays,
        actorFilter,
        tz
      );

      res.json({
        success: true,
        data: trends
      });
    } catch (error) {
      logger.error('Get session trends error', { error });
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get session trends'
      });
    }
  }

  /**
   * GET /sessions/contexts-by-actor - contexts created in the window, GROUPED BY the
   * owning session's actor, plus the coverage totals for that same window and scope
   *. Project scope + tz resolve exactly like the sibling reads above;
   * `days` goes through the clamp so a malformed value can never reach the query.
   */
  static async getContextsByActor(req: Request, res: Response): Promise<void> {
    try {
      const days = resolveRangeDays(req.query.days);
      const tz = resolveAggTimeZone(req.query.tz);

      const data = await SessionAnalyticsService.getContextsByActor(
        await resolveListScope(req as AuthenticatedRequest),
        days,
        tz
      );

      res.json({
        success: true,
        data
      });
    } catch (error) {
      logger.error('Get contexts by actor error', { error });
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get contexts by actor'
      });
    }
  }

  /**
   * GET /sessions/most-active - the sessions that produced the most CONTEXTS in the window.
   *
   * `days` goes through the same clamp as every sibling read above. It was ABSENT here
   * (item 3): the panel sits under the page's 7d/30d/90d control and the
   * read had no window at all, so it answered ALL TIME — the top row measured on prod was
   * a session that started 213 days before the request.
   */
  static async getProductiveSessions(req: Request, res: Response): Promise<void> {
    try {
      const limitNum = resolveRowLimit(req.query.limit);
      const days = resolveRangeDays(req.query.days);

      const sessions = await SessionAnalyticsService.getProductiveSessions(
        await resolveListScope(req as AuthenticatedRequest),
        limitNum,
        days
      );

      res.json({
        success: true,
        data: { sessions }
      });
    } catch (error) {
      logger.error('Get productive sessions error', { error });
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get productive sessions'
      });
    }
  }

  /**
   * GET /sessions/token-patterns - sessions started per hour of day (plus the tokens
   * those sessions carry), for the requested window and viewer timezone.
   *
   * `days` and `tz` were BOTH missing here (item 2): the read sat under
   * the page's 7d/30d/90d control while scanning all time, and bucketed by UTC hour on a
   * server running Etc/UTC. Resolved through the SAME two helpers every sibling read
   * above uses, so the three cannot drift into different windows or different zones.
   */
  static async getTokenUsagePatterns(req: Request, res: Response): Promise<void> {
    try {
      const days = resolveRangeDays(req.query.days);
      const tz = resolveAggTimeZone(req.query.tz);

      const patterns = await SessionAnalyticsService.getTokenUsagePatterns(
        await resolveListScope(req as AuthenticatedRequest),
        days,
        tz
      );

      res.json({
        success: true,
        data: { patterns }
      });
    } catch (error) {
      logger.error('Get token usage patterns error', { error });
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get token usage patterns'
      });
    }
  }

  /**
   * GET /sessions/summaries - Get session summaries with activity counts
   */
  static async getSessionSummaries(req: Request, res: Response): Promise<void> {
    try {
      const { limit, offset } = req.query;
      const limitNum = typeof limit === 'string' ? parseInt(limit) : 20;
      const offsetNum = typeof offset === 'string' ? parseInt(offset) : 0;
      
      const summaries = await SessionDetailService.getSessionSummaries(
        await resolveListScope(req as AuthenticatedRequest),
        limitNum,
        offsetNum
      );

      res.json({
        success: true,
        data: { summaries }
      });
    } catch (error) {
      logger.error('Get session summaries error', { error });
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get session summaries'
      });
    }
  }

  /**
   * GET /sessions/stats-by-period - Get aggregated session statistics by time period
   */
  static async getSessionStatsByPeriod(req: Request, res: Response): Promise<void> {
    try {
      const { period, limit } = req.query;
      const periodType = (period === 'day' || period === 'week' || period === 'month') ? period : 'day';
      const limitNum = typeof limit === 'string' ? parseInt(limit) : 30;
      
      const stats = await SessionDetailService.getSessionStatsByPeriod(
        await resolveListScope(req as AuthenticatedRequest),
        periodType,
        limitNum
      );

      res.json({
        success: true,
        data: { stats }
      });
    } catch (error) {
      logger.error('Get session stats by period error', { error });
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get session statistics by period'
      });
    }
  }

  /**
   * GET /sessions/current - Get current active session
   * Returns the most recent MCP/agent session with activity
   */
  static async getCurrentSession(req: Request, res: Response): Promise<void> {
    try {
      // SCOPED (an earlier task item 7). This picked the newest session ON THE BOX, so a
      // zero-grant non-admin was shown another project's live session — title, model,
      // token counts and all. `_req` was the tell: the handler could not have been scoped,
      // because it never looked at the request.
      const scope = await resolveListScope(req as AuthenticatedRequest);
      const params: unknown[] = [];
      const scopeWhereClause = scopeWhere(scope, 's.project_id', params);
      // Get the most recently active session (prefer MCP sessions, then any with recent activity)
      const result = await pool.query(`
        SELECT
          s.id,
          s.project_id,
          s.title,
          s.description,
          s.started_at,
          s.ended_at,
          s.last_activity_at,
          s.agent_type,
          s.status,
          s.ai_model,
          -- Tokens stay on the column (no child table, not recomputable — spec §9).
          s.input_tokens,
          s.output_tokens,
          s.total_tokens,
          -- tasks_updated has no child-table equivalent; stays a counter column.
          s.tasks_updated,
          p.name as project_name,
          -- WAS: s.tasks_created / s.tasks_completed / s.contexts_created straight off the
          -- denormalized columns, plus a context subquery carrying the wrong project rule
          -- (AND project_id = s.project_id, a correlation to the SESSION's project -- see
          -- services/sessionCounts.ts). This widget is not project-filtered, so RULE 1
          -- applies: session linkage only.
          ${contextCountSql('s')} as context_count,
          ${taskCountSql('s')} as tasks_count,
          ${completedTaskCountSql('s')} as tasks_completed_count,
          ${decisionCountSql('s')} as decisions_count
        FROM sessions s
        LEFT JOIN projects p ON s.project_id = p.id
        ${scopeWhereClause}
        ORDER BY
          s.last_activity_at DESC NULLS LAST,
          s.started_at DESC
        LIMIT 1
      `, params);

      if (result.rows.length === 0) {
        res.json({
          success: true,
          data: { session: null }
        });
        return;
      }

      const row = result.rows[0];
      const session = {
        id: row.id,
        project_id: row.project_id,
        project_name: row.project_name || 'Unknown',
        title: row.title || `Session ${row.id.substring(0, 8)}`,
        description: row.description || '',
        created_at: row.started_at,
        ended_at: row.ended_at,
        last_activity_at: row.last_activity_at,
        agent_type: row.agent_type,
        status: row.status,
        ai_model: row.ai_model,
        input_tokens: parseInt(row.input_tokens) || 0,
        output_tokens: parseInt(row.output_tokens) || 0,
        total_tokens: parseInt(row.total_tokens) || 0,
        // Both the API field name and its `_count` sibling are fed from the SAME derived
        // subquery, so `contexts_created ?? context_count` can no longer be poisoned.
        tasks_created: parseInt(row.tasks_count) || 0,
        task_count: parseInt(row.tasks_count) || 0,
        tasks_updated: parseInt(row.tasks_updated) || 0,
        tasks_completed: parseInt(row.tasks_completed_count) || 0,
        contexts_created: parseInt(row.context_count) || 0,
        context_count: parseInt(row.context_count) || 0,
        decisions_created: parseInt(row.decisions_count) || 0,
        decision_count: parseInt(row.decisions_count) || 0,
        last_context_at: row.last_activity_at
      };

      res.json({
        success: true,
        data: { session }
      });
    } catch (error) {
      logger.error('Get current session error', { error });
      res.status(500).json({
        success: false,
        error: { type: 'internal', message: 'Failed to get current session' }
      });
    }
  }

  /**
   * POST /sessions/assign - Assign current session to a project
   * 
   * REMOVED: This endpoint was disabled because sessions now auto-inherit 
   * project from project_switch MCP tool or session start parameters.
   * Manual mid-session reassignment would require mcp-server REST API 
   * (see SessionManagementHandler.assignSessionToProject).
   * 
   * If needed in future, wire to mcp-server via McpService.callTool().
   */
  static async assignCurrentSession(_req: Request, res: Response): Promise<void> {
    res.status(410).json({
      success: false,
      error: {
        type: 'removed',
        message: 'Session assignment endpoint removed. Sessions auto-inherit project from project_switch or session start.',
        recommendation: 'Use project_switch MCP tool to set project context before starting work.'
      }
    });
  }

  /**
   * PUT /sessions/:id - Update session metadata
   */
  static async updateSession(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const updates = req.body as UpdateSessionData;

      const existingSession = await SessionController.fetchSessionSummary(id);
      if (!existingSession) {
        res.status(404).json({
          success: false,
          error: {
            type: 'not_found',
            message: 'Session not found',
          },
        });
        return;
      }

      // Update sessions table (unified table)
      const fields: string[] = [];
      const values: Array<any> = [id];

      if (typeof updates.title !== 'undefined') {
        fields.push(`title = $${values.length + 1}`);
        values.push(updates.title);
      }

      if (typeof updates.description !== 'undefined') {
        fields.push(`description = $${values.length + 1}`);
        values.push(updates.description);
      }

      if (typeof updates.session_goal !== 'undefined') {
        fields.push(`session_goal = $${values.length + 1}`);
        values.push(updates.session_goal);
      }

      if (typeof updates.tags !== 'undefined') {
        fields.push(`tags = $${values.length + 1}`);
        values.push(updates.tags);
      }

      if (typeof updates.ai_model !== 'undefined') {
        // Normalize at the write boundary (the auditor review C4) so 'amp smart' and
        // 'amp-smart' can never diverge in the data. null clears the field.
        fields.push(`ai_model = $${values.length + 1}`);
        values.push(normalizeAiModel(updates.ai_model));
      }

      // the project a record is CREATED IN / MOVED TO — the subject of
      // the write, not the viewer's current scope, so getRequestProjectId() is the wrong value
      // (the header names the project being viewed and would win over the body). Authorized
      // before this line because the resolver authorizes EVERY candidate and body.project_id
      // is a PROJECT_SCOPE_SOURCE, so a cross-project write needs access to both ends.
      if (typeof updates.project_id !== 'undefined') {
        fields.push(`project_id = $${values.length + 1}::uuid`);
        values.push(updates.project_id);
      }

      if (fields.length > 0) {
        fields.push('updated_at = NOW()');
        const updateQuery = `UPDATE sessions SET ${fields.join(', ')} WHERE id = $1`;
        await pool.query(updateQuery, values);
      }

      const updatedSession = await SessionController.fetchSessionSummary(id);
      if (!updatedSession) {
        res.status(500).json({
          success: false,
          error: {
            type: 'internal',
            message: 'Failed to load updated session',
          },
        });
        return;
      }

      res.json({
        success: true,
        data: {
          session: updatedSession,
        },
      });
    } catch (error) {
      logger.error('Update session error', { error });
      res.status(500).json({
        success: false,
        error: {
          type: 'internal',
          message: error instanceof Error ? error.message : 'Failed to update session',
        },
      });
    }
  }

  /**
   * GET /sessions - Get sessions list with filtering
   */
  static async getSessionsList(req: Request, res: Response): Promise<void> {
    try {
      const { status, actor, limit, offset } = req.query;

      const params: {
        scope: ProjectListScope;
        status?: string;
        actor?: string;
        limit?: number;
        offset?: number;
      } = {
        scope: await resolveListScope(req as AuthenticatedRequest),
        // Default to the same generous cap the service uses (1000) so omitting `limit`
        // does NOT silently truncate the list. The previous default of 50 capped the
        // Sessions list at 50 rows whenever the client didn't pass a limit (which it
        // couldn't, because the generated OpenAPI client dropped limit/offset).
        limit: typeof limit === 'string' ? parseInt(limit) : 1000,
        offset: typeof offset === 'string' ? parseInt(offset) : 0,
      };
      
      if (typeof status === 'string') {
        params.status = status;
      }

      // Optional "who" slice — validated/normalized; invalid values are dropped so a
      // bad param never 500s or silently returns everything unfiltered.
      const actorFilter = parseActorParam(actor);
      if (actorFilter) {
        params.actor = actorFilter;
      }

      const sessions = await SessionAnalyticsService.getSessionsList(params);

      res.json({
        success: true,
        data: sessions
      });
    } catch (error) {
      logger.error('Get sessions list error', { error });
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get sessions list'
      });
    }
  }

  /**
   * GET /sessions/stats - Get session statistics for dashboard
   */
  static async getSessionStats(req: Request, res: Response): Promise<void> {
    try {
      // Viewer-local day bucketing for the "today" counter; default UTC.
      const tz = resolveAggTimeZone(req.query.tz);

      const stats = await SessionAnalyticsService.getSessionStats(
        await resolveListScope(req as AuthenticatedRequest),
        tz
      );

      res.json({
        success: true,
        data: stats
      });
    } catch (error) {
      logger.error('Get session stats error', { error });
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get session stats'
      });
    }
  }
  private static async fetchSessionSummary(sessionId: string): Promise<SessionSummary | null> {
    // Query unified sessions table
    const sessionsQuery = `
      SELECT
        s.id,
        s.project_id,
        p.name AS project_name,
        s.title,
        s.description,
        s.session_goal,
        s.tags,
        s.ai_model,
        s.agent_type as session_type,
        s.status,
        s.started_at as created_at,
        s.updated_at,
        -- WAS: s.contexts_created AS context_count -- the second POISONED ALIAS (the other
        -- is services/project.ts). Derived from the child table; RULE 1 (a single session's
        -- own total is never project-filtered).
        ${contextCountSql('s')} AS context_count,
        COALESCE(s.last_activity_at, s.ended_at, s.started_at) AS last_context_at
      FROM sessions s
      LEFT JOIN projects p ON p.id = s.project_id
      WHERE s.id = $1
    `;

    const { rows } = await pool.query<SessionSummaryRow>(sessionsQuery, [sessionId]);
    
    if (rows.length === 0) {
      return null;
    }

    const row = rows[0];
    return {
      id: row.id,
      project_id: row.project_id ?? undefined,
      project_name: row.project_name,
      title: row.title,
      description: row.description,
      session_goal: row.session_goal,
      tags: row.tags,
      ai_model: row.ai_model,
      session_type: row.session_type,
      status: row.status,
      created_at: row.created_at,
      updated_at: row.updated_at,
      context_count: row.context_count !== null ? Number(row.context_count) : undefined,
      last_context_at: row.last_context_at,
    };
  }
}

interface SessionSummaryRow {
  id: string;
  project_id: string | null;
  project_name: string | null;
  title: string | null;
  description: string | null;
  session_goal?: string | null;
  tags?: string[] | null;
  ai_model?: string | null;
  session_type: string | null;
  status: string | null;
  created_at: string;
  updated_at: string;
  context_count: string | null;
  last_context_at: string | null;
}

interface SessionSummary {
  id: string;
  project_id?: string;
  project_name?: string | null;
  title?: string | null;
  description?: string | null;
  session_goal?: string | null;
  tags?: string[] | null;
  ai_model?: string | null;
  session_type?: string | null;
  status?: string | null;
  created_at: string;
  updated_at: string;
  context_count?: number;
  last_context_at?: string | null;
}