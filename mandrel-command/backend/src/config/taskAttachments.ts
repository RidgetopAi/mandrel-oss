/**
 * taskAttachments — named config for the Punch List attachment surface
 * (Lane B). configs-not-hardcoded: the size cap and the mime
 * allowlist are read from here everywhere they're needed (multer's own limit,
 * the mime-sniff check, the 413/415 error bodies, and migration 102's CHECK
 * constraint comment) rather than re-typed at each call site.
 */

/** Max bytes a single attachment may hold. Matches migration 102's `byte_size` CHECK. */
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024; // 5 MiB = 5242880

/** The two producers named in a phone-filed bug report, and a
 *  later reviewer/critic's evidence. */
export const ATTACHMENT_KINDS = ['before', 'evidence'] as const;
export type AttachmentKind = (typeof ATTACHMENT_KINDS)[number];
export const DEFAULT_ATTACHMENT_KIND: AttachmentKind = 'before';

/**
 * MIME allowlist. Images are verified by magic-byte sniff (see
 * `services/taskAttachment.ts#sniffImageMime`); `text/plain` and `application/json`
 * have no reliable magic-byte signature so they are accepted on the client-declared
 * type alone — same trust level the rest of this API already gives request bodies.
 */
export const ALLOWED_ATTACHMENT_MIMES = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'text/plain',
  'application/json',
] as const;
export type AllowedAttachmentMime = (typeof ALLOWED_ATTACHMENT_MIMES)[number];

/** MIME types whose bytes are sniffed rather than trusted from the client header. */
export const SNIFFABLE_IMAGE_MIMES: readonly AllowedAttachmentMime[] = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
];

/**
 * Max task ids the bulk read (`GET /attachments?taskIds=...`) accepts in one call —
 * the board's fan-out fix caps its own per-page card count at 40 (per the coordinator's
 * follow-up), so 100 leaves headroom without inviting an unbounded IN-list query.
 */
export const MAX_BULK_ATTACHMENT_IDS = 100;

/**
 * Max characters a stored filename may hold — migration 102's `filename varchar(255)`.
 * Postgres counts varchar(n) in CHARACTERS (code points), so the sanitizer bounds by
 * code point too; a longer name is truncated with its extension preserved rather than
 * surfacing pg's "value too long" as a 500.
 */
export const MAX_ATTACHMENT_FILENAME_CHARS = 255;

/** Longest suffix (`.ext`, dot included) the truncation treats as an extension worth
 *  preserving. A 100-character "extension" is not one — it is just more name. */
export const MAX_ATTACHMENT_FILENAME_EXT_CHARS = 16;

/** What an upload whose name sanitizes to nothing is stored as. */
export const DEFAULT_ATTACHMENT_FILENAME = 'attachment';
