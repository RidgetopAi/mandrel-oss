/**
 * Task attachment types (lane B). A punch carries images: `before`
 * (what the operator photographed when filing it) and `evidence` (what the Walkthrough critic
 * uploads when it is proven). Served by `/api/tasks/:id/attachments` + `/api/attachments/:id`.
 */
export type AttachmentKind = 'before' | 'evidence';

export interface TaskAttachment {
  id: string;
  taskId: string;
  kind: AttachmentKind;
  filename: string;
  mime: string;
  byteSize: number;
  createdAt: string;
  /**
   * The bytes' path. NOT usable as an `<img src>` directly — the route is bearer-authed and
   * the token never goes in a query string — so images render via `useAuthedImage`, which
   * fetches through the shared axios instance and hands back an object URL.
   */
  url: string;
}
