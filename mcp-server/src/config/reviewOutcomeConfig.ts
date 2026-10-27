/**
 * REVIEW OUTCOME rendering — the config for reading a review CALL back off a stored record.
 *
 * WHY THIS EXISTS (from the P6 blind test): two
 * independent blind readers, given nothing but a rendered boot package, found the same
 * defect — six Reviewer verdict records were NAMED with their tasks and the word APPROVE
 * or REJECT appeared for NONE of them. One reader inferred approval from the fact that the
 * work had merged, and then said why that inference is unsafe: on 2026-08-21 three
 * Reviewers approved a tree the authoritative gate turned RED. MERGED IS NOT APPROVED.
 *
 * The outcome was never missing from the DATA. It sits in the record's own jsonb metadata
 * (`metadata.verdict`), written by Reviewer, and the walk's line renderers simply never
 * read it: a verdict rendered as SHAPE is a title clipped at the altitude's budget, and the
 * call is deeper into the prose than the clip reaches. MEASURED on prod 2026-08-26 over the
 * verdict-tagged corpus of project `riverbend` (tags `reviewer-verdict` ∪ `verdict`, 21
 * distinct contexts): 14 carry a structured `metadata.verdict`, 7 do not.
 *
 * ★ NO SECOND VOCABULARY, ON PURPOSE. The task offered two options and asked for whichever
 * avoids one. Nothing here enumerates the legal calls: APPROVE / REJECT /
 * APPROVE-WITH-NITS / APPROVE-PENDING-GATE / APPROVE-WITH-NITS-PENDING-GATE are all live in
 * the corpus today and a closed list would have to be edited before it could render the
 * next spelling — silently dropping the outcome in exactly the case where a new one appears.
 * This module reads a value and renders it verbatim (bounded and single-lined); it does not
 * decide what a verdict may say. That judgement stays with the Reviewer who wrote it.
 *
 * ★ NO ENV KNOBS, ALSO ON PURPOSE — the same call captureVocab.ts makes. These are the
 * shape of a stored record, not an operator's dial: an instance that read a different
 * metadata key would render nothing for every record every other instance can read, which
 * is a fleet-wide divergence bought for no use case. Named constants, one place, no
 * `process.env`, and therefore no .env.example accounting obligation.
 */

/**
 * The metadata key holding the review call. `metadata.verdict`, chosen because that is
 * where the records ALREADY put it (measured above) — this reads the corpus, it does not
 * ask the corpus to change.
 */
export const REVIEW_OUTCOME_METADATA_KEY = 'verdict' as const;

/**
 * When `metadata.verdict` is an OBJECT rather than a string, the sub-key holding the call.
 * Both shapes are live: `"verdict":"APPROVE-PENDING-GATE"` (e.g. an earlier context) and
 * `"verdict":{"call":"APPROVE-WITH-NITS-PENDING-GATE","nits":3,...}`.
 * Reading only the string form would drop the richer record, which is the wrong direction.
 */
export const REVIEW_OUTCOME_CALL_KEY = 'call' as const;

/**
 * The label prefix rendered in the node's stamp. Deliberately the same `key:value` shape
 * the neighbouring lifecycle stamps already use (`outcome:`, `impl:`), so this adds a
 * FIELD to an existing idiom rather than a new one for a reader to learn.
 */
export const REVIEW_OUTCOME_LABEL = 'verdict' as const;

/**
 * Hard bound on the rendered label, in characters.
 *
 * ★ THIS IS A BUDGET GUARD, NOT A STYLE CHOICE. The boot package is size-capped and drops
 * whole records silently when it overflows, so a field added to EVERY node line has to
 * carry its own ceiling: `metadata.verdict` is free-form jsonb and nothing stops a writer
 * from putting a paragraph there. 40 is sized off the longest call in the live corpus
 * (`APPROVE-WITH-NITS-PENDING-GATE`, 30 chars) with room for a longer spelling, and it
 * bounds the worst case at ~48 chars/line including the label and the ellipsis.
 */
export const REVIEW_OUTCOME_MAX_CHARS = 40;

/** The clip marker, when a stored call is longer than the bound above. */
export const REVIEW_OUTCOME_CLIP_SUFFIX = '…' as const;
