import { Request, Response } from 'express';
import { McpService } from '../services/mcp';
import { AuthenticatedRequest } from '../types/auth';
import { getRequestProjectId } from '../services/projectScopeResolver';
import { db } from '../database/connection';
import { logger } from '../config/logger';
import { LinkService } from '../services/links';
import { searchConfig } from '../config/search';
import {
  requireWriteProjectId,
  MissingWriteProjectScopeError,
} from '../services/requestProjectScope';

export class DecisionController {
  /**
   * POST /api/decisions - Record new technical decision
   */
  static async recordDecision(req: Request, res: Response): Promise<void> {
    try {
      const { title, problem, decision, rationale, alternatives } = req.body;

      // Validate required fields
      if (!title || !problem || !decision) {
        res.status(400).json({
          success: false,
          message: 'Title, problem, and decision are required fields'
        });
        return;
      }

      // PROJECT SCOPE. This call used to name NO project, and McpService
      // sends no X-Connection-ID — so it resolved through the MCP server's SHARED
      // `http-default` slot, i.e. wherever the last header-less caller anywhere on the box
      // happened to leave it. This backend serves MANY projects for MANY users, so giving it
      // its own connection slot would be the wrong model: one slot cannot represent N
      // concurrent users' project choices. The right unit is the CALL, and the request
      // already carries it. Same shape as services/task.ts:351 and controllers/context.ts:84.
      const projectId = requireWriteProjectId(req as AuthenticatedRequest, 'record a decision');

      // Call AIDIS MCP decision_record
      const result = await McpService.callTool('decision_record', {
        projectId,
        title,
        problem,
        decision,
        ...(rationale && { rationale }),
        ...(alternatives && { alternatives })
      }, (req as AuthenticatedRequest).user?.username);
      
      if (!result.success) {
        logger.error('AIDIS decision_record failed', { error: result.error });
        res.status(500).json({
          success: false,
          message: 'Failed to record decision',
          error: result.error
        });
        return;
      }

      res.status(201).json({
        success: true,
        data: result.data,
        message: 'Decision recorded successfully'
      });

    } catch (error) {
      if (error instanceof MissingWriteProjectScopeError) {
        res.status(400).json({ success: false, message: error.message });
        return;
      }
      logger.error('Record decision error', { error });
      res.status(500).json({
        success: false,
        message: 'Failed to record decision',
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * GET /api/decisions - Search technical decisions
   */
  static async searchDecisions(req: Request, res: Response): Promise<void> {
    try {
      const {
      query = '',
      status,
      answerStatus,
      created_by,
      date_from,
      date_to,
      limit = 20,
      offset = 0
      } = req.query;

      // Project scope — mirror the Contexts fix (commit 8fbf00d): the X-Project-ID header
      // (→ req.projectId via projectContextMiddleware) takes priority over the query param,
      // and the resolved id is passed STRAIGHT into the MCP decision_search args as
      // `projectId` (the tool schema's camelCase param name). NO project_switch: a GET must
      // never mutate the shared MCP session state — that mutation-on-read was a landmine.
      const projectId = getRequestProjectId(req as AuthenticatedRequest);

      logger.info('[Decision Search] Request params', {
        query, projectId, status, answerStatus, created_by, date_from, date_to, limit, offset
      });

      // Build search parameters for AIDIS MCP.
      // CLAMP the limit to the MCP decision_search tool cap: the tool schema-validates
      // `limit` at max 100 and 500s the entire request on anything higher. Clamping here
      // makes any over-limit client (the Decisions screen historically asked for 150)
      // degrade gracefully to the tool max instead of erroring — fixes the whole class.
      const searchParams: any = {
        query: query || "*", // Use "*" to show all decisions when no search query provided
        limit: Math.min(parseInt(limit as string) || 20, searchConfig.decisionSearchMaxLimit)
      };

      // Scope by project WITHOUT switching session state: forward the resolved id as the
      // MCP tool's `projectId` param (the tool resolves it per-request, no side-effects).
      if (projectId) searchParams.projectId = projectId;
      if (status) searchParams.status = status;
      // THE DECISION INBOX: forward
      // answerStatus straight to the MCP decision_search tool's `answerStatus` param
      // (open | discussing | decided) — a FOURTH status column, forwarded exactly like
      // `status` above it. Accepts one value at a time (the tool's zod schema is a bare
      // enum, not an array), so the inbox page issues one search per status it wants.
      if (answerStatus) searchParams.answerStatus = answerStatus;
      if (created_by) searchParams.created_by = created_by;
      if (date_from) searchParams.date_from = date_from;
      if (date_to) searchParams.date_to = date_to;

      logger.info('[Decision Search] MCP search params', { searchParams });

      // Call AIDIS MCP decision_search
      // mcp-write-scope: read — decision_search persists no decision; it already forwards the
      // resolved projectId above, so it never reads through the shared http-default slot.
      const result = await McpService.callTool('decision_search', searchParams, (req as AuthenticatedRequest).user?.username);
      
      logger.info('[Decision Search] MCP result success', { success: result.success });
      if (result.success) {
        logger.info('[Decision Search] MCP data keys', { keys: Object.keys(result.data || {}) });
      }

      if (!result.success) {
        logger.error('AIDIS decision_search failed', { error: result.error });
        res.status(500).json({
          success: false,
          message: 'Failed to search decisions',
          error: result.error
        });
        return;
      }

      const searchResult = result.data;
      
      // Transform the response to match frontend expectations
      const transformedResult = {
        decisions: searchResult.results || [],
        total: searchResult.total || 0,
        page: Math.floor(parseInt(offset as string) / parseInt(limit as string)) + 1,
        limit: parseInt(limit as string)
      };

      logger.info('[Decision Search] Transformed result', {
        totalDecisions: transformedResult.decisions.length,
        totalFound: transformedResult.total,
        page: transformedResult.page
      });

      res.json({
        success: true,
        data: transformedResult,
        message: `Found ${transformedResult.total} decisions`
      });

    } catch (error) {
      logger.error('Decision search error', { error });
      res.status(500).json({
        success: false,
        message: 'Failed to search decisions',
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * GET /api/decisions/stats - Get decision statistics
   */
  static async getDecisionStats(req: Request, res: Response): Promise<void> {
    try {
      // Same scope resolution as the list (searchDecisions): the X-Project-ID header
      // (→ req.projectId) beats the query param. Forward it as the MCP decision_stats
      // tool's camelCase `projectId` param — NOT the snake_case `project_id` the tool
      // never read (that was why stats scoping silently no-op'd). No project_switch.
      const projectId = getRequestProjectId(req as AuthenticatedRequest);

      // Call AIDIS MCP decision_stats
      // mcp-write-scope: read — decision_stats is an aggregate read; the projectId it is
      // scoped by is forwarded on the next line.
      const result = await McpService.callTool('decision_stats', {
        projectId: projectId || undefined
      }, (req as AuthenticatedRequest).user?.username);
      
      if (!result.success) {
        logger.error('AIDIS decision_stats failed', { error: result.error });
        res.status(500).json({
          success: false,
          message: 'Failed to get decision statistics',
          error: result.error
        });
        return;
      }

      res.json({
        success: true,
        data: result.data,
        message: 'Decision statistics retrieved'
      });

    } catch (error) {
      logger.error('Decision stats error', { error });
      res.status(500).json({
        success: false,
        message: 'Failed to get decision statistics',
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * GET /api/decisions/:id - Get single decision
   */
  static async getDecision(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;

      // PROJECT SCOPE (the reviewer N2). This read named NO project, so a
      // Command UI user resolving a decision by id read through the MCP server's shared
      // `http-default` slot — the same ambient resolution the writes above stopped using.
      // Same one-line shape as searchDecisions: forward the resolved id, never project_switch.
      const projectId = getRequestProjectId(req as AuthenticatedRequest);

      // Call AIDIS MCP decision_search with specific ID filter
      // mcp-write-scope: read — a by-id lookup; decision_search persists nothing.
      const result = await McpService.callTool('decision_search', {
        query: `id:${id}`,
        limit: 1,
        ...(projectId ? { projectId } : {})
      }, (req as AuthenticatedRequest).user?.username);
      
      if (!result.success) {
        logger.error('AIDIS decision lookup failed', { error: result.error });
        res.status(500).json({
          success: false,
          message: 'Failed to get decision',
          error: result.error
        });
        return;
      }

      const searchResult = result.data;
      const decision = searchResult.results?.[0];

      if (!decision) {
        res.status(404).json({
          success: false,
          message: 'Decision not found'
        });
        return;
      }

      res.json({
        success: true,
        data: decision,
        message: 'Decision retrieved'
      });

    } catch (error) {
      logger.error('Get decision error', { error });
      res.status(500).json({
        success: false,
        message: 'Failed to get decision',
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * PUT /api/decisions/:id - Update decision
   */
  static async updateDecision(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const {
        status,
        outcomeStatus,
        outcomeNotes,
        lessonsLearned,
        supersededBy,
        supersededReason
      } = req.body;

      // Validate input - at least one field must be provided
      if (!status && !outcomeStatus && !outcomeNotes && !lessonsLearned && !supersededBy && !supersededReason) {
        res.status(400).json({
          success: false,
          message: 'At least one update field is required'
        });
        return;
      }

      // PROJECT SCOPE — same rationale as recordDecision above. `decisionId`
      // does not make this call self-scoping: the route resolves a project to scope the
      // id/short-id lookup (routes/decisions.routes.ts handleUpdate → resolveProjectId), and
      // with no project named that resolution is the shared `http-default` slot.
      const projectId = requireWriteProjectId(req as AuthenticatedRequest, 'update a decision');

      // Call AIDIS MCP decision_update with correct parameter names
      const result = await McpService.callTool('decision_update', {
        projectId,
        decisionId: id, // String ID, not integer
        ...(status && { status }),
        ...(outcomeStatus && { outcomeStatus }),
        ...(outcomeNotes && { outcomeNotes }),
        ...(lessonsLearned && { lessonsLearned }),
        ...(supersededBy && { supersededBy }),
        ...(supersededReason && { supersededReason })
      }, (req as AuthenticatedRequest).user?.username);

      if (!result.success) {
        logger.error('AIDIS decision_update failed', { error: result.error });
        res.status(500).json({
          success: false,
          message: 'Failed to update decision',
          error: result.error
        });
        return;
      }

      res.json({
        success: true,
        data: result.data,
        message: 'Decision updated successfully'
      });

    } catch (error) {
      if (error instanceof MissingWriteProjectScopeError) {
        res.status(400).json({ success: false, message: error.message });
        return;
      }
      logger.error('Update decision error', { error });
      res.status(500).json({
        success: false,
        message: 'Failed to update decision',
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * The human sentence for an in-band decision-inbox refusal (`structuredContent.ok ===
   * false`). `McpService.makeRequest` resolves ONLY the `structuredContent` sibling of a
   * tool response when one is present (see services/mcp.ts "PAYLOAD FIRST" note) — the
   * prose in `content[].text` never reaches this backend, so the message a caller sees
   * has to be composed HERE from the typed `code` the mcp-server DOES forward. Mirrors
   * the exact refusal text mcp-server/src/handlers/decisions.ts throws, so a Command UI
   * user reads the same sentence a tool-only caller would.
   */
  private static readonly INBOX_REFUSAL_MESSAGES: Record<string, string> = {
    DECISION_ALREADY_DECIDED: 'This decision is already decided — refusing to change it.',
    DECISION_UNKNOWN_OPTION: 'Unknown option key for this decision.',
    DECISION_OPEN_INVALID: 'This decision is missing the question/options an open decision requires.',
  };

  /**
   * POST /api/decisions/:id/answer - decision_answer over the Command backend.
   * Picks an option on an open/discussing decision;
   * the chosen row + every non-chosen option are folded into alternatives_considered by
   * the mcp-server handler. `option` is REQUIRED; `note` is optional free text.
   */
  static async answerDecision(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const { option, note } = req.body;

      if (!option || typeof option !== 'string') {
        res.status(400).json({ success: false, message: 'option is required' });
        return;
      }

      // PROJECT SCOPE (mirrors updateDecision above). decision_answer is an
      // `effect:'write'` op — the mcp-server's G2 ambient-write guard
      // REJECTS a write from an unidentified caller (this backend sends no
      // X-Connection-ID) unless it carries an EXPLICIT project. `decisionId` is a full
      // UUID here so it does not need a project to RESOLVE the row — but G2 does not
      // know that; it only sees whether a project argument was named, so this is
      // required regardless. Measured live (an earlier task browser proof): omitting it
      // 400'd every Decide click with "caller presented no connection identity".
      const projectId = requireWriteProjectId(req as AuthenticatedRequest, 'answer a decision');

      const result = await McpService.callTool(
        'decision_answer',
        { decisionId: id, option, projectId, ...(note ? { note } : {}) },
        (req as AuthenticatedRequest).user?.username
      );

      if (!result.success) {
        logger.error('AIDIS decision_answer failed', { error: result.error });
        res.status(502).json({ success: false, message: result.error || 'Failed to answer decision' });
        return;
      }

      if (result.data?.ok === false) {
        const code = result.data?.code as string | undefined;
        res.status(code === 'DECISION_ALREADY_DECIDED' ? 409 : 400).json({
          success: false,
          message: DecisionController.INBOX_REFUSAL_MESSAGES[code ?? ''] ?? 'The decision could not be answered.',
          error: code,
        });
        return;
      }

      res.json({
        success: true,
        data: result.data?.decision,
        message: 'Decision answered successfully'
      });
    } catch (error) {
      if (error instanceof MissingWriteProjectScopeError) {
        res.status(400).json({ success: false, message: error.message });
        return;
      }
      logger.error('Answer decision error', { error });
      res.status(500).json({
        success: false,
        message: 'Failed to answer decision',
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * POST /api/decisions/:id/discuss - decision_discuss over the Command backend.
   * Kicks an open decision back for more context —
   * the row stays open (`answer_status='discussing'`) and the note is appended to the
   * running `answer_note` log. `note` is optional.
   */
  static async discussDecision(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const { note } = req.body;

      // PROJECT SCOPE — see the matching comment on answerDecision above; decision_discuss
      // is the same G2-guarded write shape.
      const projectId = requireWriteProjectId(req as AuthenticatedRequest, 'discuss a decision');

      const result = await McpService.callTool(
        'decision_discuss',
        { decisionId: id, projectId, ...(note ? { note } : {}) },
        (req as AuthenticatedRequest).user?.username
      );

      if (!result.success) {
        logger.error('AIDIS decision_discuss failed', { error: result.error });
        res.status(502).json({ success: false, message: result.error || 'Failed to discuss decision' });
        return;
      }

      if (result.data?.ok === false) {
        const code = result.data?.code as string | undefined;
        res.status(code === 'DECISION_ALREADY_DECIDED' ? 409 : 400).json({
          success: false,
          message: DecisionController.INBOX_REFUSAL_MESSAGES[code ?? ''] ?? 'The decision could not be sent for discussion.',
          error: code,
        });
        return;
      }

      res.json({
        success: true,
        data: result.data?.decision,
        message: 'Decision sent back for discussion'
      });
    } catch (error) {
      if (error instanceof MissingWriteProjectScopeError) {
        res.status(400).json({ success: false, message: error.message });
        return;
      }
      logger.error('Discuss decision error', { error });
      res.status(500).json({
        success: false,
        message: 'Failed to discuss decision',
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * GET /api/decisions/:id/links - Get the TYPED GRAPH EDGES touching a decision.
   *
   * Returns the real `links`-table edges (both directions) resolved to their other
   * endpoint's title + kind — the TreeWalker "thread box" (the moat). For a decision this
   * surfaces what it decided (incoming `decided_by` from contexts/tasks) and what it caused
   * (outgoing `caused`). STRUCTURE, never the semantic `related` list. Uses the ONE shared
   * resolver (LinkService.getLinksForRecord) — same query as contexts + tasks.
   */
  static async getDecisionLinks(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const links = await LinkService.getLinksForRecord(id);
      res.json({
        success: true,
        data: links,
        message: `Found ${links.length} linked records`
      });
    } catch (error) {
      logger.error('Get decision links error', { error });
      res.status(500).json({
        success: false,
        message: 'Failed to get decision links',
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * DELETE /api/decisions/:id - SOFT-delete (archive) a decision.
   *
   * THE DEFECT THIS CLOSES. This ran `DELETE FROM technical_decisions WHERE id = $1` —
   * the row was DESTROYED, along with every typed edge pointing at it — while the MCP
   * surface on the SAME table (`decision_delete` -> DecisionsHandler.archiveDecision,
   * mcp-server/src/handlers/decisions.ts) only ever set `archived_at`, and
   * `decision_search` has filtered `archived_at IS NULL` since an earlier task. Two delete
   * semantics on one table: a Command UI delete annihilated a record the MCP layer
   * believed was merely archived, and the advertised `decision restore` action had
   * nothing left to clear.
   *
   * IDEMPOTENT: a repeat delete does NOT rewrite the original `archived_at`.
   *
   * The row is not project-scoped HERE because `routes/decisions.ts` registers
   * `router.param('id', authorizeIdParam)`, which authorizes the id against the caller's
   * grants during ROUTING — before this handler runs. Adding a second, independently
   * maintained authorization decision is the thing projectScopeResolver.ts exists to
   * prevent.
   */
  static async deleteDecision(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;

      if (!id) {
        res.status(400).json({
          success: false,
          message: 'Decision ID is required'
        });
        return;
      }

      const updated = await db.query(
        `UPDATE technical_decisions SET archived_at = now()
         WHERE id = $1 AND archived_at IS NULL
         RETURNING title, archived_at`,
        [id]
      );

      if (updated.rowCount && updated.rowCount > 0) {
        res.json({
          success: true,
          data: { id, archived: true, archived_at: updated.rows[0].archived_at, already_archived: false },
          message: `Decision "${updated.rows[0].title}" deleted successfully`
        });
        return;
      }

      // Nothing updated -> already archived, or no such row. Keep those distinguishable.
      const probe = await db.query(
        'SELECT title, archived_at FROM technical_decisions WHERE id = $1',
        [id]
      );

      if (probe.rows.length === 0) {
        res.status(404).json({
          success: false,
          message: 'Decision not found'
        });
        return;
      }

      res.json({
        success: true,
        data: { id, archived: true, archived_at: probe.rows[0].archived_at, already_archived: true },
        message: `Decision "${probe.rows[0].title}" was already deleted`
      });

    } catch (error) {
      logger.error('Delete decision error', { error });
      res.status(500).json({
        success: false,
        message: 'Failed to delete decision',
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * POST /api/decisions/:id/restore - UN-archive a soft-deleted decision.
   *
   * The undo for the soft delete above, and the reason `restore` is now honest for a
   * decision deleted through the UI. Clears `archived_at` so the row returns to
   * decision_search, the list and the stats. Idempotent: restoring a live decision is a
   * successful no-op, because "it is not archived" is the true end-state either way.
   */
  static async restoreDecision(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;

      const updated = await db.query(
        `UPDATE technical_decisions SET archived_at = NULL
         WHERE id = $1 AND archived_at IS NOT NULL
         RETURNING title`,
        [id]
      );

      if (updated.rowCount && updated.rowCount > 0) {
        res.json({
          success: true,
          data: { id, archived: false, archived_at: null },
          message: `Decision "${updated.rows[0].title}" restored successfully`
        });
        return;
      }

      const probe = await db.query('SELECT title FROM technical_decisions WHERE id = $1', [id]);
      if (probe.rows.length === 0) {
        res.status(404).json({
          success: false,
          message: 'Decision not found'
        });
        return;
      }

      res.json({
        success: true,
        data: { id, archived: false, archived_at: null },
        message: `Decision "${probe.rows[0].title}" restored successfully`
      });

    } catch (error) {
      logger.error('Restore decision error', { error });
      res.status(500).json({
        success: false,
        message: 'Failed to restore decision',
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }
}
