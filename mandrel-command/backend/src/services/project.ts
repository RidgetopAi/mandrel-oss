import { db as pool } from '../database/connection';
import { logger } from '../config/logger';
import {
  ALL_PROJECTS,
  scopePredicate,
  scopeWhere,
  type ProjectListScope,
} from './projectListScope';
import { contextCountSql } from './sessionCounts';
import { McpService } from './mcp';

/**
 * The blast radius of a project delete, as MEASURED BY the mcp-server's schema-derived
 * survey (`services/projectCascade.ts`) and carried over the wire on the tool's
 * structuredContent. Deliberately a plain read-only DTO: this backend never CONSTRUCTS
 * one and never derives a verdict from one — it relays it to the client. The branded
 * `ProjectChildCounts` that guarantees `total` is derived from `byTable` lives with the
 * code that produces it; re-deriving anything from these fields here would re-create the
 * second source this fix removes.
 */
export interface ProjectDeleteImpact {
  /** Cascading child table name → rows this project owns in it. ONE entry per TABLE. */
  byTable: Record<string, number>;
  /** The sum over `byTable`, as computed at the source. */
  total: number;
  /** Cascading FKs that could not be keyed on `projects.id` — non-empty ⇒ UNKNOWN. */
  unmeasurable: string[];
}

/**
 * WHY the gate refused. Relayed from the tool's `structuredContent.reason` so the client
 * can tell apart the two refusals that are NOT interchangeable for the user:
 *
 *   'needs_confirmation' — THE ONLY RETRYABLE ONE: retry with `confirm=true` and it
 *                          proceeds.
 *   'active_project'     — `confirm=true` changes NOTHING; the active-project check runs
 *                          BEFORE the confirm gate, so a confirmed retry returns the
 *                          identical refusal. The user must switch project.
 *   'last_project'       — likewise futile; at least one project must exist.
 *   'unknown'            — the gate refused for a reason this client does not recognise.
 *                          Treated as NOT retryable, deliberately (see the whitelist).
 *
 * These arrive under the same `action:'delete_refused'`, so without this field a caller
 * cannot distinguish "you may retry" from "retrying is futile" — and telling a user to
 * confirm when confirming cannot help is a machine field that lies, which is the exact
 * defect class this task exists to fix.
 */
/**
 * The reasons this client can act on. A value absent from this set — an older gate that
 * sends none, or a newer one that sends a reason postdating this code — is NOT treated as
 * retryable. Deny-by-default: the failure mode of admitting an unknown reason is a user
 * told to retry forever; the failure mode of rejecting one is a prompt they did not need.
 */
const RECOGNISED_REFUSAL_REASONS = new Set<unknown>([
  'needs_confirmation',
  'active_project',
  'last_project',
]);

export type ProjectDeleteRefusalReason =
  | 'needs_confirmation'
  | 'active_project'
  | 'last_project'
  /** The gate refused for a reason this client does not recognise — treated as NOT retryable. */
  | 'unknown';

/** Outcome of a delegated project delete. `deleted:false` means REFUSED, not "not found". */
export interface ProjectDeleteOutcome {
  deleted: boolean;
  /**
   * Present on a refusal. Defaults to 'needs_confirmation' when the gate does not say —
   * the conservative reading, because it is the only refusal the caller can act on by
   * retrying, and an un-actionable prompt is better than a missing one.
   */
  reason?: ProjectDeleteRefusalReason;
  /**
   * The sentence shown to the caller.
   *
   * ON A REFUSAL this is the GATE'S OWN string, relayed verbatim and never re-rendered
   * here — that is the property that matters, because the refusal text is derived from
   * the same `byTable` the predicate reads, so it can never name a table the gate did not
   * count. ON SUCCESS it is a fixed local string ('Project deleted successfully'), which
   * carries no measurement and therefore nothing that could drift.
   *
   * (An earlier version of this doc claimed "never composed in this service" flat out.
   * That was false — the success branch composes one — and a doc comment that overstates
   * is a claim like any other. The distinction is refusal-vs-success, not never-vs-always.)
   */
  message: string;
  /** Present on a refusal: what the caller would have destroyed. */
  impact?: ProjectDeleteImpact;
}

export interface Project {
  id: string;
  name: string;
  description?: string;
  status: 'active' | 'inactive' | 'archived';
  git_repo_url?: string;
  root_directory?: string;
  metadata?: Record<string, any>;
  created_at: string;
  updated_at: string;
  context_count?: number;
  session_count?: number;
  last_activity?: string;
}

export interface Session {
  id: string;
  project_id: string;
  project_name?: string;
  created_at: string;
  session_type: string;
  context_count?: number;
  last_context_at?: string;
}

export interface ProjectStats {
  total_projects: number;
  active_projects: number;
  total_contexts: number;
  total_sessions: number;
  contexts_by_type: Record<string, number>;
  recent_activity: {
    contexts_last_week: number;
    sessions_last_week: number;
  };
}

export interface CreateProjectRequest {
  name: string;
  description?: string;
  git_repo_url?: string;
  root_directory?: string;
  metadata?: Record<string, any>;
}

export interface UpdateProjectRequest {
  name?: string;
  description?: string;
  status?: 'active' | 'inactive' | 'archived';
  git_repo_url?: string;
  root_directory?: string;
  metadata?: Record<string, any>;
}

export interface WatchableProject {
  id: string;
  name: string;
  root_directory: string;
}

export class ProjectService {
  /**
   * Get projects that have root_directory set (for mandrel-watcher)
   * Returns minimal data needed for git watching
   */
  static async getWatchableProjects(): Promise<WatchableProject[]> {
    try {
      const result = await pool.query(`
        SELECT id, name, root_directory
        FROM projects
        WHERE root_directory IS NOT NULL
          AND root_directory != ''
          AND status = 'active'
        ORDER BY name
      `);

      return result.rows.map(row => ({
        id: row.id,
        name: row.name,
        root_directory: row.root_directory
      }));
    } catch (error) {
      logger.error('Get watchable projects error', { error });
      throw new Error('Failed to get watchable projects');
    }
  }

  /**
   * Get all projects with statistics
   */
  static async getAllProjects(scope: ProjectListScope): Promise<Project[]> {
    try {
      // THE PROJECT LIST IS NOT LEGITIMATELY GLOBAL (an earlier task item 7). It was the
      // strongest candidate for an exception — the picker "needs" every project — but a
      // project's NAME and description are its own data, and a zero-grant non-admin got
      // the full inventory of the box. `/api/embedding/list`, the same picker feed, was
      // already confined to the caller's grants on this branch; leaving this one global
      // is the half-closed state that makes the rule unreadable.
      const params: unknown[] = [];
      const scopeClause = scopeWhere(scope, 'p.id', params);
      const result = await pool.query(`
        SELECT
          p.id, p.name, p.description, p.status, p.git_repo_url, p.root_directory,
          p.metadata, p.created_at, p.updated_at,
          COUNT(DISTINCT c.id) as context_count,
          COUNT(DISTINCT c.session_id) as session_count,
          MAX(c.created_at) as last_activity
        FROM projects p
        LEFT JOIN contexts c ON p.id = c.project_id AND c.archived_at IS NULL
        ${scopeClause}
        GROUP BY p.id, p.name, p.description, p.status, p.git_repo_url, p.root_directory,
                 p.metadata, p.created_at, p.updated_at
        ORDER BY p.updated_at DESC
      `, params);

      return result.rows.map(row => ({
        id: row.id,
        name: row.name,
        description: row.description,
        status: row.status,
        git_repo_url: row.git_repo_url,
        root_directory: row.root_directory,
        metadata: row.metadata,
        created_at: row.created_at,
        updated_at: row.updated_at,
        context_count: parseInt(row.context_count) || 0,
        session_count: parseInt(row.session_count) || 0,
        last_activity: row.last_activity
      }));
    } catch (error) {
      logger.error('Get all projects error', { error });
      throw new Error('Failed to get projects');
    }
  }

  /**
   * Get single project by ID with statistics
   */
  static async getProjectById(id: string): Promise<Project | null> {
    try {
      const result = await pool.query(`
        SELECT 
          p.id, p.name, p.description, p.status, p.git_repo_url, p.root_directory,
          p.metadata, p.created_at, p.updated_at,
          COUNT(DISTINCT c.id) as context_count,
          COUNT(DISTINCT c.session_id) as session_count,
          MAX(c.created_at) as last_activity
        FROM projects p
        LEFT JOIN contexts c ON p.id = c.project_id AND c.archived_at IS NULL
        WHERE p.id = $1
        GROUP BY p.id, p.name, p.description, p.status, p.git_repo_url, p.root_directory,
                 p.metadata, p.created_at, p.updated_at
      `, [id]);

      if (result.rows.length === 0) {
        return null;
      }

      const row = result.rows[0];
      return {
        id: row.id,
        name: row.name,
        description: row.description,
        status: row.status,
        git_repo_url: row.git_repo_url,
        root_directory: row.root_directory,
        metadata: row.metadata,
        created_at: row.created_at,
        updated_at: row.updated_at,
        context_count: parseInt(row.context_count) || 0,
        session_count: parseInt(row.session_count) || 0,
        last_activity: row.last_activity
      };
    } catch (error) {
      logger.error('Get project by ID error', { error });
      throw new Error('Failed to get project');
    }
  }

  /**
   * Create new project, AND grant its creator access to it — in ONE transaction.
   *
   * ── THE GAP THIS CLOSES (scope addition) ──────────────────────────────
   * Nothing granted project access on CREATION. `user_project_access` had exactly one
   * writer in the whole backend — the admin-only endpoint at routes/users.ts:418 — and no
   * UI drives it (`grep -rn "project-access" frontend/src` → 0 hits). So every project
   * created was invisible to every non-admin FOREVER, until somebody hand-curled a grant.
   * That was masked while every human in the fleet is role=admin, and it inverts the first
   * time a real non-admin exists — precisely when the F-04 closure in this same commit
   * makes the deny actually bite on all four doors.
   *
   * ONE TRANSACTION, NOT TWO STEPS. "A project exists with no grant" is the exact state
   * being eliminated, so it must not be reachable by a partial failure. Both rows commit
   * or neither does.
   *
   * THE GRANT IS WRITTEN EVEN FOR AN ADMIN CREATOR. Admins short-circuit inside
   * ProjectAccessService.userHasProjectAccess and do not need the row — but writing it
   * makes the grant table the honest record of who can reach what, rather than something
   * that silently depends on the `role` column, and it means DEMOTING an admin later does
   * not silently strip them of every project they built. It costs one indexed insert.
   *
   * IDEMPOTENT: `ON CONFLICT DO NOTHING`, so a re-run or a pre-existing row is not an error.
   *
   * @param createdBy the AUTHENTICATED caller's admin_users id — never a client-supplied
   *        field. Optional only because the type allows it; the sole caller
   *        (ProjectController.createProject) sits behind `router.use(authenticateToken)`
   *        and refuses the request when it is absent, rather than creating a grantless
   *        project.
   */
  static async createProject(
    projectData: CreateProjectRequest,
    createdBy?: string
  ): Promise<Project> {
    const { name, description, git_repo_url, root_directory, metadata } = projectData;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(`
        INSERT INTO projects (name, description, git_repo_url, root_directory, metadata)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING id, name, description, status, git_repo_url, root_directory,
                  metadata, created_at, updated_at
      `, [name, description, git_repo_url, root_directory, JSON.stringify(metadata || {})]);

      const row = result.rows[0];

      if (createdBy) {
        await client.query(
          `INSERT INTO user_project_access (user_id, project_id, granted_by)
           VALUES ($1, $2, $1)
           ON CONFLICT (user_id, project_id) DO NOTHING`,
          [createdBy, row.id]
        );
      }

      await client.query('COMMIT');
      logger.info('[project] created with creator grant', { projectId: row.id, createdBy });
      return {
        id: row.id,
        name: row.name,
        description: row.description,
        status: row.status,
        git_repo_url: row.git_repo_url,
        root_directory: row.root_directory,
        metadata: row.metadata,
        created_at: row.created_at,
        updated_at: row.updated_at,
        context_count: 0,
        session_count: 0
      };
    } catch (error: any) {
      await client.query('ROLLBACK').catch(() => undefined);
      logger.error('Create project error', { error });
      if (error.code === '23505') { // Unique constraint violation
        throw new Error('Project name already exists');
      }
      throw new Error('Failed to create project');
    } finally {
      client.release();
    }
  }

  /**
   * Update project
   */
  static async updateProject(id: string, updates: UpdateProjectRequest): Promise<Project | null> {
    const setClauses: string[] = [];
    const values: any[] = [];
    let paramIndex = 1;

    if (updates.name !== undefined) {
      setClauses.push(`name = $${paramIndex++}`);
      values.push(updates.name);
    }

    if (updates.description !== undefined) {
      setClauses.push(`description = $${paramIndex++}`);
      values.push(updates.description);
    }

    if (updates.status !== undefined) {
      setClauses.push(`status = $${paramIndex++}`);
      values.push(updates.status);
    }

    if (updates.git_repo_url !== undefined) {
      setClauses.push(`git_repo_url = $${paramIndex++}`);
      values.push(updates.git_repo_url);
    }

    if (updates.root_directory !== undefined) {
      setClauses.push(`root_directory = $${paramIndex++}`);
      values.push(updates.root_directory);
    }

    if (updates.metadata !== undefined) {
      setClauses.push(`metadata = $${paramIndex++}`);
      values.push(JSON.stringify(updates.metadata));
    }

    if (setClauses.length === 0) {
      throw new Error('No updates provided');
    }

    setClauses.push(`updated_at = CURRENT_TIMESTAMP`);
    values.push(id);

    try {
      const result = await pool.query(`
        UPDATE projects 
        SET ${setClauses.join(', ')}
        WHERE id = $${paramIndex}
        RETURNING id, name, description, status, git_repo_url, root_directory,
                  metadata, created_at, updated_at
      `, values);

      if (result.rows.length === 0) {
        return null;
      }

      return result.rows[0];
    } catch (error: any) {
      logger.error('Update project error', { error });
      if (error.code === '23505') { // Unique constraint violation
        throw new Error('Project name already exists');
      }
      throw new Error('Failed to update project');
    }
  }

  /**
   * Delete project — DELEGATES to the mcp-server `project_delete` tool.
   *
   * THE DEFECT THIS REPLACES. This method used to be, in its entirety:
   *
   *     const result = await pool.query('DELETE FROM projects WHERE id = $1', [id]);
   *
   * No counts, no confirmation, no blast-radius description — reached from
   * `DELETE /api/projects/:id`, on the UI surface, where a misclick is likeliest.
   * The schema has TWENTY-FOUR tables whose FK to `projects` is ON DELETE CASCADE, so
   * that one line silently destroyed all of them. MEASURED, not argued: on a migrated
   * throwaway DB a project owning a context + a task + a decision was passed to this
   * method with no confirmation argument (there was none to pass) and came back
   * `{project:0, contexts:0, tasks:0, decisions:0}`.
   *
   * WHY DELEGATION AND NOT A LOCAL GATE. The gate already exists, once, in
   * `mcp-server/src/services/projectCascade.ts`: it derives the cascading table set from
   * `pg_constraint` (`confdeltype='c'`) — the catalog a migration MUST touch to make a
   * table project-owned — and fails CLOSED, treating an unmeasurable or empty survey as
   * "requires confirmation" rather than "nothing to lose". Re-implementing counts or a
   * confirmation predicate here would be a SECOND copy of that rule, and a second copy is
   * how a rule drifts — which is the disease this whole workstream
   * exists to cure. So this service no longer decides anything about deletion; it asks the
   * component that owns the decision, exactly as `TaskService.createTask`
   * delegates task writes. `McpService.callTool` is the already-prod-proven seam
   * (Bearer auth + X-Actor-ID + container/systemd target resolution).
   *
   * CONSEQUENCE WORTH STATING: this service can no longer destroy a project by itself.
   * `pool` is not touched on this path at all, so if the mcp-server is unreachable the
   * delete FAILS — it does not fall back to a raw DELETE. That availability coupling is
   * the point, not a regression: it is what makes "the gate cannot be bypassed" a
   * structural property instead of a promise. `projectDeleteDelegation.db.test.ts` proves
   * it by driving this method with the tool call failing and reading the rows back.
   *
   * CONTRACT: mirrors the tool's rather than inventing a parallel one — `confirm` is
   * passed straight through, and a refusal comes back with the tool's OWN message and
   * counts (both derived from `describeProjectChildCounts`/`byTable` over there, so the
   * sentence the user reads and the predicate that refused cannot describe different
   * things). Nothing is rendered here.
   */
  static async deleteProject(
    id: string,
    confirm: boolean,
    actor?: string
  ): Promise<ProjectDeleteOutcome> {
    logger.info('ProjectService.deleteProject delegating to project_delete', { id, confirm });

    // mcp-write-scope: self-scoped — the call NAMES its target by handle (`project: id`), so it
    // never consults the ambient slot. This is the EXEMPT-target case the mcp-server guard
    // recognises too (services/projectBinding.ts explicitProjectTargetParams), which is why
    // requireWriteProjectId is wrong here: there is no separate project to scope it TO.
    const result = await McpService.callTool('project_delete', { project: id, confirm }, actor);

    // TOOL ERROR / isError → callTool sets success:false. Never a phantom success over a
    // failed destructive call (and never a local fallback delete).
    if (!result.success) {
      logger.error('Delete project delegation failed', { error: result.error });
      throw new Error('Failed to delete project');
    }

    // Canonical MACHINE channel (routes/index.ts ensureStructuredContent guarantees it):
    //   deleted  → { action:'deleted',        deleted:true,  project:{id} }
    //   refused  → { action:'delete_refused', deleted:false, counts, message, reason? }
    // Read the STRUCTURED record — never regex-parse the prose text block.
    const data = result.data;

    if (data?.action === 'delete_refused') {
      return {
        deleted: false,
        // The tool's own sentence, verbatim. Rendering our own from `counts` here would be
        // the second renderer this fix exists to avoid.
        message: String(data.message ?? 'Project delete refused by the safety gate.'),
        // WHITELISTED, and INVERTED: only a reason we positively recognise is admitted;
        // anything else becomes 'unknown', which is NOT retryable.
        //
        // The first version fell back to 'needs_confirmation', which was fail-OPEN for this
        // field's purpose. It had a live victim: the handler's LAST-REMAINING-PROJECT
        // refusal carried no reason at all, so it mapped to 'needs_confirmation' and the
        // controller told the caller to retry with confirm — measured returning the
        // identical refusal on confirm=true. That is the exact defect this field was added
        // to remove, one branch over.
        //
        // Under-promising retryability costs nothing: `message` always tells the user what
        // to do. Over-promising it sends them round a loop that cannot terminate.
        reason: RECOGNISED_REFUSAL_REASONS.has(data.reason) ? data.reason : 'unknown',
        impact: data.counts as ProjectDeleteImpact | undefined,
      };
    }

    if (data?.action === 'deleted' && data.deleted === true) {
      return { deleted: true, message: 'Project deleted successfully' };
    }

    // FAIL CLOSED on anything unrecognised. An unexpected payload is NOT evidence that the
    // project was destroyed, and it is certainly not evidence that it was kept — the one
    // thing we must never do is report a confident outcome we cannot support.
    logger.error('Delete project delegation returned an unrecognised payload', { data });
    throw new Error('Failed to delete project');
  }

  /**
   * Get project sessions with context counts
   */
  static async getProjectSessions(projectId: string): Promise<Session[]> {
    try {
      const result = await pool.query(`
        SELECT 
          COALESCE(c.session_id, gen_random_uuid()) as id,
          c.project_id,
          p.name as project_name,
          MIN(c.created_at) as created_at,
          COUNT(*) as context_count,
          MAX(c.created_at) as last_context_at
        FROM contexts c
        LEFT JOIN projects p ON c.project_id = p.id
        WHERE c.archived_at IS NULL AND c.project_id = $1 AND c.session_id IS NOT NULL
        GROUP BY c.session_id, c.project_id, p.name
        ORDER BY MIN(c.created_at) DESC
      `, [projectId]);

      return result.rows.map(row => ({
        id: row.id,
        project_id: row.project_id,
        project_name: row.project_name,
        created_at: row.created_at,
        session_type: 'context-based', // Legacy context-based sessions
        context_count: parseInt(row.context_count) || 0,
        last_context_at: row.last_context_at
      }));
    } catch (error) {
      logger.error('Get project sessions error', { error });
      throw new Error('Failed to get project sessions');
    }
  }

  /**
   * Get all sessions across all projects (unified from sessions table)
   */
  static async getAllSessions(
    options: { scope: ProjectListScope; limit?: number }
  ): Promise<Session[]> {
    try {
      // `scope` is REQUIRED (an earlier task item 7): `options = {}` with an optional
      // projectId meant an omitted project returned every project's sessions.
      const { scope, limit } = options;

      const params: unknown[] = [];
      const whereClause = scopeWhere(scope, 's.project_id', params);
      // RULE 2 (services/sessionCounts.ts): when the LIST is project-filtered, the derived
      // child counts are filtered to the same projects. `ANY($n::uuid[])` is spliced as the
      // comparison RHS, exactly as the single `$1` used to be.
      const projParamRef =
        scope.mode === ALL_PROJECTS ? undefined : `ANY($${params.length}::uuid[])`;

      let limitClause = '';
      if (typeof limit === 'number' && Number.isFinite(limit) && limit > 0) {
        params.push(Math.floor(limit));
        limitClause = `LIMIT $${params.length}`;
      }

      const result = await pool.query(`
        SELECT
          s.id,
          s.project_id,
          p.name as project_name,
          s.started_at as created_at,
          s.agent_type as session_type,
          -- WAS: s.contexts_created as context_count -- a POISONED ALIAS. It dressed the
          -- denormalized counter (zeroed by SessionRepo.finish on every session end) up as
          -- the derived count, so a consumer writing the defensive
          -- (contexts_created ?? context_count) got the same broken number twice and could
          -- not tell. Derived from the child table via the shared rule.
          -- This list has an optional project filter, so RULE 2 applies when it is set.
          ${contextCountSql('s', projParamRef)} as context_count,
          COALESCE(s.last_activity_at, s.ended_at, s.started_at) as last_context_at
        FROM sessions s
        LEFT JOIN projects p ON s.project_id = p.id
        ${whereClause}
        ORDER BY s.started_at DESC
        ${limitClause}
      `, params);

      return result.rows.map(row => ({
        id: row.id,
        project_id: row.project_id,
        project_name: row.project_name,
        created_at: row.created_at,
        session_type: row.session_type,
        context_count: parseInt(row.context_count) || 0,
        last_context_at: row.last_context_at
      }));
    } catch (error) {
      logger.error('Get all sessions error', { error });
      throw new Error('Failed to get sessions');
    }
  }

  /**
   * Get project statistics
   */
  static async getProjectStats(scope: ProjectListScope): Promise<ProjectStats> {
    try {
      const projParams: unknown[] = [];
      const projWhere = scopeWhere(scope, 'id', projParams);
      const ctxParams: unknown[] = [];
      // LIVE contexts only. The archive predicate is spelled into the
      // WHERE here rather than appended after the project scope so it cannot be separated
      // from it by a later edit. Soft-deleted contexts must leave every dashboard total,
      // or Delete looks like it did nothing.
      const ctxWhere =
        ' WHERE archived_at IS NULL' + scopePredicate(scope, 'project_id', ctxParams);
      const recentParams: unknown[] = [];
      const recentAnd = scopePredicate(scope, 'project_id', recentParams);

      // Get basic project counts
      const projectResult = await pool.query(`
        SELECT
          COUNT(*) as total_projects,
          COUNT(*) FILTER (WHERE status = 'active') as active_projects
        FROM projects
        ${projWhere}
      `, projParams);

      // Get context and session counts
      const contextResult = await pool.query(`
        SELECT
          COUNT(*) as total_contexts,
          COUNT(DISTINCT session_id) FILTER (WHERE session_id IS NOT NULL) as total_sessions,
          COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days') as contexts_last_week
        FROM contexts
        ${ctxWhere}
      `, ctxParams);

      // Get contexts by type
      const typeResult = await pool.query(`
        SELECT
          context_type,
          COUNT(*) as count
        FROM contexts
        ${ctxWhere}
        GROUP BY context_type
        ORDER BY context_type
      `, ctxParams);

      // Get recent sessions
      const sessionResult = await pool.query(`
        SELECT
          COUNT(DISTINCT session_id) as sessions_last_week
        FROM contexts
        WHERE archived_at IS NULL AND created_at >= NOW() - INTERVAL '7 days'
          AND session_id IS NOT NULL${recentAnd}
      `, recentParams);

      // Build the contexts_by_type object
      const contexts_by_type: Record<string, number> = {};
      typeResult.rows.forEach(row => {
        contexts_by_type[row.context_type] = parseInt(row.count);
      });

      const projectRow = projectResult.rows[0];
      const contextRow = contextResult.rows[0];
      const sessionRow = sessionResult.rows[0];

      return {
        total_projects: parseInt(projectRow.total_projects),
        active_projects: parseInt(projectRow.active_projects),
        total_contexts: parseInt(contextRow.total_contexts),
        total_sessions: parseInt(contextRow.total_sessions),
        contexts_by_type,
        recent_activity: {
          contexts_last_week: parseInt(contextRow.contexts_last_week),
          sessions_last_week: parseInt(sessionRow.sessions_last_week) || 0
        }
      };
    } catch (error) {
      logger.error('Get project stats error', { error });
      throw new Error('Failed to get project statistics');
    }
  }
}
