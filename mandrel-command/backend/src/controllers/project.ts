import { Request, Response } from 'express';
import { AuthenticatedRequest } from '../types/auth';
import { ProjectService } from '../services/project';
import { McpService } from '../services/mcp';
import { ProjectInsightsService } from '../services/projectInsights';
import { db } from '../database/connection';
import { logger } from '../config/logger';
import { resolveListScope } from '../services/projectListScope';

export class ProjectController {
  /**
   * GET /projects/watchable - Get projects with root_directory for mandrel-watcher.
   *
   * THIS ENDPOINT REQUIRES AUTHENTICATION. It previously did not, and the
   * line that used to sit here — "This endpoint is unauthenticated - used by local watcher
   * daemon" — is the exact claim that justified the leak: the route was registered above
   * `router.use(authenticateToken)` in routes/projects.ts and served project `name` +
   * `root_directory` (customer project names and absolute host filesystem paths) to any
   * caller with no credential, on prod and all 7 tenants.
   *
   * The comment is corrected HERE as well as at the route because this is where
   * `git grep getWatchableProjects` and any stack trace land you. A route's authz status is
   * decided by registration order in routes/projects.ts, not by anything in this file, so
   * do not trust either comment alone — read the router.
   */
  static async getWatchableProjects(_req: Request, res: Response): Promise<void> {
    try {
      const projects = await ProjectService.getWatchableProjects();

      res.json({
        success: true,
        data: {
          projects,
          total: projects.length
        }
      });
    } catch (error) {
      logger.error('Get watchable projects error', { error });
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get watchable projects'
      });
    }
  }

  /**
   * GET /projects - Get all projects
   */
  static async getAllProjects(req: Request, res: Response): Promise<void> {
    try {
      const projects = await ProjectService.getAllProjects(
        await resolveListScope(req as AuthenticatedRequest)
      );
      
      res.json({
        success: true,
        data: {
          projects,
          total: projects.length
        }
      });
    } catch (error) {
      logger.error('Get all projects error', { error });
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get projects'
      });
    }
  }

  /**
   * GET /projects/:id - Get single project by ID
   */
  static async getProject(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const project = await ProjectService.getProjectById(id);

      if (!project) {
        res.status(404).json({
          success: false,
          error: 'Project not found'
        });
        return;
      }

      res.json({
        success: true,
        data: { project }
      });
    } catch (error) {
      logger.error('Get project error', { error });
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get project'
      });
    }
  }

  /**
   * POST /projects - Create new project
   */
  static async createProject(req: Request, res: Response): Promise<void> {
    try {
      const projectData = req.body;

      // Basic validation
      if (!projectData.name || projectData.name.trim() === '') {
        res.status(400).json({
          success: false,
          error: 'Project name is required'
        });
        return;
      }

      // The creator comes from the AUTHENTICATED caller, never from the body (an earlier task
      // scope addition). routes/projects.ts does `router.use(authenticateToken)`
      // above this route, so req.user is always populated; an absent one is a wiring bug,
      // and the honest answer is to refuse rather than create a project that NO non-admin
      // can ever reach — the exact grantless state this change exists to eliminate.
      const createdBy = (req as AuthenticatedRequest).user?.id;
      if (!createdBy) {
        res.status(401).json({
          success: false,
          error: 'Authentication required',
          message: 'A project must have an identifiable creator to be granted access to it'
        });
        return;
      }

      const project = await ProjectService.createProject(projectData, createdBy);

      res.status(201).json({
        success: true,
        data: { project }
      });
    } catch (error) {
      logger.error('Create project error', { error });
      
      if (error instanceof Error && error.message === 'Project name already exists') {
        res.status(409).json({
          success: false,
          error: error.message
        });
        return;
      }

      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to create project'
      });
    }
  }

  /**
   * PUT /projects/:id - Update project
   */
  static async updateProject(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const updates = req.body;

      const project = await ProjectService.updateProject(id, updates);

      if (!project) {
        res.status(404).json({
          success: false,
          error: 'Project not found'
        });
        return;
      }

      res.json({
        success: true,
        data: { project }
      });
    } catch (error) {
      logger.error('Update project error', { error });
      
      if (error instanceof Error && error.message === 'Project name already exists') {
        res.status(409).json({
          success: false,
          error: error.message
        });
        return;
      }

      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to update project'
      });
    }
  }

  /**
   * DELETE /projects/:id - Delete project
   *
   * GATED. This used to be an unconditional destroy: `ProjectService.deleteProject(id)`
   * ran `DELETE FROM projects WHERE id = $1` and returned 200, cascading into all
   * twenty-four project-owned tables with no counts, no confirmation and no description
   * of what was lost. The only thing in front of it was a client-side "type the project
   * name" modal — a suggestion, not a gate: `curl -X DELETE` skipped it entirely.
   *
   * The gate now lives where it already existed, ONCE: the mcp-server's `project_delete`,
   * over `projectCascade.ts`'s schema-derived, fail-closed survey. This handler does not
   * decide anything about deletion — it forwards `confirm` and translates the outcome.
   *
   * THE CONTRACT MIRRORS THE TOOL'S (no parallel invention):
   *   DELETE /projects/:id             → the gate answers. Non-empty or unmeasurable ⇒
   *                                      409 with the impact counts + the gate's own
   *                                      sentence, and NOTHING is destroyed.
   *   DELETE /projects/:id?confirm=true → explicit confirmation; the gate proceeds.
   * 409 (not 400) because the request is well-formed — the refusal is about the state of
   * the resource, and it is retryable with `confirm=true`.
   *
   * The 404 is preserved by an existence READ before delegating: the tool answers
   * "not found" only on its prose channel, and inferring it from an absent structured
   * action would be guessing at a destructive endpoint.
   */
  static async deleteProject(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;

      // EXPLICIT means explicit: only the exact string 'true' confirms. Any other value —
      // absent, '', 'false', '0', a repeated param that makes express hand back an ARRAY —
      // is not a confirmation. A truthiness check here would make `?confirm=false` destroy
      // the project, which is the opposite of what the caller wrote.
      const confirm = req.query.confirm === 'true';

      const existing = await ProjectService.getProjectById(id);
      if (!existing) {
        res.status(404).json({
          success: false,
          error: 'Project not found'
        });
        return;
      }

      const outcome = await ProjectService.deleteProject(
        id,
        confirm,
        (req as AuthenticatedRequest).user?.username
      );

      if (!outcome.deleted) {
        // REFUSED — nothing was destroyed. The message is the gate's, relayed verbatim;
        // `impact` is what the caller would have lost, as measured at the source.
        res.status(409).json({
          success: false,
          error: outcome.message,
          // Same string under `message` as well, deliberately: the frontend's shared axios
          // error interceptor (services/api.ts) reads `response.data.message`, so an
          // `error`-only body reaches the user as "Request failed with status code 409"
          // and the blast radius — the entire point of the refusal — never gets shown.
          // Echoed from the one `outcome.message`, not composed twice.
          message: outcome.message,
          data: {
            // DERIVED, and true ONLY for the one refusal a retry can fix. This was a
            // hardcoded `true`, which lied for every refusal decided BEFORE the confirm
            // gate — active-project and last-remaining-project both return the identical
            // 409 on `?confirm=true`, so telling that caller to confirm sends them round a
            // loop that cannot terminate.
            //
            // The comparison is POSITIVE on purpose (`=== 'needs_confirmation'`, not
            // `!== 'active_project'`): a refusal reason added upstream tomorrow, or one
            // this client does not recognise, lands on FALSE. `message` always tells the
            // user what to do, so under-promising a retry costs nothing and
            // over-promising one costs them a loop.
            requiresConfirmation: outcome.reason === 'needs_confirmation',
            reason: outcome.reason,
            impact: outcome.impact
          }
        });
        return;
      }

      res.json({
        success: true,
        data: { message: outcome.message }
      });
    } catch (error) {
      logger.error('Delete project error', { error });
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to delete project'
      });
    }
  }

  /**
   * GET /projects/:id/sessions - Get project sessions
   */
  static async getProjectSessions(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const sessions = await ProjectService.getProjectSessions(id);

      res.json({
        success: true,
        data: {
          sessions,
          total: sessions.length
        }
      });
    } catch (error) {
      logger.error('Get project sessions error', { error });
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get project sessions'
      });
    }
  }

  /**
   * GET /projects/sessions/all - Get all sessions across projects
   */
  static async getAllSessions(req: Request, res: Response): Promise<void> {
    try {
      // Honor the query filters the dashboard widget sends. Previously these
      // were ignored (the param was `_req`), so the UI thought it was filtering
      // by project/limit but always received every session.
      // Project scope comes from the resolver — it has already parsed
      // `project_id` (and the header, and the other spellings), enforced the uuid shape,
      // and AUTHORIZED the caller for it. The old shape-only check here silently dropped
      // an unauthorized id to `undefined`, i.e. widened the query to ALL projects.

      const rawLimit = req.query.limit;
      const parsedLimit =
        typeof rawLimit === 'string' ? Number.parseInt(rawLimit, 10) : NaN;
      const limit =
        Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : undefined;

      const sessions = await ProjectService.getAllSessions({
        scope: await resolveListScope(req as AuthenticatedRequest),
        limit,
      });

      res.json({
        success: true,
        data: {
          sessions,
          total: sessions.length
        }
      });
    } catch (error) {
      logger.error('Get all sessions error', { error });
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get sessions'
      });
    }
  }

  /**
   * GET /projects/stats - Get project statistics
   */
  static async getProjectStats(req: Request, res: Response): Promise<void> {
    try {
      const stats = await ProjectService.getProjectStats(
        await resolveListScope(req as AuthenticatedRequest)
      );

      res.json({
        success: true,
        data: stats
      });
    } catch (error) {
      logger.error('Get project stats error', { error });
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get project statistics'
      });
    }
  }

  /**
   * GET /projects/:id/insights - Get real project insights from database
   */
  static async getProjectInsights(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;

      logger.info(`[Project Insights] Getting insights for project ${id}`);

      // Get insights directly from database
      const insights = await ProjectInsightsService.getProjectInsights(id);

      logger.info('[Project Insights] Database result', { insights });

      res.json({
        success: true,
        data: insights
      });
    } catch (error) {
      logger.error('Get project insights error', { error });
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get project insights'
      });
    }
  }

  /**
   * POST /projects/:id/set-primary - Set project as primary/default
   * Proxies to MCP server's /api/v2/projects/:id/set-primary endpoint
   */
  static async setPrimary(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;

      logger.info(`[Set Primary] Setting project ${id} as primary`);

      // Call MCP server's set-primary endpoint — forward the authenticated principal as
      // X-Actor-ID so the attribution class is whole.
      const mcpResponse = await McpService.callMcpEndpoint(
        `/api/v2/projects/${id}/set-primary`,
        'POST',
        undefined,
        (req as AuthenticatedRequest).user?.username
      );

      logger.info('[Set Primary] MCP response', { mcpResponse });

      res.json(mcpResponse);
    } catch (error) {
      logger.error('Set primary project error', { error });
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to set primary project'
      });
    }
  }

  /**
   * POST /projects/clear-primary - Clear the primary/default flag from all projects
   *
   * Unlike set-primary, there is no MCP REST endpoint to clear the flag, so this
   * clears the is_primary metadata key directly against the shared database. This
   * persists a "no default project" choice server-side so the next login's seed
   * does not re-apply a previously-set primary.
   */
  static async clearPrimary(_req: Request, res: Response): Promise<void> {
    const client = await db.connect();

    try {
      logger.info('[Clear Primary] Clearing is_primary flag from all projects');

      const updateResult = await client.query(
        `UPDATE projects
         SET metadata = metadata - 'is_primary'
         WHERE metadata->>'is_primary' = 'true'`
      );

      logger.info('[Clear Primary] Cleared primary flag', { cleared: updateResult.rowCount });

      res.json({
        success: true,
        data: {
          cleared: updateResult.rowCount ?? 0,
          is_primary: false
        }
      });
    } catch (error) {
      logger.error('Clear primary project error', { error });
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to clear primary project'
      });
    } finally {
      client.release();
    }
  }
}
