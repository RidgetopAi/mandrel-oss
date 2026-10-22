/**
 * Named-ref (`ref:<slug>`) helpers for the Command UI.
 *
 * Mirrors the backend ref grammar (mcp-server/src/utils/refs.ts): a well-formed ref
 * is `ref:` + a lowercase-alphanumeric, single-hyphen slug. The reader uses this to
 * surface a context's named ref (the human-friendly, reusable handle, e.g. "ref:resume").
 */

/** Canonical ref slug grammar (must match the backend REF_SLUG_PATTERN). */
export const REF_TAG_REGEX = /^ref:[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** The first well-formed `ref:<slug>` tag on a context, or undefined. */
export function findRefTag(tags: string[] | undefined): string | undefined {
  return tags?.find((tag) => REF_TAG_REGEX.test(tag));
}

