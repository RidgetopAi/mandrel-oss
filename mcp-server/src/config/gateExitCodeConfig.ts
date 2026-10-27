/**
 * GATE EXIT CODE rendering — the config for reading a gate RUN back off a stored record.
 *
 * WHY THIS EXISTS (from the P6 blind test, sibling
 * of an earlier task / config/reviewOutcomeConfig.ts, which did the same job for the review
 * CALL). The pre-registered fact class was "gate refs + exit codes". Both blind readers found
 * the exit code unrecoverable from a rendered boot package.
 *
 * ═══ THE MEASUREMENT THIS WAS WRITTEN AGAINST ════════════════════════════════════════
 * Measured 2026-09-03 by driving the SHIPPED renderers (renderThreadText /
 * renderCurrentStateText) with five records differing ONLY in their stored gate result. The
 * task's framing — "the boot package speaks only in GREEN/RED" — is generous. It speaks in
 * NEITHER: at the `headline` altitude a boot package uses there is no body at all, so the
 * words GREEN and RED survive only if an author happened to put them inside the first line
 * before the title clip. rc=1 (a MEASURED failure) and rc=2 (COULD NOT MEASURE) rendered
 * BYTE-IDENTICAL lines, and the ref the run executed on appeared in none of the five.
 *
 * Those two states demand opposite responses — one is a bug to fix, the other is an
 * instrument to repair — which is why CLASSES.md C1 forbids them sharing a value, and why
 * captureVocab.ts refuses to let `absent` share a value with `believed`. This module is the
 * same rule applied to the gate's own three-state contract.
 *
 * ═══ THE NAMESPACE IS A CONTRACT, NOT A GUESS ════════════════════════════════════════
 * stated verbatim in the clean gate's header:
 *     0  GREEN         — MEASURED: the CI gate ran in the clean checkout and passed
 *     1  RED           — MEASURED: the CI gate ran in the clean checkout and failed
 *     2  HARNESS ERROR — "I could not measure." NOT a verdict on the commit
 *     3  SKIP          — not applicable to this ref (checkout predates the harness)
 *    40  STATIC GREEN  — the 48-of-65 subset passed. Deliberately OUTSIDE the verdict
 *                        namespace so no caller can read it as the ship condition.
 *
 * ★ THE RAW CODE IS ALWAYS RENDERED, AND THE LABEL IS THE ASSIST — never the reverse.
 * The task's deliverable is that the exit code SURVIVES to the reader who acts on it. A
 * label alone would re-collapse the render the moment a code appears that this table does
 * not know: an unrecognised rc renders as itself, marked UNRECOGNISED, and is never folded
 * into a verdict (a past incident — unrecognised is a loud RED, never a silent pass). It also
 * means a record written on a box whose GATE_RC_STATIC_GREEN was retuned still hands the
 * reader the number, whatever this table calls it.
 *
 * ═══ WHY THE KEY ALIASES EXIST, WITH THEIR COUNTS ════════════════════════════════════
 * MEASURED on prod 2026-09-03 over all 67 contexts carrying `metadata.gate`
 *   ssh prod-host "sudo -u postgres psql -d mandrel -At -c \"SELECT k, count(*) FROM contexts,
 *     LATERAL jsonb_object_keys(metadata->'gate') k WHERE metadata ? 'gate' AND
 *     jsonb_typeof(metadata->'gate')='object' GROUP BY 1 ORDER BY 2 DESC;\""
 * the exit code is spelled THREE ways — `exitCode` (14), `exit` (3), `exit_code` (2) — and
 * the ref two — `ref` (11), `refReported` (1), `refMeasured` (1). reviewOutcomeConfig reads
 * exactly one key because the corpus had exactly one spelling; this corpus does not, and a
 * single-key reader would silently drop records that DID record the thing. Reading the
 * corpus is the same doctrine, not a departure from it.
 *
 * ⚠️ `refToGate` IS DELIBERATELY NOT AN ALIAS. It means "the ref that SHOULD be gated"
 * (measured: "merge of batch10/belief-failopen@9305f00d into mandrel main") — an
 * intention, not a ref a run executed on. Rendering it as the latter is exactly the
 * substitution this task exists to stop. `refChecked` is a boolean and is not a ref either.
 *
 * ═══ FOUR ABSENCES, AND THEY ARE NOT THE SAME ABSENCE ════════════════════════════════
 *   - no `metadata.gate` at all           → render NOTHING. Absence is absence; a stamp on a
 *                                           record that never claimed a gate is fabrication.
 *   - `run:false` (30 records on prod)    → NOT_RUN. The writer DECLARED it did not run.
 *   - a gate block with no readable code  → NOT_RECORDED. Something was said about a gate and
 *     (incl. the 14 free-prose string       the code is not in it. This is the state the task
 *      gate blocks on prod)                 names: "a GREEN with no rc must be visibly
 *                                           distinguishable from rc=0 and rc=40."
 *   - a code that is not a number         → NOT_RECORDED. Measured: two prod records store
 *     (prose in the numeric field)          "NOT RUN - outstanding, the coordinator's" in `exitCode`.
 *
 * ═══ THE LABEL IS `gate-rc`, NOT `gate`, AND THAT IS LOAD-BEARING ════════════════════
 * renderCurrentStateText ALREADY prints a `GATE:` line — the current-state ladder's answer to
 * "what is this project waiting on" (blocked / awaiting-review / release / complete,
 * currentStateConfig.ts CURRENT_STATE_GATE_IDS). That is a different question with a
 * different vocabulary, and it renders in the same document. One word, two meanings, on one
 * page is a collision the reader pays for; two spellings is the cheap fix.
 *
 * ═══ NO ENV KNOBS, ON PURPOSE — the call captureVocab.ts and reviewOutcomeConfig.ts make ══
 * These are the shape of a stored record and a published exit-code contract, not an
 * operator's dial. An instance that read a different key, or called rc=2 something else,
 * would render a different fact for records every other instance can read — fleet-wide
 * divergence bought for no use case. Named constants, one place, no `process.env`, and
 * therefore no .env.example accounting obligation.
 */

/** The reserved key inside `metadata` that carries the gate run. */
export const GATE_METADATA_KEY = 'gate' as const;

/**
 * Sub-keys holding the exit code, in PRECEDENCE order (first present wins). Measured counts
 * in the header; `exitCode` is the canonical spelling and leads for that reason.
 */
export const GATE_EXIT_CODE_KEYS = ['exitCode', 'exit', 'exit_code'] as const;

/**
 * Sub-keys holding the ref the run EXECUTED ON, in precedence order. See the header for why
 * `refToGate` and `refChecked` are excluded — they answer different questions.
 */
export const GATE_REF_KEYS = ['ref', 'refReported', 'refMeasured'] as const;

/** The sub-key carrying the writer's explicit "this did not run" declaration. */
export const GATE_RUN_KEY = 'run' as const;

/**
 * THE EXIT-CODE NAMESPACE. Keys are the codes; values are the label
 * rendered beside the code. `2` and `1` MUST NOT share a label — that identity is the whole
 * defect this module closes, and gateExitCodeRendered.contract.test.ts asserts it.
 */
export const GATE_RC_LABELS: Readonly<Record<number, string>> = Object.freeze({
  0: 'GREEN',
  1: 'RED',
  2: 'CANNOT-MEASURE',
  3: 'SKIP',
  40: 'STATIC-GREEN',
});

/**
 * The static-subset code, named separately because it is the one member of the table above
 * that is NOT part of the 0/1/2/3 verdict namespace and the one a reader most needs warned
 * about: a static GREEN is a 48-of-65 subset and is NOT the ship condition.
 *
 * ⚠️ IT HAS A SECOND SOURCE, and this constant is the DEPENDENT one: the gate's own shell
 * default `GATE_RC_STATIC_GREEN="${GATE_RC_STATIC_GREEN:-40}"`. A contract test reads that
 * shell file and goes RED if the two defaults ever disagree. The render degrades honestly even then —
 * the raw code is always printed, so a mismatch mislabels, it does not erase.
 */
export const GATE_RC_STATIC_GREEN = 40;

/**
 * What is rendered for a code the table does not know. It carries the code itself (the
 * renderer prints it either way), so this word says only "this module has no name for it" —
 * never "it passed" and never "it failed".
 */
export const GATE_RC_UNRECOGNISED_LABEL = 'UNRECOGNISED' as const;

/** The writer DECLARED the gate did not run (`run:false`). A fact, not an inference. */
export const GATE_NOT_RUN_LABEL = 'NOT-RUN' as const;

/**
 * A gate block exists and no exit code can be read out of it. Distinct from NOT-RUN: nobody
 * said whether it ran, only that the code is unrecoverable from this record.
 */
export const GATE_NOT_RECORDED_LABEL = 'NOT-RECORDED' as const;

/** Rendered in the code position when there is no code to render. */
export const GATE_RC_ABSENT_TOKEN = 'none' as const;

/**
 * The stamp's label prefix. `key:value`, the same idiom as the neighbouring `outcome:` /
 * `impl:` / `verdict:` stamps — a FIELD in an existing idiom, not a new one to learn. See the
 * header for why it is not spelled `gate`.
 */
export const GATE_RC_LABEL = 'gate-rc' as const;

/** Separates the code from its label: `gate-rc:1=RED`. */
export const GATE_RC_LABEL_SEPARATOR = '=' as const;

/** Introduces the ref the run executed on: `gate-rc:1=RED@9305f00d`. */
export const GATE_REF_SEPARATOR = '@' as const;

/**
 * How many leading characters of the ref are rendered. 8 is the id8 this codebase already
 * reads everywhere (permalinks, `left(id::text,8)`, branch anchors) and is what a reader
 * pastes into `git show`. The FULL ref still travels on the structured channel — a boot
 * package is size-capped and a 40-char sha on every line is 32 chars of budget for a
 * precision the prose line does not need.
 */
export const GATE_REF_RENDER_CHARS = 8;

/**
 * ★ THE STAMP IS BOUNDED BY CONSTRUCTION, AND THERE IS DELIBERATELY NO MAX-CHARS KNOB.
 *
 * This field rides EVERY node line of a size-capped document that drops whole records when it
 * overflows, so it has to carry a ceiling — but a `GATE_STAMP_MAX_CHARS` clip of the kind
 * REVIEW_OUTCOME_MAX_CHARS applies was WRITTEN, MEASURED AND DELETED: it could never fire.
 * `metadata.gate` has exactly one free-form input reaching this stamp — the ref — and it is
 * already clipped to GATE_REF_RENDER_CHARS before it is joined. The only other input is a
 * finite JS number, which serialises to at most 24 characters
 * (`-1.7976931348623157e+308`), against a longest label of 14 (`CANNOT-MEASURE`).
 *
 * So the worst case is 24 + 1 + 14 + 1 + 8 = 48 characters, by construction rather than by a
 * clip nobody could reach. A guard that cannot fire is a guard with no adversary; the
 * arithmetic above is asserted in gateExitCodeRendered.contract.test.ts, which is where a
 * future change that reintroduced an unbounded input would go RED.
 */
export const GATE_STAMP_WORST_CASE_CHARS = 48;
