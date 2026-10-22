/**
 * HANDOFF RESUME POINTER — guarantee the `ref:resume` tag on every stored handoff
 *. The rule + the strings live in
 * config/handoffResumePointerConfig.ts; this module is the only reader.
 *
 * THE CHOKE POINT. This runs inside ContextHandler.storeContext, immediately after
 * validateAndNormalizeTags and BEFORE the embedding text and the INSERT are built —
 * so the guaranteed tag is the tag that is indexed AND the tag that is stored AND the
 * tag reported back, with no third copy of the array anywhere. Every context_store,
 * whatever surface it arrived on (gateway action, flat tool, HTTP bridge), passes
 * through that one function; there is no second write path for a context.
 *
 * WHY AFTER NORMALIZATION, deliberately. refs.ts has already folded `ref:Resume`,
 * `ref: resume` and `ref:RESUME` onto the canonical `ref:resume` by this point, so the
 * idempotency check is an exact compare against a canonicalized array — a caller who
 * supplied the pointer in any accepted spelling sees exactly today's behaviour and
 * gets no duplicate. Adding BEFORE normalization would have made this module depend on
 * refs.ts's spelling rules a second time; one source, one pass.
 *
 * WHAT IT DOES NOT DO — and this is the deliberate scope boundary (task acceptance 5).
 * It never touches the PREVIOUS head's tags. `ref:` pointer semantics are NEWEST WINS
 * (utils/refs.ts; recallThread.ts:217; context.routes.ts:691) — a tags-only search
 * orders newest-first — so the stale head needs no un-tagging to stop winning, and
 * rewriting already-stored rows is a far larger blast radius (it would mutate records
 * a user wrote, break lineage reads that expect the tag they saw, and put a write
 * amplification on every handoff store). The pointer is guaranteed FORWARD only.
 *
 * It also never REJECTS and never drops or reorders a caller's other tags: it appends
 * at most one element, exactly like the warn-&-normalize contract the rest of the tag
 * path keeps.
 */

import {
  RESUME_POINTER_ADDED_NOTE,
  RESUME_POINTER_CONTEXT_TYPE,
  RESUME_POINTER_TAG,
} from '../config/handoffResumePointerConfig.js';

/** The honest report of what the resume-pointer layer did for one write. */
export interface ResumePointerReport {
  /** The tag this layer guarantees. Present so a machine reader needs no literal. */
  tag: string;
  /** True iff the SERVER appended the tag (false when the caller already supplied it). */
  added: boolean;
  /**
   * The caller-visible sentence when `added` is true, else null. Surfaced in the
   * store response's tag notes so a server-side mutation of a caller's data is never
   * silent (task acceptance 3).
   */
  note: string | null;
}

/**
 * Ensure the resume pointer is present on a handoff's tags.
 *
 * @param contextType the type as it will be written (only `handoff` is affected).
 * @param normalizedTags the ref+threading-normalized tags for this write.
 * @returns the tags to store (identical array contents unless the tag was appended)
 *          and the report. Returns `null` for every non-handoff type — a `type:context`
 *          store gains nothing and reports nothing.
 */
export function ensureResumePointer(
  contextType: string,
  normalizedTags: string[]
): { tags: string[]; report: ResumePointerReport | null } {
  if (contextType !== RESUME_POINTER_CONTEXT_TYPE) {
    return { tags: normalizedTags, report: null };
  }
  if (normalizedTags.includes(RESUME_POINTER_TAG)) {
    return {
      tags: normalizedTags,
      report: { tag: RESUME_POINTER_TAG, added: false, note: null },
    };
  }
  return {
    tags: [...normalizedTags, RESUME_POINTER_TAG],
    report: { tag: RESUME_POINTER_TAG, added: true, note: RESUME_POINTER_ADDED_NOTE },
  };
}
