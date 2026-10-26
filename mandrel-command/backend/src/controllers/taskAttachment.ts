/**
 * TaskAttachmentController — Punch List task attachments (Lane B).
 * NEW FILE; does not touch lane A's controllers/task.ts.
 */

import { Response } from 'express';
import { AuthenticatedRequest } from '../types/auth';
import { logger } from '../config/logger';
import { normalizeActor } from '../config/sessionActor';
import { parseAttachmentKind, parseBulkAttachmentIds } from '../validation/taskAttachment';
import {
  AttachmentMetadata,
  AttachmentTooLargeError,
  AttachmentTypeRejectedError,
  TaskAttachmentService,
} from '../services/taskAttachment';
import { allProjects, resolveCallerScope } from '../services/projectListScope';

/** The multer-populated field this route reads. Kept local so a test can import the
 *  same literal rather than re-typing the string. */
export const UPLOAD_FIELD_NAME = 'file';

/** Minimal shape of the multer `req.file` this controller needs — avoids depending on
 *  `Express.Multer.File`'s full global augmentation from a controller that otherwise
 *  never imports multer. */
interface UploadedFile {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

/**
 * RFC 6266 / RFC 5987 `Content-Disposition`. Two forms, one header:
 *   filename="<ascii>"   — the legacy fallback: every non-ASCII, quote and backslash
 *                          becomes `_`, so it can never break the quoted-string grammar;
 *   filename*=UTF-8''…   — the real name, percent-encoded, which every current browser
 *                          prefers, so a Japanese/emoji name round-trips exactly.
 * The stored name is already control-char free (validation/taskAttachment.ts), so this can
 * no longer throw inside `res.set` — the pre-fix 500 for a `\r\n` name (Reviewer #4c).
 */
export function buildContentDisposition(filename: string): string {
  // eslint-disable-next-line no-control-regex
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(filename).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
  );
  return `inline; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

function toResponseShape(meta: AttachmentMetadata) {
  return {
    id: meta.id,
    taskId: meta.taskId,
    kind: meta.kind,
    filename: meta.filename,
    mime: meta.mime,
    byteSize: meta.byteSize,
    createdBy: meta.createdBy,
    createdAt: meta.createdAt,
    url: `/api/attachments/${meta.id}`,
  };
}

export class TaskAttachmentController {
  /** POST /tasks/:id/attachments */
  static async upload(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const taskId = req.params.id;
      const file = (req as unknown as { file?: UploadedFile }).file;

      if (!file) {
        res.status(400).json({ success: false, error: 'Missing file', message: `A multipart field named "${UPLOAD_FIELD_NAME}" is required` });
        return;
      }

      const kindResult = parseAttachmentKind((req.body ?? {}).kind);
      if (!kindResult.ok) {
        res.status(400).json({ success: false, error: 'Invalid kind', message: kindResult.message });
        return;
      }

      const projectId = await TaskAttachmentService.getTaskProjectId(taskId);
      if (!projectId) {
        // The authz middleware already ran and would have denied a missing/unauthorized
        // task before this handler runs; a null here means the task vanished between the
        // authz check and this query — treat it as not-found rather than 500.
        res.status(404).json({ success: false, error: 'Task not found' });
        return;
      }

      const meta = await TaskAttachmentService.create({
        taskId,
        projectId,
        kind: kindResult.kind,
        filename: file.originalname,
        clientMime: file.mimetype,
        data: file.buffer,
        createdBy: normalizeActor(req.user?.username),
      });

      res.status(201).json({ success: true, data: toResponseShape(meta) });
    } catch (error) {
      if (error instanceof AttachmentTooLargeError) {
        res.status(413).json({ code: 'ATTACHMENT_TOO_LARGE', maxBytes: error.maxBytes });
        return;
      }
      if (error instanceof AttachmentTypeRejectedError) {
        res.status(415).json({ code: 'ATTACHMENT_TYPE_REJECTED', allowed: error.allowed });
        return;
      }
      logger.error('Upload task attachment error', { error });
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to upload attachment',
      });
    }
  }

  /** GET /tasks/:id/attachments */
  static async list(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const taskId = req.params.id;
      const items = await TaskAttachmentService.listByTask(taskId);
      res.json({ success: true, data: { attachments: items.map(toResponseShape) } });
    } catch (error) {
      logger.error('List task attachments error', { error });
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to list attachments',
      });
    }
  }

  /**
   * GET /attachments?taskIds=<uuid>,<uuid>,... — bulk-by-task-ids read for the board,
   * replacing a per-card `GET /tasks/:id/attachments` fan-out. Lives on the `/attachments`
   * prefix (NOT `/tasks/attachments`) so no `/tasks/:id` route anywhere can capture the
   * literal segment — the shipped-app defect Reviewer #1 found. Scoped by the CALLER's project grants
   * (services/projectListScope.ts resolveCallerScope — same construction every other
   * multi-row read on this backend uses); an id whose owning task sits outside that
   * scope is SILENTLY OMITTED, never 403'd, so one foreign id cannot fail the board.
   */
  static async bulkList(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const idsResult = parseBulkAttachmentIds(req.query.taskIds);
      if (!idsResult.ok) {
        res.status(400).json({ success: false, error: 'Invalid taskIds', message: idsResult.message });
        return;
      }

      // `resolveCallerScope` requires `req.user` and throws without one — correct for a
      // human/admin caller, but an agent-authenticated request has no
      // user by design. Treated like admin: unrestricted, same as the project-ownership
      // bypass in middleware/taskAttachmentAuthz.ts.
      const scope = req.agentAuthenticated ? allProjects : await resolveCallerScope(req);
      const items = await TaskAttachmentService.listByTaskIds(idsResult.ids, scope);
      res.json({ success: true, data: { attachments: items.map(toResponseShape) } });
    } catch (error) {
      logger.error('Bulk list task attachments error', { error });
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to list attachments',
      });
    }
  }

  /** GET /attachments/:attachmentId */
  static async getBytes(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const attachment = await TaskAttachmentService.getWithData(req.params.attachmentId);
      if (!attachment) {
        res.status(404).json({ success: false, error: 'Attachment not found' });
        return;
      }
      res.set({
        'Content-Type': attachment.mime,
        'Content-Disposition': buildContentDisposition(attachment.filename),
        'Cache-Control': 'private, max-age=3600',
        'X-Content-Type-Options': 'nosniff',
      });
      res.status(200).send(attachment.data);
    } catch (error) {
      logger.error('Get task attachment bytes error', { error });
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get attachment',
      });
    }
  }

  /** DELETE /attachments/:attachmentId */
  static async remove(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const removed = await TaskAttachmentService.remove(req.params.attachmentId);
      if (!removed) {
        res.status(404).json({ success: false, error: 'Attachment not found' });
        return;
      }
      res.status(204).send();
    } catch (error) {
      logger.error('Delete task attachment error', { error });
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to delete attachment',
      });
    }
  }
}
