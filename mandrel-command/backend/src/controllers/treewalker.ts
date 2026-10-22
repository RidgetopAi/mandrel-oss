/**
 * TreeWalkerController — the whole-thread graph + recall_thread story + trust endpoint that
 * lights up the moat's flagship visualizer.
 *
 *   GET /api/treewalker/thread            → walk the LIVE resume anchor (newest ref:resume
 *                                           context in the active project, X-Project-ID scoped)
 *   GET /api/treewalker/:anchorId/thread  → walk an EXPLICIT anchor
 *
 * Returns the standard `{ success, data }` envelope where data is the ThreadGraph the FE
 * `api.treewalker.getThread` expects. A genuinely-empty thread (no resume anchor) returns a
 * 200 with an honest empty graph; an explicit anchor that resolves to nothing → 404.
 */
import { Response } from 'express';
import { AuthenticatedRequest } from '../types/auth';
import { getRequestProjectId } from '../services/projectScopeResolver';
import { TreeWalkerService, AnchorNotFoundError } from '../services/treewalker';
import { TreeWalkerTiersService } from '../services/treewalkerTiers';
import { sendSuccess, sendError } from '../utils/apiResponse';
import { db } from '../database/connection';
import { logger } from '../config/logger';
import { resolveListScope } from '../services/projectListScope';

export class TreeWalkerController {
  /** Best-effort project display name for the tree tier (never fails the request). */
  private static async resolveProjectName(projectId?: string): Promise<string | undefined> {
    if (!projectId) return undefined;
    try {
      const r = await db.query('SELECT name FROM projects WHERE id = $1', [projectId]);
      return r.rows.length ? (r.rows[0].name as string) : undefined;
    } catch (error) {
      logger.warn('TreeWalker resolveProjectName failed', { error, projectId });
      return undefined;
    }
  }

  /** GET /api/treewalker/thread — walk the live resume anchor for the active project. */
  static async getResumeThread(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const scope = await resolveListScope(req);
      const projectName = await TreeWalkerController.resolveProjectName(
        getRequestProjectId(req)
      );
      const graph = await TreeWalkerService.getThread({ scope, projectName });
      sendSuccess(res, graph);
    } catch (error) {
      logger.error('TreeWalker getResumeThread error', { error });
      sendError(res, error, 500, 'Failed to build thread graph');
    }
  }

  /** GET /api/treewalker/trunk — the handoff TIMELINE (PHASE 2 item a): full count +
   *  bounded newest-first entries + per-entry supersession corroboration. Time-ordered
   *  ALWAYS; no supersedes recursion exists on this path (see treewalkerTiers.ts). */
  static async getTrunk(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const scope = await resolveListScope(req);
      sendSuccess(res, await TreeWalkerTiersService.getTrunk(scope));
    } catch (error) {
      logger.error('TreeWalker getTrunk error', { error });
      sendError(res, error, 500, 'Failed to read the trunk timeline');
    }
  }

  /** GET /api/treewalker/branches — the resume surface (PHASE 2 item c): TOP-LEVEL
   *  DRAWERS only (P2, an earlier task — sections are filtered before
   *  the cap, not after), from the `branch_membership` view (migration 086 — recorded
   *  positions only), newest-active first, named by their once-on-the-spine `branch:`
   *  tag else spine title. Each branch also carries sectionCount, and the envelope
   *  carries the honest drawer `total`/`cap`. */
  static async getBranches(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const scope = await resolveListScope(req);
      sendSuccess(res, await TreeWalkerTiersService.getBranches(scope));
    } catch (error) {
      logger.error('TreeWalker getBranches error', { error });
      sendError(res, error, 500, 'Failed to read the branch list');
    }
  }

  /** GET /api/treewalker/:anchorId/thread — walk an explicit anchor. */
  static async getThread(req: AuthenticatedRequest, res: Response): Promise<void> {
    const anchorId = req.params.anchorId;
    try {
      const scope = await resolveListScope(req);
      const projectName = await TreeWalkerController.resolveProjectName(
        getRequestProjectId(req)
      );
      const graph = await TreeWalkerService.getThread({ anchorId, scope, projectName });
      sendSuccess(res, graph);
    } catch (error) {
      if (error instanceof AnchorNotFoundError) {
        sendError(res, error, 404, 'Thread anchor not found');
        return;
      }
      logger.error('TreeWalker getThread error', { error, anchorId });
      sendError(res, error, 500, 'Failed to build thread graph');
    }
  }
}
