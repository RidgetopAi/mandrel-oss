/**
 * TaskAttachmentService — Punch List task attachments (Lane B).
 *
 * The operator files a bug from his phone with a "before" screenshot; later the Walkthrough
 * critic stores an "evidence" image against the same task. Both are small, task-scoped
 * binary blobs stored in-row (migration 102 — see that file for the sizing rationale).
 *
 * NEW FILE, does not touch lane A's services/controllers/task.ts, validation/schemas.ts,
 * or middleware/validation.ts — everything this surface needs is local to this file plus
 * its own controller/route/validation siblings.
 */

import { db as pool } from '../database/connection';
import { ProjectListScope, scopePredicate } from './projectListScope';
import { logger } from '../config/logger';
import { sanitizeAttachmentFilename } from '../validation/taskAttachment';
import {
  ALLOWED_ATTACHMENT_MIMES,
  AllowedAttachmentMime,
  AttachmentKind,
  MAX_ATTACHMENT_BYTES,
  SNIFFABLE_IMAGE_MIMES,
} from '../config/taskAttachments';

export interface AttachmentMetadata {
  id: string;
  taskId: string;
  kind: AttachmentKind;
  filename: string;
  mime: string;
  byteSize: number;
  createdBy: string | null;
  createdAt: Date;
}

export interface AttachmentWithData extends AttachmentMetadata {
  data: Buffer;
}

export class AttachmentTooLargeError extends Error {
  constructor(public readonly maxBytes: number) {
    super(`Attachment exceeds ${maxBytes} bytes`);
    this.name = 'AttachmentTooLargeError';
  }
}

export class AttachmentTypeRejectedError extends Error {
  constructor(public readonly allowed: readonly string[]) {
    super('Attachment mime type not allowed');
    this.name = 'AttachmentTypeRejectedError';
  }
}

/**
 * Magic-byte signatures for the sniffable image kinds. Checked in order; the first
 * match wins. A buffer matching none of these, when the client declared an image mime,
 * is a mismatch the caller (service) rejects rather than trusting the header blindly —
 * see `resolveStoredMime` below.
 */
function sniffImageMime(data: Buffer): AllowedAttachmentMime | null {
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png';
  }
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return 'image/jpeg';
  }
  if (data.length >= 6 && data.subarray(0, 6).toString('ascii') === 'GIF87a') {
    return 'image/gif';
  }
  if (data.length >= 6 && data.subarray(0, 6).toString('ascii') === 'GIF89a') {
    return 'image/gif';
  }
  if (
    data.length >= 12 &&
    data.subarray(0, 4).toString('ascii') === 'RIFF' &&
    data.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
}

/**
 * Decide the mime to STORE for an upload. Documents the deviation this task's contract
 * flagged as ambiguous ("pick one, document it"):
 *
 *   - client declares an image mime (one of SNIFFABLE_IMAGE_MIMES): the bytes are
 *     sniffed and the DETECTED type is what gets stored — a PNG uploaded with a
 *     client-declared `image/jpeg` header is stored as `image/png`. A mismatch between
 *     "claims to be an image" and "sniffs as no known image at all" is a 415 REJECTION,
 *     not a silent pass-through of the unverified client header.
 *   - client declares text/plain or application/json: no reliable magic-byte signature
 *     exists for either, so the client-declared mime is trusted as-is (same trust level
 *     the rest of this API already gives request bodies).
 *   - anything else: 415.
 */
export function resolveStoredMime(clientMime: string, data: Buffer): AllowedAttachmentMime {
  const normalized = clientMime.toLowerCase().split(';')[0].trim();

  if (SNIFFABLE_IMAGE_MIMES.includes(normalized as AllowedAttachmentMime)) {
    const sniffed = sniffImageMime(data);
    if (sniffed) return sniffed;
    throw new AttachmentTypeRejectedError(ALLOWED_ATTACHMENT_MIMES);
  }

  if (normalized === 'text/plain' || normalized === 'application/json') {
    return normalized;
  }

  throw new AttachmentTypeRejectedError(ALLOWED_ATTACHMENT_MIMES);
}

interface AttachmentRow {
  id: string;
  task_id: string;
  kind: AttachmentKind;
  filename: string;
  mime: string;
  byte_size: number;
  created_by: string | null;
  created_at: Date;
}

function rowToMetadata(row: AttachmentRow): AttachmentMetadata {
  return {
    id: row.id,
    taskId: row.task_id,
    kind: row.kind,
    filename: row.filename,
    mime: row.mime,
    byteSize: row.byte_size,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

export class TaskAttachmentService {
  /**
   * Store an upload against a task. `taskId`/`projectId` are the CALLER-RESOLVED,
   * already-authorized values (the route's `router.param` authorizes the task id and
   * hands us its owning project) — this method does not re-authorize, it only persists.
   *
   * Throws AttachmentTooLargeError / AttachmentTypeRejectedError; the controller maps
   * those to 413/415.
   */
  static async create(params: {
    taskId: string;
    projectId: string;
    kind: AttachmentKind;
    filename: string;
    clientMime: string;
    data: Buffer;
    createdBy?: string;
  }): Promise<AttachmentMetadata> {
    const { taskId, projectId, kind, filename, clientMime, data, createdBy } = params;

    if (data.length > MAX_ATTACHMENT_BYTES) {
      throw new AttachmentTooLargeError(MAX_ATTACHMENT_BYTES);
    }
    if (data.length === 0) {
      throw new AttachmentTypeRejectedError(ALLOWED_ATTACHMENT_MIMES);
    }

    const storedMime = resolveStoredMime(clientMime, data);
    // The ONE place a name is bounded and stripped before it reaches varchar(255) — see
    // validation/taskAttachment.ts#sanitizeAttachmentFilename for the three defects it closes.
    const storedFilename = sanitizeAttachmentFilename(filename);

    const result = await pool.query(
      `INSERT INTO task_attachments (task_id, project_id, kind, filename, mime, byte_size, data, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, task_id, kind, filename, mime, byte_size, created_by, created_at`,
      [taskId, projectId, kind, storedFilename, storedMime, data.length, data, createdBy ?? null]
    );

    logger.info('Task attachment stored', { taskId, kind, byteSize: data.length, mime: storedMime });
    return rowToMetadata(result.rows[0]);
  }

  /** List attachments for a task, newest-created-last (matches the index order). */
  static async listByTask(taskId: string): Promise<AttachmentMetadata[]> {
    const result = await pool.query(
      `SELECT id, task_id, kind, filename, mime, byte_size, created_by, created_at
       FROM task_attachments
       WHERE task_id = $1
       ORDER BY created_at ASC`,
      [taskId]
    );
    return result.rows.map(rowToMetadata);
  }

  /**
   * Bulk-by-task-ids read for the board (`GET /attachments?taskIds=`, replacing a per-card
   * `GET /tasks/:id/attachments` fan-out). Scoped by the CALLER's project grants
   * (`ProjectListScope`, same construction every other multi-row read on this backend
   * uses — services/projectListScope.ts) rather than by any single task's project: an
   * id whose owning task sits outside the caller's scope is SILENTLY OMITTED from the
   * result, never 403'd, so one foreign id in a board's batch cannot fail the whole
   * fetch. Ordered task_id then created_at, matching `listByTask`'s per-task order.
   */
  static async listByTaskIds(taskIds: string[], scope: ProjectListScope): Promise<AttachmentMetadata[]> {
    if (taskIds.length === 0) return [];

    const params: unknown[] = [taskIds];
    const scopeClause = scopePredicate(scope, 'project_id', params);
    // scopePredicate returns '' for ALL_PROJECTS (admin) and an `AND project_id = ANY($n)`
    // clause otherwise; an EMPTY scope.projectIds still produces a real (never-matching)
    // `= ANY('{}')` clause rather than falling through to "no filter" — same invariant
    // projectListScope.ts's module doc calls out for every other caller of this function.
    const result = await pool.query(
      `SELECT id, task_id, kind, filename, mime, byte_size, created_by, created_at
       FROM task_attachments
       WHERE task_id = ANY($1::uuid[])${scopeClause}
       ORDER BY task_id ASC, created_at ASC`,
      params
    );
    return result.rows.map(rowToMetadata);
  }

  /**
   * Fetch one attachment WITH its bytes, plus the owning project id so the route's
   * authorization check can scope it. Returns null when the id does not exist —
   * callers map that to 404 (or 403 for a cross-project caller, same non-disclosing
   * shape as `entityProjectScope.ts`).
   */
  static async getWithData(id: string): Promise<(AttachmentWithData & { projectId: string }) | null> {
    const result = await pool.query(
      `SELECT id, task_id, project_id, kind, filename, mime, byte_size, data, created_by, created_at
       FROM task_attachments
       WHERE id = $1`,
      [id]
    );
    if (result.rows.length === 0) return null;
    const row = result.rows[0];
    return { ...rowToMetadata(row), data: row.data, projectId: row.project_id };
  }

  /** Owning project of an attachment id, or null if it does not exist. Used for the
   *  authorization choke point on DELETE without pulling the (large) bytes column. */
  static async getOwningProjectId(id: string): Promise<string | null> {
    const result = await pool.query('SELECT project_id FROM task_attachments WHERE id = $1', [id]);
    return result.rows.length > 0 ? result.rows[0].project_id : null;
  }

  /** True if a row existed and was deleted. */
  static async remove(id: string): Promise<boolean> {
    const result = await pool.query('DELETE FROM task_attachments WHERE id = $1', [id]);
    return (result.rowCount ?? 0) > 0;
  }

  /** The owning project of a TASK id (used to stamp `project_id` on create, and to
   *  authorize the task id's own path param — same lookup shape as
   *  `entityProjectScope.findOwningProjectId`, kept local to avoid touching that
   *  shared file's closed PROJECT_OWNED_ENTITIES enum). */
  static async getTaskProjectId(taskId: string): Promise<string | null> {
    const result = await pool.query('SELECT project_id FROM tasks WHERE id = $1', [taskId]);
    return result.rows.length > 0 ? result.rows[0].project_id : null;
  }
}
