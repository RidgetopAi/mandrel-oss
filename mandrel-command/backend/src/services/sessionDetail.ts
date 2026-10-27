import { db as pool } from '../database/connection';
import { GitService } from './gitService';
import { logger } from '../config/logger';
import { scopeParamRef, type ProjectListScope } from './projectListScope';
import {
  contextCountSql,
  taskCountSql,
  completedTaskCountSql,
  decisionCountSql,
} from './sessionCounts';
import { calculateActivityScore } from './sessionScore';

export interface SessionDetail {
  id: string;
  project_id: string;
  project_name?: string;
  session_type?: string;
  started_at: string;
  ended_at?: string;
  // created_at: alias of started_at (sessions are write-once at INSERT; there is no
  // separate created_at column). The SessionDetail UI reads `created_at`, so expose it
  // explicitly rather than leaving it undefined (which rendered "Created: Invalid Date").
  created_at: string;
  // last_activity_at / last_context_at: surfaced so the detail page's "Last Activity"
  // resolves instead of falling back to "No activity". last_context_at is an alias of
  // last_activity_at for the unified sessions model.
  last_activity_at?: string;
  last_context_at?: string;
  duration_minutes: number;

  // Token metrics
  total_tokens: number;
  prompt_tokens: number;
  completion_tokens: number;

  // Activity counts. Each `*_created` field and its `*_count` sibling are fed from the
  // SAME derived source (the child rows), so a consumer writing the defensive
  // `contexts_created ?? context_count` can never be handed a poisoned zero twice
  //.
  contexts_created: number;
  context_count: number;
  decisions_created: number;
  decision_count: number;
  tasks_created: number;
  task_count: number;
  tasks_completed: number;
  tasks_updated: number;
  api_requests: number;

  // Detailed activity lists
  contexts: SessionContext[];
  decisions: SessionDecision[];
  tasks: SessionTask[];
  code_components: SessionCodeComponent[];

  // Git correlation data
  commits_contributed: number;
  linked_commits: SessionCommit[];
  git_correlation_confidence: number;

  // Summary
  context_summary?: string;
  productivity_score: number;

  // Phase 1 enhancement fields
  files_modified_count?: number;
  lines_added?: number;
  lines_deleted?: number;
  lines_net?: number;
  ai_model?: string;
  session_goal?: string;
  tags?: string[];
  active_branch?: string;
  working_commit_sha?: string;
  activity_count?: number;
  // The "who" dimension — the stable principal that owns the session (Sessions
  // Foundation, migration 062). NULL for pre-062 / header-less sessions.
  actor?: string | null;
}

export interface SessionContext {
  id: string;
  context_type: string;
  content: string;
  tags?: string[];
  created_at: string;
  relevance_score?: number;
}

export interface SessionDecision {
  id: string;
  decision_type: string;
  title: string;
  description?: string;
  status: string;
  impact_level?: string;
  created_at: string;
}

export interface SessionTask {
  id: string;
  title: string;
  type: string;
  status: string;
  priority: string;
  created_at: string;
  completed_at?: string;
}

export interface SessionCodeComponent {
  id: string;
  file_path: string;
  component_type: string;
  name: string;
  lines_of_code: number;
  complexity_score?: number;
  analyzed_at: string;
}

export interface SessionCommit {
  id: string;
  commit_sha: string;
  short_sha: string;
  message: string;
  author_name: string;
  author_email: string;
  author_date: string;
  confidence_score: number;
  link_type: string;
  time_proximity_minutes?: number;
  author_match: boolean;
}

export interface SessionSummary {
  id: string;
  project_name?: string;
  started_at: string;
  duration_minutes: number;
  session_type: string;
  total_tokens: number;
  contexts_created: number;
  decisions_created: number;
  tasks_created: number;
  tasks_completed: number;
  commits_contributed: number;
  productivity_score: number;
}

export class SessionDetailService {
  /**
   * Get comprehensive details for a single session
   */
  static async getSessionDetail(sessionId: string): Promise<SessionDetail | null> {
    try {
      // Get basic session info
      const sessionQuery = `
        SELECT
          s.*,
          p.name as project_name,
          EXTRACT(EPOCH FROM (COALESCE(s.ended_at, CURRENT_TIMESTAMP) - s.started_at)) / 60 as duration_minutes
        FROM sessions s
        LEFT JOIN projects p ON s.project_id = p.id
        WHERE s.id = $1
      `;
      
      const sessionResult = await pool.query(sessionQuery, [sessionId]);
      
      if (sessionResult.rows.length === 0) {
        return null;
      }
      
      const session = sessionResult.rows[0];
      
      // Get contexts created during this session
      const contextsQuery = `
        SELECT 
          id,
          context_type,
          content,
          tags,
          created_at,
          relevance_score
        FROM contexts
        -- RULE 1 (services/sessionCounts.ts): a SINGLE session's own view is never
        -- project-filtered. The old 'AND project_id = $2' correlated the context's project to the
        -- SESSION's project, which drops every context a long-running session wrote before
        -- a mid-session project_switch — 1715 of 7271 session-linked contexts on prod (24%,
        -- measured 2026-07-26). It also made the expanded detail card disagree with the
        -- collapsed list row, which now uses the same rule.
        -- LIVE rows only: a soft-deleted context must not reappear in
        -- the session it was written in. Same rule migration 074 already applied to the
        -- session SUMMARY counters; this detail list was the drifted copy.
        WHERE archived_at IS NULL AND session_id = $1
        ORDER BY created_at DESC
      `;

      const contextsResult = await pool.query(contextsQuery, [sessionId]);
      
      // Get decisions made during this session
      const decisionsQuery = `
        SELECT 
          id,
          decision_type,
          title,
          description,
          status,
          impact_level,
          decision_date as created_at
        FROM technical_decisions
        WHERE archived_at IS NULL AND session_id = $1
        ORDER BY decision_date DESC
      `;
      
      const decisionsResult = await pool.query(decisionsQuery, [sessionId]);
      
      // Get tasks linked to this session via session_id foreign key
      const tasksQuery = `
        SELECT
          t.id,
          t.title,
          t.type,
          t.status,
          t.priority,
          t.created_at,
          t.completed_at
        FROM tasks t
        -- LIVE rows only. The contexts and decisions lists above already
        -- carry this predicate; this one was the copy that drifted, so a soft-deleted task
        -- came back in the session's task list AND in every number derived from these rows
        -- below (tasks_created, task_count, tasks_completed, the activity score). Same rule
        -- as taskCountSql / completedTaskCountSql in services/sessionCounts.ts, which the
        -- LIST surface uses -- one rule, so the two surfaces cannot answer differently.
        WHERE t.archived_at IS NULL AND t.session_id = $1
        ORDER BY t.created_at DESC
      `;

      const tasksResult = await pool.query(tasksQuery, [sessionId]);
      
      // Get code components analyzed during this session
      const codeQuery = `
        SELECT 
          cc.id,
          cc.file_path,
          cc.component_type,
          cc.name,
          cc.lines_of_code,
          cc.complexity_score,
          cc.analyzed_at
        FROM code_components cc
        WHERE cc.project_id = $1
          AND cc.analyzed_at BETWEEN $2 AND COALESCE($3, CURRENT_TIMESTAMP)
        ORDER BY cc.analyzed_at DESC
      `;
      
      const codeResult = await pool.query(codeQuery, [
        session.project_id,
        session.started_at,
        session.ended_at
      ]);
      
      // Get git commits linked to this session
      const commitsQuery = `
        SELECT 
          gc.id,
          gc.commit_sha,
          gc.short_sha,
          gc.message,
          gc.author_name,
          gc.author_email,
          gc.author_date,
          csl.confidence_score,
          csl.link_type,
          csl.time_proximity_minutes,
          csl.author_match
        FROM git_commits gc
        JOIN commit_session_links csl ON gc.id = csl.commit_id
        WHERE csl.session_id = $1
        ORDER BY gc.author_date DESC
      `;
      
      const commitsResult = await pool.query(commitsQuery, [sessionId]);
      
      // Calculate git correlation confidence
      const avgConfidence = commitsResult.rows.length > 0 
        ? commitsResult.rows.reduce((sum, commit) => sum + commit.confidence_score, 0) / commitsResult.rows.length
        : 0;
      
      // Activity (work) score — computed from LIVE counts via the SHARED calculator
      // so the detail view and the list view (getSessionSummaries) return the SAME
      // number for the same session. (Previously the list read denormalized counters
      // — decisions_created = 0 on every prod row — and under-scored vs this path.)
      const activityScore = calculateActivityScore({
        contexts: contextsResult.rows.length,
        decisions: decisionsResult.rows.length,
        tasksCompleted: tasksResult.rows.filter(t => t.status === 'completed').length,
        // pg returns NUMERIC/BIGINT as strings — parse so the score gets real numbers
        // (the calculator also coerces defensively, but parse at the boundary too).
        durationMinutes: parseFloat(session.duration_minutes) || 0,
        totalTokens: parseInt(session.total_tokens, 10) || 0,
      });
      
      return {
        id: session.id,
        project_id: session.project_id,
        project_name: session.project_name,
        session_type: session.agent_type || session.session_type,
        started_at: session.started_at,
        ended_at: session.ended_at,
        // created_at mirrors started_at (no separate created_at column on sessions).
        // Fixes "Created: Invalid Date" on the SessionDetail page, which reads created_at.
        created_at: session.started_at,
        // last_activity_at / last_context_at drive the detail page's "Last Activity".
        // Fall back to ended_at then started_at so the field is always a real timestamp
        // (the page showed "No activity" because the endpoint never returned these).
        last_activity_at: session.last_activity_at || session.ended_at || session.started_at,
        last_context_at: session.last_activity_at || session.ended_at || session.started_at,
        duration_minutes: Math.round(session.duration_minutes),

        // Token metrics - sessions table uses input_tokens/output_tokens
        total_tokens: session.total_tokens || 0,
        prompt_tokens: session.input_tokens || session.prompt_tokens || 0,
        completion_tokens: session.output_tokens || session.completion_tokens || 0,

        // Activity counts — from the CHILD ROWS we just fetched, unconditionally.
        // WAS `session.contexts_created || contextsResult.rows.length`. The `||` rescued
        // only the ZERO case; SessionRepo.finish() also wrote PARTIAL counts (whatever
        // delta happened to be un-flushed), and a partial is truthy, so it beat the true
        // count and rendered a plausible undercount. Every finalize was wrong, not just
        // the zeroed ones — so there is nothing to prefer the column for.
        // `session.decisions_created` was worse still: no runtime writer exists anywhere,
        // so it is permanently 0 and the `||` was dead code.
        contexts_created: contextsResult.rows.length,
        context_count: contextsResult.rows.length,
        decisions_created: decisionsResult.rows.length,
        decision_count: decisionsResult.rows.length,
        tasks_created: tasksResult.rows.length,
        task_count: tasksResult.rows.length,
        tasks_completed: tasksResult.rows.filter(t => t.status === 'completed').length,
        api_requests: session.api_requests || 0,

        contexts: contextsResult.rows.map(mapContext),
        decisions: decisionsResult.rows.map(mapDecision),
        tasks: tasksResult.rows.map(mapTask),
        code_components: codeResult.rows.map(mapCodeComponent),

        // Git correlation data
        commits_contributed: commitsResult.rows.length,
        linked_commits: commitsResult.rows.map(mapCommit),
        git_correlation_confidence: Math.round(avgConfidence * 100) / 100,

        context_summary: session.context_summary,
        // Always use the freshly-computed live score (NOT the stored
        // session.productivity_score column) so detail == list deterministically.
        // The stored column is a denormalized snapshot that can be stale/0 and was
        // the source of the divergence.
        productivity_score: activityScore,

        // Phase 1 enhancement fields from sessions table
        files_modified_count: session.files_modified_count || 0,
        lines_added: session.lines_added || 0,
        lines_deleted: session.lines_deleted || 0,
        lines_net: session.lines_net || 0,
        ai_model: session.ai_model,
        session_goal: session.session_goal,
        tags: session.tags || [],
        active_branch: session.active_branch,
        working_commit_sha: session.working_commit_sha,
        activity_count: session.activity_count || 0,
        tasks_updated: session.tasks_updated || 0,
        // The "who" dimension (Sessions Foundation, migration 062) — already selected
        // via `s.*`. Serialized (null when unstamped) so the detail view can show it.
        actor: session.actor ?? null,
      };
    } catch (error) {
      logger.error('Get session detail error', { error });
      throw new Error('Failed to get session detail');
    }
  }
  
  /**
   * Get session summaries with activity counts
   */
  static async getSessionSummaries(
    scope: ProjectListScope,
    limit: number = 20,
    offset: number = 0
  ): Promise<SessionSummary[]> {
    try {
      const params: any[] = [limit, offset];
      const projRef = scopeParamRef(scope, params);
      const whereClause = projRef ? `WHERE s.project_id = ${projRef}` : '';

      // NOTE: there is exactly ONE sessions table in the schema (`sessions`).
      // The legacy separate `user_sessions` (web sessions) table was consolidated
      // into `sessions` and no longer exists in any tenant DB.
      //
      // The Activity Score is computed from LIVE counts (counted off the session_id
      // linkage), NOT the denormalized counter columns — `decisions_created` is 0 on
      // every prod row, so the old SQL formula that read it under-scored every session
      // vs the detail view. We surface the same live signals the detail path uses
      // (contexts/decisions/tasks_completed via session_id) and feed them to the
      // SHARED calculateActivityScore() in TS so list == detail. The scoring math no
      // longer lives inline in SQL (configs-not-hardcoded: weights are in config).
      const query = `
        SELECT
          s.id,
          p.name as project_name,
          s.started_at,
          s.ended_at,
          COALESCE(s.total_tokens, s.tokens_used, 0) as total_tokens,
          -- The last denormalized counter left in this query: contexts/decisions/
          -- tasks_completed below were already derived, but tasks_created still read
          -- s.tasks_created, which finish() zeroed. Derived now, same linkage as its
          -- tasks_completed sibling so the pair can't disagree.
          -- ARCHIVE-AWARE via the canonical builder. These two were the
          -- only hand-written child counts left in this query, and being hand-written is
          -- exactly how they lost the archived_at IS NULL predicate while their
          -- contexts/decisions siblings below kept it -- a soft-deleted task went on
          -- counting on the Sessions list forever. Restating the rule inline is what let
          -- it drift; calling the one builder (services/sessionCounts.ts) is what stops it.
          -- RULE 1 (no project param): this read is scoped by the SESSION's project, so a
          -- child is counted on session linkage alone — unchanged by this fix.
          ${taskCountSql('s')} as tasks_created,
          EXTRACT(EPOCH FROM (COALESCE(s.ended_at, CURRENT_TIMESTAMP) - s.started_at)) / 60 as duration_minutes,
          COALESCE(s.agent_type, 'web') as session_type,
          (
            SELECT COUNT(*) FROM contexts c
            WHERE c.session_id = s.id AND c.archived_at IS NULL
          ) as contexts_created,
          (
            SELECT COUNT(*) FROM technical_decisions d
            WHERE d.session_id = s.id AND d.archived_at IS NULL
          ) as decisions_created,
          ${completedTaskCountSql('s')} as tasks_completed
        FROM sessions s
        LEFT JOIN projects p ON s.project_id = p.id
        ${whereClause}
        -- TOTAL ORDER (the MCP-server half is an earlier change). s.started_at is
        -- NOT UNIQUE — sessions started in the same instant tie, and this list is
        -- LIMIT/OFFSET paged below. Page 1 and page 2 are two independent sorts of the same
        -- tied block, so a partial order can hand the caller one session twice and never
        -- show another. The tiebreaker is the PRIMARY KEY: unique (makes the composite
        -- total), STABLE (does not move when the row is updated, so a page boundary cannot
        -- shift under a concurrent write — which is why it is not updated_at), and cheap
        -- (the PK btree already exists).
        ORDER BY s.started_at DESC, s.id DESC
        LIMIT $1 OFFSET $2
      `;

      const result = await pool.query(query, params);

      return result.rows.map(row => {
        const contexts = parseInt(row.contexts_created) || 0;
        const decisions = parseInt(row.decisions_created) || 0;
        const tasksCompleted = parseInt(row.tasks_completed) || 0;
        const durationMinutes = parseFloat(row.duration_minutes) || 0;
        const totalTokens = parseInt(row.total_tokens) || 0;

        return {
          id: row.id,
          project_name: row.project_name,
          started_at: row.started_at,
          duration_minutes: Math.round(durationMinutes),
          session_type: row.session_type,
          total_tokens: totalTokens,
          contexts_created: contexts,
          decisions_created: decisions,
          tasks_created: parseInt(row.tasks_created) || 0,
          tasks_completed: tasksCompleted,
          // Shared calculator on live counts — identical to getSessionDetail.
          productivity_score: calculateActivityScore({
            contexts,
            decisions,
            tasksCompleted,
            durationMinutes,
            totalTokens,
          }),
          commits_contributed: 0 // Will be populated when git correlation is implemented
        };
      });
    } catch (error) {
      logger.error('Get session summaries error', { error });
      throw new Error('Failed to get session summaries');
    }
  }
  
  /**
   * Trigger automatic git correlation for a session
   */
  static async correlateSessionWithGit(sessionId: string): Promise<{
    success: boolean;
    linksCreated: number;
    linksUpdated: number;
    confidence: number;
    message: string;
  }> {
    try {
      logger.info(`🔗 Correlating session ${sessionId.substring(0, 8)}... with git commits`);
      
      // Get session details (single consolidated `sessions` table; the legacy
      // `user_sessions` table no longer exists)
      const sessionQuery = `
        SELECT project_id, started_at, ended_at
        FROM sessions
        WHERE id = $1
      `;
      
      const sessionResult = await pool.query(sessionQuery, [sessionId]);
      
      if (sessionResult.rows.length === 0) {
        return {
          success: false,
          linksCreated: 0,
          linksUpdated: 0,
          confidence: 0,
          message: 'Session not found'
        };
      }
      
      const session = sessionResult.rows[0];
      
      if (!session.project_id) {
        return {
          success: false,
          linksCreated: 0,
          linksUpdated: 0,
          confidence: 0,
          message: 'Session not assigned to a project'
        };
      }
      
      // Run git correlation using GitService
      const correlationResult = await GitService.correlateCommitsWithSessions({
        project_id: session.project_id,
        since: new Date(session.started_at),
        confidence_threshold: 0.2 // Lower threshold for individual session correlation
      });
      
      return {
        success: true,
        linksCreated: correlationResult.links_created,
        linksUpdated: correlationResult.links_updated,
        confidence: correlationResult.high_confidence_links > 0 ? 0.8 : 0.4,
        message: `Correlation completed: ${correlationResult.links_created} new links, ${correlationResult.links_updated} updated`
      };
      
    } catch (error) {
      logger.error('Session git correlation error', { error });
      return {
        success: false,
        linksCreated: 0,
        linksUpdated: 0,
        confidence: 0,
        message: error instanceof Error ? error.message : 'Failed to correlate session with git'
      };
    }
  }

  /**
   * Auto-correlate git commits when session ends
   */
  static async autoCorrelateOnSessionEnd(sessionId: string): Promise<void> {
    try {
      logger.info(`🔄 Auto-correlating session ${sessionId.substring(0, 8)}... on session end`);
      
      // Small delay to ensure all git operations are complete
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      await this.correlateSessionWithGit(sessionId);
      
    } catch (error) {
      logger.error('Auto-correlation on session end failed', { error });
      // Non-blocking error - log but don't throw
    }
  }

  /**
   * Get aggregated session statistics by time period
   */
  static async getSessionStatsByPeriod(
    scope: ProjectListScope,
    period: 'day' | 'week' | 'month' = 'day',
    limit: number = 30
  ): Promise<any[]> {
    try {
      const periodFormat = {
        day: "DATE(started_at)",
        week: "DATE_TRUNC('week', started_at)",
        month: "DATE_TRUNC('month', started_at)"
      };
      
      const params: any[] = [limit];
      // PROJECT-FILTERED aggregate → RULE 2 (services/sessionCounts.ts): a child row counts
      // for project P only if the CHILD belongs to P. Unfiltered (ALL_PROJECTS only) →
      // RULE 1, session linkage only. Never `c.project_id = s.project_id`.
      const projParamRef = scopeParamRef(scope, params);
      const whereClause = projParamRef ? `WHERE s.project_id = ${projParamRef}` : '';

      const query = `
        SELECT 
          ${periodFormat[period]} as period,
          COUNT(DISTINCT s.id) as session_count,
          SUM(EXTRACT(EPOCH FROM (COALESCE(s.ended_at, CURRENT_TIMESTAMP) - s.started_at)) / 60) as total_duration_minutes,
          -- Tokens: the column is the only durable record (spec §9). Everything else is
          -- derived from the child tables — the denormalized counters were zeroed on every
          -- session end, and decisions_created has no runtime writer at all, so this
          -- panel's decisions total was structurally 0.
          SUM(COALESCE(s.total_tokens, 0)) as total_tokens,
          SUM(${contextCountSql('s', projParamRef)}) as total_contexts,
          SUM(${decisionCountSql('s', projParamRef)}) as total_decisions,
          SUM(${taskCountSql('s', projParamRef)}) as total_tasks_created,
          AVG(EXTRACT(EPOCH FROM (COALESCE(s.ended_at, CURRENT_TIMESTAMP) - s.started_at)) / 60) as avg_duration_minutes
        FROM sessions s
        ${whereClause}
        GROUP BY ${periodFormat[period]}
        ORDER BY period DESC
        LIMIT $1
      `;
      
      const result = await pool.query(query, params);
      
      return result.rows.map(row => ({
        period: row.period,
        session_count: parseInt(row.session_count) || 0,
        total_duration_minutes: Math.round(parseFloat(row.total_duration_minutes) || 0),
        total_tokens: parseInt(row.total_tokens) || 0,
        total_contexts: parseInt(row.total_contexts) || 0,
        total_decisions: parseInt(row.total_decisions) || 0,
        total_tasks_created: parseInt(row.total_tasks_created) || 0,
        avg_duration_minutes: Math.round(parseFloat(row.avg_duration_minutes) || 0)
      }));
    } catch (error) {
      logger.error('Get session stats by period error', { error });
      throw new Error('Failed to get session statistics by period');
    }
  }
}

// Helper functions
// (The activity/work score now lives in the shared calculateActivityScore() in
//  ./sessionScore so the list + detail surfaces compute it identically.)

function mapContext(row: any): SessionContext {
  return {
    id: row.id,
    context_type: row.context_type,
    content: row.content,
    tags: row.tags,
    created_at: row.created_at,
    relevance_score: row.relevance_score
  };
}

function mapDecision(row: any): SessionDecision {
  return {
    id: row.id,
    decision_type: row.decision_type,
    title: row.title,
    description: row.description,
    status: row.status,
    impact_level: row.impact_level,
    created_at: row.created_at
  };
}

function mapTask(row: any): SessionTask {
  return {
    id: row.id,
    title: row.title,
    type: row.type,
    status: row.status,
    priority: row.priority,
    created_at: row.created_at,
    completed_at: row.completed_at
  };
}

function mapCodeComponent(row: any): SessionCodeComponent {
  return {
    id: row.id,
    file_path: row.file_path,
    component_type: row.component_type,
    name: row.name,
    lines_of_code: row.lines_of_code,
    complexity_score: row.complexity_score,
    analyzed_at: row.analyzed_at
  };
}

function mapCommit(row: any): SessionCommit {
  return {
    id: row.id,
    commit_sha: row.commit_sha,
    short_sha: row.short_sha,
    message: row.message,
    author_name: row.author_name,
    author_email: row.author_email,
    author_date: row.author_date,
    confidence_score: parseFloat(row.confidence_score) || 0,
    link_type: row.link_type,
    time_proximity_minutes: row.time_proximity_minutes,
    author_match: row.author_match || false
  };
}