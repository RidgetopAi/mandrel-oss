/**
 * Threading tag grammar — first-class validation for the record-linking convention.
 *
 * The record-linking model (mandrel-record-linking-convention) threads
 * tasks↔contexts↔decisions into one searchable story using a small, fixed tag
 * grammar. Historically that grammar was a HAND-MAINTAINED convention with no
 * machine validation for the threading prefixes — a typo (`task:9e25` instead of
 * `task:an earlier change`, `scope:prod` instead of `scope:product`) would silently store a
 * tag that never joins, quietly breaking the thread. `ref:` was made first-class in
 * an earlier change (see ./refs.ts); this module extends that exact approach — WARN & NORMALIZE,
 * NEVER reject/drop — to the rest of the threading prefixes so threading is consistent
 * and self-documenting end-to-end.
 *
 * This module is the single source of truth for the THREADING grammar. It is used at
 * the write boundary (context_store) AFTER ref normalization, so a context's tags are
 * validated for BOTH ref grammar and threading grammar in one pass.
 *
 * THE PREFIXES (canonical — mirrors the record-linking convention memory):
 *   task:<id8>        — context belongs to this task's thread (8 lowercase hex).
 *   decision:<id8>    — record ladders up to this decision (8 lowercase hex).
 *   context:<id8|uuid> — a record points to a context (8 lowercase hex, or a full UUID).
 *   scope:<value>     — lens axis; company work vs product work.
 *   owner:<value>     — lens axis; the department that owns it.
 *   tranche:<value>   — lens axis; the build risk class.
 *   component:<value> — lens axis; which component of the company-map registry.
 *   actor:<value>     — lens axis; which registered actor (agent/human/automation).
 *   batch:<value>     — lens axis; which batch/phase label.
 *
 * THE LENS AXES AND THEIR VALUES ARE NOT DECLARED HERE. They live in
 * `config/threadingVocabConfig.ts` (LENS_AXES) — this module owns the GRAMMAR, that file
 * owns the VOCABULARY, and the prefix table below is BUILT from it so there is no second
 * list to keep in step. Three axes were added there by an earlier decision after measuring
 * 257 out-of-set values on prod that turned out to be right values on missing axes.
 *
 * DESIGN — warn & normalize & QUARANTINE, never hard-reject (contract preserved from refs.ts):
 *   - We NEVER reject a context_store carrying a malformed threading tag (that would
 *     be a regression against existing callers and could lose a user's content).
 *   - We normalize the salvageable common cases (trim, lowercase) so `Task:9E25F00D`
 *     becomes `task:an earlier change`, and RETURN a warning describing what changed.
 *   - An unsalvageable value is QUARANTINED (see below), never dropped, and warned about.
 *
 * ═══ WHY QUARANTINE, AND WHY NOT REJECTION ═══════════════════
 * This module used to keep an invalid threading value VERBATIM and merely warn. That is
 * the worst of the three available behaviours, and it shipped a live defect: a record
 * tagged `scope:mandrel` carries a tag that READS like a threading tag, SORTS like one,
 * DISPLAYS like one, and threads nothing — while the only signal saying so is a warning
 * in a 200-response body that no human reads on a successful call. The author is told;
 * every LATER reader is misled, permanently, by a tag that looks authoritative.
 *
 * The obvious fix — reject the write — is NOT available here, and that is a measured
 * constraint rather than a preference. `src/tests/tagValidationWritePaths.contract.test.ts`
 * asserts, deliberately and with its reasoning written out, that these writes SUCCEED and
 * the tag SURVIVES: this validator reaches every customer at once inside a schema
 * migration, so a new rejection would fail writes that have always been accepted, in the
 * worst possible packaging. That contract is unchanged by this change and still asserted.
 *
 * So the tag is neither kept-as-is nor rejected: it is REWRITTEN into a form that cannot
 * be mistaken for a working threading tag. `scope:mandrel` is stored as
 * `invalid-scope:mandrel` — which no longer wears a threading prefix (`matchedPrefix`
 * anchors with startsWith, so the quarantined form matches nothing), states its own
 * status to any later reader in the tag text itself, keeps the author's original value
 * fully recoverable, and is idempotent: re-writing a record's tags does not re-prefix it.
 * The write still succeeds and the warning still fires; what changes is that the
 * MISLEADING ARTEFACT is gone from the row, which is the half of the defect that outlives
 * the request.
 */

import { isRefTag, validateAndNormalizeRefTags } from './refs.js';
import { isUuidOrShortId } from './idResolver.js';
import { LENS_AXES } from '../config/threadingVocabConfig.js';

/**
 * THE ID GRAMMAR FOR `task:` / `decision:` / `context:` IS THE RESOLVER'S, NOT A COPY.
 *
 * This module used to carry its own `/^[0-9a-f]{8}$/` (and, for `context:`, a full-UUID
 * regex). Under warn-and-store that private copy was harmless: a value the copy called
 * invalid was still STORED VERBATIM, so `config/tagEdgeConfig.ts` still handed it to
 * `utils/idResolver.ts`, and the resolver — which accepts a full UUID or ANY 8+-hex short
 * id (`isUuidOrShortId`) — still minted the edge. The copy produced a spurious warning and
 * nothing else.
 *
 * QUARANTINE MADE THE COPY LOAD-BEARING, and then it dropped real links. A quarantined tag
 * no longer wears its prefix, so `tagToEdgeIntent` stops matching it and the edge is never
 * attempted. Every form the copy called invalid AND the resolver called valid became a
 * silently-unthreaded write. MEASURED on this ref against a real in-project task
 * (`460fd070-0f8d-4d31-9d78-72ae4d1e3a01`), one context_store per form, reading `links`:
 *
 *   task:an earlier change                            -> stored as-is            edge minted: 1
 *   task:460fd0700          (9 hex)          -> invalid-task:460fd0700  edge minted: 0
 *   task:460fd0700f8d       (12 hex)         -> invalid-task:...        edge minted: 0
 *   task:460fd070-0f8d-...  (the FULL uuid)  -> invalid-task:...        edge minted: 0
 *
 * The last row is the one that matters, because the FULL UUID IS THE REMEDY THE PRODUCT
 * ITSELF HANDS THE USER. `services/links.ts` answers a cross-project reference with
 * "Re-tag with the FULL uuid (task:<uuid>) to link across projects", and
 * `src/tests/refScopeHonesty.contract.test.ts` asserts that message. Following that
 * instruction produced a quarantined tag and no edge.
 *
 * This is the SAME defect the `context:` prefix was repaired for in 8f65f00 (45 prod
 * records would have stopped threading); `task:` and `decision:` carried it too and were
 * not widened with it. The fix is not a third hand-written pattern — it is to stop having
 * a second answer at all (and CLASSES.md C5's "two copies of one list"): a
 * threading id value is well-formed exactly when the resolver that will consume it says so.
 *
 * WHAT THIS DELIBERATELY DOES NOT MAKE LEGAL: `isUuidOrShortId` requires hex (hyphens
 * stripped) and >= 8 chars, so `task:nothex!!`, `task:9e25` and an empty value are still
 * unusable and still quarantined — the values quarantine was built for are untouched.
 */
const isThreadingIdValue = (v: string): boolean => isUuidOrShortId(v);

/**
 * THE QUARANTINE MARKER — prepended to a threading tag whose value is unsalvageable.
 *
 * Lives here because this module documents itself as the single source of truth for the
 * threading grammar, and this marker IS part of that grammar: it is the one spelling that
 * means "this wore a threading prefix and the value was not usable".
 *
 * REQUIRED PROPERTIES, each of which the guard exercises:
 *   1. It must not itself begin any known threading prefix, or quarantining would be
 *      non-idempotent (`invalid-invalid-scope:...` on every re-tag).
 *   2. It must be readable in the tag text, because the reader it protects is a HUMAN
 *      scanning a record's tags, not a program.
 *   3. It must preserve the author's original value verbatim after it, so nothing the
 *      caller wrote is destroyed and a retag can recover the intent.
 */
export const THREADING_QUARANTINE_PREFIX = 'invalid-';

/**
 * The threading prefixes this module validates, each with a validator over the value
 * AFTER lowercase-trim normalization. `ref:` is intentionally NOT here — it is owned by
 * refs.ts and validated separately (this module composes with it).
 */
type PrefixSpec = {
  /** The tag prefix including the trailing colon, e.g. `task:`. */
  prefix: string;
  /** A human description of the expected value form, for warnings. */
  expects: string;
  /** True if the (already lowercased+trimmed) value is well-formed. */
  isValid: (value: string) => boolean;
};

const ID_EXPECTS = 'an id8 or a full UUID — 8+ hex characters, the form the id resolver accepts';

/**
 * The ID-BEARING prefixes — the ones `config/tagEdgeConfig.ts` turns into edges. Their
 * value grammar is the resolver's (see isThreadingIdValue above), never a private copy.
 */
const ID_PREFIXES: PrefixSpec[] = [
  { prefix: 'task:', expects: `${ID_EXPECTS} (task:<id8|uuid>)`, isValid: isThreadingIdValue },
  { prefix: 'decision:', expects: `${ID_EXPECTS} (decision:<id8|uuid>)`, isValid: isThreadingIdValue },
  // All three id-bearing prefixes share ONE predicate on purpose. `context:` was widened
  // alone in 8f65f00 (a hand-written UUID-only pattern quarantined `context:<id8>`, which
  // mints edges and appears on 45 prod records); `task:`/`decision:` carried the same shape
  // of defect and are repaired here by removing the private copy rather than adding a third.
  { prefix: 'context:', expects: `${ID_EXPECTS} (context:<id8|uuid>)`, isValid: isThreadingIdValue },
];

/**
 * The full prefix table: the id-bearing prefixes plus every LENS AXIS declared in
 * `config/threadingVocabConfig.ts`. A LensAxisSpec is structurally a PrefixSpec with the
 * closed set attached, so the axes are spread in rather than re-typed — adding an axis is
 * a one-file change in the config and this module needs no edit at all.
 */
const THREADING_PREFIXES: PrefixSpec[] = [...ID_PREFIXES, ...LENS_AXES];

export interface TagValidation {
  /** Tags after normalization (ref + threading tags normalized where possible; others untouched). */
  tags: string[];
  /**
   * Human-readable warnings for ref/threading tags that were normalized or are still
   * invalid. Empty when every recognized tag was already well-formed.
   */
  warnings: string[];
}

/** The threading prefix this tag claims (case-insensitive), or null if it claims none. */
function matchedPrefix(tag: string): PrefixSpec | null {
  const lower = tag.trim().toLowerCase();
  return THREADING_PREFIXES.find(p => lower.startsWith(p.prefix)) ?? null;
}

/** True if the tag claims a known threading prefix (regardless of value validity). */
export function isThreadingTag(tag: string): boolean {
  return matchedPrefix(tag) !== null;
}

/**
 * Validate + normalize ONE threading tag. Returns the (possibly normalized) tag and an
 * optional warning. Normalization is conservative: lowercase + trim only — we never
 * guess a value (e.g. we do NOT try to expand `scope:prod` → `scope:product`), because
 * a wrong guess would corrupt the link silently. A still-invalid value is kept verbatim
 * with a warning.
 */
function normalizeThreadingTag(tag: string, spec: PrefixSpec): { tag: string; warning?: string } {
  const trimmed = tag.trim();
  const rawValue = trimmed.slice(spec.prefix.length);
  const normalizedValue = rawValue.trim().toLowerCase();
  const normalizedTag = `${spec.prefix}${normalizedValue}`;

  if (spec.isValid(normalizedValue)) {
    // Well-formed after the cheap normalization. Warn ONLY if normalization changed
    // the tag (so a clean tag is silent, a case/whitespace fix is reported).
    if (normalizedTag !== trimmed) {
      return {
        tag: normalizedTag,
        warning: `Normalized threading tag "${tag}" → "${normalizedTag}".`,
      };
    }
    return { tag: normalizedTag };
  }

  // Unsalvageable value: QUARANTINE it. The write still succeeds and the tag is still
  // stored (never dropped, never rejected) — but in a form that cannot be mistaken for a
  // working threading tag by the readers who come after the author. See the module header.
  const quarantined = `${THREADING_QUARANTINE_PREFIX}${normalizedTag}`;
  return {
    tag: quarantined,
    warning:
      `Tag "${tag}" uses the "${spec.prefix}" threading prefix but its value is not ` +
      `${spec.expects}; it does not thread, so it was stored as "${quarantined}" rather ` +
      `than as a threading tag. Nothing was rejected or dropped — re-tag with a valid ` +
      `value to thread it.`,
  };
}

/**
 * Validate & normalize a tag array for the FULL linking grammar at the write boundary.
 *
 * Order of operations (composition, not duplication):
 *   1. Ref grammar (ref:<slug>) via refs.ts — unchanged behavior.
 *   2. Threading grammar (task:/decision:/context:/scope:/owner:/tranche:) here.
 *   3. Everything else passes through untouched.
 *
 * NEVER throws, NEVER rejects, NEVER drops a tag — it normalizes, QUARANTINES an
 * unsalvageable threading value (see THREADING_QUARANTINE_PREFIX), and reports. The
 * combined warnings preserve ref-first ordering.
 */
export function validateAndNormalizeTags(tags: string[] | undefined): TagValidation {
  // 1. Ref grammar first (owned by refs.ts).
  const refResult = validateAndNormalizeRefTags(tags);
  const warnings = [...refResult.warnings];

  // 2. Threading grammar over the ref-normalized tags. A ref tag is never also a
  //    threading tag (distinct prefixes), so this pass leaves ref tags alone.
  const out = refResult.tags.map(tag => {
    if (isRefTag(tag)) return tag; // already handled by refs.ts
    const spec = matchedPrefix(tag);
    if (!spec) return tag; // not a threading tag → untouched
    const { tag: normalized, warning } = normalizeThreadingTag(tag, spec);
    if (warning) warnings.push(warning);
    return normalized;
  });

  return { tags: out, warnings };
}

/**
 * True if this tag is a QUARANTINED threading tag — i.e. it was written wearing a
 * threading prefix with a value the grammar could not use. Exported so a consumer can
 * SELECT the population (a retag report, a data-quality finding) without re-deriving the
 * marker; a second hand-written copy of `'invalid-'` is the drift this repo keeps killing.
 */
export function isQuarantinedThreadingTag(tag: string): boolean {
  const lower = tag.trim().toLowerCase();
  if (!lower.startsWith(THREADING_QUARANTINE_PREFIX)) return false;
  return matchedPrefix(lower.slice(THREADING_QUARANTINE_PREFIX.length)) !== null;
}
