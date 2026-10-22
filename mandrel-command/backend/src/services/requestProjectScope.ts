/**
 * requestProjectScope — the ONE place a Command-backend WRITE resolves which project it
 * writes to.
 *
 * =============================================================================
 * THE DEFECT THIS CLOSES
 * =============================================================================
 * `services/mcp.ts` sends `X-Actor-ID` but NO `X-Connection-ID`. On the MCP server every
 * caller that presents no connection identity is collapsed onto ONE shared, sticky,
 * last-writer-wins project slot (`http-default`), so any call that names no project resolves
 * to wherever the last header-less caller ANYWHERE on that box left it. Measured on prod
 * 2026-07-27/28: that slot cycled riverbend→personal→acme ~13 times in five hours.
 *
 * Three write call sites named no project — `decision_record`, `decision_update`, and
 * `context_store` (which passed `req.projectId || req.body.projectId` UNVALIDATED, so an
 * absent header silently produced the same ambient write).
 *
 * =============================================================================
 * WHY NOT JUST GIVE THE BACKEND ITS OWN X-Connection-ID
 * =============================================================================
 * Because one slot cannot represent N concurrent users' project choices. This process
 * serves many projects for many users; a per-process slot would make every user's write
 * race every other user's project selection — a smaller shared slot, not a fixed one. The
 * correct unit of scope is the CALL, and the request already carries it (`X-Project-ID` →
 * `req.projectId`, attached by middleware/project.ts). The reads already do this correctly
 * (controllers/context.ts:84 via buildContextSearchArgs), as does task creation
 * (services/task.ts:351); this brings the remaining writes onto the same rule.
 *
 * FAIL LOUD, NOT FAIL AMBIENT. With no project on the request the honest
 * answer is a 400 telling the client to send `X-Project-ID`, not a write into whatever
 * project the shared slot points at. A write that lands in an unknown project is worse than
 * a write that does not happen: it is invisible, and it is in someone else's data.
 */

import { AuthenticatedRequest } from '../types/auth';
import {
  getRequestProjectId,
  type ProjectScopedRequestLike,
} from './projectScopeResolver';

/**
 * Thrown when a WRITE arrives with no project scope. Mirrors
 * `services/contextSearchAdapter.ts:MissingProjectIdError` (the same class, on the read
 * path) rather than inventing a second idiom — both map to a 400 in the controller.
 */
export class MissingWriteProjectScopeError extends Error {
  constructor(readonly operation: string) {
    super(
      `A project is required to ${operation}. Send the 'X-Project-ID' header (or a ` +
        `projectId in the body) — a write with no project would land in a shared, ` +
        `last-writer-wins scope that no user owns.`
    );
    this.name = 'MissingWriteProjectScopeError';
  }
}

/**
 * The project a WRITE from this request must be scoped to.
 *
 * ── THE HOLE THIS LINE USED TO BE ────────────────────────────────────
 * This function read `req.projectId ?? req.body?.projectId` directly. `req.projectId` was
 * authorized (middleware/project.ts checked the X-Project-ID header); `req.body.projectId`
 * was NOT CHECKED BY ANYTHING. A logged-in non-admin with zero grants who omitted the
 * header and put `projectId` in the body wrote into any project they named — the exact
 * bypass the header door was built to close, one field over.
 *
 * The body field is now a first-class source in services/projectScopeResolver.ts's
 * PROJECT_SCOPE_SOURCES and is authorized by projectContextMiddleware before any
 * controller runs, so this function's whole job is now the ONE thing it always did well:
 * refuse to write when no project was named at all (fail loud, not fail ambient).
 *
 * @param req        the (authenticated) request, after projectContextMiddleware
 * @param operation  a short human phrase for the error message ("record a decision")
 * @throws MissingWriteProjectScopeError when the request names no project
 * @throws ProjectScopeNotResolvedError when the middleware never ran (loud 500)
 */
export function requireWriteProjectId(
  req: ProjectScopedRequestLike,
  operation: string
): string {
  const projectId = getRequestProjectId(req);
  if (typeof projectId !== 'string' || projectId.trim() === '') {
    throw new MissingWriteProjectScopeError(operation);
  }
  return projectId;
}

/** Convenience alias for controllers already typed on AuthenticatedRequest. */
export type ProjectScopedRequest = Pick<AuthenticatedRequest, 'projectId' | 'projectScope' | 'body'>;
