/**
 * attachments domain — the punch-list image attachments (lane B's
 * contract). All Command backend:
 *
 *   POST   /api/tasks/:id/attachments   multipart `file` (+ optional `kind`)  → 201 attachment
 *   GET    /api/tasks/:id/attachments                                          → { attachments }
 *   GET    /api/attachments?taskIds=a,b,…  (max 100 ids; out-of-scope ids omitted) → { attachments }
 *   GET    /api/attachments/:id                                                → image bytes
 *   DELETE /api/attachments/:id                                                → 204
 *
 * Errors the UI branches on: 413 `ATTACHMENT_TOO_LARGE`, 415 `ATTACHMENT_TYPE_REJECTED` —
 * both arrive on the shared interceptor's `ApiError.code`.
 *
 * The bytes ride the SAME axios instance as everything else (bearer + correlation id +
 * the discriminating 401), as a `blob`. That is what lets an `<img>` show an authed image
 * without ever putting the token in a URL — see hooks/useAuthedImage.
 */
import { http, unwrapData, type ApiEnvelope } from '../request';
import type { AxiosRequestConfig } from 'axios';
import type { TaskAttachment, AttachmentKind } from '../../types/attachment';

/** The multipart field names lane B reads. Named once here, never inlined. */
export const ATTACHMENT_FORM_FIELDS = {
  file: 'file',
  kind: 'kind',
} as const;

/**
 * The bulk read's server-side cap on `ids` per request (lane B). A board with more punch
 * cards than this is read in chunks of exactly this size; named once here.
 */
export const ATTACHMENTS_BULK_MAX_IDS = 100;

export const attachmentsApi = {
  /**
   * GET /api/attachments?taskIds=… — ONE read for a whole board (lane B's bulk route; on
   * the `/attachments` prefix so no `/tasks/:id` route can capture it — Reviewer #1).
   * Flat list ordered by taskId then createdAt; a task id outside the caller's project
   * scope is silently omitted, so an absent task is NOT an error and never throws.
   * Chunked at `ATTACHMENTS_BULK_MAX_IDS` transparently; `[]` for no ids (no request).
   */
  async listForTasks(taskIds: ReadonlyArray<string>, config?: AxiosRequestConfig): Promise<TaskAttachment[]> {
    const out: TaskAttachment[] = [];
    for (let i = 0; i < taskIds.length; i += ATTACHMENTS_BULK_MAX_IDS) {
      const chunk = taskIds.slice(i, i + ATTACHMENTS_BULK_MAX_IDS);
      // eslint-disable-next-line no-await-in-loop
      const body = await http.get<ApiEnvelope<{ attachments?: TaskAttachment[] }>>(
        '/attachments',
        { ...config, params: { ...(config?.params ?? {}), taskIds: chunk.join(',') } }
      );
      const data = unwrapData(body, 'Failed to list attachments for tasks');
      out.push(...((data?.attachments ?? []) as TaskAttachment[]));
    }
    return out;
  },

  /** GET /api/tasks/:id/attachments — un-nests `data.attachments`; `[]` is an honest empty. */
  async list(taskId: string, config?: AxiosRequestConfig): Promise<TaskAttachment[]> {
    const body = await http.get<ApiEnvelope<{ attachments?: TaskAttachment[] }>>(
      `/tasks/${encodeURIComponent(taskId)}/attachments`,
      config
    );
    const data = unwrapData(body, 'Failed to list attachments');
    return (data?.attachments ?? []) as TaskAttachment[];
  },

  /**
   * POST /api/tasks/:id/attachments — one file per request, multipart. The shared
   * instance's default `Content-Type: application/json` is overridden to let the browser
   * set the multipart boundary itself (an explicit multipart header without a boundary is
   * rejected by every parser). Tolerates BOTH an enveloped `{ data: { attachment } }` and a
   * raw attachment body, since lane B's 201 shape is documented as the bare object.
   */
  async upload(
    taskId: string,
    file: Blob,
    kind?: AttachmentKind,
    config?: AxiosRequestConfig
  ): Promise<TaskAttachment> {
    const form = new FormData();
    const filename = (file as File).name || 'photo.jpg';
    form.append(ATTACHMENT_FORM_FIELDS.file, file, filename);
    if (kind) form.append(ATTACHMENT_FORM_FIELDS.kind, kind);
    const body = await http.post<ApiEnvelope<{ attachment?: TaskAttachment } | TaskAttachment>>(
      `/tasks/${encodeURIComponent(taskId)}/attachments`,
      form,
      { ...config, headers: { ...(config?.headers ?? {}), 'Content-Type': undefined } }
    );
    const data = unwrapData(body, 'Failed to upload attachment') as
      | { attachment?: TaskAttachment }
      | TaskAttachment
      | undefined;
    const attachment =
      data && 'attachment' in data && data.attachment ? data.attachment : (data as TaskAttachment);
    if (!attachment || !attachment.id) {
      throw new Error('Attachment payload missing in response');
    }
    return attachment;
  },

  /** GET /api/attachments/:id — the image bytes, authed, as a Blob for an object URL. */
  async blob(id: string, config?: AxiosRequestConfig): Promise<Blob> {
    return http.get<Blob>(`/attachments/${encodeURIComponent(id)}`, {
      ...config,
      responseType: 'blob',
    });
  },

  /** DELETE /api/attachments/:id → 204 (no body; nothing to unwrap). */
  async remove(id: string, config?: AxiosRequestConfig): Promise<void> {
    await http.del<unknown>(`/attachments/${encodeURIComponent(id)}`, config);
  },
};

export type AttachmentsApi = typeof attachmentsApi;
