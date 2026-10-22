/**
 * taskAttachmentAuthz — project-scoping choke point for the attachments surface
 * (Lane B). NEW FILE: mirrors the shape of
 * `services/entityProjectScope.ts` (same 400/401/403/500 contract, same
 * no-existence-oracle rule) without editing that file's closed
 * `PROJECT_OWNED_ENTITIES` map, which lane A also reads.
 *
 * Two path params need authorizing here:
 *   - `:id` on `POST/GET /tasks/:id/attachments` — a TASK id. Resolved via
 *     `TaskAttachmentService.getTaskProjectId`.
 *   - `:attachmentId` on `GET/DELETE /attachments/:attachmentId` — an ATTACHMENT id.
 *     Resolved via `TaskAttachmentService.getOwningProjectId`.
 *
 * Both funnel through the same deny-with-403-for-both-cases logic as
 * `authorizeEntityPathParam`, so a caller cannot use this surface as an existence
 * oracle for either tasks or attachments.
 */

import { Response, NextFunction } from 'express';
import { AuthenticatedRequest } from '../types/auth';
import { isValidUuid } from '../utils/uuid';
import { ProjectAccessService } from '../services/projectAccess';
import { TaskAttachmentService } from '../services/taskAttachment';

type ProjectIdLookup = (id: string) => Promise<string | null>;

function buildAuthorizer(paramName: string, lookup: ProjectIdLookup) {
  return async function authorizeParam(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    const value = req.params[paramName];
    const deny = (status: number, error: string, message: string) => {
      res.status(status).json({ success: false, error, message });
    };

    if (typeof value !== 'string' || !isValidUuid(value.trim())) {
      deny(400, 'Invalid ID format', 'The id must be a valid UUID');
      return;
    }
    // The MANDREL_AGENT_TOKEN service credential (middleware/agentAuth.ts) authenticates a
    // machine, not a project-scoped human — it has no `req.user` to check ownership
    // against, by design. Treated like an admin caller: trusted, and not scoped to any one
    // project's grant list. Checked BEFORE the `!user` guard below, since an
    // agent-authenticated request never carries a `user`.
    if (req.agentAuthenticated) {
      next();
      return;
    }
    const user = req.user;
    if (!user) {
      deny(401, 'Authentication required', 'This request requires a valid token');
      return;
    }
    if (user.role === 'admin') {
      next();
      return;
    }

    try {
      const owningProjectId = await lookup(value.trim().toLowerCase());
      // NO ROW AND NO ACCESS ARE THE SAME ANSWER — see entityProjectScope.ts's module
      // doc for why splitting them would make this an existence oracle.
      if (owningProjectId === null) {
        deny(403, 'Access denied', 'You do not have access to the requested record');
        return;
      }
      const allowed = await ProjectAccessService.userHasProjectAccess(
        { id: user.id, role: user.role },
        owningProjectId
      );
      if (!allowed) {
        deny(403, 'Access denied', 'You do not have access to the requested record');
        return;
      }
    } catch {
      // C1: "could not measure" gets its own branch and never becomes an allow.
      deny(500, 'Access check failed', 'Internal server error during authorization');
      return;
    }
    next();
  };
}

/** Authorize `:id` as a task id (used by the `/tasks/:id/attachments` family). */
export const authorizeTaskIdParam = buildAuthorizer('id', TaskAttachmentService.getTaskProjectId);

/** Authorize `:attachmentId` as an attachment id (used by the `/attachments/:attachmentId` family). */
export const authorizeAttachmentIdParam = buildAuthorizer(
  'attachmentId',
  TaskAttachmentService.getOwningProjectId
);
