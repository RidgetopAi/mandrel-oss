import { Response } from 'express';
import { AuthenticatedRequest } from '../types/auth';
import { resolveListScope, type ProjectListScope } from '../services/projectListScope';
import { ProjectAccessService } from '../services/projectAccess';
import { ContextService, ContextSearchParams } from '../services/context';
import { McpService } from '../services/mcp';
import {
  buildContextSearchArgs,
  mapCanonicalRowToRest,
  MissingProjectIdError,
  type CanonicalContextRow,
} from '../services/contextSearchAdapter';
import { searchConfig } from '../config/search';
import type { UpdateContextData } from '../validation/schemas';
import { logger } from '../config/logger';
import {
  requireWriteProjectId,
  MissingWriteProjectScopeError,
} from '../services/requestProjectScope';

export class ContextController {
  /**
   * GET /api/contexts - list/search contexts (search consolidation).
   *
   * TWO-MODE DISPATCH — the ONE dispatch point:
   *   • `query` present → CANONICAL semantic search via the one engine
   *     (McpService.callTool 'context_search', the same proxy seam createContext
   *     uses). Matching/ranking lives ONLY in mcp-server; this is a thin proxy.
   *   • no `query`     → BROWSE listing (structured-column SQL, real pagination,
   *     archived_at IS NULL default) via ContextService.searchContexts.
   */
  static async searchContexts(req: AuthenticatedRequest, res: Response): Promise<void> {
    // D3 (Reviewer): getRequestProjectId() THROWS when projectContextMiddleware never ran,
    // and this was the ONE call site of 25 sitting OUTSIDE a try. routes/contexts.ts:77
    // registers this handler raw on Express ^4.18, which does not catch a rejected promise
    // from an async handler — so the throw would not become a 500, it would HANG the
    // request until the client timed out. That is the same 450s/540s failure this branch
    // already hit once in resolve.ts, and it is latent only because /api/contexts sits
    // under the /api mount today; server.ts:95 shows this codebase does mount routers
    // outside /api. Inside the try, it is an honest 500.
    let query: string | undefined;
    let params: ContextSearchParams;
    try {
      // UNSCOPED MEANS "THE CALLER'S PROJECTS", NEVER "ALL PROJECTS" (an earlier task
      // item 7). This was `getRequestProjectId(req)` + `projectId ? {project_id} : {}`,
      // so omitting the project browsed every project's contexts.
      const scope = await resolveListScope(req);
      query = req.query.query as string | undefined;
      params = ContextController.buildSearchParams(req, scope, query);
    } catch (error) {
      logger.error('Search contexts scope resolution failed', { error });
      res.status(500).json({
        success: false,
        message: 'Failed to resolve project scope for this request',
      });
      return;
    }

    return ContextController.runSearch(req, res, params);
  }

  /** Pure param assembly, split out so the scope resolution above can be wrapped. */
  private static buildSearchParams(
    req: AuthenticatedRequest,
    scope: ProjectListScope,
    query: string | undefined
  ): ContextSearchParams {
    return {
      ...(query && { query }),
      scope,
      ...(req.query.session_id && { session_id: req.query.session_id as string }),
      ...(req.query.type && { type: req.query.type as string }),
      ...(req.query.tags && { tags: (req.query.tags as string).split(',') }),
      ...(req.query.min_similarity && { min_similarity: parseFloat(req.query.min_similarity as string) }),
      ...(req.query.date_from && { date_from: req.query.date_from as string }),
      ...(req.query.date_to && { date_to: req.query.date_to as string }),
      limit: req.query.limit ? parseInt(req.query.limit as string) : 20,
      offset: req.query.offset ? parseInt(req.query.offset as string) : 0,
      sort_by: (req.query.sort_by as 'created_at' | 'relevance' | 'updated_at') || 'created_at',
      sort_order: (req.query.sort_order as 'asc' | 'desc') || 'desc',
      ...ContextController.archiveScopeFromQuery(req)
    };
  }

  /**
   * `?archived=only|include` → the archive scope, FAIL CLOSED.
   *
   * `only` is the Archived view, `include` is the both-worlds escape hatch, and ANY other
   * value — absent, empty, a typo, an array from a repeated query param — yields LIVE rows
   * only. That direction matters: a fail-OPEN parse would make `?archived=inclde` silently
   * leak soft-deleted contexts into the default list, which is the exact hole this task
   * exists to close. Same shape and same spelling as TaskController's `?archived=`.
   */
  private static archiveScopeFromQuery(
    req: AuthenticatedRequest
  ): { archived_only?: boolean; include_archived?: boolean } {
    const archivedScope = typeof req.query.archived === 'string' ? req.query.archived : '';
    if (archivedScope === 'only') return { archived_only: true };
    if (archivedScope === 'include') return { include_archived: true };
    return {};
  }

  private static async runSearch(
    req: AuthenticatedRequest,
    res: Response,
    params: ContextSearchParams
  ): Promise<void> {
    // BROWSE MODE — no free-text query. Structured filters only.
    if (!params.query) {
      try {
        const result = await ContextService.searchContexts(params);
        res.json({
          success: true,
          data: result,
          message: `Found ${result.total} contexts`
        });
      } catch (error) {
        logger.error('Browse contexts error', { error });
        res.status(500).json({
          success: false,
          message: 'Failed to browse contexts',
          error: error instanceof Error ? error.message : 'Unknown error'
        });
      }
      return;
    }

    // SEARCH MODE — proxy to the canonical engine.
    let mcpArgs;
    try {
      mcpArgs = buildContextSearchArgs(params);
    } catch (error) {
      if (error instanceof MissingProjectIdError) {
        res.status(400).json({ success: false, message: error.message });
        return;
      }
      logger.error('Search contexts (arg build) error', { error });
      res.status(500).json({
        success: false,
        message: 'Failed to search contexts',
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      return;
    }

    // mcp-write-scope: read — context_search persists no context; buildContextSearchArgs
    // above already resolves and forwards the project (the read path this task did not change).
    const mcpResult = await McpService.callTool('context_search', mcpArgs, req.user?.username);

    // Embedder/MCP unavailable → an HONEST error (503), NOT an empty "no results".
    // Each search now costs a query embed; a down engine must surface, not lie.
    if (!mcpResult.success) {
      logger.error('Context search proxy failed', { error: mcpResult.error });
      res.status(503).json({
        success: false,
        message: 'Search is temporarily unavailable (the matching engine did not respond). Please try again.',
        error: mcpResult.error
      });
      return;
    }

    const structured = (mcpResult.data ?? {}) as { results?: CanonicalContextRow[] };
    const rows = Array.isArray(structured.results) ? structured.results : [];

    // Enrich with project_name — ONE id→name lookup (all rows share the scoped project).
    const projectName = await ContextController.resolveProjectName(mcpArgs.projectId);
    const contexts = rows.map((row) => mapCanonicalRowToRest(row, projectName));

    // Search mode is relevance-ordered top-N: honest count of what we returned, no
    // fabricated total. Limit defaults to searchConfig.searchDefaultLimit.
    const limit = params.limit ?? searchConfig.searchDefaultLimit;
    res.json({
      success: true,
      data: {
        contexts,
        total: contexts.length,
        page: 1,
        limit,
        offset: params.offset ?? 0
      },
      message: `Found ${contexts.length} matching contexts`
    });
  }

  /** Resolve a project's display name (best-effort; null on miss or DB error). */
  private static async resolveProjectName(projectId: string): Promise<string | undefined> {
    try {
      const { db } = await import('../database/connection');
      const result = await db.query('SELECT name FROM projects WHERE id = $1', [projectId]);
      return result.rows[0]?.name;
    } catch (error) {
      logger.warn('Failed to resolve project name for search results', { error });
      return undefined;
    }
  }

  /**
   * GET /api/contexts/:id - Get single context
   */
  static async getContext(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const context = await ContextService.getContextById(id);

      if (!context) {
        res.status(404).json({
          success: false,
          message: 'Context not found'
        });
        return;
      }

      res.json({
        success: true,
        data: context
      });
    } catch (error) {
      logger.error('Get context error', { error });
      res.status(500).json({
        success: false,
        message: 'Failed to get context',
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * PUT /api/contexts/:id - Update context
   */
  static async updateContext(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const updates = req.body as UpdateContextData;

      const filteredUpdates: UpdateContextData = {};
      if (typeof updates.content === 'string') {
        filteredUpdates.content = updates.content;
      }
      if (Array.isArray(updates.tags)) {
        filteredUpdates.tags = updates.tags;
      }
      if (updates.metadata && typeof updates.metadata === 'object') {
        filteredUpdates.metadata = updates.metadata;
      }
      if (typeof updates.relevance_score === 'number') {
        filteredUpdates.relevance_score = updates.relevance_score;
      }
      // the project a record is CREATED IN / MOVED TO — the subject of
      // the write, not the viewer's current scope, so getRequestProjectId() is the wrong value
      // (the header names the project being viewed and would win over the body). Authorized
      // before this line because the resolver authorizes EVERY candidate and body.project_id
      // is a PROJECT_SCOPE_SOURCE, so a cross-project write needs access to both ends.
      if (typeof updates.project_id === 'string') {
        filteredUpdates.project_id = updates.project_id;
      }

      if (Object.keys(filteredUpdates).length === 0) {
        res.status(400).json({
          success: false,
          message: 'No valid updates provided'
        });
        return;
      }

      // Validate project_id if provided
      if (filteredUpdates.project_id) {
        const { db } = await import('../database/connection');
        const projectExists = await db.query(
          'SELECT id FROM projects WHERE id = $1 AND status = $2',
          [filteredUpdates.project_id, 'active']
        );

        if (projectExists.rows.length === 0) {
          res.status(400).json({
            success: false,
            message: 'Invalid project ID or project is not active'
          });
          return;
        }

        // Get current context to check if project is changing
        const currentContext = await ContextService.getContextById(id);

        if (!currentContext) {
          res.status(404).json({
            success: false,
            message: 'Context not found'
          });
          return;
        }

        if (currentContext.project_id !== filteredUpdates.project_id) {
          // Project is changing - add audit trail to metadata
          const auditTrail = {
            from_project_id: currentContext.project_id,
            to_project_id: filteredUpdates.project_id,
            moved_at: new Date().toISOString(),
            moved_by: 'user' // or get from auth context
          };

          filteredUpdates.metadata = {
            ...(currentContext.metadata || {}),
            move_history: [
              ...((currentContext.metadata?.move_history) || []),
              auditTrail
            ]
          };
        }
      }

      const context = await ContextService.updateContext(id, filteredUpdates);

      if (!context) {
        res.status(404).json({
          success: false,
          message: 'Context not found'
        });
        return;
      }

      res.json({
        success: true,
        data: context,
        message: 'Context updated successfully'
      });
    } catch (error) {
      logger.error('Update context error', { error });
      res.status(500).json({
        success: false,
        message: 'Failed to update context',
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * DELETE /api/contexts/:id - SOFT-delete (archive) a single context.
   *
   * The row is NOT destroyed: `archived_at` is set, matching MCP `context_delete` on the
   * same table, and `POST /api/contexts/:id/restore` undoes it.
   */
  static async deleteContext(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const result = await ContextService.deleteContext(id);

      if (!result.found) {
        res.status(404).json({
          success: false,
          message: 'Context not found'
        });
        return;
      }

      res.json({
        success: true,
        data: {
          id,
          archived: true,
          archived_at: result.archivedAt,
          already_archived: result.alreadyArchived
        },
        message: result.alreadyArchived
          ? 'Context was already deleted'
          : 'Context deleted successfully'
      });
    } catch (error) {
      logger.error('Delete context error', { error });
      res.status(500).json({
        success: false,
        message: 'Failed to delete context',
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * POST /api/contexts/:id/restore - UN-archive a soft-deleted context.
   *
   * Clears `archived_at`, returning the context to the default list, counts and export.
   * This is what makes `restore` honest for a record deleted through the UI: before
   * an earlier task the UI delete destroyed the row, so there was nothing left to restore.
   */
  static async restoreContext(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const result = await ContextService.restoreContext(id);

      if (!result.found) {
        res.status(404).json({
          success: false,
          message: 'Context not found'
        });
        return;
      }

      res.json({
        success: true,
        data: { id, archived: false, archived_at: null },
        message: 'Context restored successfully'
      });
    } catch (error) {
      logger.error('Restore context error', { error });
      res.status(500).json({
        success: false,
        message: 'Failed to restore context',
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * DELETE /api/contexts/bulk/delete - Bulk SOFT-delete contexts.
   *
   * PROJECT-SCOPED. The ids arrive in the BODY, so this route has no
   * `router.param('id', authorizeIdParam)` authorization to lean on the way the single
   * delete does — the scope resolved here is the only thing standing between a caller
   * and a row in a project they hold no grant on.
   */
  static async bulkDeleteContexts(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { ids } = req.body;

      if (!Array.isArray(ids) || ids.length === 0) {
        res.status(400).json({
          success: false,
          message: 'Invalid or empty context IDs array'
        });
        return;
      }

      const result = await ContextService.bulkDeleteContexts(ids, await resolveListScope(req));

      res.json({
        success: true,
        data: result,
        message: `${result.deleted} contexts deleted successfully`
      });
    } catch (error) {
      logger.error('Bulk delete contexts error', { error });
      res.status(500).json({
        success: false,
        message: 'Failed to bulk delete contexts',
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * POST /api/contexts/bulk/update - Bulk update contexts.
   *
   * PROJECT-SCOPED (REALIGN step 9), the same shape as bulk delete
   * above: body ids, no `:id` param authorization, so the scope resolved here is the
   * whole authorization. Before this, `bulkUpdateContexts(ids, updates)` re-tagged or
   * re-homed any row on the box by id for any caller with a session.
   *
   * Two grants, checked separately:
   *   - the SOURCE rows must lie inside the caller's scope (the service's WHERE);
   *   - a `project_id` DESTINATION must be a project the caller holds. It sits under
   *     `updates.project_id`, which is NOT a PROJECT_SCOPE_SOURCE, so projectContextMiddleware
   *     never saw it — unlike `POST /tasks/bulk/move`, whose top-level `body.project_id` is
   *     authorized before the handler runs.
   *
   * Response stays additive for the BulkToolbar (`success` + `data.updated`); `data.skipped`
   * names the ids that were not touched.
   */
  static async bulkUpdateContexts(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { ids, updates } = req.body;

      if (!Array.isArray(ids) || ids.length === 0) {
        res.status(400).json({
          success: false,
          message: 'Invalid or empty context IDs array'
        });
        return;
      }

      if (!updates || typeof updates !== 'object') {
        res.status(400).json({
          success: false,
          message: 'Updates object is required'
        });
        return;
      }

      // validateBody('ContextBulkUpdate') has already made this a uuid string when present.
      const destination: string | undefined = updates.project_id;
      if (destination !== undefined) {
        if (!req.user) {
          res.status(401).json({
            success: false,
            message: 'Authentication required to move contexts between projects'
          });
          return;
        }
        if (!(await ProjectAccessService.userHasProjectAccess(req.user, destination))) {
          res.status(403).json({
            success: false,
            message: 'Access denied to the destination project'
          });
          return;
        }
      }

      const result = await ContextService.bulkUpdateContexts(ids, updates, await resolveListScope(req));

      res.json({
        success: true,
        data: result,
        message: result.skipped.length === 0
          ? `${result.updated} contexts updated successfully`
          : `${result.updated} contexts updated; ${result.skipped.length} skipped (not in your project scope)`
      });
    } catch (error) {
      logger.error('Bulk update contexts error', { error });
      res.status(500).json({
        success: false,
        message: 'Failed to bulk update contexts',
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * GET /api/contexts/stats - Get context statistics
   * Oracle Phase 1: Use req.projectId from middleware
   */
  static async getContextStats(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const stats = await ContextService.getContextStats(await resolveListScope(req));

      res.json({
        success: true,
        data: stats
      });
    } catch (error) {
      logger.error('Get context stats error', { error });
      res.status(500).json({
        success: false,
        message: 'Failed to get context statistics',
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * GET /api/contexts/weekly-velocity - Get weekly context velocity analytics
   */
  static async getWeeklyVelocity(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      // Oracle Phase 1: Unified project filtering - header takes priority over query param
      const weeklyVelocity = await ContextService.getWeeklyVelocity(await resolveListScope(req));

      res.json({
        success: true,
        data: { weeklyVelocity }
      });
    } catch (error) {
      logger.error('Get weekly velocity error', { error });
      res.status(500).json({
        success: false,
        message: 'Failed to get weekly velocity',
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * GET /api/contexts/export - Export contexts
   * Oracle Phase 1: Use req.projectId from middleware
   */
  static async exportContexts(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const params: ContextSearchParams = {
        ...(req.query.query && { query: req.query.query as string }),
        // UNSCOPED MEANS "THE CALLER'S PROJECTS" (an earlier task item 7). This was
        // `projectId ? { project_id: projectId } : {}` — an omitted project exported
        // every project's contexts.
        scope: await resolveListScope(req),
        ...(req.query.type && { type: req.query.type as string }),
        ...(req.query.tags && { tags: (req.query.tags as string).split(',') }),
        ...(req.query.date_from && { date_from: req.query.date_from as string }),
        ...(req.query.date_to && { date_to: req.query.date_to as string }),
        sort_by: (req.query.sort_by as 'created_at' | 'relevance' | 'updated_at') || 'created_at',
        sort_order: (req.query.sort_order as 'asc' | 'desc') || 'desc'
      };

      const format = req.query.format as 'json' | 'csv' || 'json';
      const exportData = await ContextService.exportContexts(params, format);

      res.setHeader('Content-Disposition', `attachment; filename="${exportData.filename}"`);
      res.setHeader('Content-Type', exportData.contentType);
      res.send(exportData.data);
    } catch (error) {
      logger.error('Export contexts error', { error });
      res.status(500).json({
        success: false,
        message: 'Failed to export contexts',
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * GET /api/contexts/:id/related - Get related contexts
   */
  static async getRelatedContexts(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const limit = req.query.limit ? parseInt(req.query.limit as string) : 5;
      
      const relatedContexts = await ContextService.getRelatedContexts(id, limit);

      res.json({
        success: true,
        data: relatedContexts,
        message: `Found ${relatedContexts.length} related contexts`
      });
    } catch (error) {
      logger.error('Get related contexts error', { error });
      res.status(500).json({
        success: false,
        message: 'Failed to get related contexts',
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * GET /api/contexts/:id/links - Get the TYPED GRAPH EDGES touching a context.
   *
   * Returns the real `links`-table edges (both directions) resolved to their other
   * endpoint's title/kind — the TreeWalker "thread box" moat. This is DISTINCT from
   * /related (embedding similarity); never conflate the two.
   */
  static async getContextLinks(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const links = await ContextService.getContextLinks(id);

      res.json({
        success: true,
        data: links,
        message: `Found ${links.length} linked records`
      });
    } catch (error) {
      logger.error('Get context links error', { error });
      res.status(500).json({
        success: false,
        message: 'Failed to get context links',
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * POST /api/contexts - Create a new context via MCP
   */
  static async createContext(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { content, type, tags, metadata } = req.body;

      if (!content || typeof content !== 'string') {
        res.status(400).json({
          success: false,
          message: 'Content is required and must be a string'
        });
        return;
      }

      // PROJECT SCOPE. WAS: `req.projectId || req.body.projectId`, passed
      // UNVALIDATED — so a request with neither sent `projectId: undefined` to the tool,
      // which then resolved through the MCP server's SHARED `http-default` slot (McpService
      // sends no X-Connection-ID) and stored the user's context in whatever project the last
      // header-less caller anywhere on the box had left it pointing at. The resolution was
      // already written here; what was missing was refusing the ambient fallback.
      const projectId = requireWriteProjectId(req, 'store a context');

      const result = await McpService.callTool('context_store', {
        content,
        type: type || 'discussion',
        tags: tags || [],
        metadata: metadata || {},
        projectId
      }, req.user?.username);

      if (!result.success) {
        res.status(500).json({
          success: false,
          message: 'Failed to create context',
          error: result.error
        });
        return;
      }

      res.status(201).json({
        success: true,
        data: result.data,
        message: 'Context created successfully'
      });
    } catch (error) {
      if (error instanceof MissingWriteProjectScopeError) {
        res.status(400).json({ success: false, message: error.message });
        return;
      }
      logger.error('Create context error', { error });
      res.status(500).json({
        success: false,
        message: 'Failed to create context',
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }
}
