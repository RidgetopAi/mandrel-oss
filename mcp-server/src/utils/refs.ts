/**
 * Named refs (`ref:<slug>`) — first-class grammar + helpers.
 *
 * A `ref:<slug>` tag is a memorable, human-friendly pointer to a context (or a
 * thread of contexts). It is resolved by a tags-only `context_search` —
 * `context_search({ tags: ["ref:<slug>"] })` — which filters by the tag and orders
 * newest-first, so a MOVING ref (a slug carried by successive contexts, e.g.
 * `ref:resume`) resolves to the LATEST context, while a PINNED ref (carried by a
 * single context, e.g. `ref:cp-gaps`) resolves to that one thread.
 *
 * This module is the single source of truth for the ref GRAMMAR. It is used at the
 * write boundary (context_store) to validate/normalize ref tags so a typo'd or
 * garbage ref can never silently break resolution, and it is safe to reuse anywhere
 * a ref needs to be recognized or parsed.
 *
 * DESIGN — warn & normalize, never hard-reject:
 *   - We do NOT reject a context_store that carries a malformed ref tag (that would
 *     be a regression risk against existing callers and could lose a user's content).
 *   - We DO normalize the salvageable common cases (trim, lowercase, collapse
 *     whitespace/underscores to a single hyphen) so `ref:My Resume` becomes a valid
 *     `ref:my-resume`, and we RETURN a warning describing what we changed or what we
 *     could not fix. Non-ref tags pass through completely untouched.
 */

/** The canonical ref slug grammar: lowercase alphanumerics and single hyphens. */
export const REF_PREFIX = 'ref:';
export const REF_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** Matches a tag that CLAIMS to be a ref (prefix only) regardless of slug validity. */
const REF_TAG_PREFIX = /^ref:/i;

export interface RefValidation {
  /** The tags after normalization (non-ref tags untouched, ref tags normalized where possible). */
  tags: string[];
  /**
   * Human-readable warnings for ref tags that were normalized or are still invalid.
   * Empty when every ref tag was already well-formed (or there were no ref tags).
   */
  warnings: string[];
}

/** True if the tag claims to be a ref (`ref:` prefix), regardless of slug validity. */
export function isRefTag(tag: string): boolean {
  return REF_TAG_PREFIX.test(tag.trim());
}

/** True if the tag is a WELL-FORMED ref (`ref:` + a valid slug). */
export function isValidRefTag(tag: string): boolean {
  if (!isRefTag(tag)) return false;
  return REF_SLUG_PATTERN.test(tag.trim().slice(REF_PREFIX.length));
}

/**
 * Extract the slug from a ref tag (`ref:resume` → `resume`), or `null` if it is not
 * a ref tag. Does not validate the slug — use isValidRefTag for that.
 */
export function parseRefSlug(tag: string): string | null {
  const t = tag.trim();
  if (!REF_TAG_PREFIX.test(t)) return null;
  return t.slice(REF_PREFIX.length);
}

/**
 * Attempt to coerce a raw slug into the canonical grammar. Returns the normalized
 * slug, or `null` if there is nothing salvageable (e.g. empty, or no usable chars).
 *
 * Normalization: lowercase, trim, replace any run of non-[a-z0-9] characters with a
 * single hyphen, strip leading/trailing hyphens. This salvages the common human
 * inputs (`My Resume`, `cp_gaps`, `Audit/Retrieval`) into valid slugs without
 * silently mangling an already-valid slug (a valid slug is a fixed point here).
 */
export function normalizeRefSlug(rawSlug: string): string | null {
  const normalized = rawSlug
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (normalized.length === 0) return null;
  return normalized;
}

/**
 * Validate & normalize a tag array for ref grammar at the write boundary.
 *
 * - Non-ref tags pass through unchanged and in order.
 * - A well-formed ref tag passes through unchanged (no warning).
 * - A salvageable malformed ref tag is normalized in place AND a warning is emitted
 *   describing the rewrite (e.g. `ref:My Resume` → `ref:my-resume`).
 * - An unsalvageable ref tag (e.g. `ref:` or `ref:___`) is kept verbatim (we never
 *   drop a user's tag) but a warning flags it as a ref that will not resolve.
 *
 * This NEVER throws and NEVER rejects — it only normalizes + reports.
 */
export function validateAndNormalizeRefTags(tags: string[] | undefined): RefValidation {
  if (!tags || tags.length === 0) return { tags: tags ?? [], warnings: [] };

  const warnings: string[] = [];
  const out = tags.map((tag) => {
    if (!isRefTag(tag)) return tag; // non-ref → untouched
    if (isValidRefTag(tag)) return tag.trim(); // already well-formed (trim only)

    const rawSlug = parseRefSlug(tag) ?? '';
    const fixedSlug = normalizeRefSlug(rawSlug);
    if (fixedSlug && REF_SLUG_PATTERN.test(fixedSlug)) {
      const fixed = `${REF_PREFIX}${fixedSlug}`;
      warnings.push(
        `Normalized malformed ref "${tag}" → "${fixed}" (refs must match ${REF_PREFIX}[a-z0-9-]).`
      );
      return fixed;
    }
    // Unsalvageable — keep verbatim, but warn loudly that it will not resolve cleanly.
    warnings.push(
      `Tag "${tag}" looks like a ref but is not a valid ${REF_PREFIX}[a-z0-9-] slug; ` +
        `it was stored as-is and may not resolve via tags-only search.`
    );
    return tag;
  });

  return { tags: out, warnings };
}
