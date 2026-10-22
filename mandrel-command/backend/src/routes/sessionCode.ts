import { Router, Request, Response , type RequestParamHandler } from 'express';
import { authenticateToken } from '../middleware/auth';
import { validateUUIDParam } from '../middleware/validation';
import { SessionDetailService } from '../services/sessionDetail';
import { GitService } from '../services/gitService';
import { db as pool } from '../database/connection';
import { logger } from '../config/logger';
import { declareAnyAuthenticatedMayWrite } from '../middleware/authz';
import { authorizeEntityPathParam } from '../services/entityProjectScope';

const router = Router();

// Apply authentication to all session-code routes
router.use(authenticateToken);

/**
 * AUTHORIZE THE ENTITY PATH PARAM (an earlier task — the entity-detail half).
 *
 * Covers GET /session/:sessionId, /commits/:sessionId, /metrics/:sessionId.
 * Registered as `router.param`, so it runs during ROUTING for every route on this router
 * that carries `:sessionId` — including ones nobody has written yet. That inheritance is the
 * whole point; the list-shaped alternative is what left these open while
 * `/api/projects/:id` next door was tight.
 *
 * Fail-closed and NON-DISCLOSING: a row that does not exist and a row the caller may not
 * have both answer 403, matching authorizeProjectPathParam. See services/entityProjectScope.ts.
 */
const authorizeSessionIdParam: RequestParamHandler = (req, res, next, value) =>
  authorizeEntityPathParam('session')(
    req as unknown as Parameters<ReturnType<typeof authorizeEntityPathParam>>[0],
    res as unknown as Parameters<ReturnType<typeof authorizeEntityPathParam>>[1],
    next,
    String(value)
  );
router.param('sessionId', authorizeSessionIdParam);


/**
 * GET /api/session-code/current
 * Get code activity for the current active session
 */
router.get('/current', async (_req: Request, res: Response): Promise<void> => {
  try {
    // Get current session from context or find most recent active session
    const sessionQuery = `
      SELECT id, project_id, started_at, ended_at
      FROM sessions 
      WHERE ended_at IS NULL 
      ORDER BY started_at DESC 
      LIMIT 1
    `;
    
    const sessionResult = await pool.query(sessionQuery);
    
    if (sessionResult.rows.length === 0) {
      res.status(404).json({
        success: false,
        error: 'No active session found'
      });
      return;
    }

    const session = sessionResult.rows[0];
    const sessionDetail = await SessionDetailService.getSessionDetail(session.id);
    
    if (!sessionDetail) {
      res.status(404).json({
        success: false,
        error: 'Session details not found'
      });
      return;
    }

    // Get code analysis sessions for this development session
    const codeAnalysisQuery = `
      SELECT 
        id, session_type, files_analyzed, components_found, dependencies_found,
        analysis_duration_ms, status, started_at, completed_at, commit_sha,
        branch_name, working_directory, git_status_clean, files_changed_count,
        new_components_count, updated_components_count, quality_score,
        trigger_type, auto_triggered
      FROM code_analysis_sessions
      WHERE development_session_id = $1
      ORDER BY started_at DESC
    `;
    
    const codeAnalysisResult = await pool.query(codeAnalysisQuery, [session.id]);

    res.json({
      success: true,
      data: {
        session: {
          id: sessionDetail.id,
          project_id: sessionDetail.project_id,
          project_name: sessionDetail.project_name,
          started_at: sessionDetail.started_at,
          duration_minutes: sessionDetail.duration_minutes
        },
        code_activity: {
          total_components: sessionDetail.code_components.length,
          components: sessionDetail.code_components,
          git_commits: sessionDetail.linked_commits,
          commits_contributed: sessionDetail.commits_contributed,
          git_correlation_confidence: sessionDetail.git_correlation_confidence
        },
        analysis_sessions: codeAnalysisResult.rows,
        metadata: {
          last_updated: new Date().toISOString(),
          analysis_count: codeAnalysisResult.rows.length
        }
      }
    });

  } catch (error) {
    logger.error('Get current session code activity error', { error });
    res.status(500).json({
      success: false,
      error: 'Failed to get current session code activity',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * GET /api/session-code/session/:sessionId
 * Get code activity for a specific session
 */
router.get('/session/:sessionId', validateUUIDParam('sessionId'), async (req: Request, res: Response): Promise<void> => {
  try {
    const { sessionId } = req.params;
    
    const sessionDetail = await SessionDetailService.getSessionDetail(sessionId);
    
    if (!sessionDetail) {
      res.status(404).json({
        success: false,
        error: 'Session not found'
      });
      return;
    }

    // Get code analysis sessions for this development session
    const codeAnalysisQuery = `
      SELECT 
        id, session_type, files_analyzed, components_found, dependencies_found,
        analysis_duration_ms, status, started_at, completed_at, commit_sha,
        branch_name, working_directory, git_status_clean, files_changed_count,
        new_components_count, updated_components_count, quality_score,
        trigger_type, auto_triggered, metadata
      FROM code_analysis_sessions
      WHERE development_session_id = $1
      ORDER BY started_at DESC
    `;
    
    const codeAnalysisResult = await pool.query(codeAnalysisQuery, [sessionId]);

    // Get detailed code metrics for analysis sessions
    const metricsQuery = `
      SELECT 
        cm.analysis_session_id,
        cm.metric_name,
        cm.metric_value,
        cm.component_id,
        cc.name as component_name,
        cc.file_path as component_file_path
      FROM code_metrics cm
      JOIN code_components cc ON cm.component_id = cc.id
      WHERE cm.analysis_session_id = ANY($1)
      ORDER BY cm.analysis_session_id, cm.metric_name
    `;
    
    const analysisSessionIds = codeAnalysisResult.rows.map(row => row.id);
    const metricsResult = analysisSessionIds.length > 0 
      ? await pool.query(metricsQuery, [analysisSessionIds])
      : { rows: [] };

    // Group metrics by analysis session
    const metricsBySession = metricsResult.rows.reduce((acc, metric) => {
      if (!acc[metric.analysis_session_id]) {
        acc[metric.analysis_session_id] = [];
      }
      acc[metric.analysis_session_id].push(metric);
      return acc;
    }, {} as Record<string, any[]>);

    res.json({
      success: true,
      data: {
        session: {
          id: sessionDetail.id,
          project_id: sessionDetail.project_id,
          project_name: sessionDetail.project_name,
          started_at: sessionDetail.started_at,
          ended_at: sessionDetail.ended_at,
          duration_minutes: sessionDetail.duration_minutes,
          session_type: sessionDetail.session_type
        },
        code_activity: {
          total_components: sessionDetail.code_components.length,
          components: sessionDetail.code_components,
          git_commits: sessionDetail.linked_commits,
          commits_contributed: sessionDetail.commits_contributed,
          git_correlation_confidence: sessionDetail.git_correlation_confidence
        },
        analysis_sessions: codeAnalysisResult.rows.map(session => ({
          ...session,
          metrics: metricsBySession[session.id] || []
        })),
        summary: {
          total_analysis_sessions: codeAnalysisResult.rows.length,
          total_files_analyzed: codeAnalysisResult.rows.reduce((sum, s) => sum + (s.files_analyzed?.length || 0), 0),
          total_components_found: codeAnalysisResult.rows.reduce((sum, s) => sum + (s.components_found || 0), 0),
          average_quality_score: codeAnalysisResult.rows.length > 0 
            ? codeAnalysisResult.rows
                .filter(s => s.quality_score !== null)
                .reduce((sum, s) => sum + s.quality_score, 0) / 
              codeAnalysisResult.rows.filter(s => s.quality_score !== null).length
            : null
        }
      }
    });
    return;

  } catch (error) {
    logger.error('Get session code activity error', { error });
    res.status(500).json({
      success: false,
      error: 'Failed to get session code activity',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * POST /api/session-code/analyze
 * Trigger code analysis for current session
 */
router.post(
  '/analyze',
  declareAnyAuthenticatedMayWrite('read-oriented analysis triggered by POST because of body size'),
  async (req: Request, res: Response): Promise<void> => {
  try {
    const {
      sessionId,
      analysisScope = 'full',
      targetFiles = [],
      gitContext = true
    } = req.body;

    // Get current session if not provided
    let targetSessionId = sessionId;
    if (!targetSessionId) {
      const currentSessionQuery = `
        SELECT id FROM sessions 
        WHERE ended_at IS NULL 
        ORDER BY started_at DESC 
        LIMIT 1
      `;
      const sessionResult = await pool.query(currentSessionQuery);
      
      if (sessionResult.rows.length === 0) {
        res.status(404).json({
          success: false,
          error: 'No active session found and no sessionId provided'
        });
      }
      
      targetSessionId = sessionResult.rows[0].id;
    }

    // Get session details to get project info
    const sessionDetail = await SessionDetailService.getSessionDetail(targetSessionId);
    if (!sessionDetail) {
      res.status(404).json({
        success: false,
        error: 'Session not found'
      });
      return;
    }

    // Get current git context
    let gitInfo = {};
    if (gitContext) {
      try {
        const currentCommit = await GitService.getCurrentCommitInfo(sessionDetail.project_id);
        gitInfo = {
          commit_sha: currentCommit.commit_sha,
          branch_name: currentCommit.branch_name,
          is_clean: currentCommit.is_clean,
          working_directory: process.cwd() // Would get from project config in real implementation
        };
      } catch (error) {
        logger.warn('Could not get git context', { error });
      }
    }

    // Create code analysis session record
    const insertAnalysisQuery = `
      INSERT INTO code_analysis_sessions (
        project_id, development_session_id, session_type, analysis_scope,
        target_files, trigger_type, triggered_by_agent, auto_triggered,
        commit_sha, branch_name, working_directory, git_status_clean,
        started_at, status
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14
      ) RETURNING id, started_at
    `;

    const analysisResult = await pool.query(insertAnalysisQuery, [
      sessionDetail.project_id,
      targetSessionId,
      'triggered', // session_type
      analysisScope,
      targetFiles,
      'request_analysis', // trigger_type
      null, // triggered_by_agent - would come from auth context
      false, // auto_triggered
      (gitInfo as any).commit_sha || null,
      (gitInfo as any).branch_name || null,
      (gitInfo as any).working_directory || null,
      (gitInfo as any).is_clean || null,
      new Date(),
      'pending'
    ]);

    const analysisSessionId = analysisResult.rows[0].id;
    const startedAt = analysisResult.rows[0].started_at;

    // TODO: In a real implementation, this would trigger actual code analysis
    // For now, we'll simulate completion with basic data
    const completionTime = new Date();
    const duration = completionTime.getTime() - new Date(startedAt).getTime();

    await pool.query(`
      UPDATE code_analysis_sessions 
      SET 
        status = 'completed',
        completed_at = $2,
        analysis_duration_ms = $3,
        components_found = 0,
        dependencies_found = 0,
        files_analyzed = $4
      WHERE id = $1
    `, [
      analysisSessionId,
      completionTime,
      duration,
      targetFiles.length > 0 ? targetFiles : ['simulated-analysis']
    ]);

    res.json({
      success: true,
      data: {
        analysis_session_id: analysisSessionId,
        session_id: targetSessionId,
        project_id: sessionDetail.project_id,
        analysis_scope: analysisScope,
        target_files: targetFiles,
        started_at: startedAt,
        completed_at: completionTime,
        duration_ms: duration,
        status: 'completed',
        git_context: gitInfo,
        message: 'Code analysis triggered successfully'
      }
    });
    return;

  } catch (error) {
    logger.error('Trigger code analysis error', { error });
    res.status(500).json({
      success: false,
      error: 'Failed to trigger code analysis',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * GET /api/session-code/commits/:sessionId
 * Get git commits for a session
 */
router.get('/commits/:sessionId', validateUUIDParam('sessionId'), async (req: Request, res: Response): Promise<void> => {
  try {
    const { sessionId } = req.params;
    const { includeFileChanges = false, confidenceThreshold = 0.3 } = req.query;

    const sessionDetail = await SessionDetailService.getSessionDetail(sessionId);
    if (!sessionDetail) {
      res.status(404).json({
        success: false,
        error: 'Session not found'
      });
      return;
    }

    // Get commits with optional file changes
    const commitsQuery = `
      SELECT 
        gc.*,
        csl.confidence_score,
        csl.link_type,
        csl.time_proximity_minutes,
        csl.author_match
      FROM git_commits gc
      JOIN commit_session_links csl ON gc.id = csl.commit_id
      WHERE csl.session_id = $1
        AND csl.confidence_score >= $2
      ORDER BY gc.author_date DESC
    `;

    const commitsResult = await pool.query(commitsQuery, [
      sessionId, 
      parseFloat(confidenceThreshold as string)
    ]);

    const commits = commitsResult.rows;

    // Get file changes if requested
    let commitsWithFiles = commits;
    if (includeFileChanges === 'true' && commits.length > 0) {
      const commitIds = commits.map(c => c.id);
      
      const fileChangesQuery = `
        SELECT 
          gfc.commit_id,
          gfc.file_path,
          gfc.old_file_path,
          gfc.change_type,
          gfc.lines_added,
          gfc.lines_removed,
          gfc.is_binary,
          gfc.is_generated
        FROM git_file_changes gfc
        WHERE gfc.commit_id = ANY($1)
        ORDER BY gfc.commit_id, gfc.file_path
      `;

      const fileChangesResult = await pool.query(fileChangesQuery, [commitIds]);
      
      // Group file changes by commit
      const fileChangesByCommit = fileChangesResult.rows.reduce((acc, change) => {
        if (!acc[change.commit_id]) {
          acc[change.commit_id] = [];
        }
        acc[change.commit_id].push(change);
        return acc;
      }, {} as Record<string, any[]>);

      commitsWithFiles = commits.map(commit => ({
        ...commit,
        file_changes: fileChangesByCommit[commit.id] || []
      }));
    }

    res.json({
      success: true,
      data: {
        session_id: sessionId,
        project_id: sessionDetail.project_id,
        commits: commitsWithFiles,
        summary: {
          total_commits: commits.length,
          confidence_threshold: parseFloat(confidenceThreshold as string),
          average_confidence: commits.length > 0 
            ? commits.reduce((sum, c) => sum + c.confidence_score, 0) / commits.length
            : 0,
          high_confidence_commits: commits.filter(c => c.confidence_score > 0.7).length,
          author_matched_commits: commits.filter(c => c.author_match).length,
          time_range: commits.length > 0 ? {
            earliest: commits[commits.length - 1].author_date,
            latest: commits[0].author_date
          } : null
        }
      }
    });
    return;

  } catch (error) {
    logger.error('Get session commits error', { error });
    res.status(500).json({
      success: false,
      error: 'Failed to get session commits',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * POST /api/session-code/correlate
 * Manually trigger session-code correlation
 */
router.post(
  '/correlate',
  declareAnyAuthenticatedMayWrite('derives correlations for the caller session; additive'),
  async (req: Request, res: Response): Promise<void> => {
  try {
    const { 
      sessionId, 
      forceRefresh = false, 
      confidenceThreshold = 0.3,
      scope = 'session'
    } = req.body;

    if (!sessionId) {
      res.status(400).json({
        success: false,
        error: 'sessionId is required'
      });
    }

    const sessionDetail = await SessionDetailService.getSessionDetail(sessionId);
    if (!sessionDetail) {
      res.status(404).json({
        success: false,
        error: 'Session not found'
      });
      return;
    }

    // Trigger correlation using SessionDetailService
    const correlationResult = await SessionDetailService.correlateSessionWithGit(sessionId);

    // If successful, also trigger git commit collection for recent data
    if (correlationResult.success && forceRefresh) {
      try {
        const since = new Date(sessionDetail.started_at);
        await GitService.collectCommitData({
          project_id: sessionDetail.project_id,
          since,
          limit: 100
        });
      } catch (error) {
        logger.warn('Failed to refresh git data during correlation', { error });
      }
    }

    res.json({
      success: true,
      data: {
        session_id: sessionId,
        project_id: sessionDetail.project_id,
        correlation_result: correlationResult,
        scope,
        confidence_threshold: confidenceThreshold,
        force_refresh: forceRefresh,
        timestamp: new Date().toISOString()
      }
    });
    return;

  } catch (error) {
    logger.error('Manual session correlation error', { error });
    res.status(500).json({
      success: false,
      error: 'Failed to correlate session with code',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * GET /api/session-code/metrics/:sessionId
 * Get code metrics for a session
 */
router.get('/metrics/:sessionId', validateUUIDParam('sessionId'), async (req: Request, res: Response): Promise<void> => {
  try {
    const { sessionId } = req.params;
    const { metricType, aggregateLevel = 'session' } = req.query;

    const sessionDetail = await SessionDetailService.getSessionDetail(sessionId);
    if (!sessionDetail) {
      res.status(404).json({
        success: false,
        error: 'Session not found'
      });
      return;
    }

    // Get code analysis sessions for this session
    const analysisSessionsQuery = `
      SELECT id, session_type, components_found, dependencies_found,
             analysis_duration_ms, files_analyzed, quality_score,
             started_at, completed_at
      FROM code_analysis_sessions
      WHERE development_session_id = $1
      ORDER BY started_at DESC
    `;

    const analysisResult = await pool.query(analysisSessionsQuery, [sessionId]);
    const analysisSessions = analysisResult.rows;

    if (analysisSessions.length === 0) {
      // MISSING `return` (pre-existing, folded in with an earlier task). This branch sent a
      // 200 and then FELL THROUGH to the rest of the handler, which sends a SECOND
      // response — `Cannot set headers after they are sent to the client`, and an
      // unhandled throw inside an async Express 4 handler, i.e. a hung request.
      // It was unreachable before this branch only because a non-admin never got this far:
      // the route answered from the victim's data or 404'd first. Authorizing the param
      // made the empty-analysis path reachable for a legitimately granted caller, which is
      // how it surfaced. The empty case is the honest answer; it just has to stop here.
      res.json({
        success: true,
        data: {
          session_id: sessionId,
          metrics: {},
          message: 'No code analysis sessions found for this session'
        }
      });
      return;
    }

    const analysisIds = analysisSessions.map(s => s.id);

    // Get detailed metrics
    let metricsQuery = `
      SELECT 
        cm.analysis_session_id,
        cm.component_id,
        cm.metric_name,
        cm.metric_value,
        cm.measured_at,
        cc.name as component_name,
        cc.file_path,
        cc.component_type
      FROM code_metrics cm
      JOIN code_components cc ON cm.component_id = cc.id
      WHERE cm.analysis_session_id = ANY($1)
    `;

    const queryParams: any[] = [analysisIds];

    if (metricType) {
      metricsQuery += ` AND cm.metric_name = $${queryParams.length + 1}`;
      queryParams.push(metricType);
    }

    metricsQuery += ` ORDER BY cm.analysis_session_id, cm.component_id, cm.metric_name`;

    const metricsResult = await pool.query(metricsQuery, queryParams);
    const metrics = metricsResult.rows;

    // Aggregate metrics based on level
    let aggregatedMetrics: any = {};

    if (aggregateLevel === 'session') {
      // Aggregate at session level
      const metricsByName = metrics.reduce((acc, metric) => {
        if (!acc[metric.metric_name]) {
          acc[metric.metric_name] = {
            values: [],
            components: new Set()
          };
        }
        acc[metric.metric_name].values.push(parseFloat(metric.metric_value) || 0);
        acc[metric.metric_name].components.add(metric.component_name);
        return acc;
      }, {} as Record<string, any>);

      aggregatedMetrics = Object.entries(metricsByName).reduce((acc, [name, data]: [string, any]) => {
        const values = data.values;
        acc[name] = {
          total: values.reduce((sum: number, val: number) => sum + val, 0),
          average: values.length > 0 ? values.reduce((sum: number, val: number) => sum + val, 0) / values.length : 0,
          min: Math.min(...values),
          max: Math.max(...values),
          count: values.length,
          components_affected: data.components.size
        };
        return acc;
      }, {} as Record<string, any>);

    } else if (aggregateLevel === 'component') {
      // Aggregate by component
      aggregatedMetrics = metrics.reduce((acc, metric) => {
        const key = `${metric.file_path}:${metric.component_name}`;
        if (!acc[key]) {
          acc[key] = {
            component_name: metric.component_name,
            file_path: metric.file_path,
            component_type: metric.component_type,
            metrics: {}
          };
        }
        acc[key].metrics[metric.metric_name] = parseFloat(metric.metric_value) || 0;
        return acc;
      }, {} as Record<string, any>);
    }

    // Calculate session-level summary statistics
    const sessionMetrics = {
      total_analysis_sessions: analysisSessions.length,
      total_components_analyzed: analysisSessions.reduce((sum, s) => sum + (s.components_found || 0), 0),
      total_files_analyzed: new Set(analysisSessions.flatMap(s => s.files_analyzed || [])).size,
      total_analysis_time_ms: analysisSessions.reduce((sum, s) => sum + (s.analysis_duration_ms || 0), 0),
      average_quality_score: analysisSessions.length > 0
        ? analysisSessions
            .filter(s => s.quality_score !== null)
            .reduce((sum, s) => sum + s.quality_score, 0) / 
          analysisSessions.filter(s => s.quality_score !== null).length
        : null,
      metric_types_collected: [...new Set(metrics.map(m => m.metric_name))],
      time_range: {
        first_analysis: analysisSessions[analysisSessions.length - 1]?.started_at,
        last_analysis: analysisSessions[0]?.completed_at
      }
    };

    res.json({
      success: true,
      data: {
        session_id: sessionId,
        project_id: sessionDetail.project_id,
        aggregate_level: aggregateLevel,
        metric_type_filter: metricType || null,
        session_metrics: sessionMetrics,
        aggregated_metrics: aggregatedMetrics,
        analysis_sessions: analysisSessions,
        raw_metrics_count: metrics.length
      }
    });
    return;

  } catch (error) {
    logger.error('Get session code metrics error', { error });
    res.status(500).json({
      success: false,
      error: 'Failed to get session code metrics',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

export default router;