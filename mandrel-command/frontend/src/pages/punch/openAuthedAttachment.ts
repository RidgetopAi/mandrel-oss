/**
 * openAuthedAttachment — fetch an attachment's bytes through the authed client and open
 * them full-size in a new tab as an object URL. NEVER a bearer token in a URL. Shared by
 * AuthedFileTile (non-image attachments) and AuthedImage's gallery click-to-open, so the
 * "open full size" mechanism is defined exactly once (an earlier decision / an earlier task —
 * a gallery image previously had no click target at all).
 */
import { api } from '../../api';

/** How long the object URL stays valid after the new tab was handed it. */
const OPENED_URL_TTL_MS = 60_000;

export async function openAuthedAttachment(attachmentId: string): Promise<void> {
  const blob = await api.attachments.blob(attachmentId);
  const url = URL.createObjectURL(blob);
  window.open(url, '_blank', 'noopener');
  window.setTimeout(() => URL.revokeObjectURL(url), OPENED_URL_TTL_MS);
}

export default openAuthedAttachment;
