/**
 * Session Analytics Controller
 * Business logic extracted from MCP handlers for REST API
 * Part of MCP → REST migration (Phase 2D/2E, Phase 3)
 */

import { Request, Response } from 'express';
import { SessionManagementHandler } from '../../handlers/sessionAnalytics.js';
import { SessionTracker } from '../../services/session/SessionTracker.js';
import { db } from '../../config/database.js';
import { formatSessionsList, formatSessionStats, formatSessionComparison } from '../../utils/sessionFormatters.js';
import { logger } from '../../utils/logger.js';
import { isValidUuid } from '../../utils/uuid.js';

/**
 * Format-check a session id at the REST boundary. Returns true and writes a
 * clean 404 if the id is not a syntactically valid UUID, so a malformed id
 * (e.g. `session_voiceitt-bridge`) never reaches a Postgres uuid column and
 * throws `invalid input syntax for type uuid` (an unhandled 500). 404 (not 400)
 * because at this REST surface a non-UUID `:sessionId` simply cannot identify
 * any session — it is "not found", not a malformed *request body*.
 */
function rejectInvalidSessionId(res: Response, sessionId: string): boolean {
  if (isValidUuid(sessionId)) return false;
  res.status(404).json({
    success: false,
    error: 'Session not found'
  });
  return true;
}

/**
 * Normalize an Express request value (route param or query param) to a plain
 * string. In @types/express 5.x, `req.params[x]` is typed `string | string[]`
 * and `req.query[x]` is `string | string[] | ParsedQs | ParsedQs[] | undefined`.
 * These endpoints only ever expect single scalar values, so collapse arrays to
 * their first element and coerce anything else to a string (empty when absent).
 */
function asStr(value: unknown): string {
  if (Array.isArray(value)) {
    return value.length > 0 ? asStr(value[0]) : '';
  }
  if (value === undefined || value === null) {
    return '';
  }
  return String(value);
}

/**
 * Session Analytics Controller
 * Provides REST API endpoints for session tracking and analytics
 */
export class SessionAnalyticsController {
  /**
   * Record a session activity
   * POST /api/v2/sessions/:sessionId/activities
   */
  async recordActivity(req: Request, res: Response): Promise<void> {
    try {
      const sessionId = asStr(req.params.sessionId);
      if (rejectInvalidSessionId(res, sessionId)) return;
      const { activityType, activityData } = req.body;

      if (!sessionId || !activityType) {
        res.status(400).json({
          success: false,
          error: 'sessionId and activityType are required'
        });
        return;
      }

      const result = await SessionManagementHandler.recordSessionActivity(
        sessionId,
        activityType,
        activityData || {}
      );

      // Extract text from MCP response format
      const textContent = result.content[0].text;

      res.json({
        success: true,
        data: {
          sessionId,
          activityType,
          activityData,
          message: textContent
        }
      });
    } catch (error) {
      const err = error as Error;
      logger.error('Failed to record activity', err);
      res.status(500).json({
        success: false,
        error: err.message || 'Unknown error'
      });
    }
  }

  /**
   * Get session activities
   * GET /api/v2/sessions/:sessionId/activities?type=&limit=
   */
  async getActivities(req: Request, res: Response): Promise<void> {
    try {
      const sessionId = asStr(req.params.sessionId);
      if (rejectInvalidSessionId(res, sessionId)) return;
      const activityType = req.query.type as string | undefined;
      const limit = req.query.limit ? Number(req.query.limit) : 100;

      if (!sessionId) {
        res.status(400).json({
          success: false,
          error: 'sessionId is required'
        });
        return;
      }

      const result = await SessionManagementHandler.getSessionActivitiesHandler(
        sessionId,
        activityType,
        limit
      );

      // Extract text from MCP response format
      const textContent = result.content[0].text;

      res.json({
        success: true,
        data: {
          sessionId,
          activities: textContent
        }
      });
    } catch (error) {
      const err = error as Error;
      logger.error('Failed to get activities', err);
      res.status(500).json({
        success: false,
        error: err.message || 'Unknown error'
      });
    }
  }

  /**
   * Record file edit
   * POST /api/v2/sessions/:sessionId/files
   */
  async recordFileEdit(req: Request, res: Response): Promise<void> {
    try {
      const sessionId = asStr(req.params.sessionId);
      if (rejectInvalidSessionId(res, sessionId)) return;
      const { filePath, linesAdded, linesDeleted, source } = req.body;

      if (!sessionId || !filePath || isNaN(Number(linesAdded)) || isNaN(Number(linesDeleted))) {
        res.status(400).json({
          success: false,
          error: 'sessionId, filePath, linesAdded, and linesDeleted are required'
        });
        return;
      }

      const result = await SessionManagementHandler.recordFileEdit(
        sessionId,
        filePath,
        Number(linesAdded),
        Number(linesDeleted),
        (source || 'tool') as 'tool' | 'git' | 'manual'
      );

      // Extract text from MCP response format
      const textContent = result.content[0].text;

      res.json({
        success: true,
        data: {
          sessionId,
          filePath,
          linesAdded: Number(linesAdded),
          linesDeleted: Number(linesDeleted),
          netChange: Number(linesAdded) - Number(linesDeleted),
          source: source || 'tool',
          message: textContent
        }
      });
    } catch (error) {
      const err = error as Error;
      logger.error('Failed to record file edit', err);
      res.status(500).json({
        success: false,
        error: err.message || 'Unknown error'
      });
    }
  }

  /**
   * Get session files
   * GET /api/v2/sessions/:sessionId/files
   */
  async getFiles(req: Request, res: Response): Promise<void> {
    try {
      const sessionId = asStr(req.params.sessionId);
      if (rejectInvalidSessionId(res, sessionId)) return;

      if (!sessionId) {
        res.status(400).json({
          success: false,
          error: 'sessionId is required'
        });
        return;
      }

      // Get files array directly from SessionTracker (not MCP handler)
      const files = await SessionTracker.getSessionFiles(sessionId);

      // Map field names to match frontend SessionFile interface
      const mappedFiles = files.map(file => ({
        id: file.id,
        session_id: file.session_id,
        file_path: file.file_path,
        lines_added: file.lines_added,
        lines_deleted: file.lines_deleted,
        source: file.source,
        first_modified_at: file.first_modified,
        last_modified_at: file.last_modified
      }));

      res.json({
        success: true,
        data: {
          sessionId,
          files: mappedFiles
        }
      });
    } catch (error) {
      const err = error as Error;
      logger.error('Failed to get files', err);
      res.status(500).json({
        success: false,
        error: err.message || 'Unknown error'
      });
    }
  }

  /**
   * Calculate productivity score
   * POST /api/v2/sessions/:sessionId/productivity
   */
  async calculateProductivity(req: Request, res: Response): Promise<void> {
    try {
      const sessionId = asStr(req.params.sessionId);
      if (rejectInvalidSessionId(res, sessionId)) return;
      const { configName } = req.body;

      if (!sessionId) {
        res.status(400).json({
          success: false,
          error: 'sessionId is required'
        });
        return;
      }

      const result = await SessionManagementHandler.calculateSessionProductivity(
        sessionId,
        configName || 'default'
      );

      // Extract text from MCP response format
      const textContent = result.content[0].text;

      res.json({
        success: true,
        data: {
          sessionId,
          configName: configName || 'default',
          message: textContent
        }
      });
    } catch (error) {
      const err = error as Error;
      logger.error('Failed to calculate productivity', err);
      res.status(500).json({
        success: false,
        error: err.message || 'Unknown error'
      });
    }
  }

  /**
   * List sessions with filters
   * GET /api/v2/sessions?projectId=&dateFrom=&dateTo=...
   */
  async listSessions(req: Request, res: Response): Promise<void> {
    try {
      const {
        projectId,
        dateFrom,
        dateTo,
        tags,
        status,
        agentType,
        hasGoal,
        minProductivity,
        sortBy = 'started_at',
        sortOrder = 'desc',
        limit = 25,
        offset = 0
      } = req.query;

      // Parse tags if provided as comma-separated string
      let parsedTags: string[] | undefined;
      if (tags) {
        parsedTags = typeof tags === 'string' ? tags.split(',') : (tags as string[]);
      }

      // Build WHERE clauses dynamically
      const whereConditions: string[] = [];
      const queryParams: any[] = [];
      let paramIndex = 1;

      if (projectId) {
        whereConditions.push(`s.project_id = $${paramIndex++}`);
        queryParams.push(projectId);
      }

      if (dateFrom) {
        whereConditions.push(`s.started_at >= $${paramIndex++}`);
        queryParams.push(dateFrom);
      }

      if (dateTo) {
        whereConditions.push(`s.started_at <= $${paramIndex++}`);
        queryParams.push(dateTo);
      }

      if (parsedTags && parsedTags.length > 0) {
        whereConditions.push(`s.tags && $${paramIndex++}::text[]`);
        queryParams.push(parsedTags);
      }

      if (status && status !== 'all') {
        whereConditions.push(`s.status = $${paramIndex++}`);
        queryParams.push(status);
      }

      if (agentType) {
        whereConditions.push(`s.agent_type = $${paramIndex++}`);
        queryParams.push(agentType);
      }

      const hasGoalString = String(hasGoal);
      if (hasGoalString === 'true' || hasGoalString === 'TRUE') {
        whereConditions.push(`s.session_goal IS NOT NULL`);
      } else if (hasGoalString === 'false' || hasGoalString === 'FALSE') {
        whereConditions.push(`s.session_goal IS NULL`);
      }

      if (minProductivity !== undefined) {
        whereConditions.push(`s.productivity_score >= $${paramIndex++}`);
        queryParams.push(Number(minProductivity));
      }

      const whereClause = whereConditions.length > 0
        ? 'WHERE ' + whereConditions.join(' AND ')
        : '';

      // Validate sortBy
      const validSortFields = ['started_at', 'duration', 'productivity', 'loc'];
      const safeSortBy = validSortFields.includes(sortBy as string) ? sortBy : 'started_at';
      const safeSortOrder = sortOrder === 'asc' ? 'ASC' : 'DESC';

      // Build ORDER BY clause.
      //
      // TOTAL ORDER: every key below is non-unique — duration, productivity
      // and lines_net tie constantly (whole blocks of NULL/0), and this query is LIMIT/OFFSET
      // paged just below, so a partial order lets a page boundary repeat one session and drop
      // another. `s.id` is the PK: unique, stable under edits, already indexed. It is appended
      // to every branch rather than to one, because a tiebreaker that covers some sort modes
      // is a tiebreaker that fails on whichever mode the caller actually picked.
      const TIEBREAK = 's.id DESC';
      let orderByClause = '';
      if (safeSortBy === 'started_at') {
        orderByClause = `ORDER BY s.started_at ${safeSortOrder}, ${TIEBREAK}`;
      } else if (safeSortBy === 'duration') {
        orderByClause = `ORDER BY s.duration_minutes ${safeSortOrder}, ${TIEBREAK}`;
      } else if (safeSortBy === 'productivity') {
        orderByClause = `ORDER BY s.productivity_score ${safeSortOrder} NULLS LAST, ${TIEBREAK}`;
      } else if (safeSortBy === 'loc') {
        orderByClause = `ORDER BY s.lines_net ${safeSortOrder} NULLS LAST, ${TIEBREAK}`;
      }

      // Main query
      const query = `
        SELECT * FROM v_session_summaries s
        ${whereClause}
        ${orderByClause}
        LIMIT $${paramIndex++} OFFSET $${paramIndex++}
      `;

      queryParams.push(Number(limit), Number(offset));

      const result = await db.query(query, queryParams);

      // Get total count
      const countQuery = `
        SELECT COUNT(*) as count FROM v_session_summaries s
        ${whereClause}
      `;

      const countResult = await db.query(countQuery, queryParams.slice(0, -2));
      const totalCount = parseInt(countResult.rows[0].count);

      // Format output
      const formattedOutput = formatSessionsList(
        result.rows,
        totalCount,
        {
          projectId,
          dateFrom,
          dateTo,
          tags: parsedTags,
          status,
          agentType,
          hasGoal,
          minProductivity,
          sortBy,
          sortOrder
        },
        Number(limit),
        Number(offset)
      );

      res.json({
        success: true,
        data: {
          sessions: result.rows,
          totalCount,
          limit: Number(limit),
          offset: Number(offset),
          formatted: formattedOutput
        }
      });
    } catch (error) {
      const err = error as Error;
      logger.error('Failed to list sessions', err);
      res.status(500).json({
        success: false,
        error: err.message || 'Unknown error'
      });
    }
  }

  /**
   * Get session detail by ID
   * GET /api/v2/sessions/:sessionId
   */
  async getSessionDetail(req: Request, res: Response): Promise<void> {
    try {
      const sessionId = asStr(req.params.sessionId);
      if (rejectInvalidSessionId(res, sessionId)) return;

      if (!sessionId) {
        res.status(400).json({
          success: false,
          error: 'sessionId is required'
        });
        return;
      }

      // Query session from v_session_summaries view
      const query = `
        SELECT * FROM v_session_summaries
        WHERE id = $1
      `;

      const result = await db.query(query, [sessionId]);

      if (result.rows.length === 0) {
        res.status(404).json({
          success: false,
          error: 'Session not found'
        });
        return;
      }

      const session = result.rows[0];

      res.json({
        success: true,
        data: {
          session
        }
      });
    } catch (error) {
      const err = error as Error;
      logger.error('Failed to get session detail', err);
      res.status(500).json({
        success: false,
        error: err.message || 'Unknown error'
      });
    }
  }

  /**
   * Get session statistics
   * GET /api/v2/sessions/stats?projectId=&period=&groupBy=&phase2Only=
   */
  async getStats(req: Request, res: Response): Promise<void> {
    try {
      const {
        projectId,
        period = 'all',
        groupBy = 'none',
        phase2Only = false
      } = req.query;

      // Get enhanced stats
      const stats = await SessionTracker.getSessionStatsEnhanced({
        projectId: projectId as string | undefined,
        period: (period as string) as 'day' | 'week' | 'month' | 'all' | undefined,
        groupBy: (groupBy as string) as 'project' | 'agent' | 'tag' | 'none' | undefined,
        phase2Only: String(phase2Only) === 'true' || String(phase2Only) === 'TRUE'
      });

      // Format output
      const formattedOutput = formatSessionStats(stats, {
        projectId,
        period,
        groupBy,
        phase2Only
      });

      res.json({
        success: true,
        data: {
          stats,
          formatted: formattedOutput
        }
      });
    } catch (error) {
      const err = error as Error;
      logger.error('Failed to get session stats', err);
      res.status(500).json({
        success: false,
        error: err.message || 'Unknown error'
      });
    }
  }

  /**
   * Sync files from git for a session (manual trigger)
   * POST /api/v2/sessions/:sessionId/sync-files
   */
  async syncFiles(req: Request, res: Response): Promise<void> {
    try {
      const sessionId = asStr(req.params.sessionId);
      if (rejectInvalidSessionId(res, sessionId)) return;

      if (!sessionId) {
        res.status(400).json({
          success: false,
          error: 'sessionId is required'
        });
        return;
      }

      logger.info('Manual file sync triggered', {
        component: 'SessionAnalyticsController',
        operation: 'syncFiles',
        metadata: { sessionId }
      });

      const result = await SessionTracker.syncFilesFromGit(sessionId);

      if (result.error) {
        res.status(500).json({
          success: false,
          error: result.error,
          data: {
            filesProcessed: result.filesProcessed,
            totalLinesAdded: result.totalLinesAdded,
            totalLinesDeleted: result.totalLinesDeleted
          }
        });
        return;
      }

      res.json({
        success: true,
        data: {
          sessionId,
          filesProcessed: result.filesProcessed,
          totalLinesAdded: result.totalLinesAdded,
          totalLinesDeleted: result.totalLinesDeleted,
          netChange: result.totalLinesAdded - result.totalLinesDeleted,
          message: `Synced ${result.filesProcessed} files from git (+${result.totalLinesAdded}/-${result.totalLinesDeleted} lines)`
        }
      });
    } catch (error) {
      const err = error as Error;
      logger.error('Failed to sync files', err);
      res.status(500).json({
        success: false,
        error: err.message || 'Unknown error'
      });
    }
  }

  /**
   * Compare two sessions
   * GET /api/v2/sessions/compare?sessionId1=&sessionId2=
   */
  async compareSessions(req: Request, res: Response): Promise<void> {
    try {
      const sessionId1 = asStr(req.query.sessionId1);
      const sessionId2 = asStr(req.query.sessionId2);

      if (!sessionId1 || !sessionId2) {
        res.status(400).json({
          success: false,
          error: 'Both sessionId1 and sessionId2 are required'
        });
        return;
      }

      // Format-check both ids before they reach the uuid column. A malformed id
      // would otherwise make Postgres throw `invalid input syntax for type uuid`
      // (an unhandled 500). A non-UUID id cannot identify any session → 404.
      if (!isValidUuid(sessionId1) || !isValidUuid(sessionId2)) {
        res.status(404).json({
          success: false,
          error: 'One or both sessions not found'
        });
        return;
      }

      // Fetch both sessions
      const result = await db.query(`
        SELECT * FROM v_session_summaries
        WHERE id IN ($1, $2)
      `, [sessionId1, sessionId2]);

      if (result.rows.length !== 2) {
        res.status(404).json({
          success: false,
          error: `One or both sessions not found. Session 1: ${sessionId1}, Session 2: ${sessionId2}`
        });
        return;
      }

      // Find which is which
      const session1 = result.rows.find((r: any) => r.id === sessionId1);
      const session2 = result.rows.find((r: any) => r.id === sessionId2);

      if (!session1 || !session2) {
        res.status(404).json({
          success: false,
          error: 'Sessions not found'
        });
        return;
      }

      // Format output
      const formattedOutput = formatSessionComparison(session1, session2);

      res.json({
        success: true,
        data: {
          session1,
          session2,
          formatted: formattedOutput
        }
      });
    } catch (error) {
      const err = error as Error;
      logger.error('Failed to compare sessions', err);
      res.status(500).json({
        success: false,
        error: err.message || 'Unknown error'
      });
    }
  }

  /**
   * Start a new session
   * POST /api/v2/sessions/start
   */
  async startSession(req: Request, res: Response): Promise<void> {
    try {
      const { projectId, title, description, sessionGoal, tags, aiModel, sessionType } = req.body;

      logger.info(`Starting new session for project: ${projectId || 'auto-detect'}`);

      // Normalize ai_model at the write boundary (the auditor review C4): trim/lowercase/
      // hyphenate so 'amp smart' and 'amp-smart' can never diverge in the data again.
      const { normalizeAiModel } = await import('../../config/aiModels.js');
      const normalizedAiModel = normalizeAiModel(aiModel);

      // Sessions Foundation Phase 1: derive the ACTOR to stamp. On an AUTHED surface the
      // authenticated principal is authoritative and a client cannot REPLACE it — it may only
      // REFINE it (by default the principal overrides the
      // declared header; with composites enabled it SCOPES the declared handle into
      // `<principal>/<handle>`). deriveActor owns that rule — do not restate it here. This
      // mcp-server REST sessions mount is NOT currently fronted by
      // auth, so `oauthSubject` is normally absent here and the declared X-Actor-ID header is
      // used (attribution, not authz, on the single-tenant container); if this mount is later
      // placed behind dualBearerAuth the auth-derive branch activates automatically. Absent
      // both → the lifecycle service stamps the flagged `anonymous` actor + counter.
      const { deriveActor } = await import('../../config/actorRegistry.js');
      const authSub = (req as { oauthSubject?: { sub?: string } }).oauthSubject?.sub;
      const actor = deriveActor(authSub, req.header('X-Actor-ID'));

      const { SessionAnalyticsHandler } = await import('../../handlers/sessionAnalytics.js');
      const result = await SessionAnalyticsHandler.startSession(
        projectId,
        title,
        description,
        sessionGoal,
        tags,
        normalizedAiModel ?? undefined,
        sessionType,
        actor
      );

      if (!result.success) {
        res.status(500).json(result);
        return;
      }

      logger.info(`Session started successfully: ${result.data?.session_id?.substring(0, 8)}...`);

      res.status(201).json({
        success: true,
        data: result.data,
        message: 'Session started successfully'
      });
    } catch (error) {
      const err = error as Error;
      logger.error('Failed to start session', err);
      res.status(500).json({
        success: false,
        error: err.message || 'Unknown error'
      });
    }
  }

  /**
   * End a session
   * POST /api/v2/sessions/:sessionId/end
   */
  async endSession(req: Request, res: Response): Promise<void> {
    try {
      const sessionId = asStr(req.params.sessionId);
      if (rejectInvalidSessionId(res, sessionId)) return;

      if (!sessionId) {
        res.status(400).json({
          success: false,
          error: 'sessionId is required'
        });
        return;
      }

      logger.info(`Ending session: ${sessionId.substring(0, 8)}...`);

      const { SessionAnalyticsHandler } = await import('../../handlers/sessionAnalytics.js');
      const result = await SessionAnalyticsHandler.endSession(sessionId);

      if (!result.success) {
        res.status(500).json(result);
        return;
      }

      logger.info(`Session ended successfully: ${sessionId.substring(0, 8)}...`);
      logger.info(`  Productivity score: ${result.data?.productivity_score}`);
      logger.info(`  Contexts created: ${result.data?.contexts_created}`);

      res.json({
        success: true,
        data: result.data,
        message: 'Session ended successfully'
      });
    } catch (error) {
      const err = error as Error;
      logger.error('Failed to end session', err);
      res.status(500).json({
        success: false,
        error: err.message || 'Unknown error'
      });
    }
  }

  /**
   * Get active session
   * GET /api/v2/sessions/active
   */
  async getActiveSession(_req: Request, res: Response): Promise<void> {
    try {
      logger.debug('Getting active session');

      const { SessionAnalyticsHandler } = await import('../../handlers/sessionAnalytics.js');
      const result = await SessionAnalyticsHandler.getActiveSession();

      if (!result.success) {
        // No active session is not an error, return 200 with null data
        res.json({
          success: true,
          data: null,
          message: 'No active session found'
        });
        return;
      }

      logger.debug(`Active session: ${result.data?.session_id?.substring(0, 8)}...`);

      res.json({
        success: true,
        data: result.data,
        message: 'Active session retrieved'
      });
    } catch (error) {
      const err = error as Error;
      logger.error('Failed to get active session', err);
      res.status(500).json({
        success: false,
        error: err.message || 'Unknown error'
      });
    }
  }
}
