import { Router, Request, Response, NextFunction } from 'express';
import multer, { MulterError } from 'multer';
import { authenticateAgentOrUser } from '../middleware/agentAuth';
import { declareAnyAuthenticatedMayWrite } from '../middleware/authz';
import { authorizeTaskIdParam, authorizeAttachmentIdParam } from '../middleware/taskAttachmentAuthz';
import { TaskAttachmentController, UPLOAD_FIELD_NAME } from '../controllers/taskAttachment';
import { MAX_ATTACHMENT_BYTES } from '../config/taskAttachments';

/**
 * Punch List task attachments (Lane B).
 *
 * TWO routers, each mounted by routes/index.ts at the ONE prefix it owns:
 *   taskScopedAttachmentRoutes  → `/tasks`        POST/GET  /:id/attachments
 *   attachmentRoutes            → `/attachments`  GET       /            (bulk, ?taskIds=)
 *                                                 GET/DELETE /:attachmentId
 *
 * WHY NOT ONE ROUTER AT `/` (the first cut, the reviewer #1 + #6): the bulk read
 * used to live at `/tasks/attachments`, and routes/tasks.ts's `GET /:id` — mounted
 * earlier — captured the literal `attachments` as `:id` (400 'Invalid ID format'), so the
 * board's thumbnails never loaded in the shipped app. Its own DB test mounted only this
 * router and stayed green. Moving the bulk route onto the `/attachments` prefix removes
 * the collision STRUCTURALLY — no `/tasks/:id` route can ever see it — so nothing here
 * depends on mount ORDER in routes/index.ts. And a router-level `authenticateToken` on a
 * `/`-mounted router turned every unknown `/api/*` into a 401 instead of the 404
 * `notFoundHandler` owes it; mounting at the two specific prefixes ends that too.
 * Both facts are asserted against the REAL app (server.ts) in taskAttachments.db.test.ts.
 *
 * Auth model matches routes/tasks.ts, EXCEPT the gate: `authenticateAgentOrUser`
 * accepts the MANDREL_AGENT_TOKEN service credential (the headless Walkthrough
 * critic) OR a user JWT, 401ing a caller with neither. Then
 * `router.param` (authorizeTaskIdParam / authorizeAttachmentIdParam, in
 * middleware/taskAttachmentAuthz.ts) authorizes the project-owning id in the path before
 * any handler runs — same 400/401/403/500 contract as services/entityProjectScope.ts, kept
 * as a sibling file rather than editing that module's closed PROJECT_OWNED_ENTITIES map. An
 * agent-authenticated request has no `req.user` to scope against, so that middleware treats
 * it like an admin caller (see its own comment) rather than 401ing on the missing user.
 */

/** `/tasks/:id/attachments` — mounted at `/tasks`, after routes/tasks.ts, which has no
 *  `/:id/attachments` route: a three-segment path its two-segment `/:id` cannot match. */
export const taskScopedAttachmentRoutes = Router();
/** `/attachments` + `/attachments/:attachmentId` — mounted at `/attachments`. */
export const attachmentRoutes = Router();

taskScopedAttachmentRoutes.use(authenticateAgentOrUser);
attachmentRoutes.use(authenticateAgentOrUser);

// Multer memory storage — bytes never touch disk; the service persists them straight
// into `task_attachments.data`. `limits.fileSize` is the FIRST line of defense against
// an oversize upload (multer aborts the stream before it fully buffers); the service's
// own `MAX_ATTACHMENT_BYTES` check is the second, in case a caller ever calls
// TaskAttachmentService.create directly without going through this multer config.
// `defParamCharset: 'utf8'`: busboy decodes an un-encoded multipart `filename=` as latin1
// by default, so a browser-sent Japanese/emoji name arrived as mojibake and was stored
// that way (the reviewer #4a). Browsers send the raw UTF-8 bytes; tell busboy so.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_ATTACHMENT_BYTES },
  defParamCharset: 'utf8',
});

// Authorize the TASK id (`:id`) wherever it appears as a path param on its router.
taskScopedAttachmentRoutes.param('id', authorizeTaskIdParam);
// Authorize the ATTACHMENT id (`:attachmentId`) wherever it appears on its router.
attachmentRoutes.param('attachmentId', authorizeAttachmentIdParam);

/**
 * Adapts multer's own thrown errors (oversize file -> LIMIT_FILE_SIZE) into this API's
 * 413 shape, so a request that fails multer's OWN size guard gets the same
 * `ATTACHMENT_TOO_LARGE` body the service-level check produces for any other caller —
 * one contract regardless of which layer caught the oversize file.
 */
function handleUploadErrors(err: unknown, _req: Request, res: Response, next: NextFunction): void {
  if (err instanceof MulterError && err.code === 'LIMIT_FILE_SIZE') {
    res.status(413).json({ code: 'ATTACHMENT_TOO_LARGE', maxBytes: MAX_ATTACHMENT_BYTES });
    return;
  }
  if (err instanceof MulterError) {
    res.status(400).json({ success: false, error: 'Upload error', message: err.message });
    return;
  }
  next(err);
}

/**
 * @swagger
 * /attachments:
 *   get:
 *     summary: Bulk-by-task-ids read of task attachment metadata (board fan-out fix)
 *     description: >
 *       Replaces a per-card `GET /tasks/:id/attachments` fan-out. Task ids outside the
 *       caller's resolved project scope are silently OMITTED from the result, not
 *       403'd, so one foreign id cannot fail the whole board fetch.
 *     tags: [Task Attachments]
 *     parameters:
 *       - in: query
 *         name: taskIds
 *         required: false
 *         schema:
 *           type: string
 *         description: Comma-separated task UUIDs, max 100
 *     responses:
 *       200:
 *         description: Attachment metadata (no bytes) for the requested task ids, grouped flat and ordered by task_id then created_at
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: object
 *                   properties:
 *                     attachments:
 *                       type: array
 *                       items:
 *                         $ref: '#/components/schemas/TaskAttachment'
 *       400:
 *         description: Malformed taskIds, or more than 100 ids
 */
// `GET /attachments` (bare) and `GET /attachments/:attachmentId` cannot collide: the param
// route needs a non-empty segment. So this needs no registration-order discipline either.
attachmentRoutes.get('/', TaskAttachmentController.bulkList);

/**
 * @swagger
 * /tasks/{id}/attachments:
 *   post:
 *     summary: Upload an attachment for a task (before screenshot or evidence image)
 *     tags: [Task Attachments]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               file:
 *                 type: string
 *                 format: binary
 *               kind:
 *                 type: string
 *                 enum: [before, evidence]
 *                 default: before
 *             required: [file]
 *     responses:
 *       201:
 *         description: Attachment stored
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   $ref: '#/components/schemas/TaskAttachment'
 *       404:
 *         description: Task not found
 *       413:
 *         description: File exceeds the 5 MiB cap
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/TaskAttachmentTooLargeError'
 *       415:
 *         description: Mime type not in the allowlist
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/TaskAttachmentTypeRejectedError'
 */
taskScopedAttachmentRoutes.post(
  '/:id/attachments',
  declareAnyAuthenticatedMayWrite('filing a task attachment is additive; capped at 5 MiB and mime-allowlisted'),
  upload.single(UPLOAD_FIELD_NAME),
  handleUploadErrors,
  TaskAttachmentController.upload
);

/**
 * @swagger
 * /tasks/{id}/attachments:
 *   get:
 *     summary: List attachments for a task
 *     tags: [Task Attachments]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: Attachments for the task, no bytes included
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: object
 *                   properties:
 *                     attachments:
 *                       type: array
 *                       items:
 *                         $ref: '#/components/schemas/TaskAttachment'
 */
taskScopedAttachmentRoutes.get('/:id/attachments', TaskAttachmentController.list);

/**
 * @swagger
 * /attachments/{attachmentId}:
 *   get:
 *     summary: Get an attachment's raw bytes
 *     tags: [Task Attachments]
 *     parameters:
 *       - in: path
 *         name: attachmentId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: The attachment bytes, Content-Type set to the stored mime
 *         content:
 *           application/octet-stream:
 *             schema:
 *               type: string
 *               format: binary
 *       404:
 *         description: Attachment not found
 */
attachmentRoutes.get('/:attachmentId', TaskAttachmentController.getBytes);

/**
 * @swagger
 * /attachments/{attachmentId}:
 *   delete:
 *     summary: Delete an attachment
 *     tags: [Task Attachments]
 *     parameters:
 *       - in: path
 *         name: attachmentId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       204:
 *         description: Deleted
 *       404:
 *         description: Attachment not found
 */
attachmentRoutes.delete(
  '/:attachmentId',
  declareAnyAuthenticatedMayWrite('deleting ONE attachment row — the underlying task/task history is untouched'),
  TaskAttachmentController.remove
);

