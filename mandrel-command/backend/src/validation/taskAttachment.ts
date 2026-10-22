/**
 * Validation for the Punch List attachment surface (Lane B).
 * NEW FILE — deliberately not added to `validation/schemas.ts`'s SchemaRegistry
 * (lane A's file); this surface is multipart, not JSON body, so the generic
 * `validateBody` middleware doesn't apply here anyway.
 */

import { z } from 'zod';
import {
  ATTACHMENT_KINDS,
  AttachmentKind,
  DEFAULT_ATTACHMENT_FILENAME,
  DEFAULT_ATTACHMENT_KIND,
  MAX_ATTACHMENT_FILENAME_CHARS,
  MAX_ATTACHMENT_FILENAME_EXT_CHARS,
  MAX_BULK_ATTACHMENT_IDS,
} from '../config/taskAttachments';
import { isValidUuid } from '../utils/uuid';

const KindSchema = z.enum(ATTACHMENT_KINDS);

/** Parse the optional multipart `kind` field. Invalid values are REJECTED (400), not
 *  silently coerced to the default — an explicit-but-wrong `kind` is a caller bug worth
 *  surfacing, unlike an absent one. */
export function parseAttachmentKind(raw: unknown): { ok: true; kind: AttachmentKind } | { ok: false; message: string } {
  if (raw === undefined || raw === null || raw === '') {
    return { ok: true, kind: DEFAULT_ATTACHMENT_KIND };
  }
  const result = KindSchema.safeParse(raw);
  if (!result.success) {
    return { ok: false, message: `kind must be one of: ${ATTACHMENT_KINDS.join(', ')}` };
  }
  return { ok: true, kind: result.data };
}

/**
 * Parse the bulk-read `taskIds` query param: a comma-separated list of task UUIDs.
 *  - absent/empty -> ok, empty array (the caller asked for nothing; the route
 *    returns an empty `attachments: []` rather than 400ing a degenerate call)
 *  - any malformed UUID -> 400 (mirrors the single-id 400 shape used everywhere else
 *    on this surface — a shape error, not a lookup failure)
 *  - more than MAX_BULK_ATTACHMENT_IDS -> 400, never silently truncated (a silent
 *    truncation would make the board's later ids invisible without a signal why)
 */
export function parseBulkAttachmentIds(
  raw: unknown
): { ok: true; ids: string[] } | { ok: false; message: string } {
  if (raw === undefined || raw === null || raw === '') {
    return { ok: true, ids: [] };
  }
  if (typeof raw !== 'string') {
    return { ok: false, message: 'taskIds must be a comma-separated string of UUIDs' };
  }
  const parts = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  if (parts.length > MAX_BULK_ATTACHMENT_IDS) {
    return { ok: false, message: `taskIds must name at most ${MAX_BULK_ATTACHMENT_IDS} ids (got ${parts.length})` };
  }
  const invalid = parts.filter((id) => !isValidUuid(id));
  if (invalid.length > 0) {
    return { ok: false, message: `invalid UUID(s) in taskIds: ${invalid.slice(0, 5).join(', ')}` };
  }
  // De-duplicated, lowercased — matches how every other id lookup on this surface
  // normalizes before querying (see middleware/taskAttachmentAuthz.ts).
  return { ok: true, ids: [...new Set(parts.map((id) => id.toLowerCase()))] };
}

/**
 * The filename boundary. Everything that reaches `task_attachments.filename` passes
 * through here (the service calls it, so a direct service caller is covered too):
 *  - control characters (NUL, CR, LF, TAB, DEL, ...) are STRIPPED. A stored CR/LF made
 *    every later `GET /attachments/:id` for that row throw inside `res.set(...)` — a
 *    permanently unreadable attachment from one bad upload name (the reviewer #4c).
 *  - bounded to MAX_ATTACHMENT_FILENAME_CHARS code points, keeping a short extension,
 *    instead of letting pg's varchar(255) reject the INSERT as a 500 (#4b).
 *  - a name that sanitizes to nothing becomes DEFAULT_ATTACHMENT_FILENAME.
 * Non-ASCII is preserved as-is — multer is configured with `defParamCharset: 'utf8'` so
 * the name arrives decoded rather than as latin1 mojibake (#4a).
 */
export function sanitizeAttachmentFilename(raw: string | null | undefined): string {
  // eslint-disable-next-line no-control-regex
  const stripped = (raw ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (stripped.length === 0) return DEFAULT_ATTACHMENT_FILENAME;

  // Code points, not UTF-16 units: varchar(n) counts characters, and slicing a string by
  // index would split a surrogate pair (an emoji) in half at the boundary.
  const chars = Array.from(stripped);
  if (chars.length <= MAX_ATTACHMENT_FILENAME_CHARS) return stripped;

  const dot = chars.lastIndexOf('.');
  const extChars = dot > 0 ? chars.slice(dot) : [];
  const ext = extChars.length > 1 && extChars.length <= MAX_ATTACHMENT_FILENAME_EXT_CHARS ? extChars : [];
  const base = chars.slice(0, MAX_ATTACHMENT_FILENAME_CHARS - ext.length);
  return base.join('') + ext.join('');
}
