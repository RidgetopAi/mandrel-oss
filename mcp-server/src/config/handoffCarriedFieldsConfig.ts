/**
 * HANDOFF CARRIED FIELDS — `mode` and `spine` as SCHEMA, not as prose (P5.4).
 * Scope: riverbend/reports/artifacts/p5-briefing-parity/SCOPE.md §2 P5.4.
 *
 * ═══ THE DEFECT THIS CONFIGURES AGAINST ═════════════════════════════════════════════════
 * The two highest-load lines in a boot document —
 *
 *     MODE: build — …what we are doing, and what NOT to do…
 *     PATH: roots → tree:canonical → trunk(@x) ⟶ branch:y (spine an earlier task)
 *
 * — are recovered by a REGEX over the free-text body of a handoff. That works for exactly
 * one corpus: ours,
 * because we invented the convention and we write it by hand.
 *
 * MEASURED, 2026-08-23, rendering our own boot package against a FOREIGN project: MODE and
 * PATH both came back "(none recorded)", the branch walk came back "NOT WALKED", and the
 * blocked-on-human section matched "0 of 0". It degraded HONESTLY — it never fabricated —
 * but the two most valuable sections of the document were empty. That is what a customer
 * gets today, permanently, and a section that is ALWAYS empty is worse than an absent one:
 * it teaches the reader to skip that part of the page.
 *
 * A CONFIGURABLE REGEX DOES NOT FIX THIS, and that is the whole reason this file exists
 * rather than a `MANDREL_MODE_PATTERN` env var. Making the parser configurable makes the
 * PARSER configurable; it does not make the DATA present. No customer writes `MODE:` in
 * prose, in any spelling, so no pattern reaches it. The fix has to move the convention into
 * the write path — the caller declares the field, the server stores it, the renderer reads
 * a field instead of guessing at a sentence.
 *
 * ═══ WHERE IT IS STORED, AND WHY THERE ══════════════════════════════════════════════════
 * `contexts.metadata` (jsonb, already exists — P5.4 forbids a new column and is right to:
 * two optional string fields do not earn a migration across 8 instances), under ONE
 * reserved namespace object:
 *
 *     {"handoff": {"mode": "build", "spine": "b341f00d"}}
 *
 * Namespaced rather than top-level `metadata.mode` deliberately. `metadata` is a free-form
 * object the CALLER owns and `context_update` MERGES into — a customer using `mode` for
 * their own purposes would silently start driving our renderer. One reserved key, stated in
 * the tool description, is the smallest surface that cannot collide by accident.
 *
 * ═══ THE MODE VOCABULARY — THE DECISION, AND ITS REASONING ══════════════════════════════
 * P5.4 asks whether the product should ship OUR five modes or a more general set.
 *
 * IT SHIPS OURS AS A *RECOGNISED VOCABULARY*, ENV-OVERRIDABLE PER DEPLOYMENT — and the
 * distinction between "recognised" and "constrained" is the entire answer:
 *
 *   1. Validation here is WARN-AND-STORE and NEVER rejects (see handoffCarriedFields.ts).
 *      So this list is not a constraint on what a caller may say; it is the set of values
 *      the server RECOGNISES without comment. Any other string is stored and rendered
 *      exactly the same way, plus a note. That makes the cost of a too-NARROW list one
 *      warning line, and the cost of an EMPTY list the loss of all guidance — asymmetric,
 *      so ship a list.
 *   2. The only corpus anyone has MEASURED is ours. Inventing `review`, `plan`, `triage`
 *      to look general would be asserting a taxonomy wider than the sample we have (C2),
 *      inside the very file that exists because a convention was over-generalised once.
 *      `define-to-lock` in particular is unmistakably Riverbend's ceremony, and shipping
 *      it says so honestly rather than dressing it up as a universal.
 *   3. A deployment whose working model differs sets MANDREL_HANDOFF_MODE_VOCABULARY and
 *      its warnings go away. In the tenant fleet one instance ≈ one customer (SCOPE §8.9),
 *      so an env knob IS per-customer configuration.
 *
 * THE DOCUMENTED DEFAULT IS *ABSENT*, and that is not an oversight. There is no
 * `DEFAULT_MODE`, because a mode nobody chose is a fabricated claim about how a session
 * should behave — the single most obeyed line in the document, invented by the server.
 * No field and no parseable prose renders "(none recorded)", which is a measurement.
 */

import { transientCap } from './fieldLimits.js';

/** Read a STRING env var, falling back only when the variable is genuinely absent. */
function envStr(name: string, fallback: string): string {
  const raw = process.env[name]; // env-read: via-callers
  return raw === undefined ? fallback : raw;
}

/**
 * The context_type that carries these fields. Imported from the resume pointer's config
 * rather than re-spelled: `handoff` is already the gate for the resume-pointer stamp and
 * the supersession mint, and a third literal is a third thing that can drift.
 */
export { RESUME_POINTER_CONTEXT_TYPE as CARRIED_FIELDS_CONTEXT_TYPE } from './handoffResumePointerConfig.js';

/**
 * The reserved `contexts.metadata` key these fields live under. NOT an env knob: it is the
 * name a renderer, a future migration, and any customer reading raw metadata all resolve
 * through. A deployment that renamed it would keep reporting successful handoff stores
 * while the briefing silently read nothing — the defect above, reintroduced as a setting.
 */
export const CARRIED_FIELDS_METADATA_KEY = 'handoff';

/** The key inside that namespace holding the declared mode. */
export const CARRIED_FIELDS_MODE_KEY = 'mode';

/** The key inside that namespace holding the declared spine reference. */
export const CARRIED_FIELDS_SPINE_KEY = 'spine';

/**
 * THE RECOGNISED MODE VOCABULARY — a suggestion set, never a constraint. See the header
 * for why these five and not an invented general set. Comma-separated env override;
 * an EMPTY override (`MANDREL_HANDOFF_MODE_VOCABULARY=`) is honoured and means "recognise
 * nothing, warn on every value", which is a legitimate choice for a deployment that has
 * not settled a taxonomy yet.
 */
export const HANDOFF_MODE_VOCABULARY_DEFAULT: readonly string[] = Object.freeze([
  'facilitate',
  'define-to-lock',
  'build',
  'debug',
  'research',
]);

/** READ-AT-CALL-TIME so a test can vary the vocabulary without module surgery. */
export function READ_HANDOFF_MODE_VOCABULARY(): readonly string[] {
  // The sentinel is a NUL-prefixed string because no environment variable can contain a
  // NUL, so it can never collide with a real value. Written as the ESCAPE '\u0000' and not
  // as a raw NUL byte: a raw one makes git call this file binary and hides every future
  // diff of it (scripts/check-no-nul-bytes.sh). The two spellings are the same string.
  const raw = envStr('MANDREL_HANDOFF_MODE_VOCABULARY', '\u0000UNSET');
  if (raw === '\u0000UNSET') return HANDOFF_MODE_VOCABULARY_DEFAULT;
  return Object.freeze(
    raw
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.length > 0),
  );
}

/**
 * The longest a STORED mode may be — re-exported from the ONE field-limits registry rather
 * than re-chosen here, so the truncation the service applies and the bound the surface
 * documents cannot drift apart. See TRANSIENT_LIMITS.handoffModeStored for why there are
 * two bounds (this one truncates and warns; the zod one is anti-abuse and can reject).
 */
export const CARRIED_FIELDS_MODE_MAX_CHARS = transientCap('handoffModeStored');

// ─────────────────────────────────────────────────────────────────────────────
// RENDER — the labels the briefing's handoff section emits.
// ─────────────────────────────────────────────────────────────────────────────

/** The label for the declared working mode. */
export const CARRIED_FIELDS_MODE_LABEL = 'MODE';

/**
 * The label for the FULL PROSE PATH line — the human narrative of where the reader is on
 * the tree. It has NO field equivalent and never will: a path is a sentence a person
 * writes, and inventing one from a spine id would be exactly the fabrication this feature
 * exists to remove. It renders ONLY from prose, and is labelled `[source: prose]` so a
 * reader is never told a sentence came from a field.
 */
export const CARRIED_FIELDS_PATH_LABEL = 'PATH';

/**
 * The label for the STRUCTURED spine — the record the handoff resumes. This is the half of
 * the old PATH line that is actually machine-usable (`branch_open <id8>`), and it is
 * rendered under its own label rather than as "PATH" because a spine is not a path, and
 * calling it one would be a small lie told on every boot.
 */
export const CARRIED_FIELDS_SPINE_LABEL = 'SPINE';

/** Rendered when a carried field is present in NEITHER the metadata NOR the prose. */
export const CARRIED_FIELDS_NONE_RECORDED = '(none recorded)';

/** Provenance suffix format. `%s` is the source word (see CarriedFieldSource). */
export const CARRIED_FIELDS_SOURCE_FORMAT = '  [source: %s]';

/**
 * Rendered beside a spine reference the briefing could NOT resolve to a live record in
 * this project. An unresolvable spine is a FACT worth telling the reader (their
 * `branch_open` will fail), and stating it is strictly better than dropping the line —
 * the same reasoning handoffStamp.ts uses for `[now: deleted]`.
 */
export const CARRIED_FIELDS_SPINE_UNRESOLVED = 'unresolved in this project';

/**
 * The kind word printed for a spine whose type could not be read. NOT "task": guessing a
 * kind we did not read is the same confidently-wrong move as guessing the id.
 */
export const CARRIED_FIELDS_SPINE_UNKNOWN_KIND = 'record';

/** How much of a resolved spine's title the SPINE line shows. */
export const CARRIED_FIELDS_SPINE_TITLE_CHARS = 60;

// ─────────────────────────────────────────────────────────────────────────────
// CALLER-FACING NOTES. Every server-side normalisation, drop or non-recognition is
// surfaced to the caller — a server mutating a caller's data is never silent.
// ─────────────────────────────────────────────────────────────────────────────

export function CARRIED_FIELDS_NOTE_UNRECOGNISED_MODE(
  value: string,
  vocabulary: readonly string[],
): string {
  return (
    `Stored mode "${value}" — not in this deployment's recognised vocabulary ` +
    `[${vocabulary.join(', ')}]. STORED AND RENDERED anyway (a handoff is never rejected ` +
    `over a mode). Set MANDREL_HANDOFF_MODE_VOCABULARY to recognise your own taxonomy.`
  );
}

export function CARRIED_FIELDS_NOTE_NORMALIZED(raw: string, stored: string): string {
  return `Normalized mode "${raw}" -> "${stored}" (trimmed, lower-cased, spaces/underscores to hyphens).`;
}

export function CARRIED_FIELDS_NOTE_TRUNCATED(max: number): string {
  return `Mode truncated to ${max} chars — a mode is a label, not a description.`;
}

export function CARRIED_FIELDS_NOTE_WRONG_TYPE(contextType: string, gateType: string): string {
  return (
    `mode/spine are carried by \`${gateType}\` contexts and were NOT stored on this ` +
    `\`${contextType}\` — nothing reads them there. Store the handoff itself with these fields.`
  );
}

export function CARRIED_FIELDS_NOTE_SPINE_SHAPE(value: string): string {
  return (
    `Stored spine "${value}" — it is not a UUID or an 8+-hex short id, so no record can ` +
    `resolve from it. STORED AND RENDERED anyway; the briefing will label it unresolved.`
  );
}

export function CARRIED_FIELDS_NOTE_OVERWROTE(key: string): string {
  return (
    `The explicit \`${key}\` argument replaced a value you also supplied at ` +
    `metadata.${CARRIED_FIELDS_METADATA_KEY}.${key} — the argument is the declared intent and wins.`
  );
}
