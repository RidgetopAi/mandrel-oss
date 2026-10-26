/**
 * AGENT CAPTURE VOCABULARY — the single source of truth for `metadata.capture`.
 *
 * P4 LAYER 1 of the agent-work-capture plan (spec an earlier context).
 * Written against a MEASUREMENT, not a hunch — see P2's result
 *: of 13 records written by agents that had been told to say how they
 * knew, 11/11 runs wrote SOMETHING and only 5/13 carried a STRUCTURED status. The other
 * eight put their confidence in honest, readable prose. Prose is not aggregatable: "which
 * classes recurred despite a fix?" cannot be answered by grepping it.
 *
 * So the gap this module closes is DISCOVERABILITY — nobody knew the shape — not refusal.
 * There is no enforcement here beyond the shape of the field itself (see THE ONE RULE
 * below); making a record REFUSE to be written without one is a separate, later layer.
 *
 * ═══════════════════════════════════════════════════════════════════════════════════════
 * WHY IT RIDES `metadata`, AND WHY THE NAME `provenance` IS NOT USED
 * ═══════════════════════════════════════════════════════════════════════════════════════
 * `contexts` has ZERO trust/confidence columns, and every write tool's zod is strict — an
 * unrecognized top-level `provenance` param is HARD-REJECTED, not dropped. `metadata` is the
 * one field already accepted on all ten write boundaries, already round-trips through
 * `structuredContent`, and already hosts one other reserved key (the artifact-reference
 * array, config/artifactRefConfig.ts). This is the second tenant of that same house, and it
 * deliberately reuses that house's rules.
 *
 * THREE existing mechanisms answer NEARBY questions and none of them answers this one, so
 * none of their names are reused:
 *   - `provenance_class` on `links` — DERIVED from `mint_via` (declared|guessed|unclassified),
 *     a stored generated column with a live CHECK. THE NAME IS TAKEN.
 *   - `trust.band`  — computed at READ time; `unproven` means "no outcome evidence yet",
 *     NOT "the author was unsure". Never persisted. [trust-render-exempt: naming the
 *     neighbouring mechanism in order to say this module is NOT it.]
 *   - the belief adjudicator — produces EDGES, not record fields.
 * `capture.status` is the only one of the four that is AUTHOR-DECLARED: it records what the
 * writer did, not what the system inferred.
 *
 * ═══════════════════════════════════════════════════════════════════════════════════════
 * FOUR STATES, AND WHY `absent` HAS NO VALUE
 * ═══════════════════════════════════════════════════════════════════════════════════════
 *   verified  — an instrument was run, and the command and its output are CITED.
 *   believed  — reasoned, not measured.
 *   refuted   — measured, and found false.
 *   absent    — nobody said. **THE KEY IS SIMPLY NOT THERE.**
 *
 * `absent` is deliberately NOT a member of CAPTURE_STATUSES and is REJECTED as a written
 * value (see validateMetadataCapture). Absent means nobody said; `believed` means somebody
 * reasoned. Collapsing them manufactures a confidence that was never claimed — and it also
 * destroys the only signal that says whether the convention has been adopted at all.
 *
 * This follows the house precedent exactly:
 *   - `078_declared_limbs.sql:11-24` — the column is NULLABLE WITH NO DEFAULT, because
 *     `NOT NULL DEFAULT '{}'` would collapse "not derived" into "derived, nothing there"
 *     and destroy the only signal that says whether the backfill has run.
 *   - `079_link_provenance_meter.sql` — 'unclassified' is its own bucket, never folded into
 *     'guessed'.
 * Same rule as CLASSES.md C1: an instrument has THREE states, and "could not measure" never
 * shares a value with "no".
 *
 * ═══════════════════════════════════════════════════════════════════════════════════════
 * ★ THE ONE RULE: `verified` IS NON-FREE
 * ═══════════════════════════════════════════════════════════════════════════════════════
 * A record claiming `status:'verified'` MUST carry a sibling `evidence` — the command and
 * its output, or a reference to an artifact that holds them. Without it the label is
 * honor-system, and an honor-system label is WORSE than no label: it READS as evidence of
 * having checked, and the next reader builds on it.
 *
 * This is the schema version of the house rule "every count carries its command", which our
 * own agent instructions demand in prose and cannot enforce. Prose is the expensive, weak
 * version of a rule; the same rule in a validator is the cheap, strong one.
 *
 * `believed` and `refuted` require nothing: a belief is honest about being a belief, and a
 * refutation that names no measurement is still a warning worth having.
 *
 * ═══════════════════════════════════════════════════════════════════════════════════════
 * NO ENV OVERRIDES IN THIS FILE, AND THAT IS THE POINT
 * ═══════════════════════════════════════════════════════════════════════════════════════
 * The standing rule is no hardcoded variables — tunables live in a named config. These are
 * not tunables: they are a CONTRACT that ships to every caller and is advertised verbatim by
 * `discover({action:'contract'})`. A per-box env that could loosen `verified` would make the
 * contract mean something different on each box, which is the exact drift L1 exists to end.
 * So this module is a static vocabulary, exactly like config/decisionVocab.ts and
 * config/edgeTypes.ts — one source, no knobs.
 */

import { vocabList } from './decisionVocab.js';

/** The reserved key inside `metadata` that carries the author-declared capture block. */
export const CAPTURE_METADATA_KEY = 'capture';

/** The field inside that block that carries the declared status. */
export const CAPTURE_STATUS_KEY = 'status';

/** The sibling field that carries the citation `verified` requires. */
export const CAPTURE_EVIDENCE_KEY = 'evidence';

/**
 * THE DECLARED STATES. `absent` is NOT here and must never be added — absence is expressed
 * by omitting the block, and a written 'absent' is rejected (see REJECTED_STATUS_VALUES).
 * Order is semantic: strongest claim first, then the two that claim less.
 */
export const CAPTURE_STATUSES = ['verified', 'believed', 'refuted'] as const;

export type CaptureStatus = (typeof CAPTURE_STATUSES)[number];

/** What each state MEANS. Advertised verbatim by discover.contract — one wording, one place. */
export const CAPTURE_STATUS_MEANING: Readonly<Record<CaptureStatus, string>> = Object.freeze({
  verified:
    'An instrument was run. The command and its output are cited in `evidence` — REQUIRED for this status.',
  believed: 'Reasoned, not measured. Honest about being a belief; nothing further is required.',
  refuted: 'Measured, and found false. Cite what you measured if you have it.',
});

/**
 * The fourth state, which has no value. Stated as a named export so the contract renderer
 * and the docs cannot describe it in two different ways.
 */
export const CAPTURE_ABSENT_MEANING =
  'Not stated — the `capture` block is simply absent. Nobody said, which is NOT the same as ' +
  '`believed` (somebody reasoned). Never write a status of "absent": omit the block instead.';

/**
 * Statuses whose claim is NOT free. Written as a list rather than a literal comparison so a
 * future state that also demands a citation is added in ONE place.
 */
export const CAPTURE_STATUSES_REQUIRING_EVIDENCE: readonly CaptureStatus[] = ['verified'];

/**
 * Values that are REJECTED with a specific message rather than the generic "not in the
 * vocabulary" one, because each is a plausible mis-spelling of a state that exists.
 * 'absent'/'unknown'/'none'/'n/a' are all attempts to write DOWN the fourth state, which is
 * exactly the collision this module exists to prevent.
 */
export const REJECTED_STATUS_VALUES: Readonly<Record<string, string>> = Object.freeze({
  absent: 'absence is expressed by OMITTING the capture block, never by writing a value',
  unknown: 'absence is expressed by OMITTING the capture block, never by writing a value',
  none: 'absence is expressed by OMITTING the capture block, never by writing a value',
  'n/a': 'absence is expressed by OMITTING the capture block, never by writing a value',
  unverified: "use 'believed' (reasoned, not measured) — or omit the block if nobody said",
});

/**
 * Minimum length of an `evidence` STRING, in characters. A one-character citation is the
 * honor-system label wearing a costume, and the whole point of the rule is that the citation
 * be readable by the next person. Deliberately small: the floor exists to reject a
 * placeholder, not to police how someone writes a command. An OBJECT/ARRAY evidence (a
 * pointer) is accepted as-is and is NOT further validated — the artifact-ref rules are keyed
 * on metadata.artifacts, never on capture.evidence.
 */
export const CAPTURE_EVIDENCE_MIN_CHARS = 8;

/**
 * A record shape agents are expected to produce, and the op that writes it.
 *
 * NOTHING HERE IS A DESCRIPTION OF AN OP. The `opId` is a REFERENCE; the human-facing
 * description is read live from OP_REGISTRY by the contract renderer, and a contract test
 * asserts every opId named here exists and every `contextType` is a value context_store
 * actually accepts. That is the no-second-catalog doctrine (opRegistry.ts:10-16): a
 * hand-written copy of a tool's contract rots, and this repo can prove it — its own
 * agent-facing doc advertised a stale tool count and an unauthenticated curl for months.
 */
export interface CaptureRecordShape {
  /** What the agent is producing, in the words an agent would use. */
  readonly shape: string;
  /** The op that writes it. MUST exist in OP_REGISTRY (guarded). */
  readonly opId: string;
  /** For context_store shapes: the `type` value. MUST be in context_store's enum (guarded). */
  readonly contextType?: string;
  /** WHEN to write it — the moment, which is the half agents get wrong. */
  readonly when: string;
  /** Why this record is worth its bytes to somebody who is not you. */
  readonly why: string;
}

/**
 * THE SHAPES. Sourced from the P4 spec's record-shape table, which
 * mapped each one onto the EXISTING schema deliberately — no new context type was added,
 * because a new type costs a migration, a DB CHECK drop/recreate, and five hand-edited
 * duplicate lists.
 */
export const CAPTURE_RECORD_SHAPES: readonly CaptureRecordShape[] = Object.freeze([
  {
    shape: 'RUN REPORT — what you did, how you tested it, what is verified vs merely changed, what blocked you',
    opId: 'context_store',
    contextType: 'completion',
    when: 'at the end of every task, before you hand back',
    why: 'your transcript is discarded; this is the only thing the next agent on this branch can read',
  },
  {
    shape: 'DEFECT — one record per fix: the symptom, the cause, the class it belongs to',
    opId: 'context_store',
    contextType: 'error',
    when: 'per fix, at the moment you understand the cause',
    why: 'a class nobody recorded is a class the next person rediscovers from scratch',
  },
  {
    shape: 'REVIEW VERDICT — the call, the round number, per-finding tier, the gate and its exit code',
    opId: 'context_store',
    contextType: 'completion',
    when: 'every review round, not just the one that approves',
    why: 'review catches most defects; unrecorded, that signal cannot be aggregated or trusted',
  },
  {
    shape: 'DEPLOY / RELEASE — what shipped, to where, at which ref',
    opId: 'context_store',
    contextType: 'milestone',
    when: 'after the roll completes, with the ref it actually ran on',
    why: 'reconstructing what was live on a given day is otherwise archaeology',
  },
  {
    shape: 'EVIDENCE POINTER — where an external artifact lives, its identity, and how to verify it',
    opId: 'context_artifact',
    when: 'when your evidence is a file, a log, or a commit rather than pasteable output',
    why: 'Mandrel stores no artifact bytes; a resolvable, fail-closed reference beats a pasted excerpt',
  },
  {
    shape: 'OUTCOME — how the decision actually turned out',
    opId: 'decision_update',
    when: 'once the thing decided has been built and observed',
    why: 'this is the ground-truth column the trust model consumes; without it every record stays unproven',
  },
]);

/** The vocabulary as the comma-joined list model-facing prose shows. */
export function captureStatusList(): string {
  return vocabList(CAPTURE_STATUSES);
}

/** True when this status may not be claimed without a citation. */
export function statusRequiresEvidence(status: string): boolean {
  return (CAPTURE_STATUSES_REQUIRING_EVIDENCE as readonly string[]).includes(status);
}

function isPlainObject(v: unknown): v is Record<string, any> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Is this `evidence` value a real citation rather than a placeholder? */
function evidenceIsPresent(value: unknown): boolean {
  if (typeof value === 'string') return value.trim().length >= CAPTURE_EVIDENCE_MIN_CHARS;
  if (Array.isArray(value)) return value.length > 0;
  if (isPlainObject(value)) return Object.keys(value).length > 0;
  return false;
}

/**
 * VALIDATE the reserved `capture` key inside a `metadata` bag. Returns a list of human
 * messages; an empty list means "nothing to say", which INCLUDES the common case of no
 * capture block at all.
 *
 * GUARDING THE CLASS, NOT THE INSTANCE: this is called from the ONE shared `baseMetadata`
 * definition in middleware/validation.ts, exactly like validateMetadataArtifactRefs, so
 * every write boundary that accepts metadata is covered by construction and a boundary
 * added later inherits it for free. There is no per-boundary copy to drift.
 *
 * Metadata carrying no `capture` key is untouched — zero behaviour change for every other
 * write, which is what makes this a shape constraint on a NEW field rather than a gate on
 * an existing one.
 */
export function validateMetadataCapture(metadata: unknown): string[] {
  if (!isPlainObject(metadata)) return [];
  if (!Object.prototype.hasOwnProperty.call(metadata, CAPTURE_METADATA_KEY)) return [];

  const block = metadata[CAPTURE_METADATA_KEY];
  // The MERGE-delete sentinel (metadata is merged shallow; an explicit null deletes a key).
  // Deleting a capture block is not a malformed capture block.
  if (block === null) return [];

  const at = `metadata.${CAPTURE_METADATA_KEY}`;
  if (!isPlainObject(block)) {
    return [
      `${at}: must be an OBJECT (got ${Array.isArray(block) ? 'array' : typeof block}). ` +
        `Shape: {"${CAPTURE_STATUS_KEY}": "<${captureStatusList()}>", "${CAPTURE_EVIDENCE_KEY}": "<command + its output>"}.`,
    ];
  }

  const errors: string[] = [];
  const status = block[CAPTURE_STATUS_KEY];

  if (status === undefined) {
    errors.push(
      `${at}.${CAPTURE_STATUS_KEY} is REQUIRED when a capture block is present. ` +
        `One of: ${captureStatusList()}. To say nothing, omit the whole \`${CAPTURE_METADATA_KEY}\` block — ` +
        `absence is a state, and it is not the same as 'believed'.`,
    );
    return errors;
  }

  if (typeof status !== 'string' || !(CAPTURE_STATUSES as readonly string[]).includes(status)) {
    const key = typeof status === 'string' ? status.trim().toLowerCase() : '';
    const specific = Object.prototype.hasOwnProperty.call(REJECTED_STATUS_VALUES, key)
      ? ` — ${REJECTED_STATUS_VALUES[key]}`
      : '';
    errors.push(
      `${at}.${CAPTURE_STATUS_KEY}: ${JSON.stringify(status)} is not a capture status${specific}. ` +
        `Valid: ${captureStatusList()}. ${CAPTURE_ABSENT_MEANING}`,
    );
    return errors;
  }

  if (statusRequiresEvidence(status) && !evidenceIsPresent(block[CAPTURE_EVIDENCE_KEY])) {
    errors.push(
      `${at}.${CAPTURE_STATUS_KEY}='${status}' REQUIRES a sibling \`${CAPTURE_EVIDENCE_KEY}\` — ` +
        `the command and its output (≥ ${CAPTURE_EVIDENCE_MIN_CHARS} chars), or an artifact reference. ` +
        `An unevidenced '${status}' reads as proof of having checked, so it is worse than saying nothing: ` +
        `use 'believed' if you reasoned it, or cite the instrument you ran.`,
    );
  }

  return errors;
}
