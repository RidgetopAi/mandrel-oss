/**
 * GATE METADATA — the WRITE boundary for `metadata.gate`.
 *
 * an earlier Task. This is the write-side half of an earlier task (batch-13 lane F), which had to
 * build a three-spelling recognizer just to render an exit code. That recognizer is the
 * `regex-recognizer-unowned-parser` class one layer over, and it exists because this field was
 * SPECCED (captureVocab's REVIEW VERDICT shape says "the gate and its exit code") and never
 * VALIDATED. A field with a spec and no validator is the weakest possible arrangement:
 * writers believe they are conforming, readers believe they are reading a contract, and
 * neither is true. The fix belongs here, at the write, because a reader can only ever cope.
 *
 * ═══ MEASURED ON THE PROD CORPUS, 2026-09-05, BEFORE WRITING A LINE ══════════════════
 *   ssh prod-host "sudo -u postgres psql -d mandrel -At -F'|' \
 *     -c \"SELECT jsonb_typeof(metadata->'gate'), count(*) FROM contexts
 *          WHERE metadata ? 'gate' GROUP BY 1;\" \
 *     -c \"SELECT k, count(*) FROM contexts, LATERAL jsonb_object_keys(metadata->'gate') k
 *          WHERE metadata ? 'gate' AND jsonb_typeof(metadata->'gate')='object'
 *          GROUP BY 1 ORDER BY 2 DESC;\""
 * 67 contexts (53 object, 14 free-prose STRING) + 5 tasks (5/5 free-prose string) + 0
 * decisions carry the key, spread over 60 distinct sub-keys.
 *
 * ★ THE EXIT CODE IS SPELLED FIVE WAYS ON PROD, NOT THREE. The read side knows
 * `exitCode` (14) · `exit` (3) · `exit_code` (2); the same query also returns `rc` (1) and
 * `static_subset_exit` (1). Those FOURTH and FIFTH spellings ARRIVED WHILE THE READ SIDE WAS
 * BEING BUILT — which is the whole argument for validating the write rather than widening
 * the recognizer again. Sharpening the pattern is the move that never ends (CLASSES.md C3).
 *
 * ═══ THE DISPOSITION OF THE EXISTING RECORDS: (a) — VALIDATE NEW WRITES ONLY ══════════
 * The 19 free-prose blocks (14 contexts + 5 tasks) are left EXACTLY AS THEY ARE, as history.
 * Nothing here migrates, coerces or rewrites a stored record; a backfill is a data mutation
 * on the production corpus and is the coordinator's call, not a side effect of adding a validator.
 *
 * WHY THAT IS NOT A BREAKING CHANGE FOR THEM, STATED PRECISELY:
 *   - READS are untouched. gateExitCodeConfig.ts keeps every alias it knows and keeps
 *     rendering the historical corpus; this module deliberately does not shrink the reader.
 *   - RE-SAVES are untouched unless the caller RE-SENDS a gate block. Validation runs on the
 *     caller's `metadata` PARAM (middleware/validation.ts `baseMetadata`); the stored value is
 *     merged SQL-side afterwards (utils/metadataMerge.ts) and is never re-parsed. A
 *     context_update that does not mention `gate` cannot be rejected by this rule.
 *   - What IS newly refused: a NEW write that sends a malformed gate block. That is the point,
 *     and the writer gets a message naming the canonical spelling.
 * The one thing to know before merging: an agent that copies a 2026-08 prose gate block
 * verbatim into a new record will now be REJECTED where it used to be stored. That is
 * intended and it is the only behaviour change reaching a caller.
 *
 * ═══ COERCION IS REFUSED ON PURPOSE ══════════════════════════════════════════════════
 * Option (b) — quietly normalise `exit`/`rc` to `exitCode` — buys tidiness by manufacturing a
 * fact the writer did not state, and it hides the drift from the only person who can stop it.
 * Option (c) — warn and store anyway — is the credential-detector reasoning
 * in its losing form: a validator that is routed around is worse than an honest
 * absence, because it reads as enforcement. Prose in a numeric field is REJECTED, never
 * coerced. Two prod records store "NOT RUN - outstanding, the coordinator's" in an exit-code field;
 * coercing that to a number would invent a verdict out of an apology.
 *
 * ═══ THE POPULATION THIS GUARDS, AND WHAT IT DELIBERATELY LEAVES ALONE ════════════════
 * RESERVED here: the exit code, the ref the run executed on, and the `run` declaration —
 * the three fields the read side actually consumes — plus their measured mis-spellings.
 * NOT reserved: every other sub-key. `metadata` is a free-form bag and `gate` blocks legitimately
 * carry `name`, `reason`, `stagesRan`, `owner`, `note` and 50 more descriptive keys. A closed
 * key set would reject all of them, be inconvenient within a week, and be deleted — a guard
 * that blocks correct work is worse than the hole it closed (CLASSES.md C3). So this is a
 * TYPE-AND-SPELLING rule on three reserved fields, not a schema for the whole block.
 * NOT DEFENDED, so the bound is honest: any writer that does not cross the MCP tool schemas
 * — raw SQL, a migration, the Command UI's own writers.
 *
 * ═══ `refToGate` AND `refChecked` ARE NOT REFS, AND ARE NOT TOUCHED ═══════════════════
 * `refToGate` means "the ref that SHOULD be gated" — an intention, not an observation — and
 * `refChecked` is a boolean. gateExitCodeConfig.ts excludes both from GATE_REF_KEYS for that
 * reason. Treating either as a mis-spelling of `ref` would be precisely the substitution an earlier task
 * exists to stop, so neither appears in the rejected-alias table below.
 *
 * ═══ NO ENV KNOBS ════════════════════════════════════════════════════════════════════
 * The same call captureVocab.ts, reviewOutcomeConfig.ts and gateExitCodeConfig.ts make: this
 * is the shape of a stored record, advertised to every caller, not an operator's dial. A
 * per-box loosening would make one fleet member accept a record every other member rejects.
 */

import {
  GATE_METADATA_KEY,
  GATE_EXIT_CODE_KEYS,
  GATE_REF_KEYS,
  GATE_RUN_KEY,
} from './gateExitCodeConfig.js';

export { GATE_METADATA_KEY };

/**
 * THE CANONICAL SPELLINGS. Each is the FIRST element of the read side's precedence list, so
 * the write contract cannot drift from what the renderer prefers — there is no second copy of
 * these strings to keep in sync, and gateMetadataWrite.contract.test.ts asserts the identity.
 */
export const GATE_CANONICAL_EXIT_CODE_KEY = GATE_EXIT_CODE_KEYS[0];
export const GATE_CANONICAL_REF_KEY = GATE_REF_KEYS[0];
export const GATE_CANONICAL_RUN_KEY = GATE_RUN_KEY;

/**
 * Exit-code spellings that are REJECTED on write and still READ by gateExitCodeConfig.
 * Read broadly (the corpus is what it is), write narrowly.
 *
 * ★ THIS IS A DENY-LIST, NOT A CLOSED KEY SET. It refuses the spellings BELOW, by name; a
 * spelling nobody has written yet is ACCEPTED. That limit is EXECUTED in §2 of
 * gateMetadataWrite.contract.test.ts rather than promised here, because a limits sentence
 * cannot be checked and the one this replaced was false. Widening it is the move that never
 * ends (CLASSES.md C3).
 *
 * The first two come from the reader's own alias list — derived, not re-typed, so a reader
 * alias added tomorrow is automatically refused at the write. `rc` and `static_subset_exit`
 * are measured spellings the reader does NOT know: they are listed here explicitly because a
 * value the renderer cannot see is worse than one it can, not better.
 */
export const GATE_EXIT_CODE_ALIASES: readonly string[] = Object.freeze([
  ...GATE_EXIT_CODE_KEYS.slice(1),
  'rc',
  'static_subset_exit',
  'exitcode',
  'exitStatus',
  'status_code',
]);

/**
 * Ref spellings that are REJECTED on write. Derived from the reader's alias list for the same
 * reason. `refToGate`/`refChecked` are NOT here — see the header.
 */
export const GATE_REF_ALIASES: readonly string[] = Object.freeze([...GATE_REF_KEYS.slice(1)]);

/**
 * Minimum length of a `ref`, in characters. A ref exists to be pasted into `git show`; the
 * shortest thing that can be is an abbreviated sha, and git's own floor for that is 4.
 * Deliberately low — this rejects `""` and `" "`, it does not police how anyone names a ref.
 */
export const GATE_REF_MIN_CHARS = 4;

/**
 * THE ADVERTISED SHAPE, for `discover({action:'contract'})`.
 *
 * WHY THIS EXISTS AT ALL (and it is the half that keeps the validator from being resented
 * into deletion): captureVocab's REVIEW VERDICT shape already instructs agents to record
 * "the gate and its exit code", and until now the contract stopped there. An agent was told
 * to write the field, given no shape, and then refused at the boundary. A rule an agent can
 * only discover by tripping over it is a rule it will route around — the same reasoning
 * an earlier decision applied to the credential detector.
 *
 * It is DATA, not a paragraph in the renderer, for the reason every other contract surface
 * in this repo is: a hand-written copy of a contract rots, and this repo can prove it. The
 * renderer walks this list; a field added here is advertised with no renderer change, and
 * gateMetadataWrite.contract.test.ts asserts the advertised example is itself ACCEPTED by
 * validateMetadataGate, so the contract cannot drift away from the rule it teaches.
 */
export interface GateFieldSpec {
  readonly key: string;
  /** The accepted JSON type, in the words the rejection message uses. */
  readonly type: string;
  /** What the field MEANS — the half that stops the next mis-spelling being invented. */
  readonly meaning: string;
}

export const GATE_FIELD_SPECS: readonly GateFieldSpec[] = Object.freeze([
  {
    key: GATE_CANONICAL_RUN_KEY,
    type: 'boolean',
    meaning:
      'Did the gate RUN? `false` is a fact worth recording and is the most common live state — ' +
      'it is not the same as a gate that ran and told us nothing.',
  },
  {
    key: GATE_CANONICAL_EXIT_CODE_KEY,
    type: 'integer, or null for "no code recorded"',
    meaning:
      'The exit code ITSELF, never a word for it: 0 GREEN · 1 RED · 2 COULD-NOT-MEASURE · ' +
      '3 SKIP · 40 STATIC-GREEN (a subset, NOT the ship condition). Prose here is REJECTED, ' +
      'never coerced — put the sentence in a sibling key such as `reason`.',
  },
  {
    key: GATE_CANONICAL_REF_KEY,
    type: `string of at least ${GATE_REF_MIN_CHARS} characters`,
    meaning:
      'The ref the run EXECUTED ON — an observation. `refToGate` is a different fact (the ref ' +
      'that SHOULD be gated, an intention) and the two must never be substituted.',
  },
]);

/**
 * The example the contract hands out. Deliberately a REAL shape rather than a placeholder:
 * unlike a capture `evidence` citation, an example gate block invents no measurement — the
 * ref is written as a placeholder token precisely so it cannot read as one.
 */
export const GATE_CONTRACT_EXAMPLE: Readonly<Record<string, unknown>> = Object.freeze({
  [GATE_METADATA_KEY]: Object.freeze({
    [GATE_CANONICAL_RUN_KEY]: true,
    [GATE_CANONICAL_EXIT_CODE_KEY]: 0,
    [GATE_CANONICAL_REF_KEY]: '<the sha the run executed on>',
  }),
});

/** Stated once, so the renderer and this module cannot describe absence two ways. */
export const GATE_ABSENT_MEANING =
  'Omit the whole `gate` block if no gate is in question. Absence is a state. An EMPTY block ' +
  '(`{}`) is rejected: it claims a gate and records nothing about it.';

function isPlainObject(v: unknown): v is Record<string, any> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * How many characters of a REJECTED value are echoed back in the error message. The message
 * goes to the caller AND into the server log, so an unbounded echo puts an arbitrary — possibly
 * large, possibly sensitive — caller-supplied string in both. 60 is enough to recognise what
 * you sent and short enough that a 4KB paste does not become a 4KB log line.
 */
export const GATE_ECHO_MAX_CHARS = 60;

/** Echo a rejected value back to its writer, always clipped. */
function echoValue(v: unknown): string {
  if (typeof v !== 'string') return describeType(v);
  const clipped = v.slice(0, GATE_ECHO_MAX_CHARS);
  return JSON.stringify(clipped) + (v.length > GATE_ECHO_MAX_CHARS ? ' …(clipped)' : '');
}

function describeType(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

/** The shape line quoted back to a writer who got it wrong. One wording, one place. */
export const GATE_SHAPE_HINT =
  `{"${GATE_CANONICAL_RUN_KEY}": true, "${GATE_CANONICAL_EXIT_CODE_KEY}": 0, ` +
  `"${GATE_CANONICAL_REF_KEY}": "<the sha the run executed on>"} ` +
  `— prose belongs in a sibling key (\`reason\`, \`note\`), never in ` +
  `\`${GATE_CANONICAL_EXIT_CODE_KEY}\`.`;

/**
 * VALIDATE the reserved `gate` key inside a `metadata` bag. Returns human messages; an empty
 * list means "nothing to say", which INCLUDES the common case of no gate block at all.
 *
 * GUARDING THE CLASS, NOT THE INSTANCE: called from the ONE shared `baseMetadata` definition
 * in middleware/validation.ts, exactly like validateMetadataArtifactRefs and
 * validateMetadataCapture — so every write boundary that accepts metadata is covered by
 * construction, and a boundary added later inherits it with no per-boundary copy to drift.
 *
 * ★ ABSENT IS NOT MALFORMED, AND THE TWO MUST NOT SHARE AN ANSWER (CLASSES.md C1). A record
 * with no `metadata.gate` is silent about the gate and is accepted untouched. A record whose
 * gate block is `{}` is NOT silent — it asserts a gate block and says nothing inside it — and
 * is rejected. Collapsing those two would either fabricate a claim nobody made or bless the
 * empty block that started the drift.
 */
export function validateMetadataGate(metadata: unknown): string[] {
  if (!isPlainObject(metadata)) return [];
  if (!Object.prototype.hasOwnProperty.call(metadata, GATE_METADATA_KEY)) return [];

  const block = metadata[GATE_METADATA_KEY];
  // The MERGE-delete sentinel (metadata merges shallow; an explicit null deletes the key).
  // Deleting a gate block is not a malformed gate block.
  if (block === null) return [];

  const at = `metadata.${GATE_METADATA_KEY}`;

  if (!isPlainObject(block)) {
    return [
      `${at}: must be an OBJECT (got ${describeType(block)}). A gate result is a MEASUREMENT ` +
        `— an exit code and the ref it was measured on — and free prose here cannot be read ` +
        `back by anything. Shape: ${GATE_SHAPE_HINT}`,
    ];
  }

  const keys = Object.keys(block);
  if (keys.length === 0) {
    return [
      `${at}: is EMPTY. An empty gate block claims a gate and records nothing about it. ` +
        `Omit the block entirely to say nothing — absence is a state — or state the run: ` +
        `${GATE_SHAPE_HINT}`,
    ];
  }

  const errors: string[] = [];

  for (const alias of GATE_EXIT_CODE_ALIASES) {
    if (Object.prototype.hasOwnProperty.call(block, alias)) {
      errors.push(
        `${at}.${alias}: the exit code is spelled \`${GATE_CANONICAL_EXIT_CODE_KEY}\`. ` +
          `Five spellings of it already exist on the corpus and every reader downstream pays ` +
          `for each one. Rename the key.`,
      );
    }
  }

  for (const alias of GATE_REF_ALIASES) {
    if (Object.prototype.hasOwnProperty.call(block, alias)) {
      errors.push(
        `${at}.${alias}: the ref a run executed on is spelled \`${GATE_CANONICAL_REF_KEY}\`. ` +
          `Rename the key. (\`refToGate\` is a different fact — the ref that SHOULD be gated ` +
          `— and is not affected by this rule.)`,
      );
    }
  }

  if (Object.prototype.hasOwnProperty.call(block, GATE_CANONICAL_EXIT_CODE_KEY)) {
    const rc = block[GATE_CANONICAL_EXIT_CODE_KEY];
    // null is ALLOWED and means "no code recorded" — the honest partner of `run:false`.
    if (rc !== null && !(typeof rc === 'number' && Number.isInteger(rc))) {
      const quoted = echoValue(rc);
      errors.push(
        `${at}.${GATE_CANONICAL_EXIT_CODE_KEY}: must be an INTEGER (or null for "no code ` +
          `recorded"), got ${quoted}. It is NOT coerced: "0" is not 0, and prose in this field ` +
          `("NOT RUN - outstanding" is on the corpus twice) would become an invented verdict. ` +
          `Put the sentence in a sibling key and the number here.`,
      );
    }
  }

  if (Object.prototype.hasOwnProperty.call(block, GATE_CANONICAL_REF_KEY)) {
    const ref = block[GATE_CANONICAL_REF_KEY];
    if (ref !== null && (typeof ref !== 'string' || ref.trim().length < GATE_REF_MIN_CHARS)) {
      errors.push(
        `${at}.${GATE_CANONICAL_REF_KEY}: must be a STRING of at least ${GATE_REF_MIN_CHARS} ` +
          `characters naming the ref the run EXECUTED ON (or null if unrecorded), got ` +
          `${echoValue(ref)}. ` +
          `A gate result with no ref is a verdict about nothing in particular.`,
      );
    }
  }

  if (Object.prototype.hasOwnProperty.call(block, GATE_CANONICAL_RUN_KEY)) {
    const run = block[GATE_CANONICAL_RUN_KEY];
    if (typeof run !== 'boolean') {
      errors.push(
        `${at}.${GATE_CANONICAL_RUN_KEY}: must be a BOOLEAN, got ${describeType(run)}. ` +
          `It is the writer's declaration that the gate did or did not run — the one thing ` +
          `distinguishing "did not run" from "ran and told us nothing".`,
      );
    } else if (run === false) {
      // SELF-CONTRADICTION, the same class artifactRef rejects: a block cannot declare the
      // gate did not run and also report what it exited with. Measured on prod: ZERO records
      // do this today (`SELECT metadata->'gate'->>'run', jsonb_typeof(metadata->'gate'->'exitCode')
      // … GROUP BY 1,2` returns run=false with exitCode null(7) or absent(23) only), so this
      // rule refuses a state the corpus has never legitimately held.
      const rc = block[GATE_CANONICAL_EXIT_CODE_KEY];
      if (typeof rc === 'number') {
        errors.push(
          `${at}: contradicts itself — \`${GATE_CANONICAL_RUN_KEY}:false\` says the gate did ` +
            `not run, while \`${GATE_CANONICAL_EXIT_CODE_KEY}:${rc}\` reports what it exited ` +
            `with. Drop whichever is untrue; a reader cannot.`,
        );
      }
    }
  }

  return errors;
}
