/**
 * ORACLE HARDENING: INPUT VALIDATION MIDDLEWARE
 * Zod-based validation for all AIDIS MCP tool requests
 * Prevents malformed input and ensures data integrity
 */

import { z } from 'zod';
import { TAG_CENSUS_MAX_LIMIT } from '../config/archiveDisclosureConfig.js';
import { formatZodErrorMessage } from '../utils/actionableError.js';
import { isUuidOrShortId } from '../utils/idResolver.js';
import { SESSION_IDENTITY_CONFIG } from '../config/sessionIdentityConfig.js';
import { isValidUuid } from '../utils/uuid.js';
import { RECALL_RESPONSE_FORMATS } from '../config/recallConfig.js';
import { EDGE_TYPES, EDGE_NODE_TYPES } from '../config/edgeTypes.js';
import { IMPLEMENTATION_STATUSES, OUTCOME_STATUSES, ANSWER_STATUSES } from '../config/decisionVocab.js';
import { MAX_LINKS_PER_WRITE } from '../config/linksConfig.js';
import { THREAD_ALTITUDES, THREAD_CONFIG } from '../config/threadConfig.js';
import { ALTITUDES } from '../config/altitudeConfig.js';
import { TRUST_BANDS } from '../config/trustConfig.js';
import { AUTO_THREAD_OPT_OUT_FLAG } from '../config/autoThreadConfig.js';
import { contextTypeEnum } from '../config/contextTypes.js';
import { TASK_BULK_MAX_IDS, TASK_MAX_DEPENDENCIES, TASK_MAX_PUNCH_CLAUSES, TASK_MAX_PUNCH_TOUCHES } from '../config/taskConfig.js';
import { REPROJECT_RECORD_TYPES } from '../config/reprojectConfig.js';
import { SMART_SEARCH_SOURCE_KEYS } from '../config/searchMergeConfig.js';
import {
  BOOL_TRUE_STRINGS,
  BOOL_FALSE_STRINGS,
  INT_STRING_PATTERN,
  FLOAT_STRING_PATTERN,
} from '../config/paramCoercionConfig.js';
// BOUNDARY HYGIENE: reject obviously-malformed input at the edge, fail
// loud. `findArtifactSignatures` catches RAW (non-code-span) leaked tool-call XML;
// `isReservedIdentityString` catches a literal "null"/"undefined" in an identity field.
// The vocabulary lives in config/inputHygieneConfig.ts (configs-not-hardcoded); the logic
// is ONE shared definition reused by the sweep script (centralize the guard).
import {
  findArtifactSignatures,
  findArtifactSignaturesDeep,
  isReservedIdentityString,
} from '../utils/inputHygiene.js';
// METADATA SUBTREE SCAN bounds — tunables, not literals in the walker.
import { METADATA_SCAN_MAX_REPORTED } from '../config/inputHygieneConfig.js';
// CREDENTIAL DETECTION: the FIRST thing in this repo that
// has ever detected a credential in a stored field. High-precision only — structurally
// identifiable shapes (provider token prefixes, PEM private-key headers, `Authorization:
// Bearer <token>`), never entropy. The detector returns IDS, never matched text, so a
// rejection message cannot leak the secret it just refused.
import {
  findCredentialSignatures,
  findCredentialSignaturesDeep,
  describeCredentialSignatures,
} from '../utils/credentialDetection.js';
import { CREDENTIAL_SCAN_MAX_REPORTED } from '../config/credentialDetectionConfig.js';
// FIELD-SIZE CAPS: every string `.max()` below DERIVES from this single
// source — `cap()` for a field backed by a real column (the value is derived FROM the
// column: varchar → its length, TEXT → the shared anti-abuse ceiling), `transientCap()`
// for an input that is never persisted and therefore has no column truth. NO field-size
// literal belongs in this file: hand-typed caps are exactly what drifted from the schema
// (task_create.description capped at 2000 against a TEXT column; assignedTo unbounded
// against a varchar(200)). tests/fieldLimits.schema.test.ts asserts the registry against
// the LIVE information_schema, so a column change or a re-drifted cap goes RED.
import { cap, transientCap } from '../config/fieldLimits.js';
// ARTIFACT REFERENCES: the write-boundary gate for the reserved
// `metadata.<ARTIFACT_REF_CONFIG.metadataKey>` array. See baseMetadata below.
import { validateMetadataArtifactRefs } from '../services/artifactRef.js';
import { validateMetadataCapture } from '../config/captureVocab.js';
// THE THIRD RESERVED KEY: `metadata.gate`, the gate RUN. Specced by
// captureVocab's REVIEW VERDICT shape, unvalidated until now, and drifted to five spellings
// of the exit code on the live corpus. See config/gateMetadataVocab.ts.
import { validateMetadataGate } from '../config/gateMetadataVocab.js';
// P5.5 / migration 093: the blocked_on value set has ONE home — the CHECK constraint — and
// config/blockedOnConfig.ts is its in-process mirror. Importing it here means a widened
// validator cannot accept a value Postgres will reject with a raw 23514 → 500.
import { BLOCKED_ON_VALUES, TASK_LIST_SORTS, type TaskListSort } from '../config/blockedOnConfig.js';
import { TASK_STAGES, PUNCH_PROOF_KINDS, PUNCH_SOURCES, PUNCH_CLAUSE_OWNERS } from '../config/taskStageConfig.js';

/**
 * SHORT-ID ACCEPTANCE: an id field that accepts EITHER a full UUID OR
 * an 8+-hex-char short id (the prefix our tool outputs are referenced by). Previously
 * these fields were strict `.uuid()`, which rejected the short form every reference uses
 * — a tool-only agent could not resolve a short id → full UUID through the public tools.
 *
 * This refinement still VALIDATES THE SHAPE (must be hex/uuid-shaped — non-hex garbage is
 * rejected here with an actionable message), it just no longer demands a FULL uuid. The
 * handler/db layer then resolves a short id → full UUID server-side (see idResolver.ts).
 * It plays correctly with strict mode: the field is declared + value-validated; only the
 * "must be a complete UUID" constraint is relaxed to "uuid OR short hex id".
 */
const uuidOrShortId = () =>
  z.string().refine((v) => isUuidOrShortId(v), {
    message:
      'must be a full UUID or a short id (8+ hex characters — the prefix shown in 🆔 ID output). ' +
      'Non-hex values are not valid ids. If unsure, use a *_search/*_list tool to find the ' +
      'record and copy its full UUID.',
  });

/**
 * THE FENCING TOKEN — a FULL uuid, never a short id.
 *
 * `claimId` is NOT an id you look a record up by: it is the SERVER-MINTED lock key, compared
 * verbatim against `tasks.claim_id` (a `uuid` column, cast `$n::uuid` in every predicate). A
 * short-id prefix is therefore not a shorter way to say the same thing — it can never match,
 * and `uuidOrShortId()` would wave it through the edge only for Postgres to blow up on the
 * cast, surfacing as a raw driver error instead of the typed refusal this contract promises.
 * Half of a lock key is not a lock key.
 *
 * ONE helper used by every claimId param (task_update / cancel_task / claim / renew / release)
 * so the rule cannot drift per-site (guard the class, one source).
 *
 * WHY `isValidUuid` AND NOT zod's `.uuid()` — two reasons, both measured, not stylistic:
 *   1. utils/uuid.ts is this repo's SINGLE SOURCE for "what Postgres's uuid type accepts", and
 *      it exists precisely because a library `.uuid()` enforces the RFC-4122 version/variant
 *      nibbles and would OVER-REJECT real ids the DB stored and accepts. Rejecting a token the
 *      column holds would lock a legitimate holder out of its own claim.
 *   2. `.uuid()` is not free on the wire: it emits `"format": "uuid"` into the advertised
 *      inputSchema for all five claimId params — a real tools/list surface change (caught by
 *      toolSurfaceGolden.contract.test.ts) and surface budget spent, for a rule the runtime
 *      already enforces. A `.refine()` renders as plain `{"type":"string"}`, exactly like
 *      `uuidOrShortId()` — byte-identical surface, strictly tighter validation.
 */
const claimToken = () =>
  z.string().refine((v) => isValidUuid(v), {
    message:
      'claimId must be the FULL uuid returned by task_claim (short ids are not accepted — it ' +
      'is a fencing token compared verbatim against the claim_id column, not a record handle ' +
      'you look up). Copy the `claimId` from the claim response, or re-claim the task to get ' +
      'a fresh one.',
  });

/**
 * BOUNDARY HYGIENE: wrap a free-text field schema so a value carrying RAW
 * (non-code-span) leaked tool-call XML is REJECTED at the edge with an actionable message,
 * instead of being silently stored as poison. A degraded client (long session / compaction
 * — a NORMAL condition for us and customers) leaked the raw serialized tool call into the
 * argument value; Mandrel is a memory product, so storing that corrupts every later read.
 *
 * Code-span aware (see utils/inputHygiene.ts): a signature QUOTED in backticks/fences as
 * documentation passes (this very task's description does exactly that) — only a raw,
 * un-quoted structural leak is rejected. Applied to every free-text CONTENT field across
 * task/context/decision writes (one helper, the whole class — not the one
 * reported field).
 */
const toolXmlFreeText = (inner: z.ZodString) =>
  inner.refine((v) => findArtifactSignatures(v).length === 0, (v) => ({
    message:
      `contains leaked tool-call XML (${findArtifactSignatures(v).join(', ')}) — this looks ` +
      `like a raw serialized tool call bled into the value, not real content. Re-send just ` +
      `the intended text. (Quoting these tags as documentation inside \`backticks\` is fine.)`,
  }));

/**
 * BOUNDARY HYGIENE, RULE 2: reject a value carrying a
 * STRUCTURALLY-IDENTIFIABLE credential. Mandrel is a memory product and a record is a
 * transcript, so our own a past incident ("the token never enters the transcript") applies to the
 * store itself — and until this task nothing here detected a credential in any field.
 *
 * HIGH PRECISION ONLY, and the message says what that means so a caller who trips it is not
 * left guessing. The message names the credential KIND, never the matched text.
 */
const credentialFreeText = <T extends z.ZodTypeAny>(inner: T) =>
  inner.refine((v: unknown) => findCredentialSignatures(v).length === 0, (v: unknown) => ({
    message:
      `contains what looks like a live credential (${describeCredentialSignatures(findCredentialSignatures(v))}) ` +
      `— a stored record is a transcript, so a real secret must not be written into one. ` +
      `Remove or redact the value and re-send. (Only structurally-identifiable credentials ` +
      `are matched: a provider token PREFIX written as documentation, with no secret body ` +
      `after it, is fine.)`,
  }));

/**
 * THE STORED-FREE-TEXT GUARD: both boundary-hygiene rules, applied wherever prose is stored.
 * The name is historical — every call site below still reads `artifactFreeText`, which
 * predates rule 2 — so it is stated here rather than left to be inferred: this wrapper now
 * enforces BOTH the leaked-tool-call-XML rule AND the credential rule. Composed once, so the
 * two rules cannot drift apart across ~40 call sites.
 */
const artifactFreeText = (inner: z.ZodString) => credentialFreeText(toolXmlFreeText(inner));

/**
 * BOUNDARY HYGIENE: a free-form identity string (assignedTo / createdBy)
 * that must not be the literal word "null"/"undefined" — the tell of a degraded client
 * stringifying a JS null/undefined into the field (the incident stored assignedTo = the
 * STRING "null"). A bare z.string() accepts it; this rejects it with an actionable message.
 * The cap is applied by the caller (`.max(cap(...))`); this only adds the reserved-string
 * refinement, so it composes with the existing column-derived length bound.
 */
const identityString = (inner: z.ZodString) =>
  inner.refine((v) => !isReservedIdentityString(v), {
    message:
      'is the literal string "null"/"undefined" — that is a stringified empty value, not an ' +
      'identity. Omit the field to leave it unset, or pass a real name/handle.',
  });

/**
 * Coerce a string-from-the-bridge boolean into a real boolean.
 *
 * THE BUG CLASS (string-from-bridge): MCP clients / the HTTP bridge serialize
 * everything as JSON strings, so a boolean param arrives as "true"/"false" (not a
 * real boolean). A bare z.boolean() then rejects it with "Expected boolean, received
 * string". And z.coerce.boolean() is WRONG here — it uses JS truthiness, so the
 * NON-EMPTY string "false" coerces to `true` (a silent correctness bug).
 *
 * THE FIX: an explicit preprocess that maps the documented string forms to real
 * booleans BEFORE validation, then validates as a boolean:
 *   "true"  | "1" | "yes" | "on"            (case-insensitive) -> true
 *   "false" | "0" | "no"  | "off" | ""      (case-insensitive) -> false
 * Real booleans pass through untouched. Any OTHER value is left as-is so the inner
 * z.boolean() still REJECTS garbage (e.g. "maybe") rather than silently defaulting.
 *
 * Reuse this for EVERY boolean tool param that can arrive over the bridge so the
 * "Expected boolean, received string" class can't reappear tool-by-tool.
 */
export const coerceBooleanValue = (v: unknown): unknown => {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (BOOL_TRUE_STRINGS.includes(s)) return true;
    if (BOOL_FALSE_STRINGS.includes(s)) return false;
  }
  return v; // leave non-coercible values for z.boolean() to reject
};

const coercedBoolean = () => z.preprocess(coerceBooleanValue, z.boolean());

/**
 * Coerce a string-from-the-bridge integer into a real number BEFORE validation —
 * the numeric sibling of coercedBoolean(). Same root cause: the HTTP bridge / MCP
 * clients serialize args as JSON, so a numeric param (limit/offset) can arrive as
 * the STRING "20" rather than the number 20, and a bare z.number() would reject it.
 *
 * Conservative: only a string that is a clean base-10 integer is converted; anything
 * else (real number passes straight through; "abc", "1.5", "") is left untouched so
 * the inner z.number().int() still REJECTS garbage rather than silently defaulting.
 * Pass the inner schema (with .min/.max/.default) so each call sites its own bounds.
 */
export const coerceIntValue = (v: unknown): unknown => {
  if (typeof v === 'string') {
    const s = v.trim();
    if (INT_STRING_PATTERN.test(s)) return parseInt(s, 10);
  }
  return v; // number passes through; non-integer string left for z.number() to reject
};

const coercedInt = (inner: z.ZodTypeAny) => z.preprocess(coerceIntValue, inner);

/**
 * Coerce a string-from-the-bridge decimal into a real number BEFORE validation — the float
 * sibling of coercedInt(). Same root cause: a numeric param (e.g. a confidence floor) can
 * arrive as the STRING "0.5" rather than 0.5. Conservative: only a clean decimal/integer
 * string is converted; anything else is left for the inner z.number() to reject.
 */
export const coerceFloatValue = (v: unknown): unknown => {
  if (typeof v === 'string') {
    const s = v.trim();
    if (FLOAT_STRING_PATTERN.test(s)) return parseFloat(s);
  }
  return v; // number passes through; garbage left for z.number() to reject
};

const coercedFloat = (inner: z.ZodTypeAny) => z.preprocess(coerceFloatValue, inner);

// Base validation schemas
//
// ARTIFACT REFERENCES — THE WRITE BOUNDARY.
//
// `metadata` is a free-form jsonb bag on TEN write boundaries (context store/update, project
// create/update, decision record/update, task create/update/bulk_update, link). One RESERVED
// key inside it is not free-form: the artifact-reference array
// (ARTIFACT_REF_CONFIG.metadataKey, default `artifacts`), which states WHERE an external
// artifact lives, WHAT its identity is, and HOW to verify it — Mandrel never stores the bytes.
//
// A malformed reference is REJECTED here, loudly, rather than stored: a silently-accepted bad
// artifact ref is WORSE than no ref, because it reads as verified provenance. So is a
// reference that CONTRADICTS ITSELF (an `observed` identity that disagrees with the expected
// hash/head) — validateMetadataArtifactRefs blocks that too, which is what makes a hash
// mismatch a stop rather than a warning.
//
// GUARDING THE CLASS, NOT THE INSTANCE: this lives on the ONE shared
// `baseMetadata` definition, so all ten boundaries are covered by construction and a
// boundary added later inherits the guard for free — there is no per-boundary copy to drift.
// Metadata carrying no artifact key is untouched (zero behaviour change for every other write).
const baseMetadata = z
  .record(z.any())
  .superRefine((meta, ctx) => {
    for (const message of validateMetadataArtifactRefs(meta)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message });
    }
    // THE SECOND RESERVED KEY (P4 L1): `metadata.capture`,
    // the AUTHOR-DECLARED "how do I know this" block. It rides the SAME shared definition for
    // the SAME reason the artifact rule does — all ten write boundaries are covered by
    // construction, and a boundary added later inherits it with no copy to drift.
    //
    // The only thing enforced is the SHAPE OF THE FIELD ITSELF: a status must be from the
    // vocabulary, and `verified` must carry its evidence. Nothing here requires anyone to
    // write a capture block; metadata without one is untouched. That distinction is the
    // whole scope boundary of this layer.
    for (const message of validateMetadataCapture(meta)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message });
    }
    // THE THIRD RESERVED KEY: `metadata.gate`, the gate RUN — an exit code
    // and the ref it was measured on. It rides this SAME shared definition for the SAME
    // reason the two above do: all ten write boundaries are covered by construction.
    //
    // It differs from those two in WHY it is needed. `capture` was a NEW field given a shape
    // before anyone wrote one; `gate` was specced by captureVocab's REVIEW VERDICT shape,
    // shipped with no validator, and drifted — five spellings of the exit code and prose
    // sitting in the numeric field, measured on prod (counts in gateMetadataVocab.ts). The
    // read side had to grow a recognizer to cope, which is the class this closes at source.
    //
    // Only the THREE reserved sub-fields are typed (exit code / ref / run) plus their measured
    // mis-spellings; every other sub-key of the block stays free-form. Nothing here rewrites
    // or migrates a stored record — validation sees the caller's param only.
    for (const message of validateMetadataGate(meta)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message });
    }
    // THE FOURTH RULE ON THIS DEFINITION: the SAME leaked-tool-call-XML
    // hygiene the prose fields carry, applied to the WHOLE metadata subtree.
    //
    // THE HOLE IT CLOSES: `content` / `title` / `description` are wrapped in
    // artifactFreeText; `metadata` was not scanned at all. P4 L1 then made that the field we
    // actively push raw tool output into — its contract tells agents to cite "the command and
    // its output" in `metadata.capture.evidence`. So the field with the MOST tool output had
    // the LEAST hygiene of anything on the record.
    //
    // WHY THE WHOLE SUBTREE AND NOT `capture.evidence` (CLASSES.md C3 — name the population):
    // `evidence` is the key somebody happened to report. `metadata` is a free-form bag, so a
    // named-key check guards the shapes we remembered and passes the sibling invented next
    // quarter. The population here is EVERY string reachable in the bag, at any depth, in
    // objects and arrays alike — which needs no edit when a new reserved key appears.
    //
    // WHAT THIS ACCEPTS AND WHAT IT REFUSES — stated exactly, because `evidence` is command
    // output by design and a reader will trust this instead of re-measuring it. The predicate
    // is the IDENTICAL code-span-aware `findArtifactSignatures` the prose fields use:
    //   PASSES — ordinary command output, and a signature deliberately quoted in backticks.
    //     Confirmed against 20 adversarial controls (vitest output, heredocs, `awk` with bare
    //     angle brackets, HTML, a `<T,>` diff hunk, base64, mermaid, jest snapshots, git
    //     conflict markers, a 4000-line log).
    //   REFUSED — an XML-BEARING CAPTURE that contains one of the wrapper tags un-quoted. An
    //     RSS/Atom feed, a pom.xml, an Ant build.xml, a WSDL annotation and a Jenkins job
    //     config all carry `</description>`, and pasting one raw is rejected. That is a REAL
    //     false positive, not a hypothetical; the remedy is backticks or a fenced block.
    // This is NOT a new class: the identical payload is already refused in `contexts.content`
    // on this same tree, so the vocabulary is pre-existing and shipping. Applying the house
    // rule consistently is this change; narrowing the vocabulary would change `content` too
    // and is a product decision recorded separately, not something to patch here.
    const scan = findArtifactSignaturesDeep(meta);
    if (scan.findings.length > 0) {
      const shown = scan.findings.slice(0, METADATA_SCAN_MAX_REPORTED);
      const named = shown
        .map((f) => `metadata${f.path ? `.${f.path}` : ''} (${f.signatures.join(', ')})`)
        .join('; ');
      const more =
        scan.findings.length > shown.length
          ? ` …and ${scan.findings.length - shown.length} more`
          : '';
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          `contains leaked tool-call XML at ${named}${more} — this looks like a raw serialized ` +
          `tool call bled into the value, not real content. Re-send just the intended text. ` +
          `(Quoting these tags as documentation inside \`backticks\` is fine.)`,
      });
    } else if (scan.truncated) {
      // THE THIRD STATE, given its own branch (CLASSES.md C1): the walk hit its depth/node
      // bound, so part of the bag was NEVER LOOKED AT. Reporting that as clean is exactly the
      // failure where "could not measure" is silently spelled "no". This DOES refuse callers:
      // a bag nested deeper than METADATA_SCAN_MAX_DEPTH, or one holding more than
      // METADATA_SCAN_MAX_NODES nodes (a ~5000-element array reaches it, and a
      // machine-generated bag can), is rejected rather than stored unscanned. Both bounds are
      // config, so the fix for a legitimate caller that trips one is to raise the bound — not
      // to let an unscanned bag through.
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'is too deeply nested or too large to be scanned for leaked tool-call XML, so it ' +
          'cannot be accepted — an unscanned bag is not a clean bag. Flatten it, or move the ' +
          'bulk into an artifact reference.',
      });
    }
    // THE FOURTH RULE ON THIS DEFINITION: CREDENTIALS.
    //
    // THE HOLE IT CLOSES: nothing in this repo had ever detected a credential in ANY stored
    // field. The tool-XML rule above is not secret-scanning — it matches seven structural
    // wrapper tags from the 2026-07-17 degraded-client incident, and a synthetic credential
    // placed in `metadata.capture.evidence` stored successfully with it in force. Meanwhile
    // the P4 L1 capture contract INSTRUCTS agents to paste "the command and its output" here,
    // which is exactly where a token appears.
    //
    // WHY THE SAME SUBTREE WALK: identical reasoning to the rule above (CLASSES.md C3 — name
    // the population). `evidence` is the key somebody reported; `metadata` is a free-form bag.
    // The population is every string reachable in it, at any depth, and it needs no edit when
    // a new reserved key appears. Both rules share ONE walker (utils/inputHygiene.scanStringsDeep)
    // so they cannot drift in bounds or in truncation semantics.
    //
    // WHAT THIS ACCEPTS AND WHAT IT REFUSES — the ACCEPT half is the load-bearing one here,
    // because this field is command output by design and an over-broad scanner is the failure
    // mode (a scanner that cries wolf gets disabled, and then we have a guard that reads as
    // protection while providing none — an earlier decision rejected entropy detection for
    // exactly this reason):
    //   PASSES — ordinary command output, git shas, uuids, base64 payloads, docker sha256
    //     digests, diff hunks, `-----BEGIN CERTIFICATE-----` / `PUBLIC KEY` blocks, an env-var
    //     NAME, and `Authorization: Bearer $TOKEN` / `<token>` / `SCREAMING_SNAKE` placeholders.
    //   REFUSED — a provider token prefix followed by a real secret body, a PEM PRIVATE key
    //     header, and `Authorization: Bearer` carrying a token-shaped value.
    //   ACCEPTED MISS, on purpose — a bare hex/base64 blob with no structural marker.
    // The vocabulary is config/credentialDetectionConfig.ts; the controls are executed in
    // tests/credentialHygiene.unit.test.ts rather than asserted in this comment.
    //
    // NOTE THE MESSAGE NAMES A KIND, NEVER A VALUE: the detector returns ids, so
    // rejecting a leaked secret cannot itself echo the secret into the transcript.
    const credentialScan = findCredentialSignaturesDeep(meta);
    if (credentialScan.findings.length > 0) {
      const shown = credentialScan.findings.slice(0, CREDENTIAL_SCAN_MAX_REPORTED);
      const named = shown
        .map(
          (f) =>
            `metadata${f.path ? `.${f.path}` : ''} (${describeCredentialSignatures(f.matches)})`,
        )
        .join('; ');
      const more =
        credentialScan.findings.length > shown.length
          ? ` …and ${credentialScan.findings.length - shown.length} more`
          : '';
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          `contains what looks like a live credential at ${named}${more} — a stored record is ` +
          `a transcript, so a real secret must not be written into one. Remove or redact the ` +
          `value and re-send. (Only structurally-identifiable credentials are matched: a ` +
          `provider token PREFIX with no secret body after it is fine.)`,
      });
    }
    // No separate truncation branch: the walk is the SAME walk, with the same bounds, so a
    // truncated bag has already been refused by the tool-XML rule above. Adding a second
    // rejection here would only duplicate that message, never change the verdict — and the
    // contract that keeps it true (both rules use one walker) is asserted executably in
    // tests/credentialHygiene.unit.test.ts, not left to this comment.
  })
  .optional();
// RECALL payload control (T1 item 1): the read tools accept response_format to choose
// concise (default, truncated) vs detailed (full content). Enum sourced from the single
// config constant so the schema, route, and docs can't drift. Optional → route defaults
// to concise via RECALL_DEFAULT_FORMAT.
const recallResponseFormat = z.enum(RECALL_RESPONSE_FORMATS);
// THE ONE VOLUME VOCABULARY (SEARCH P3). Derived from
// config/altitudeConfig.ALTITUDES so the zod validator, the advertised inputSchema, the
// routes and the projection cannot drift — there is exactly one list. Every read tool that
// returns records takes THIS enum under THIS name; `response_format` above survives only as
// a DEPRECATED ALIAS for callers already in flight.
const altitudeEnum = z.enum(ALTITUDES as unknown as [string, ...string[]]);
// `projects.name` is the only column this alias guards (the dead naming_* schemas that
// also used it were deleted in the MCP-2026 rebuild Phase 1).
const baseName = z.string().min(1).max(cap('projects.name'));
// `projects.description` — a TEXT column. Was .max(2000), an invented limit.
// BOUNDARY HYGIENE: a project description is stored prose on the same
// memory surface as a context body, so it carries the same leaked-XML rule.
const baseDescription = artifactFreeText(z.string().max(cap('projects.description'))).optional();
// tags are an unbounded text[] on every table — these are transient anti-abuse guards.
//
// ── WHY THERE ARE TWO OF THESE ────────────────────────────────────────────
// `tags` was the LAST stored free-text field with no hygiene at all — not even the tool-XML
// rule every other stored string has carried since an earlier task. It stayed open because ONE
// definition served two opposite jobs: the tags you WRITE onto a record, and the tags you
// FILTER a search by. Wrapping the single shared definition would have made `context_search`
// THROW on a signature-bearing filter value — refusing to let you SEARCH for the poison you
// are trying to find. An earlier the builder correctly declined to make that call unilaterally;
// an earlier decision authorizes the split.
//
// The split is the fix, and the names carry the distinction so a new boundary cannot pick the
// wrong one by accident:
//   baseTagsWrite  — PERSISTED. Same hygiene as every other stored string.
//   baseTagsFilter — a READ predicate, never stored. Anti-abuse caps only, no hygiene, on
//                    purpose: a filter is a question about the store, not an addition to it.
const baseTagsFilter = z
  .array(z.string().max(transientCap('tagLength')))
  .max(transientCap('tagCount'))
  .optional();
const baseTagsWrite = z
  .array(artifactFreeText(z.string().max(transientCap('tagLength'))))
  .max(transientCap('tagCount'))
  .optional();
const baseQuery = z.string().min(1).max(transientCap('searchQuery'));
// SHARED numeric bases — bridge-safe by construction. Both are reused by several tools
// (baseLimit: context.search / decision.search / task.list / smart_search; baseRelevanceScore:
// context.store / context.update), so the coercion belongs HERE, once, not at each use.
const baseLimit = coercedInt(z.number().int().min(1).max(100).default(10));
const baseRelevanceScore = coercedFloat(z.number().min(0).max(10).optional());

// TYPED-EDGE enums — DERIVED from the single-source domain (config/edgeTypes.ts) so the
// zod validator, the model-facing inputSchema, AND the DB CHECK can never drift. Hoisted
// here (above the schemas that use them) so both the explicit link/unlink/get_links tools
// AND the first-class `links` write param (T5a) share ONE definition.
const edgeTypeEnum = z.enum(EDGE_TYPES as unknown as [string, ...string[]]);
const edgeNodeTypeEnum = z.enum(EDGE_NODE_TYPES as unknown as [string, ...string[]]);

// FIRST-CLASS `links` WRITE PARAM (T5a): an optional array on
// context_store / decision_record. Each element is EITHER an explicit edge spec OR a
// shorthand referent. The union is non-strict on extra keys at the spec level (the
// service's normalizeLinkSpec is the authority on which form a spec is); we validate the
// SHAPES the tool documents and reject the rest with an actionable message. The array
// bound derives from MAX_LINKS_PER_WRITE (config — no hardcoded variable).
//   (a) EXPLICIT : { edgeType, to, toType }
//   (b) SHORTHAND: { task } | { decision } | { context }  → informs / decided_by / learned_from
const explicitLinkSpec = z.object({
  edgeType: edgeTypeEnum,
  to: uuidOrShortId(),
  toType: edgeNodeTypeEnum,
});
const shorthandTaskLink = z.object({ task: uuidOrShortId() });
const shorthandDecisionLink = z.object({ decision: uuidOrShortId() });
const shorthandContextLink = z.object({ context: uuidOrShortId() });
const linkSpecSchema = z.union([
  explicitLinkSpec,
  shorthandTaskLink,
  shorthandDecisionLink,
  shorthandContextLink,
]);
const linksParam = z.array(linkSpecSchema).max(MAX_LINKS_PER_WRITE).optional();

// System Health Schemas
const mandrelSystemSchemas = {
  ping: z.object({
    message: z.string().max(transientCap('pingMessage')).optional()
  }),
  
  status: z.object({}),
  
  help: z.object({}),
  
  explain: z.object({
    toolName: z.string().min(1).max(transientCap('toolName'))
  }),
  
  examples: z.object({
    toolName: z.string().min(1).max(transientCap('toolName'))
  }),

  // THE AGENT CAPTURE CONTRACT (P4 L1). NO PARAMS BY DESIGN: it renders the
  // whole contract, which is short, and a filter param would be one more thing to guess
  // before you can ask what the shape is. Strict-empty, like status/help.
  contract: z.object({})
};

// Legacy alias for backward compatibility
const aidisSystemSchemas = mandrelSystemSchemas;

// Session Lifecycle Schemas (session-rework SR-2)
// Explicit user-controlled lifecycle. session_start accepts optional title/goal/project
// stamped onto the session row (session_goal → Session View). session_end/session_status
// take no params — they operate on THIS connection's current session (resolved from the
// same X-Connection-ID the route layer threads everywhere). Bounds mirror the existing
// session metadata limits (SessionManagementHandler.validateSessionParams: goal ≤ 1000).
const sessionLifecycleSchemas = {
  start: z.object({
    // BOUNDARY HYGIENE (finishing the sweep): both are PERSISTED prose —
    // routes/session.routes.ts stamps them onto the session row, and the Session View renders
    // them back. Same wrapper, same code-span exemption, as every other stored free-text field.
    title: artifactFreeText(z.string().min(1).max(cap('sessions.title'))).optional(),
    // DRIFT-FIX: was .max(1000), a bound copied from an older handler-side
    // check (SessionManagementHandler.validateSessionParams) rather than from the schema —
    // `sessions.session_goal` is TEXT. Derives from the column now.
    goal: artifactFreeText(z.string().max(cap('sessions.session_goal'))).optional(),
    // `project` is a NAME-or-ID lookup argument (routes/session.routes.ts resolveProject:
    // exact id → exact name → substring name). It inherits projects.name's bound, which is
    // >= a UUID's 36 chars so a canonical id always fits.
    project: z.string().min(1).max(cap('projects.name')).optional()
  }),

  end: z.object({}),

  status: z.object({})
};

// SESSION IDENTITY read schemas (Amp-orb eval W3). Both are READ-ONLY.
// session_list is project-scoped (name-or-id lookup → inherits projects.name's bound); its
// limit/offset bounds come from the identity config so the schema and the runtime clamp cannot
// disagree. session_get takes a full UUID or an 8+-hex short id — validated by the SAME
// shared uuidOrShortId() helper every other id-taking tool uses (one definition, no copy).
const sessionIdentitySchemas = {
  list: z.object({
    project: z.string().min(1).max(cap('projects.name')).optional(),
    allProjects: z.boolean().optional(),
    actor: z.string().min(1).max(cap('sessions.actor')).optional(),
    openOnly: z.boolean().optional(),
    limit: coercedInt(z.number().int().positive().max(SESSION_IDENTITY_CONFIG.listMaxLimit).optional()),
    offset: coercedInt(z.number().int().min(0).optional())
  }),

  get: z.object({
    // REUSES the shared uuidOrShortId() helper — the SAME predicate every other id-taking tool
    // validates with. A second copy of "what a valid id looks like" is the drift this codebase
    // keeps paying for.
    sessionId: uuidOrShortId()
  })
};

// Session PIN Schema (Sessions Foundation Phase 2a).
// The DB-persisted PIN is the user's "this is my session" targeting primitive, keyed by the
// caller's ACTOR (derived at the edge from X-Actor-ID / auth `sub`, never a tool arg). action
// selects get|set|clear; sessionId is the target for `set` (optional — defaults to the
// connection's current active session). INERT w.r.t. resolution in 2a: setting a pin does not
// change how sessions resolve until resolverMode leaves 'legacy' — it only persists intent.
const sessionPinSchema = z.object({
  action: z.enum(['get', 'set', 'clear']),
  sessionId: z.string().uuid().optional()
});

// Context Management Schemas
const contextSchemas = {
  store: z.object({
    // Store the user's FULL content — never silently lose data (the operator's no-data-loss
    // bar). The old .max(10000) cap rejected real conversational turns (~23k chars)
    // with a 500 and was the LongMemEval eval pain. There is no hard *storage* limit:
    // `contexts.content` is Postgres TEXT, and the embedding path is independently
    // bounded — the handler embeds only request.content.substring(0, 1000) (see
    // handlers/context.ts), so the local model's token limit (EMBEDDING_MAX_TEXT_LENGTH,
    // default 8000) is never reached regardless of stored length. The stored row keeps
    // everything and stays retrievable. The generous 5MB ceiling below is ONLY an
    // anti-abuse guard (well above any real turn and below express.json's 10mb body
    // limit) so a pathological payload can't OOM the process — it is not a content cap.
    // BOUNDARY HYGIENE: + artifactFreeText — contexts are the same memory
    // surface as tasks and can be poisoned the same way by a degraded client. Code-span
    // aware, so a context legitimately documenting tool-call XML inside backticks/fences
    // (common for us) still stores fine; only a RAW un-quoted leak is rejected.
    content: artifactFreeText(z.string().min(1).max(cap('contexts.content'))),
    // One source for the domain (config/contextTypes.ts) — the DB CHECK constraint and
    // mandrel-command's ContextTypeSchema are the other two copies that must agree.
    type: contextTypeEnum(),
    tags: baseTagsWrite,
    relevanceScore: baseRelevanceScore,
    metadata: baseMetadata,
    // FIRST-CLASS LINKS (T5a): mint typed edges from this context to other records, by
    // EXPLICIT spec or shorthand. Robust: a bad/unresolvable link warns (never breaks the
    // store); the record + good links still persist.
    links: linksParam,
    // AUTO-THREAD OPT-OUT (T5b): when true, SKIP the automatic
    // active-thread edges for this single write (the writer is being deliberate). The
    // param NAME is sourced from config (AUTO_THREAD_OPT_OUT_FLAG) so the schema, the
    // route check, and the docs can never drift. coercedBoolean() so "true"/"false" over
    // the HTTP bridge are handled. [autoThreadOptOut] is a computed key from that config.
    [AUTO_THREAD_OPT_OUT_FLAG]: coercedBoolean().optional(),
    // CARRIED FIELDS (P5.4) — MODE and SPINE as SCHEMA rather than prose a regex scrapes.
    // Both are plain OPTIONAL STRINGS on purpose, and `mode` is deliberately NOT a
    // z.enum(): the recognised vocabulary is a SUGGESTION (config/handoffCarriedFieldsConfig.ts),
    // and a zod enum would REJECT an unrecognised value at the boundary — turning "your
    // mode is unusual" into "your handoff was not stored". Losing a handoff is
    // catastrophic; storing an odd mode is not. Recognition happens in the service, which
    // warns and stores. The only bound here is the anti-abuse length cap every free string
    // on this surface carries.
    // BOUNDARY HYGIENE: free-text carried values, scanned like every other
    // stored string. This does NOT reintroduce the enum problem the comment above rejects —
    // an UNRECOGNISED mode still stores fine; only a raw structural leak is refused, and a
    // handoff whose MODE line is leaked XML has already lost the thing it was carrying.
    mode: artifactFreeText(z.string().max(transientCap('handoffMode'))).optional(),
    spine: artifactFreeText(z.string().max(transientCap('handoffSpine'))).optional(),
    projectId: z.string().optional(),
    sessionId: z.string().optional()
  }),
  
  search: z.object({
    // SHORT-ID SYMMETRY (T1 item 2): context_search.id used to be strict `.uuid()` while
    // every mutate/detail tool already accepts an 8+-hex short id via uuidOrShortId().
    // That asymmetry meant a tool-only agent who copied a short id from a list couldn't
    // do a direct context_search by it. Now it accepts a full UUID OR an id8, resolved
    // (project-scoped, parameterized, wildcard-rejecting) in the handler exactly like the
    // other tools. Direct lookup by context id — bypasses semantic search.
    id: uuidOrShortId().optional(),
    query: z.string().min(1).max(transientCap('searchQuery')).optional(), // Optional when id is provided
    type: contextTypeEnum().optional(),
    tags: baseTagsFilter,
    limit: baseLimit,
    minSimilarity: coercedFloat(z.number().min(0).max(100).optional()),
    offset: coercedInt(z.number().int().min(0).optional()),
    projectId: z.string().optional(),
    sessionId: z.string().optional(),
    // ADDITIVE structured created_at range (an earlier task — search consolidation). ISO
    // timestamps; forwarded to the one engine as `created_at >= dateFrom` / `<= dateTo`.
    // Optional → no behavior change for existing callers.
    dateFrom: z.string().optional(),
    dateTo: z.string().optional(),
    // RECALL payload control (T1 item 1): 'concise' (default) truncates each content to
    // RECALL_CONCISE_MAXLEN with a "fetch full" affordance; 'detailed' returns full
    // content. Fixes the heaviest path dumping full bodies ×N. Default applied in-route.
    response_format: recallResponseFormat.optional(),
    // THE ADVERTISED SIZE DIAL (SEARCH P3): headline | summary | full, the
    // same three values with the same meaning on every read tool. Default applied in-route
    // from RECALL_DEFAULT_ALTITUDE (still `full` — see recallConfig for why that default
    // must not become `summary`).
    altitude: altitudeEnum.optional(),
    // SOFT-DELETE: by DEFAULT exclude archived contexts (archived_at IS
    // NULL). Pass includeArchived:true to also return archived rows. coercedBoolean() so
    // the bridge's "true"/"false" string is accepted (never the truthiness footgun).
    includeArchived: coercedBoolean().optional()
  }).refine(data => data.id || data.query || (data.tags !== undefined && data.tags.length > 0), {
    // Accept a TAGS-ONLY call (id OR query OR a non-empty tags array). A tags-only
    // request is answered by the existing `tags && $1` GIN filter (no dummy query
    // needed). Behavior when a query is present is unchanged.
    message: "Provide at least one of: 'id', 'query', or a non-empty 'tags' array"
  }),
  
  get_recent: z.object({
    limit: coercedInt(z.number().int().min(1).max(20).default(5)),
    projectId: z.string().optional(),
    // RECALL payload control (T1 item 1): 'concise' (default) truncates each content;
    // 'detailed' returns full content. Same policy + config as context_search.
    response_format: recallResponseFormat.optional(),
    // THE ADVERTISED SIZE DIAL (SEARCH P3) — same enum, same semantics.
    altitude: altitudeEnum.optional(),
    // SOFT-DELETE: exclude archived by default; includeArchived:true reveals them.
    includeArchived: coercedBoolean().optional()
  }),

  // CURATE (T1 item 4 — redesign §4 Capability 4): context_update. Contexts were
  // IMMUTABLE after write (only soft-delete/restore existed), so a typo'd thread tag or a
  // stale back-link couldn't be repaired — the linking grammar wasn't curate-able. This
  // edits a stored context: content, tags (re-tag/re-thread), metadata (MERGE, not
  // replace — T1 item 6), relevanceScore. Accepts a full UUID or 8+-hex short id
  // (resolved project-scoped in the handler). Strict: only declared keys. At least one
  // editable field required (contextId/projectId are not edits).
  update: z.object({
    contextId: uuidOrShortId(),
    // same ceiling as store (anti-abuse, not a content cap) + artifactFreeText
    // so the edit path can't smuggle in the leak the store path now rejects.
    content: artifactFreeText(z.string().min(1).max(cap('contexts.content'))).optional(),
    tags: baseTagsWrite, // re-tag / re-thread (validated+normalized by the handler like store)
    // metadata is MERGED shallow over the existing object (T1 item 6); an explicit null
    // value DELETES that key. baseMetadata is z.record(z.any()), so null values are
    // accepted here and interpreted as deletes by mergeMetadata.
    metadata: baseMetadata,
    relevanceScore: baseRelevanceScore,
    projectId: z.string().optional()
  }).refine(
    data => data.content !== undefined || data.tags !== undefined ||
            data.metadata !== undefined || data.relevanceScore !== undefined,
    { message: 'At least one field to update must be provided (content, tags, metadata, relevanceScore)' }
  ),

  // ARTIFACT REFERENCE RESOLUTION. Reads the structured
  // artifact references stored on a record's metadata and returns, per reference: the SOURCE,
  // the EXPECTED IDENTITY (hash/head/base) and RETRIEVAL INSTRUCTIONS — the deterministic
  // lookup that replaces reading a handoff's prose. Supplying observed* asks for an ACCEPTANCE
  // ADJUDICATION, which is fail-closed: a mismatch is a loud error, never a warning.
  artifact: z.object({
    id: uuidOrShortId(),
    recordType: z.enum(['context', 'task', 'decision']).optional(),
    // Which reference to adjudicate when observed* are supplied (default 0). Resolution
    // always covers EVERY reference on the record regardless.
    index: coercedInt(z.number().int().min(0).optional()),
    // What the caller MEASURED after fetching the artifact. Hex shapes are checked here so a
    // garbage "observation" can never be silently compared and silently pass.
    // NOTE (the reviewer N-B, the optional half): tightening these to the config's exact hex
    // lengths would change the DERIVED tools/list inputSchema — i.e. the golden fixture, which
    // is the reviewer's to regenerate from the merged source. The nit was explicitly "fix it if
    // it's free"; a wire-surface change is not free, so it is deliberately NOT made here. The
    // safe degrade is unchanged and now reports honestly: a too-short revision comes back as
    // `inconclusive` ("supplied but too abbreviated to confirm"), never as acceptance and never
    // as the caller's silence. See compareIdentity in services/artifactRef.ts.
    observedSha256: z.string().regex(/^[0-9a-fA-F]+$/, 'observedSha256 must be hex').optional(),
    observedHead: z.string().regex(/^[0-9a-fA-F]+$/, 'observedHead must be hex').optional(),
    projectId: z.string().optional()
  }),

  // STRICT-MODE SAFETY: the handler (context.routes.handleStats) reads
  // args.projectId via resolveProjectId to scope the stats, so projectId is a REAL,
  // accepted-and-used param. It was missing from the zod schema, so under strict mode a
  // legitimate project-scoped call would have been wrongly rejected. Declare it (don't
  // drop it) — declared == accepted == handler-reads.
  stats: z.object({
    projectId: z.string().optional(),
    // SOFT-DELETE: archived contexts are EXCLUDED from every count by
    // default so the numbers reconcile with context_search. SAME param name and meaning as
    // contextSchemas.search's includeArchived — one concept, one spelling.
    includeArchived: coercedBoolean().optional()
  }),

  // SOFT-DELETE / ARCHIVE: reversible cleanup through the public tool
  // surface (no raw SQL). `delete` sets archived_at=now(); `restore` clears it. Both
  // accept a full UUID OR an 8+-hex short id (resolved project-scoped in the handler).
  delete: z.object({
    contextId: uuidOrShortId(),
    projectId: z.string().optional()
  }),
  restore: z.object({
    contextId: uuidOrShortId(),
    projectId: z.string().optional()
  })
};

// Allowed project status values — must match the DB CHECK constraint on projects.status
const projectStatusEnum = z.enum(['active', 'archived', 'completed', 'paused']);

// Project Management Schemas
const projectSchemas = {
  create: z.object({
    name: baseName,
    description: baseDescription,
    status: projectStatusEnum.optional(),
    gitRepoUrl: z.string().optional(),
    rootDirectory: z.string().optional(),
    metadata: baseMetadata
  }),

  update: z.object({
    project: z.string().min(1).max(cap('projects.name')), // project id or name to update
    name: baseName.optional(),
    description: artifactFreeText(z.string().max(cap('projects.description'))).nullable().optional(),
    status: projectStatusEnum.optional(),
    gitRepoUrl: z.string().optional(),
    rootDirectory: z.string().optional(),
    metadata: baseMetadata
  }).refine(
    data => data.name !== undefined || data.description !== undefined ||
            data.status !== undefined || data.gitRepoUrl !== undefined ||
            data.rootDirectory !== undefined || data.metadata !== undefined,
    { message: 'At least one field to update must be provided (name, description, status, gitRepoUrl, rootDirectory, metadata)' }
  ),

  delete: z.object({
    project: z.string().min(1).max(cap('projects.name')), // project id or name to delete
    confirm: z.boolean().optional().default(false)
  }),

  switch: z.object({
    project: z.union([
      z.string().uuid(), // Project ID
      z.string().min(1).max(cap('projects.name')) // Project name
    ])
  }),
  
  info: z.object({
    project: z.string().min(1).max(cap('projects.name')),
    // `contextCount` counts LIVE contexts by default; includeArchived:true
    // widens it. Same spelling + default as every other includeArchived.
    includeArchived: coercedBoolean().optional()
  }),

  // WS2 living summary: project optional → the caller's current project.
  // FIX A: `spine` optional → scope the briefing to THIS branch instead of the connection's
  // open position, through the SAME uuidOrShortId contract branch_open and branch_history
  // use (resolved project-scoped across context/decision/task, never first-match — one
  // resolver, services/spineResolver.ts). Present-but-refused when the branch-scope flag is
  // off; the refusal is reported in structuredContent, never silently ignored.
  briefing: z.object({
    project: z.string().min(1).max(cap('projects.name')).optional(),
    spine: uuidOrShortId().optional()
  }),

  // REPROJECT: MOVE a record between projects, preserving its
  // id, timestamps, session provenance and typed edges. All three params are REQUIRED —
  // there is no ambient fallback for either end of a move, deliberately: a destination that
  // defaulted to "the caller's current project" is the project-slot bleed that MISFILES
  // records in the first place, wired into the tool meant to repair them.
  moveRecord: z.object({
    recordType: z.enum(REPROJECT_RECORD_TYPES as unknown as [string, ...string[]]),
    recordId: uuidOrShortId(),
    toProject: z.string().min(1).max(cap('projects.name'))
  }),

  list: z.object({
    includeStats: z.union([z.boolean(), z.string().transform(val => val === 'true')]).optional().default(false),
    // PAGINATION: project_list used to return EVERY project unbounded
    // (output bloat as the project count grows). Add a bounded page window mirroring
    // task_list's limit/offset, but with a project-appropriate DEFAULT of 20 (projects
    // are far fewer than tasks; 20 fits a typical workspace without truncating). Both
    // arrive as STRINGS over the bridge → coercedInt() (numeric sibling of
    // coercedBoolean) so "20"/"40" validate. Truncation is reported honestly in-route
    // (total vs returned + a "showing N of M" note) — never a silent cut.
    limit: coercedInt(z.number().int().min(1).max(100).default(20)),
    offset: coercedInt(z.number().int().min(0).optional()),
    // with includeStats, `contextCount` counts LIVE contexts by default;
    // includeArchived:true widens every row's count. Same spelling + default as elsewhere.
    includeArchived: coercedBoolean().optional()
  }),
  
  current: z.object({}),

  insights: z.object({
    projectId: z.string().optional(),
    // SOFT-DELETE: archived rows are EXCLUDED from all three entity
    // breakdowns by default so they reconcile with context_search / decision_search /
    // task_list. SAME param name and meaning as those three — one concept, one spelling
    //.
    includeArchived: coercedBoolean().optional()
  }),

  // TAG CENSUS. `includeArchived` is spelled and defaulted EXACTLY as on
  // the search/list tools — one concept, one spelling — because a
  // census whose population disagreed with the ops it is used to plan against would be a
  // new instrument that lies quietly.
  tags: z.object({
    projectId: z.string().optional(),
    // Cap DERIVED from the tag-length limit, never hand-typed: a tag PREFIX cannot
    // usefully be longer than a tag.
    prefix: z.string().min(1).max(transientCap('tagLength')).optional(),
    entities: z.array(z.enum(['context', 'decision', 'task'])).min(1).optional(),
    includeArchived: coercedBoolean().optional(),
    limit: coercedInt(z.number().int().min(1).max(TAG_CENSUS_MAX_LIMIT).optional()),
  })
};

// Technical Decision learning-loop enums — DERIVED from the single-source domain
// (config/decisionVocab.ts) so the zod validator, the TS union in handlers/decisions.ts,
// the model-facing prose in opRegistry, AND the DB CHECK constraints on
// technical_decisions can never drift (same pattern as edgeTypeEnum
// above). Reused by record + update + SEARCH so all three tools share one definition.
const outcomeStatusEnum = z.enum(OUTCOME_STATUSES as unknown as [string, ...string[]]);
const implementationStatusEnum = z.enum(IMPLEMENTATION_STATUSES as unknown as [string, ...string[]]);
// THE DECISION INBOX — a FOURTH status column,
// derived from config/decisionVocab.ts exactly like the two above so the validator, the DB
// CHECK (migration 104), and the opRegistry prose cannot drift apart.
const answerStatusEnum = z.enum(ANSWER_STATUSES as unknown as [string, ...string[]]);

/**
 * One `options[]` entry on an open decision. SHAPE only — the BUSINESS rule ("an open
 * decision needs >=2 options, each with >=1 pro and >=1 con") is a TYPED refusal enforced by
 * handlers/decisions.ts (validateOpenDecisionShape), not here: zod .parse() failures are
 * generic, and the punch specifically requires a refusal that NAMES the field. pros/cons
 * default to `[]` (never undefined) so that predicate can test `.length === 0` uniformly.
 * BOUNDARY HYGIENE (an earlier task precedent): free-text sub-fields wrapped the same way
 * `alternativesConsidered` above is.
 */
const decisionOptionSchema = z.object({
  key: z.string().min(1),
  label: artifactFreeText(z.string().min(1)),
  pros: z.array(artifactFreeText(z.string())).optional().default([]),
  cons: z.array(artifactFreeText(z.string())).optional().default([]),
  recommended: z.boolean().optional(),
});

// Technical Decision Schemas
const decisionSchemas = {
  record: z.object({
    decisionType: z.enum(['architecture', 'library', 'framework', 'pattern', 'api_design', 'database', 'deployment', 'security', 'performance', 'ui_ux', 'testing', 'tooling', 'process', 'naming_convention', 'code_style']),
    // BOUNDARY HYGIENE: decisions are the same memory surface — wrap the
    // free-text prose fields so a degraded client can't poison them either (code-span aware).
    title: artifactFreeText(z.string().min(1).max(cap('technical_decisions.title'))),
    // DRIFT-FIX: description was .max(5000) and rationale .max(2000) —
    // both TEXT columns. The rationale is the "why" behind a decision; it is the last
    // prose we should be truncating. Both now carry the anti-abuse ceiling only. Safe
    // because the embed text these feed is bounded at the call site (handlers/decisions.ts).
    description: artifactFreeText(z.string().min(1).max(cap('technical_decisions.description'))),
    rationale: artifactFreeText(z.string().max(cap('technical_decisions.rationale'))),
    impactLevel: z.enum(['low', 'medium', 'high', 'critical']),
    // BOUNDARY HYGIENE (the sibling sweep): these four are PERSISTED prose an
    // agent writes, and they were the only decision free-text fields left unscanned while
    // every field around them was wrapped. Same code-span-aware predicate — quoted docs pass.
    alternativesConsidered: z.array(z.object({
      name: artifactFreeText(z.string()),
      pros: z.array(artifactFreeText(z.string())).optional(),
      cons: z.array(artifactFreeText(z.string())).optional(),
      reasonRejected: artifactFreeText(z.string())
    })).optional(),
    problemStatement: artifactFreeText(z.string().max(cap('technical_decisions.problem_statement'))).optional(),
    // Learning-loop fields settable UP FRONT (capture). success_criteria is the
    // moat field: record what "success" looks like now, evaluate it later via
    // decision_update.outcomeStatus. implementationStatus tracks the build lifecycle.
    // BOUNDARY HYGIENE: free-text learning-loop prose → artifactFreeText.
    successCriteria: artifactFreeText(z.string().max(cap('technical_decisions.success_criteria'))).optional(),
    implementationStatus: implementationStatusEnum.optional(),
    // A1: outcome fields are also settable AT RECORD TIME (mirroring implementationStatus,
    // which already round-trips on create). Previously zod's .parse() silently stripped
    // these on create → a decision recorded with a known outcome lost it. outcomeStatus
    // defaults to 'unknown' in the DB when unset; 'too_early' etc. are allowed.
    outcomeStatus: outcomeStatusEnum.optional(),
    outcomeNotes: artifactFreeText(z.string().max(cap('technical_decisions.outcome_notes'))).optional(),
    lessonsLearned: artifactFreeText(z.string().max(cap('technical_decisions.lessons_learned'))).optional(),
    // BOUNDARY HYGIENE: write-only persisted strings — scanned. (Unlike
    // `tags`, this schema is not shared with a read/search param, so wrapping it changes no
    // read behaviour.)
    affectedComponents: z.array(artifactFreeText(z.string())).optional(),
    tags: baseTagsWrite.optional(),
    // FIRST-CLASS LINKS (T5a): mint typed edges from this decision to other records, by
    // EXPLICIT spec or shorthand. Same robustness contract as context_store — a bad link
    // warns (never breaks the record); the decision + good links still persist.
    links: linksParam,
    projectId: z.string().optional(),
    metadata: baseMetadata.optional(),
    // THE DECISION INBOX: omitted -> stored as 'decided',
    // byte-identical to today. 'open' REQUIRES a non-empty question + >=2 well-formed options
    // (typed refusal, handlers/decisions.ts validateOpenDecisionShape) — nothing written on
    // failure. See gateway.decision.record's humanDescriptions for the full rule.
    answerStatus: answerStatusEnum.optional(),
    question: artifactFreeText(z.string().max(cap('technical_decisions.question'))).optional(),
    options: z.array(decisionOptionSchema).optional(),
    deadline: z.string().datetime({ offset: true }).nullable().optional(),
  }),

  search: z.object({
    query: z.string().min(1).max(transientCap('searchQuery')).optional(), // Make query optional for flexible filtering
    limit: baseLimit,
    // Add all parameters the handler actually supports (all optional)
    decisionType: z.enum(['architecture', 'library', 'framework', 'pattern',
      'api_design', 'database', 'deployment', 'security', 'performance',
      'ui_ux', 'testing', 'tooling', 'process', 'naming_convention', 'code_style']).optional(),
    status: z.enum(['active', 'deprecated', 'superseded', 'under_review']).optional(),
    // outcomeStatus is a SEPARATE column from `status` (the lifecycle): it filters the
    // learning-loop result column (technical_decisions.outcome_status). This is the
    // moat-critical READ filter for the GAP1 Evaluator — "show me the decisions that
    // FAILED / SUCCEEDED" — which `status` (active/deprecated/…) cannot express. Enum
    // matches the DB CHECK constraint exactly (outcomeStatusEnum, reused).
    outcomeStatus: outcomeStatusEnum.optional(),
    // implementationStatus is a THIRD, separate column (technical_decisions.
    // implementation_status): "has the thing we decided actually been BUILT?" — as opposed to
    // `status` (lifecycle) and `outcomeStatus` (how it turned out). It was already RETURNED in
    // every search result but was not QUERYABLE, so the half-executed-decision class could be
    // seen only one record at a time by someone who had already found the records some other
    // way. That blind spot let an earlier decision read `planned` for 12 days after the work
    // shipped and then had an audit DERIVE "unstarted" from it. an earlier Task
    // . Enum DERIVED from config/decisionVocab.ts — the SAME implementationStatusEnum
    // decision_update and decision_record use, never a second copy of the list.
    implementationStatus: implementationStatusEnum.optional(),
    // THE DECISION INBOX filter: answerStatus:'open' is the
    // inbox read — "every decision waiting on a human." A FOURTH status column, distinct
    // from status/outcomeStatus/implementationStatus above.
    answerStatus: answerStatusEnum.optional(),
    impactLevel: z.enum(['low', 'medium', 'high', 'critical']).optional(),
    component: z.string().optional(),
    tags: baseTagsFilter.optional(),
    // REAL PAGINATION. `limit` is capped at 100, and decision_search had NO
    // offset — so a filter class with more than 100 members could not be enumerated through
    // the public tool at all, and the OUTPUT schema advertised `offset`/`hasMore` it never
    // returned. Bridge-safe via coercedInt (an MCP client serializes args as JSON and can
    // send "100"). This used to note that it mirrored project_list "rather than task_list's
    // bare z.number()" — i.e. the defect was seen, routed around locally, and left in place
    // to be copied again. There is no longer a bare one to route around:
    // coercedInt()/coercedFloat() is the standing rule for every numeric param, enforced by
    // numericParamCoercion.contract.test.ts.
    offset: coercedInt(z.number().int().min(0).optional()),
    // SORT DIRECTION over decision_date. The point of the implementationStatus
    // filter is the STALENESS list — "which decisions have been 'planned' the longest" — which
    // is inherently oldest-first, and the only order this tool could ever produce was
    // newest-first. On a semantic query this is the TIEBREAKER after relevance; relevance still
    // ranks first. Default 'newest' keeps every existing caller byte-identical.
    sortDirection: z.enum(['newest', 'oldest']).optional(),
    projectId: z.string().optional(),
    // includeOutcome arrives as a STRING over the bridge ("true"/"false"); coerce it
    // so a tool-only client isn't rejected with "Expected boolean, received string".
    includeOutcome: coercedBoolean().optional(),
    // SOFT-DELETE: exclude archived decisions by default; includeArchived
    // reveals them. coercedBoolean() for the same string-from-bridge reason as above.
    includeArchived: coercedBoolean().optional()
    // Note: dateFrom/dateTo excluded - complex date parsing not needed for AI ease-of-use
  }),

  // decision_get: fetch a SINGLE decision by id with FULL detail (all fields incl.
  // the learning-loop outcome fields). Mirrors context_search's `id` direct-lookup
  // idiom (bypasses semantic search). Accepts a full UUID OR an 8+-hex short id
  // — the short id is resolved → full UUID in the handler.
  get: z.object({
    decisionId: uuidOrShortId(),
    projectId: z.string().optional()
  }),
  
  // DEFECT A FIX (decision_update was a no-op through the bridge): the zod schema
  // declared `outcome`/`lessons` but the route handler reads outcomeStatus/
  // outcomeNotes/lessonsLearned. zod uses .parse() (not .strict()), so the real
  // params were SILENTLY STRIPPED → the handler got all-undefined → updateDecision
  // threw "No update fields provided". This schema now declares EXACTLY the params
  // the handler reads (declared==handler boundary, a past incident class fix), with the
  // learning-loop enums validated against the DB CHECK constraints.
  update: z.object({
    // Accepts a full UUID OR an 8+-hex short id; resolved in the handler.
    decisionId: uuidOrShortId(),
    status: z.enum(['active', 'deprecated', 'superseded', 'under_review']).optional(),
    // Learning-loop fields settable AFTER THE FACT (evaluate → correct).
    // Every cap here derives from its TEXT column — and derives from the
    // SAME registry entries decision_record uses, so the capture path and the evaluate path
    // can no longer disagree about how much a field may hold.
    // BOUNDARY HYGIENE: the evaluate/curate path mirrors decision_record —
    // wrap the same free-text prose fields so a leak can't enter via update either.
    outcomeStatus: outcomeStatusEnum.optional(),
    outcomeNotes: artifactFreeText(z.string().max(cap('technical_decisions.outcome_notes'))).optional(),
    lessonsLearned: artifactFreeText(z.string().max(cap('technical_decisions.lessons_learned'))).optional(),
    implementationStatus: implementationStatusEnum.optional(),
    successCriteria: artifactFreeText(z.string().max(cap('technical_decisions.success_criteria'))).optional(),
    problemStatement: artifactFreeText(z.string().max(cap('technical_decisions.problem_statement'))).optional(),
    // CONTRACT SYMMETRY (follow-up to the dependency id8 resolver): supersededBy was the LAST
    // decision id arg still demanding a full `.uuid()` — it rejected the id8 short form
    // every other id-accepting arg (decisionId here, task deps, link endpoints) accepts.
    // Now uuidOrShortId(); the handler resolves an id8 → full UUID (resolveEntityId,
    // project-scoped) BEFORE the DB write, so the uuid column never sees a short id.
    supersededBy: uuidOrShortId().optional(),
    supersededReason: artifactFreeText(z.string().max(cap('technical_decisions.superseded_reason'))).optional(),
    // CURATE (T1 item 5): edit title / description / tags after the fact (previously
    // decision_update could touch only the learning-loop + supersession fields, never the
    // core prose or tags). title/description match decision_record's bounds; tags
    // re-tag/re-thread the decision. metadata is MERGED shallow (T1 item 6) — explicit
    // null deletes a key. (decision_record already accepts metadata; this makes it
    // editable.) title/description changes re-embed downstream (handler) so search stays
    // in sync.
    title: artifactFreeText(z.string().min(1).max(cap('technical_decisions.title'))).optional(),
    description: artifactFreeText(z.string().min(1).max(cap('technical_decisions.description'))).optional(),
    tags: baseTagsWrite.optional(),
    metadata: baseMetadata.optional(),
    // THE DECISION INBOX: answerStatus='open' is validated
    // against the MERGED row (this call's question/options, else the existing row's) in
    // handlers/decisions.ts — a typed refusal naming the field, nothing written.
    answerStatus: answerStatusEnum.optional(),
    question: artifactFreeText(z.string().max(cap('technical_decisions.question'))).optional(),
    options: z.array(decisionOptionSchema).optional(),
    deadline: z.string().datetime({ offset: true }).nullable().optional(),
    // projectId scopes the SHORT-ID resolution of decisionId to one project.
    // Optional + not an updatable field, so it's excluded from the .refine
    // "at least one field to update" check below. Declared so strict mode accepts it.
    projectId: z.string().optional()
  }).refine(
    data => data.status !== undefined || data.outcomeStatus !== undefined ||
            data.outcomeNotes !== undefined || data.lessonsLearned !== undefined ||
            data.implementationStatus !== undefined || data.successCriteria !== undefined ||
            data.problemStatement !== undefined || data.supersededBy !== undefined ||
            data.supersededReason !== undefined || data.title !== undefined ||
            data.description !== undefined || data.tags !== undefined ||
            data.metadata !== undefined || data.answerStatus !== undefined ||
            data.question !== undefined || data.options !== undefined ||
            data.deadline !== undefined,
    { message: 'At least one field to update must be provided (status, outcomeStatus, outcomeNotes, lessonsLearned, implementationStatus, successCriteria, problemStatement, supersededBy, supersededReason, title, description, tags, metadata, answerStatus, question, options, deadline)' }
  ),

  // STRICT-MODE SAFETY: decisions.routes.handleStats reads args.projectId via
  // resolveProjectId to scope the stats — a real accepted-and-used param. Declare it so
  // strict mode doesn't reject a legitimate project-scoped call.
  stats: z.object({
    projectId: z.string().optional(),
    // SOFT-DELETE: archived decisions are EXCLUDED from every stats
    // breakdown by default, so the counts reconcile with decision_search. This is the
    // SAME param name and the SAME meaning as decisionSchemas.search's includeArchived —
    // deliberately not a second spelling for one concept.
    includeArchived: coercedBoolean().optional()
  }),

  // SOFT-DELETE / ARCHIVE: reversible cleanup. delete → archived_at=now();
  // restore → archived_at=NULL. Accepts full UUID or 8+-hex short id (resolved in handler).
  delete: z.object({
    decisionId: uuidOrShortId(),
    projectId: z.string().optional()
  }),
  restore: z.object({
    decisionId: uuidOrShortId(),
    projectId: z.string().optional()
  }),

  // THE DECISION INBOX.
  // decision_answer: pick an option on an open/discussing decision. `option` names an
  // `options[].key` on the row itself — validated in handlers/decisions.ts (a typed refusal
  // if unknown), not here (zod cannot see the row's own options).
  answer: z.object({
    decisionId: uuidOrShortId(),
    option: z.string().min(1),
    note: artifactFreeText(z.string().max(cap('technical_decisions.answer_note'))).optional(),
    projectId: z.string().optional()
  }),
  // decision_discuss: the escape hatch — kick an open decision back for more context.
  discuss: z.object({
    decisionId: uuidOrShortId(),
    note: artifactFreeText(z.string().max(cap('technical_decisions.answer_note'))).optional(),
    projectId: z.string().optional()
  })
};

// Task enums — defined ONCE and reused across task_create/list/update/bulk_update
// so the advertised + accepted value sets can never drift apart (one
// centralized definition, not N copies). taskStatusEnum INCLUDES 'cancelled' to
// match the `tasks.status` column (varchar(50), no CHECK constraint — see the
// COMMENT in 000_baseline_schema.sql which documents 'cancelled' as a real value).
// Previously task_create/list/update advertised only todo/in_progress/completed/
// blocked while task_bulk_update already allowed 'cancelled' → a status the DB
// accepts was rejected by the validator on the single-task path (A3).
const taskStatusEnum = z.enum(['todo', 'in_progress', 'blocked', 'completed', 'cancelled']);
// P5.5 / migration 093 — WHO must act next. Built from BLOCKED_ON_VALUES rather than typed
// here, so the advertised value set, the accepted value set and the database's CHECK
// constraint cannot drift apart (one centralized definition, not N copies).
// `.nullable()` is deliberate and is NOT the same as `.optional()`: OMITTED means "do not
// touch this field" and the statement never names the column; explicit NULL means "clear
// it", and both must be expressible or a caller can set a value and never unset it.
const taskBlockedOnEnum = z.enum(
  BLOCKED_ON_VALUES as unknown as [string, ...string[]],
);
const taskPriorityEnum = z.enum(['low', 'medium', 'high', 'urgent']);
const taskTypeEnum = z.enum(['feature', 'bug', 'bugfix', 'refactor', 'test', 'review', 'docs', 'documentation', 'devops', 'general']);
// THE PUNCH LIST LANE (migration 101). Defined ONCE from
// config/taskStageConfig.ts (a past incident — one centralized definition, not N copies) so the
// advertised value set, the accepted value set and the DB CHECK cannot drift apart, the same
// discipline taskBlockedOnEnum above follows for BLOCKED_ON_VALUES.
const taskStageEnum = z.enum(TASK_STAGES as unknown as [string, ...string[]]);
// THE STRUCTURED PUNCH CONTRACT. ONE
// `{ text, owner, proof? }` clause of `punch.doneWhen`. `owner`/`proof` are left OPTIONAL
// here (not `.refine()`d into requiredness) so a malformed clause — one missing `owner`, or
// a `lane` clause missing `proof` — reaches services/taskPunchCompleteness.ts, which is
// what produces the exact `doneWhen[<i>].<field>` refusal path a caller can act on, instead
// of a generic zod error naming the whole array. `.passthrough()` so an extra, forward-
// compatible key on a clause is never silently stripped.
const punchDoneWhenClauseParam = z.object({
  text: z.string().max(transientCap('punchDoneWhen')).optional(),
  owner: z.enum(PUNCH_CLAUSE_OWNERS as unknown as [string, ...string[]]).optional(),
  proof: z.string().max(transientCap('punchProof')).optional(),
}).passthrough();

// The punch-list "done when / how proven / where it came from" object (task_create /
// task_update). Stored by shallow merge into `metadata.punch` — see utils/punchMerge.ts.
// Each field independently optional so a caller can fill the form progressively across
// multiple calls without erasing what an earlier call set.
// Each field `.nullable()` — matching baseMetadata's "explicit null deletes a key" merge
// contract (utils/punchMerge.ts) — so a caller can clear ONE punch field (e.g. re-opening
// `proofKind` while keeping `doneWhen`) without deleting the whole object via metadata.
const punchParam = z.object({
  // THE STRUCTURED CONTRACT: an array of clauses is REQUIRED at stage='ready' (services/
  // taskPunchCompleteness.ts refuses a string, an empty array, or a malformed clause there
  // — naming the exact field). The bare STRING branch is the LEGACY shape: still accepted
  // here (so an in-flight row sitting at any OTHER stage keeps working, an earlier decision's
  // "unguarded off-ready" rule), but refused the moment the row is AT or MOVING TO ready.
  doneWhen: z.union([
    z.string().min(1).max(transientCap('punchDoneWhen')),
    z.array(punchDoneWhenClauseParam).max(TASK_MAX_PUNCH_CLAUSES),
  ]).nullable().optional(),
  proofKind: z.enum(PUNCH_PROOF_KINDS as unknown as [string, ...string[]]).nullable().optional(),
  source: z.enum(PUNCH_SOURCES as unknown as [string, ...string[]]).nullable().optional(),
  // repo-relative paths/globs the change will edit. Optional; when present each entry must
  // be a non-empty string (a caller who means "nothing yet" omits the field, not `[""]`).
  touches: z.array(z.string().min(1).max(transientCap('punchTouches'))).max(TASK_MAX_PUNCH_TOUCHES).nullable().optional(),
  // SERVER-MIRRORED, NEVER CALLER-WRITABLE: the SAME id shape `dependencies`
  // accepts (full UUID or 8+-hex short id). Declared here so the shape is documented and
  // validated on the wire; utils/punchMerge.ts#reconcilePunchDependsOn is what actually
  // enforces "only via `dependencies`" and refuses a direct set with [PUNCH_DEPENDS_ON_DIRECT].
  dependsOn: z.array(uuidOrShortId()).max(TASK_MAX_DEPENDENCIES).optional(),
}).optional();

// Task Management Schemas
const taskSchemas = {
  create: z.object({
    // BOUNDARY HYGIENE: artifactFreeText rejects a title carrying raw
    // leaked tool-call XML (a degraded client's serialized call bleeding into the value).
    title: artifactFreeText(z.string().min(1).max(cap('tasks.title'))),
    // THE HEADLINE FIX: was .max(2000) against a TEXT column. That cap
    // rejected a live incident record three times in two minutes and forced a spec out of
    // a task and into a context — breaking the "task is the spine of a thread" doctrine.
    // A task description now carries whatever the writer needs, guarded only by the shared
    // anti-abuse ceiling. BOUNDARY HYGIENE: + artifactFreeText — the 12
    // corrupted records leaked raw `</description>`/`<parameter name=` XML here; reject it
    // at the edge (code-span-quoted docs still pass).
    description: artifactFreeText(z.string().max(cap('tasks.description'))).optional(),
    type: taskTypeEnum.optional().default('general'),
    priority: taskPriorityEnum.optional().default('medium'),
    status: taskStatusEnum.optional(),
    // DRIFT-FIX (the (b) direction): was an UNBOUNDED z.string() over a
    // varchar(200) column with nothing truncating in between — a 201-char assignee passed
    // validation and detonated in Postgres as a raw 22001 surfaced as a 500. Bounded to the
    // column so it fails with an actionable zod message at the edge instead. BOUNDARY
    // HYGIENE: + identityString — reject the literal "null"/"undefined" a
    // degraded client stringifies in (the incident stored assignedTo = the string "null").
    assignedTo: identityString(z.string().max(cap('tasks.assigned_to'))).optional(),
    // DRIFT-FIX (nit 4): createdBy is a REAL column (tasks.created_by, a
    // free-form string — who/what created the task) and handleCreate already forwards
    // args.createdBy into tasksHandler.createTask, but it was NEVER declared here. Under
    // strict mode an undeclared key is REJECTED, so the genuine capability
    // was unreachable through MCP. Declare it (string, like assignedTo) so it's reachable.
    // Bounded to its varchar(200) column — same (b)-direction fix as assignedTo.
    // BOUNDARY HYGIENE: + identityString — createdBy was stored NULL/"null"
    // by the degraded session; reject the literal-string form at the edge.
    createdBy: identityString(z.string().max(cap('tasks.created_by'))).optional(),
    // SHORT-ID CONTRACT FIX: each dependency now accepts a full UUID OR an
    // 8+-hex short id (uuidOrShortId) — the SAME id shape every other id-taking tool
    // accepts — instead of a bare z.string() that passed a short id straight to the
    // `dependencies uuid[]` column and let Postgres blow up with a raw "invalid input
    // syntax for type uuid" cast error. handleCreate then resolves each id → full UUID via
    // the ONE shared resolver (idResolver) before the INSERT. Cap is config-driven
    // (TASK_MAX_DEPENDENCIES) — no hardcoded literal.
    dependencies: z.array(uuidOrShortId()).max(TASK_MAX_DEPENDENCIES).optional(),
    // DECLARED STRUCTURAL PARENT: the ONLY source of a `subtask_of` edge.
    // Position ("standing on" a task branch) never mints it — a structural containment
    // claim needs explicit intent (precedence ladder). Same id shape +
    // resolver as `dependencies` (full UUID or 8+-hex short id, project-scoped).
    parentTaskId: uuidOrShortId().optional(),
    // FIRST-CLASS `links` WRITE PARAM — T5a PARITY for tasks. context_store
    // and decision_record have had this since T5a; task_create was the gap, which is part of
    // why tasks were born graph leaves. mintExplicitLinks is source-agnostic, so this is
    // nearly free. SAME schema object the other two use — one definition, no drift.
    links: linksParam,
    tags: baseTagsWrite,
    // ── P5.5 / migration 093 ─────────────────────────────────────────────────────
    // "Waiting on a human" becomes a FIELD instead of a tag convention. These two params
    // are what make the column reachable through the public tool surface at all — a column
    // no tool can write is not a feature. On a deployment that has not run migration 093,
    // supplying either is a TYPED ERROR naming the migration (nothing is written), never a
    // silent drop; see services/taskBlockedOnCapability.assertBlockedOnWritable.
    blockedOn: taskBlockedOnEnum.nullable().optional(),
    // A DEADLINE, and the only deadline this product treats as authoritative. Accepted as an
    // ISO-8601 datetime so a client never has to guess a format; a date found in a task's
    // PROSE is a different, weaker thing that the briefing labels `due?` and never sorts by.
    dueAt: z.string().datetime({ offset: true }).nullable().optional(),
    projectId: z.string().optional(),
    metadata: baseMetadata,
    // THE PUNCH LIST LANE (migration 101). Optional; task_list can
    // filter on it. Setting stage:'ready' REQUIRES title + metadata.punch.doneWhen +
    // metadata.punch.proofKind + a resolved project — see services/taskPunchCompleteness.ts.
    stage: taskStageEnum.optional(),
    punch: punchParam
  }),

  list: z.object({
    status: taskStatusEnum.optional(),
    // Same single-or-array shape `statuses` gives task_status, deliberately: task_list's
    // `stage` accepts either a single value or an array so a board asking "everything in
    // ready or claimed" is one call, not one per stage.
    stage: z.union([taskStageEnum, z.array(taskStageEnum).min(1).max(7)]).optional(),
    // DRIFT-FIX (nit 4): `statuses` is a REAL multi-status filter the
    // handler honors (listTasks builds `status IN (...)` from it) and takes PRECEDENCE
    // over the single `status` when present. It was read (args.statuses) but never
    // declared, so strict mode rejected it → a genuinely-useful filter was unreachable.
    // Declare it as an array of the same task-status enum so the values stay aligned.
    statuses: z.array(taskStatusEnum).min(1).max(5).optional(),
    priority: taskPriorityEnum.optional(),
    // DRIFT-FIX (nit 4): `phase` is a REAL filter the handler honors
    // (listTasks matches it against the tags array). Read (args.phase) but never
    // declared → rejected under strict mode. Declare it (a short string) so it's
    // reachable. The handler expands it to every separator/case spelling of the phase
    // tag before matching (config/phaseTagConfig.ts) — it is NOT a bare
    // `phase-` prefix any more, and that mattered: 82 tasks on prod carry a phase tag
    // with no `phase-` spelling among their tags at all, so the dash-only lookup could not
    // return them for any value.
    phase: z.string().min(1).max(transientCap('phaseFilter')).optional(),
    // assignedTo (NOT assignedAgent): the handler reads args.assignedTo and the
    // column is `assigned_to` (a simple string, not an FK/uuid — same as
    // task_create/task_update/bulk_update). The prior `assignedAgent` name + .uuid()
    // both diverged from the handler read, so this filter was silently dropped
    // (zod .parse() strips the undeclared assignedTo → undefined at the handler).
    // Bounded to the assigned_to column: a filter value longer than the
    // column can never match a stored row, so accepting it only defers a pointless query.
    assignedTo: z.string().max(cap('tasks.assigned_to')).optional(),
    type: taskTypeEnum.optional(),
    tags: baseTagsFilter,
    limit: baseLimit,
    // A7: pagination. Previously task_list had no offset, so with default limit 10
    // (max 100) any row beyond the first 100 was unreachable through the tool. Mirrors
    // context_search's offset so callers can page. THE STANDING RULE:
    // every numeric param is declared through coercedInt()/coercedFloat(). This comment
    // used to point at context_search's BARE z.number() as the thing to copy, and that is
    // exactly how the defect spread — copy the HELPER, never a bare z.number().
    offset: coercedInt(z.number().int().min(0).optional()),
    // STRICT-MODE SAFETY: tasks.routes.handleList reads args.projectId
    // via resolveProjectId to scope the list — a REAL accepted-and-used param that was
    // missing from the schema. Under strict mode a legitimate project-scoped task_list
    // call (the retrievalErgonomics contract exercises exactly this) would be wrongly
    // rejected. Declare it (don't drop it) — declared == accepted == handler-reads.
    projectId: z.string().optional(),
    // SOFT-DELETE: exclude archived tasks by default; includeArchived
    // reveals them. coercedBoolean() for the string-from-bridge boolean.
    includeArchived: coercedBoolean().optional(),
    // ── THE DEADLINE IS READABLE ─────────────────────────────────
    // `due_at` (migration 093) could be WRITTEN by task_create/task_update and read by
    // NOTHING: the only surface that consulted it was project_briefing's "Waiting on a
    // human" section, which selects blocked_on='human' first — so a deadline on a task
    // blocked on anything else was unanswerable without raw SQL. These two params make
    // "what is due in the next N days" a tool call.
    // Same datetime shape task_create's `dueAt` accepts, deliberately: a caller should
    // never have to format the value differently to filter on it than to set it.
    dueBefore: z.string().datetime({ offset: true }).optional(),
    // ── THE FLOW FILTERS (gap 4) ──────────────────────────────────
    // A board that cannot report on itself. Answering "do we generate more tasks than we
    // close?" cost a full 1,212-row list sweep PLUS 1,212 `task_details` calls, because
    // `dueBefore` filters the DEADLINE only and there was no date filter on creation or on
    // closure at all. A report that expensive gets run once by hand and never again.
    //
    // Same datetime shape as `dueBefore`, deliberately: a caller should never have to format
    // an instant differently depending on which column it is compared against.
    createdAfter: z.string().datetime({ offset: true }).optional(),
    createdBefore: z.string().datetime({ offset: true }).optional(),
    // `closedAfter` and NOT `completedAfter`: a flow question that counts only COMPLETIONS is
    // the wrong question, and it is the one that hid the 2026-08-19 cull of 107 tasks — the
    // largest outflow event in our history — because those tasks were CANCELLED. `closed_at`
    // (migration 098) covers both terminal doors. REFUSED, never silently dropped, on a
    // database that has no such column — see services/taskClosedAtCapability.ts.
    closedAfter: z.string().datetime({ offset: true }).optional(),
    // DERIVED from config/blockedOnConfig.TASK_LIST_SORTS — not a hand-written enum, so
    // the advertised values, the accepted values and the orderings listTasks implements
    // are one declaration (CLASSES.md C5: two copies of one list drift).
    sort: z.enum(TASK_LIST_SORTS as unknown as [TaskListSort, ...TaskListSort[]]).optional()
  }),

  update: z.object({
    // Accepts a full UUID OR an 8+-hex short id; resolved (project-scoped)
    // in the handler.
    taskId: uuidOrShortId(),
    status: taskStatusEnum.optional(),
    priority: taskPriorityEnum.optional(),
    // THE TYPE OF THE WORK, EDITABLE (batch-5 lane K). `type` is a REAL column that
    // task_create writes and task_list FILTERS ON, and until now NOTHING could change it
    // after the fact: it was absent from this schema (so strict mode REJECTED it) and
    // absent from the handler's SET-clause builder (so there was no write path to reach
    // even if it had been declared). A task filed as `general` in a hurry was `general`
    // forever. That was survivable only while the Command backend wrote the column with
    // its own raw SQL; the moment that backend delegates its update to THIS tool, the
    // TaskDrawer's type control breaks — a capability lost to a correct refactor.
    // SAME `taskTypeEnum` as create, deliberately: create and update cannot disagree
    // about what a valid type is, and the DB CHECK constraint has exactly one mirror in
    // this file (a past incident — one centralized definition, not N copies).
    // No `.default()` here, unlike create: on an UPDATE, omitted must mean "do not touch
    // this column", and a default would silently rewrite every un-named task to
    // `general` on any other edit.
    type: taskTypeEnum.optional(),
    // A5: assignees are free-form strings everywhere else (task_create / bulk_update)
    // and the `assigned_to` column is varchar(200), NOT a uuid FK. The prior
    // .uuid() here rejected every real (non-UUID) assignee. Align to a plain string,
    // bounded to the column. BOUNDARY HYGIENE: +
    // identityString — the update path is the sibling of create, so guard it too (the
    // whole class, not just the reported create surface).
    assignedTo: identityString(z.string().max(cap('tasks.assigned_to'))).optional(),
    // A4: priority + progress are REAL columns on `tasks` and are now wired through
    // route→handler (they were previously accepted by zod but silently dropped — the
    // route forwarded only status/assignedTo/metadata).
    progress: coercedInt(z.number().int().min(0).max(100).optional()),
    // ── THE APPEND AFFORDANCE ────────────────────────────────────
    // `notes` was previously REMOVED from this schema, reasoning "there is no `notes`
    // column on `tasks`, so advertising it would be a promise the handler cannot keep".
    // The promise IS keepable — `task_bulk_update` has kept it since an earlier change by writing
    // to the `metadata` jsonb column — and removing it here is what left "record where
    // this task now stands" with no home at all. MEASURED 2026-08-21: two independent
    // actors in one session reached for `notes`, were correctly rejected by strict mode,
    // read the schema, found `description`, and used it. `description` is a SILENT FULL
    // REPLACE, so one of them destroyed a build spec. The absent affordance was the trap.
    //
    // It APPENDS a timestamped, actor-attributed entry to `metadata.noteLog` and does not
    // touch `description`. Not a text column (jsonb has no length), so the cap is a
    // judgement bound stated in config, matching bulk_update's.
    // BOUNDARY HYGIENE: `notes` is METADATA BY ANOTHER DOOR — the handler
    // APPENDS it into `metadata.noteLog`, so a leak here lands in the exact bag the
    // baseMetadata scan above now guards. Scanning it at the param keeps the two doors to one
    // destination under one rule instead of leaving the back one open.
    notes: artifactFreeText(z.string().max(transientCap('bulkUpdateNotes'))).optional(),
    // DRIFT-FIX (nit 4): metadata is a REAL column (tasks.metadata jsonb)
    // and handleUpdate already forwards args.metadata into updateTaskStatus (which writes
    // it), but it was NEVER declared here → rejected under strict mode, so updating a
    // task's metadata through MCP was impossible. Declare it (baseMetadata, like
    // task_create / task_bulk_update) so the existing persist path is reachable.
    // metadata is now MERGED shallow over existing (T1 item 6) — explicit null deletes a key.
    metadata: baseMetadata,
    // CURATE (T1 item 5): edit title / description / tags after the fact (previously
    // task_update could touch only status/priority/assignee/progress/metadata).
    // DRIFT-FIX: title was .max(255) with a comment noting it sat "well
    // under the column's varchar(500)" — an invented limit the schema never asked for, and
    // an EDIT path that could not express a title task_create could. description was
    // .max(2000) against TEXT — the same cap that forced specs out of tasks. Both now
    // derive from the column, so create and update agree by construction.
    // BOUNDARY HYGIENE: + artifactFreeText on the edit path too, so a
    // curate/edit can't smuggle in the leaked-XML the create path now rejects.
    title: artifactFreeText(z.string().min(1).max(cap('tasks.title'))).optional(),
    description: artifactFreeText(z.string().max(cap('tasks.description'))).optional(),
    tags: baseTagsWrite,
    // ── P5.5 / migration 093 ─────────────────────────────────────────────────────
    // "Waiting on a human" becomes a FIELD instead of a tag convention. These two params
    // are what make the column reachable through the public tool surface at all — a column
    // no tool can write is not a feature. On a deployment that has not run migration 093,
    // supplying either is a TYPED ERROR naming the migration (nothing is written), never a
    // silent drop; see services/taskBlockedOnCapability.assertBlockedOnWritable.
    // DEPENDENCIES BECOME EDITABLE (gap 2 — the round-2 correction).
    //
    // This column was WRITE-ONCE AT CREATE: declared on task_create, absent from this schema
    // AND from the handler's SET-clause builder, so no task could acquire a dependency after
    // the moment it was filed. That is why `dependencies` is non-empty on ZERO rows
    // fleet-wide — it is emptied by its own unreachability, not by disuse. A task becomes
    // blocked LATER, by definition, so the honest channel for "task X must land first" was
    // missing at exactly the moment anyone needed it. Same declared-but-unreachable defect
    // this surface has now hit five times (see the DRIFT-FIX notes on task_update above).
    //
    // Making it writable is what makes the blocked-needs-a-named-blocker rule SATISFIABLE
    // rather than merely strict — without it the rule would force authors onto `blockedOn`,
    // whose enum has no value meaning "another task", and a forced wrong value poisons
    // project_briefing's "Waiting on a human". Same cap and item shape as task_create.
    dependencies: z.array(uuidOrShortId()).max(TASK_MAX_DEPENDENCIES).optional(),
    blockedOn: taskBlockedOnEnum.nullable().optional(),
    // A DEADLINE, and the only deadline this product treats as authoritative. Accepted as an
    // ISO-8601 datetime so a client never has to guess a format; a date found in a task's
    // PROSE is a different, weaker thing that the briefing labels `due?` and never sorts by.
    dueAt: z.string().datetime({ offset: true }).nullable().optional(),
    // projectId scopes the SHORT-ID resolution of taskId to one project.
    // Optional + not an updatable field, so it's excluded from the .refine "at least one
    // field to update" check below. Declared so strict mode accepts it.
    projectId: z.string().optional(),
    // ATOMIC TASK CLAIM (an earlier task SPEC §6.5; fence widened by an earlier task): the
    // FENCING token. While a claim is LIVE, EVERY task_update mutation requires it (or the
    // audited force) — the old "content fields never need it" carve-out was the field-shaped
    // hole a forged progress/metadata write walked through. A supplied token is VALIDATED on
    // every update regardless of fields; an invalid one is a typed rejection, never ignored.
    // Also implicitly renews the lease, and clears the claim on a terminal status. Neither
    // claimId nor force is an "updatable field", so both are excluded from the .refine below.
    claimId: claimToken().optional(),
    // The audited human escape hatch: deliberately override a LIVE claim held by someone
    // else. Exists for humans on the dashboard, not for agents racing each other.
    force: coercedBoolean().optional(),
    // THE PUNCH LIST LANE (migration 101). Setting stage:'ready'
    // REQUIRES title + metadata.punch.doneWhen + metadata.punch.proofKind + a resolved
    // project, evaluated against the MERGED (existing + this call's) state — see
    // services/taskPunchCompleteness.ts.
    stage: taskStageEnum.optional(),
    punch: punchParam
  }).refine(
    // P5.5: blockedOn/dueAt are REAL updatable fields, so an update that sets ONLY one of
    // them must be accepted. Leaving them out of this predicate would advertise a param and
    // then reject every call that used it alone — the exact "declared but unreachable"
    // defect an earlier task nit 4 catalogued four times in this same file.
    data => data.status !== undefined || data.priority !== undefined ||
            data.assignedTo !== undefined || data.progress !== undefined ||
            data.metadata !== undefined || data.title !== undefined ||
            data.description !== undefined || data.tags !== undefined ||
            data.blockedOn !== undefined || data.dueAt !== undefined ||
            // a DEPENDENCIES-ONLY update is the whole point of making the column
            // writable — "this task now waits on that one" must be a legal call on its own,
            // or the channel is advertised and then rejected. Omitting it here would have
            // reproduced the declared-but-unreachable defect one layer up from the one this
            // change exists to fix, which is precisely how this file's catalogue got long.
            data.dependencies !== undefined ||
            // a note ALONE is the whole point — "just record a status note" must
            // be a legal call, or the affordance is advertised and then rejected, which is
            // the "declared but unreachable" defect this file has catalogued repeatedly.
            data.notes !== undefined ||
            // Lane K: re-typing a task ALONE is the whole edit — "this is a bug, not a
            // feature" names no other field. Omitting it here would advertise the param
            // and then reject every call that used it by itself, which is the same
            // declared-but-unreachable defect one line up.
            data.type !== undefined ||
            // migration 101: a stage-only or punch-only update is the whole point of the
            // progressive-fill workflow (see punchParam) — must be legal alone.
            data.stage !== undefined ||
            data.punch !== undefined,
    { message: 'At least one field to update must be provided (status, priority, type, assignedTo, progress, metadata, title, description, tags, dependencies, blockedOn, dueAt, notes, stage, punch)' }
  ),

  bulk_update: z.object({
    // Each id accepts a full UUID OR an 8+-hex short id; resolved
    // (project-scoped) in the handler before the atomic bulk update.
    // MAX is CONFIG-DRIVEN (an earlier task — TASK_BULK_MAX_IDS, default 500): the old
    // hardcoded 50 rejected real bulk sweeps, and the bridge surfaced that rejection as a
    // bare `null` to the caller. The bulk UPDATE is one atomic `id = ANY($n)` statement, so
    // a large list is safe; exceeding the cap still fails with a CLEAR zod error, never null.
    task_ids: z.array(uuidOrShortId()).min(1).max(TASK_BULK_MAX_IDS),
    status: taskStatusEnum.optional(),
    // Bounded to the assigned_to column — the third sibling of the same
    // unbounded-over-varchar(200) bug (create / update / bulk_update). Guard the whole
    // class, not the instance. BOUNDARY HYGIENE: + identityString
    // — same reserved-string reject as create/update, the third sibling of that class.
    assignedTo: identityString(z.string().max(cap('tasks.assigned_to'))).optional(),
    priority: taskPriorityEnum.optional(),
    // the SAME taskTypeEnum task_create/task_update declare, so a value
    // legal in single cannot be illegal in bulk. It was undeclared here AND had no SET
    // clause in bulkUpdateTasks, which made a task's KIND write-once in bulk.
    type: taskTypeEnum.optional(),
    metadata: baseMetadata,
    // bulk_update's `notes` IS supported — the handler merges it into the metadata
    // jsonb column (see tasks.ts bulkUpdateTasks). Real + honored. Not a text column
    // (jsonb has no length), so this is a transient/judgement cap, stated in config.
    // BOUNDARY HYGIENE: `notes` is METADATA BY ANOTHER DOOR — the handler
    // APPENDS it into `metadata.noteLog`, so a leak here lands in the exact bag the
    // baseMetadata scan above now guards. Scanning it at the param keeps the two doors to one
    // destination under one rule instead of leaving the back one open.
    notes: artifactFreeText(z.string().max(transientCap('bulkUpdateNotes'))).optional(),
    projectId: z.string().optional(),
    // ATOMIC TASK CLAIM (SPEC §6.8): a bulk write cannot hold N claims, so
    // there is no claimId here — live-claimed rows are SKIPPED and reported through the
    // existing failed/errors shape. force:true overrides (audited per row).
    force: coercedBoolean().optional(),
    // NAMING A BLOCKER, IN BULK (gap 2). The SAME `taskBlockedOnEnum` that
    // task_create and task_update declare, so a value legal in single cannot be illegal in
    // bulk — the third sibling of the class an earlier task fixed for `type`.
    //
    // WHY IT HAD TO BE ADDED HERE AND NOT JUST DOCUMENTED: gap 2 makes a move to `blocked`
    // REFUSE unless a blocker is named, and a board sweep blocking ten tasks behind one
    // freeze is a real, common use of this tool. Without this param the fail-closed rule
    // would be unsatisfiable on this path — a rule that closes the product rather than a
    // hole. Nullable so an explicit clear stays expressible and distinct from "said nothing".
    blockedOn: taskBlockedOnEnum.nullable().optional(),
    // THE PUNCH LIST LANE (migration 101) — same completeness gate as
    // task_update, applied per row. A bulk sweep into stage='ready' that would leave ANY
    // targeted row incomplete refuses the WHOLE call rather than partially applying, matching
    // this tool's existing atomic-bulk contract.
    stage: taskStageEnum.optional(),
    punch: punchParam
  }),

  details: z.object({
    // Accepts a full UUID OR an 8+-hex short id; resolved (project-scoped)
    // in the handler.
    taskId: uuidOrShortId(),
    projectId: z.string().optional()
  }),

  progress_summary: z.object({
    groupBy: z.enum(['phase', 'status', 'priority', 'type', 'assignedTo']).optional().default('phase'),
    projectId: z.string().optional(),
    // RECONCILE WITH task_list: exclude archived by default so summary
    // counts match a status-filtered task_list; includeArchived:true counts them too.
    includeArchived: coercedBoolean().optional()
  }),

  // SOFT-DELETE / ARCHIVE: reversible cleanup. delete → archived_at=now();
  // restore → archived_at=NULL. Distinct from the `cancelled` STATUS (a lifecycle state):
  // archive removes a task from default listings entirely, reversibly. Accepts full UUID
  // or 8+-hex short id (resolved project-scoped in the handler).
  delete: z.object({
    taskId: uuidOrShortId(),
    projectId: z.string().optional(),
    // ATOMIC TASK CLAIM (SPEC §6.8): archiving a live-claimed task yanks it
    // off the board under its holder — refused by default, force:true overrides (audited).
    force: coercedBoolean().optional()
  }),
  restore: z.object({
    taskId: uuidOrShortId(),
    projectId: z.string().optional()
  }),

  // CANCEL: a dedicated convenience tool that sets status='cancelled' —
  // a first-class lifecycle state (the tasks.status column accepts it; taskStatusEnum
  // includes it; task_list/details already render it). `cancelled` was already reachable
  // via task_update/task_bulk_update; this is the explicit, self-documenting verb. Accepts
  // a full UUID or 8+-hex short id, resolved project-scoped in the handler. Idempotent.
  cancel: z.object({
    taskId: uuidOrShortId(),
    projectId: z.string().optional(),
    // cancel_task IS task_update(status='cancelled'), so it is an OWNERSHIP write and is
    // fenced identically — it therefore takes the same claimId/force (guard the
    // whole class, not just the surface the bug was reported on).
    claimId: claimToken().optional(),
    force: coercedBoolean().optional()
  }),

  // ── ATOMIC TASK CLAIM (SPEC v1 §6.1) ────────────────
  // A first-class claim lifecycle, DELIBERATELY separate from ordinary editing: task_update
  // must never auto-acquire ownership.
  claim: z.object({
    taskId: uuidOrShortId(),
    // ATTRIBUTION ONLY — never the lock key (SPEC D2). NOT a "default": the actor derived at
    // the edge (OAuth sub / X-Actor-ID) takes PRECEDENCE over this argument — declared data may
    // REFINE, never REPLACE, a verified identity (closing
    // an earlier note). With composites off (the shipped default) a caller that HAS a derived
    // actor has this argument ignored; with them on it replaces only the handle segment under
    // that caller's own principal; it is used verbatim only when no actor is derivable.
    // Resolution lives in tasks.routes.ts#claimActor via refineActor() — one choke point.
    // Bounded to the claim_actor column, and guarded by identityString like every other
    // actor-ish field on this table.
    actor: identityString(z.string().max(cap('tasks.assigned_to'))).optional(),
    // The D1 status guard, caller-widenable but NEVER absent. Default lives in config
    // (TASK_CLAIM_CONFIG.defaultAllowedStatuses) so the claimable set is a named tunable.
    allowedStatuses: z.array(taskStatusEnum).min(1).max(5).optional(),
    // Optimistic-lock CAS. The version is bumped by a DB TRIGGER on every write path, so it
    // is honest regardless of which surface changed the row (SPEC D4).
    expectedVersion: coercedInt(z.number().int().min(0).optional()),
    // SHAPE only (a positive integer). The configured floor/ceiling is enforced by ONE
    // runtime check in TaskClaimService (typed `lease-out-of-bounds`), deliberately NOT
    // mirrored here: a zod bound would freeze TASK_CLAIM_CONFIG's value at MODULE LOAD, so
    // an operator retuning the lease via env would face a schema that disagrees with the
    // service — two sources for one rule, drifting. A 0-second lease (instantly
    // stealable) is still rejected, just by the source that owns the rule.
    leaseSeconds: coercedInt(z.number().int().positive().optional()),
    // ONLY for an idempotent retry: the token you already hold. Never a way to CHOOSE your
    // token on a fresh claim — a client-chosen fencing token is a forgeable lock. ENFORCED IN
    // SQL, not here: CLAIM_SQL only ever WRITES a freshly minted server-side uuid, and keeps
    // the presented one solely when it MATCHES the row's live claim (taskClaim.ts CLAIM_SQL).
    claimId: claimToken().optional(),
    projectId: z.string().optional()
  }),
  renew: z.object({
    taskId: uuidOrShortId(),
    claimId: claimToken(),
    // Shape only — bounds enforced by the service (see claim.leaseSeconds above).
    leaseSeconds: coercedInt(z.number().int().positive().optional()),
    projectId: z.string().optional()
  }),
  release: z.object({
    taskId: uuidOrShortId(),
    claimId: claimToken(),
    projectId: z.string().optional()
  })
};

// Smart Search & AI Recommendations Schemas
const smartSearchSchemas = {
  search: z.object({
    query: baseQuery,
    projectId: z.string().optional(),
    // includeTypes is the REAL source filter the handler honors.
    //
    // CONSTRAINED TO THE SOURCE VOCABULARY. This was `z.array(z.string())`,
    // and an unconstrained string array is not a lax validator — it is a MEASURING
    // INSTRUMENT WITH ONLY TWO STATES WHERE THREE EXIST (C1). An unknown key passed
    // validation, matched no adapter in sourceAdapters(), contributed no candidates, and
    // came back as `results: []` with `ok: true` — so "your query found nothing" and "the
    // source you named does not exist" were the SAME ANSWER. Measured consequence:
    // `includeTypes:['task']` returned a clean empty success for the entire period the task
    // vectors were baked but unread, which is indistinguishable from a project with no
    // matching tasks. It now fails with zod naming the valid set.
    //
    // The enum DERIVES from SMART_SEARCH_SOURCE_KEYS, so the accepted set, the advertised
    // inputSchema (buildInputSchema reads this very zod schema) and the adapter list cannot
    // drift. Note it is the VOCABULARY, not SMART_SEARCH_DEFAULT_SOURCES: a source that is
    // built but not yet in the default set must still be explicitly requestable, which is
    // what makes the default-set flip independently revertable.
    includeTypes: z.array(z.enum(SMART_SEARCH_SOURCE_KEYS as unknown as [string, ...string[]])).optional(),
    // DRIFT-FIX: `scope` was DEPRECATED (removed). It was advertised but
    // NEVER forwarded/read by handleSmartSearch / smartSearchHandler.smartSearch — a
    // redundant, singular-form duplicate of includeTypes that additionally named sources
    // that no longer exist (naming registry dropped in migration 034; agent system removed
    // in migration 016). Removing it makes advertised == accepted == actually-works rather
    // than advertising a no-op that names phantom sources. Use includeTypes instead.
    limit: baseLimit,
    // THE SIZE DIAL IT NEVER HAD (SEARCH P3). smart_search returned the WHOLE
    // body of every row — 15,498 o200k tokens at limit 10 on prod, 14,379 of them in
    // structuredContent alone. Default `summary` (SMART_SEARCH_DEFAULT_ALTITUDE).
    altitude: altitudeEnum.optional()
  }),

  recommendations: z.object({
    context: z.string().max(transientCap('recommendationContext')),
    projectId: z.string().optional(),
    type: z.enum(['naming', 'implementation', 'architecture', 'testing']).optional()
  })
};

// TYPED-EDGE GRAPH Schemas (Mandrel Core Redesign T2a).
// The edge_type / node_type enums DERIVE from the single-source domain
// (config/edgeTypes.ts) so the zod validation, the model-facing inputSchema, and the
// DB CHECK can never drift. Ids accept a full UUID OR an 8+-hex short id (uuidOrShortId,
// resolved project-scoped in the handler) exactly like every other id-taking tool.
// edgeTypeEnum / edgeNodeTypeEnum are defined ONCE at the top (hoisted so the T5a
// `links` write param shares them). Reused here for the explicit link/unlink/get_links.
const linkSchemas = {
  // link: create a typed edge from → to for edges that can't be inferred, and to REPAIR.
  link: z.object({
    from: uuidOrShortId(),
    fromType: edgeNodeTypeEnum,
    to: uuidOrShortId(),
    toType: edgeNodeTypeEnum,
    edgeType: edgeTypeEnum,
    metadata: baseMetadata,
    projectId: z.string().optional()
  }),
  // unlink: remove a typed edge (the curate/repair counterpart).
  unlink: z.object({
    from: uuidOrShortId(),
    to: uuidOrShortId(),
    edgeType: edgeTypeEnum,
    projectId: z.string().optional()
  }),
  // get_links: read a record's edges in both directions (T2b trust / T3 recall_thread).
  get_links: z.object({
    id: uuidOrShortId(),
    // optional direction filter; defaults to 'both' in the handler.
    direction: z.enum(['out', 'in', 'both']).optional(),
    // optional edge-type filter (restrict the walk); validated against the domain.
    edgeTypes: z.array(edgeTypeEnum).optional(),
    projectId: z.string().optional()
  })
};

// recall_thread Schema (Mandrel Core Redesign T3) — THE headline pull tool.
// The altitude enum + edge-type enum + trust-band floor all DERIVE from the single-source
// config modules (threadConfig / edgeTypes / trustConfig) so the schema, the inputSchema,
// and the engine can never drift. Lenient inputs, strict declared output (the §7 discipline).
const threadAltitudeEnum = z.enum(THREAD_ALTITUDES as unknown as [string, ...string[]]);
const trustBandEnum = z.enum(TRUST_BANDS as unknown as [string, ...string[]]);
const recallThreadSchemas = {
  recall_thread: z.object({
    // anchor: a ref:<slug>, OR a full UUID / 8+-hex short id of a context/decision/task.
    // NOT uuidOrShortId() — a ref:<slug> is a legal anchor too, so accept any non-empty
    // string here and resolve (robustly, actionable error) in the engine.
    anchor: z.string().min(1).max(transientCap('threadAnchor')),
    // altitude: TWO axes, one enum, both derived from THREAD_ALTITUDES:
    //   content/zoom  — headline | summary | full (content depth per node; default summary),
    //   projection    — current (the deterministic current-state read model).
    altitude: threadAltitudeEnum.optional(),
    // optional edge-type filter restricting the walk (subset of the v1 domain).
    edgeTypes: z.array(edgeTypeEnum).optional(),
    // optional BFS depth; clamped to [1, maxDepth] in the engine. coercedInt for the bridge.
    depth: coercedInt(z.number().int().min(1).max(THREAD_CONFIG.maxDepth)).optional(),
    // optional TOTAL-NODE cap; clamped to [1, maxNodesCeiling] in the engine, which reports
    // the applied value as `maxNodesUsed`. THE resumability lever for a truncated thread:
    // re-call with `nodes.length + truncatedCount`. The bound derives from THREAD_CONFIG so
    // the schema and the engine's clamp cannot drift (they are the same number).
    maxNodes: coercedInt(z.number().int().min(1).max(THREAD_CONFIG.maxNodesCeiling)).optional(),
    // optional trust floor: a BAND name (trusted/ok/unproven/stale/superseded/contradicted)
    // OR a numeric score in [0,1]. Nodes below the floor are dropped (the anchor never is).
    // coercedFloat wraps the WHOLE union: a decimal string ("0.5") becomes 0.5 for the
    // numeric arm, while a band name ("trusted") is not a numeric string and passes through
    // untouched to the enum arm. This shape is why the wrap must live HERE and not be left to
    // the central coerceArgsToDeclaredTypes seam, which treats ZodUnion as deny-by-default —
    // measured on prod v0.17.0: minTrust:0.5 succeeded, minTrust:"0.5" was rejected.
    minTrust: coercedFloat(z.union([trustBandEnum, z.number().min(0).max(1)]).optional()),
    projectId: z.string().optional()
  })
};

// Session active-thread anchor Schemas (Mandrel Core Redesign T5b) — THE
// deterministic auto-threading layer's control surface. Ids accept a full UUID OR an
// 8+-hex short id (uuidOrShortId, resolved project-scoped in the handler) exactly like
// every other id-taking tool. thread_set requires at least one of task/decision (the
// route enforces "at least one" with an actionable error — zod can't express "≥1 of an
// optional set" without an awkward refine that would muddy the actionable message).
const threadSchemas = {
  // thread_set (DEPRECATED alias → branch_open): accepts the legacy task/decision params.
  // `replace` is accepted-but-inert (a position IS a whole replacement) so old callers
  // don't break on strict-key validation.
  thread_set: z.object({
    task: uuidOrShortId().optional(),
    decision: uuidOrShortId().optional(),
    replace: coercedBoolean().optional(),
    projectId: z.string().optional()
  }),
  // thread_current (DEPRECATED alias → branch_current). No params (per-session state).
  thread_current: z.object({}),
  // thread_clear (DEPRECATED alias → branch_close). No params (per-session state).
  thread_clear: z.object({})
};

// Branch position Schemas (PHASE 1 positional membership)
// — the session's CURRENT BRANCH control surface. branch_open takes the spine id
// (full UUID or 8+-hex short id — resolved project-scoped across context/decision/task,
// never first-match); branch_current / branch_close operate on per-session state and take
// only the optional projectId scope.
const branchSchemas = {
  branch_open: z.object({
    id: uuidOrShortId(),
    projectId: z.string().optional()
  }),
  branch_current: z.object({
    projectId: z.string().optional()
  }),
  branch_close: z.object({
    projectId: z.string().optional()
  }),
  // branch_history (SK2) — read a branch's members, open or CLOSED. Takes the
  // spine id through the same uuidOrShortId contract branch_open uses (resolved project-
  // scoped across context/decision/task, never first-match) plus the two scope/paging knobs.
  // STRICT: exactly these three. The walk DEPTH is deliberately not a param — it is a server
  // bound in config/branchHistoryConfig.ts, reported back when it bites, not a caller knob.
  branch_history: z.object({
    id: uuidOrShortId(),
    projectId: z.string().optional(),
    // coercedInt: a JSON-serializing MCP client sends "20", not 20 (numericParamCoercion
    // guards the whole surface on this). The CEILING is not declared here — it is
    // BRANCH_HISTORY_CONFIG.maxLimit, applied at the route, which clamps and says so rather
    // than rejecting; a max() here would turn a tunable server bound into a wire contract.
    limit: coercedInt(z.number().int().positive().optional())
  }),
  // branch_assign / branch_unassign (P3) — DECLARE or REMOVE a record's
  // branch after the fact. Both ids go through the SAME uuidOrShortId contract every other
  // id-taking tool uses (resolved project-scoped across context/decision/task, never
  // first-match). `spine` is required on assign because a nullable spine encoding "remove"
  // was REJECTED: it makes a required identifier nullable to smuggle in a second verb.
  // `reason` is free text for the audit row; its LENGTH bound is a server tunable
  // (MEMBERSHIP_MOVE_CONFIG.maxReasonLength) applied at the service, which truncates and
  // keeps the row rather than rejecting a call over a long sentence.
  branch_assign: z.object({
    id: uuidOrShortId(),
    spine: uuidOrShortId(),
    // BOUNDARY HYGIENE (finishing the sweep): the reason is PERSISTED to
    // branch_membership_moves.reason and read back as audit prose. The length rule stays at
    // the service (it truncates rather than rejects); this adds only the leaked-XML refusal.
    reason: artifactFreeText(z.string()).optional(),
    projectId: z.string().optional()
  }),
  branch_unassign: z.object({
    id: uuidOrShortId(),
    reason: artifactFreeText(z.string()).optional(),
    projectId: z.string().optional()
  })
};

// Session Management Schemas - DELETED (2025-10-24)
// Session MCP tools removed - sessions now auto-manage via SessionTracker service
// REST API endpoints at /api/v2/sessions/* handle UI analytics needs

// Main validation schema registry
// EXPORTED so toolDefinitions.ts can DERIVE the model-facing inputSchema from the
// same zod schema that actually gates the request — making the two physically
// impossible to diverge (the 3-layer schema-drift class fix). See toolDefinitions.ts.
export const validationSchemas = {
  // System Health (with backward compatibility aliases)
  mandrel_ping: aidisSystemSchemas.ping,
  mandrel_status: aidisSystemSchemas.status,
  mandrel_help: aidisSystemSchemas.help,
  mandrel_explain: aidisSystemSchemas.explain,
  mandrel_examples: aidisSystemSchemas.explain, // Same schema as explain - takes toolName parameter
  mandrel_contract: mandrelSystemSchemas.contract,
  // Backward compatibility aliases
  aidis_ping: aidisSystemSchemas.ping,
  aidis_status: aidisSystemSchemas.status,
  aidis_help: aidisSystemSchemas.help,
  aidis_explain: aidisSystemSchemas.explain,
  aidis_examples: aidisSystemSchemas.explain,

  // Session Lifecycle (session-rework SR-2) — explicit user-controlled
  // start/end/status; connection-scoped via the route layer's X-Connection-ID.
  session_start: sessionLifecycleSchemas.start,
  session_end: sessionLifecycleSchemas.end,
  session_status: sessionLifecycleSchemas.status,
  // Sessions Foundation Phase 2a — DB-persisted PIN (get/set/clear), actor-scoped.
  session_pin: sessionPinSchema,
  // Amp-orb eval W3 — the session IDENTITY read model (read-only).
  session_list: sessionIdentitySchemas.list,
  session_get: sessionIdentitySchemas.get,

  // Context Management
  context_store: contextSchemas.store,
  context_search: contextSchemas.search,
  context_get_recent: contextSchemas.get_recent,
  // CURATE (T1 item 4): edit a stored context (content / re-tag / metadata-merge / score).
  context_update: contextSchemas.update,
  context_stats: contextSchemas.stats,
  // ARTIFACT REFERENCES: resolve + fail-closed verify a record's references.
  context_artifact: contextSchemas.artifact,
  // Soft-delete / archive
  context_delete: contextSchemas.delete,
  context_restore: contextSchemas.restore,
  
  // Project Management
  project_create: projectSchemas.create,
  project_update: projectSchemas.update,
  project_delete: projectSchemas.delete,
  project_switch: projectSchemas.switch,
  project_info: projectSchemas.info,
  project_briefing: projectSchemas.briefing,
  project_move_record: projectSchemas.moveRecord,
  project_list: projectSchemas.list,
  project_current: projectSchemas.current,
  project_insights: projectSchemas.insights,
  project_tags: projectSchemas.tags,
  
  // Technical Decisions
  decision_record: decisionSchemas.record,
  decision_search: decisionSchemas.search,
  decision_get: decisionSchemas.get,
  decision_update: decisionSchemas.update,
  decision_stats: decisionSchemas.stats,
  // Soft-delete / archive
  decision_delete: decisionSchemas.delete,
  decision_restore: decisionSchemas.restore,
  // THE DECISION INBOX
  decision_answer: decisionSchemas.answer,
  decision_discuss: decisionSchemas.discuss,

  // Task Management
  task_create: taskSchemas.create,
  task_list: taskSchemas.list,
  task_update: taskSchemas.update,
  task_bulk_update: taskSchemas.bulk_update,
  task_details: taskSchemas.details,
  task_progress_summary: taskSchemas.progress_summary,
  // Soft-delete / archive
  task_delete: taskSchemas.delete,
  task_restore: taskSchemas.restore,
  // Cancel convenience tool
  cancel_task: taskSchemas.cancel,
  // Atomic task claim — CAS acquire / lease renew / release.
  task_claim: taskSchemas.claim,
  task_renew: taskSchemas.renew,
  task_release: taskSchemas.release,

  // Smart Search & AI Recommendations
  smart_search: smartSearchSchemas.search,
  get_recommendations: smartSearchSchemas.recommendations,

  // Typed-edge graph (Mandrel Core Redesign T2a)
  link: linkSchemas.link,
  unlink: linkSchemas.unlink,
  get_links: linkSchemas.get_links,

  // recall_thread (Mandrel Core Redesign T3) — the traversal-narrative headline tool
  recall_thread: recallThreadSchemas.recall_thread,

  // Branch position (PHASE 1 positional membership).
  branch_open: branchSchemas.branch_open,
  branch_current: branchSchemas.branch_current,
  branch_close: branchSchemas.branch_close,
  branch_history: branchSchemas.branch_history,

  // Mutable branch membership (P3) — declare / remove a record's branch.
  branch_assign: branchSchemas.branch_assign,
  branch_unassign: branchSchemas.branch_unassign,

  // DEPRECATED anchor aliases (retired by PHASE 1 — WARN and delegate to branch_*).
  thread_set: threadSchemas.thread_set,
  thread_current: threadSchemas.thread_current,
  thread_clear: threadSchemas.thread_clear,

  // Git Integration Tools - DELETED (C4, 2026-06-09)
  // 3 dormant git MCP tools (git_session_commits, git_commit_sessions,
  // git_correlate_session) removed; live gitTracker service retained.

  // Session Management - DELETED (2025-10-24)
  // 5 session tools removed - sessions auto-manage via SessionTracker service
};

/**
 * STRICT MODE: the set of param names a tool's zod schema declares.
 * Unwraps the .refine()/.preprocess() wrappers (ZodEffects) to reach the underlying
 * ZodObject so refined schemas (context_search, *_update) report their real keyset.
 * One central derivation from the SAME zod schema that gates VALUES, so the advertised
 * inputSchema (additionalProperties:false), the declared keys here, and the value
 * validator can never drift apart. Returns null for a non-object schema (none today).
 */
function declaredKeys(schema: unknown): Set<string> | null {
  let s: any = schema;
  // Unwrap ZodEffects (refine/preprocess/transform) down to the inner object.
  while (s && s._def && s._def.typeName === 'ZodEffects') {
    s = s._def.schema;
  }
  if (s && s._def && s._def.typeName === 'ZodObject' && s.shape) {
    return new Set(Object.keys(s.shape));
  }
  return null;
}

/**
 * The declared parameter names for a TOOL NAME (project-binding).
 *
 * The public, tool-keyed face of `declaredKeys` above. `services/projectBinding.ts` asks
 * the tool's OWN schema which of its parameters names a project, rather than carrying a
 * second hand-maintained list of "tools that take a projectId" — a second list is exactly
 * the drift a past incident (#5, count the copies) is about. Returns null for an unknown tool
 * or a non-object schema; the caller then treats the tool as declaring no project scope.
 */
export function declaredParamKeys(toolName: string): Set<string> | null {
  const schema = validationSchemas[toolName as keyof typeof validationSchemas];
  if (!schema) return null;
  return declaredKeys(schema);
}

/**
 * STRICT MODE (Change B): the subset of a tool's declared params that are REQUIRED
 * (not optional / not defaulted). Same ZodEffects-unwrap as declaredKeys, then keeps the shape
 * entries whose zod type is NOT optional (`isOptional()` is true for ZodOptional AND for a param
 * with a `.default()`, so defaulted params are correctly treated as non-required). Threaded into
 * the actionable `unrecognized_keys` error so it can name the params that ARE required (mirroring
 * the enum error which already lists allowed values). Returns [] for a non-object schema.
 */
function requiredKeys(schema: unknown): string[] {
  let s: any = schema;
  while (s && s._def && s._def.typeName === 'ZodEffects') {
    s = s._def.schema;
  }
  if (s && s._def && s._def.typeName === 'ZodObject' && s.shape) {
    return Object.entries(s.shape)
      .filter(([, v]: [string, any]) => (typeof v?.isOptional === 'function' ? !v.isOptional() : true))
      .map(([k]) => k);
  }
  return [];
}

/**
 * SCHEMA-DRIVEN PARAM COERCION (P0) — the whole-class fix for
 * "the gateway surface strips param types".
 *
 * WHAT IT REPLACES. This supersedes `MandrelMcpServer.deserializeParameters()`, a hardcoded
 * NAME ALLOW-LIST (arrayParams=[tags,…], numberParams=[limit,…]) that rescued a param only if
 * someone had remembered to add its NAME to a literal list, with a SILENT PASS-THROUGH default
 * for everything else — the allow-by-default disease a past incident names. `progress` was on neither
 * list and there was no object branch at all, so every `metadata` param went unrescued.
 * The severity was asymmetric and that is the real point: an unrescued NUMBER fails LOUD
 * (z.number() rejects the string) but an unrescued ARRAY fails SILENTLY — JSON-string in,
 * filter quietly dropped, WRONG RESULTS out.
 *
 * WHY THE SCHEMA IS THE RIGHT ORACLE. We already hold the tool's declared zod schema right
 * here, and this function sits on the ONE seam every op crosses on every transport (flat via
 * validationMiddleware, gateway via dispatchGateway, discover.ping/status via its delegate).
 * So the declared type — not a name — decides the conversion, and a newly-added param is
 * covered the moment it is declared. There is no list to keep in sync, which is exactly what
 * made the old mechanism rot.
 *
 * ZERO TOKEN COST. The schema is consulted SERVER-SIDE and never advertised. This does NOT
 * widen the lazy inputSchema, so the ~86% tool-surface token cut (1318 tokens lazy vs ~11,600
 * full) is untouched. Advertising fuller schemas would ALSO fix the bug and is the wrong fix
 * for that reason; MANDREL_TOOLLIST_MODE=full remains an emergency lever only.
 *
 * DENY BY DEFAULT — the governing rule. A value is converted only when the declared type is
 * unambiguous AND the string matches a narrow grammar (config/paramCoercionConfig.ts). In
 * EVERY other case the ORIGINAL string is left in place so the strict validator rejects it
 * LOUDLY. We never substitute a wrong-but-plausible value: "abc" for a number stays "abc"
 * (it does NOT become NaN or 0), malformed JSON for an array stays a string (it does NOT
 * become []), and "maybe" for a boolean stays "maybe" (it does NOT become true). A loud
 * error is always preferred to a silent wrong answer.
 *
 * DECLARED STRINGS ARE NEVER TOUCHED. A param declared ZodString/ZodEnum is returned
 * byte-identical — no trim, no re-encode, no retype. `query` depends on this (it must reach
 * the reserved-prefix guard exactly as the caller typed it), and so does every id/handle param.
 * UNIONS ARE DELIBERATELY NOT COERCED: a union's intended target type is ambiguous, and
 * guessing is precisely the failure mode this function exists to prevent.
 */
function unwrapZodType(schema: any): any {
  // Peel the wrappers that do not change the underlying VALUE type. Bounded to avoid any
  // possibility of a cycle in a malformed schema.
  const WRAPPERS = new Set([
    'ZodOptional',
    'ZodNullable',
    'ZodDefault',
    'ZodEffects',
    'ZodBranded',
    'ZodCatch',
    'ZodReadonly',
  ]);
  let s = schema;
  for (let depth = 0; depth < 20; depth++) {
    const typeName = s?._def?.typeName;
    if (!typeName || !WRAPPERS.has(typeName)) break;
    // ZodEffects nests under `.schema`; the rest nest under `.innerType`.
    const next = typeName === 'ZodEffects' ? s._def.schema : s._def.innerType;
    if (!next) break;
    s = next;
  }
  return s;
}

/** Numeric coercion that preserves integer precision (parseInt) and still accepts decimals. */
function coerceNumberValue(v: unknown): unknown {
  if (typeof v !== 'string') return v;
  const s = v.trim();
  if (INT_STRING_PATTERN.test(s)) return coerceIntValue(v);
  if (FLOAT_STRING_PATTERN.test(s)) return coerceFloatValue(v);
  return v; // garbage left for z.number() to reject LOUDLY
}

/**
 * Convert one transport-stringified value to the type its zod schema DECLARES.
 * Returns the value UNCHANGED whenever conversion is not unambiguously safe.
 */
function coerceValueToDeclaredType(declared: any, value: unknown): unknown {
  // Only transport-stringified values are candidates; a correctly-typed value is never touched.
  if (typeof value !== 'string') return value;

  const base = unwrapZodType(declared);
  const typeName = base?._def?.typeName;

  switch (typeName) {
    // Declared string-ish → NEVER touched (the `query` passthrough guarantee).
    case 'ZodString':
    case 'ZodEnum':
    case 'ZodNativeEnum':
    case 'ZodLiteral':
      return value;

    // DELIBERATELY RETAINED, though numericParamCoercion.contract.test.ts now proves every
    // numeric leaf in validationSchemas carries its own coercedInt/coercedFloat wrapper.
    // PRECISELY: this branch is REDUNDANT, not idle — and the order matters. This walker runs
    // at :1654, BEFORE schema.parse() at :1656, so for a TOP-LEVEL numeric it is this branch
    // that does the conversion and the z.preprocess wrapper that becomes the no-op, not the
    // other way round. Kept on purpose, as a BACKSTOP rather than as a second policy:
    //   - It delegates to coerceNumberValue → coerceIntValue/coerceFloatValue, the SAME single
    //     source the wrappers use. There is no second rule here that could drift; the only
    //     thing that differs between the two delivery points is COVERAGE, and coverage is now
    //     derived by that guard rather than hand-maintained.
    //   - If the guard ever regresses or a schema is built outside validationSchemas, this is
    //     what keeps a stringified number working instead of 400-ing a caller.
    // NOTE the asymmetry that makes the wrappers non-negotiable and this branch insufficient
    // on its own: this walker sees TOP-LEVEL keys only, while a z.preprocess wrapper runs
    // inside .parse() and therefore reaches union arms, array elements and shared consts.
    // recall_thread.minTrust (a union) is the existence proof — it was broken on prod v0.17.0
    // precisely because only this seam covered it and unions are deny-by-default below.
    // Do NOT delete the seam itself: it is still the ONLY rescue for bare booleans and for
    // JSON-stringified arrays/objects, which no wrapper covers.
    case 'ZodNumber':
      return coerceNumberValue(value);

    case 'ZodBoolean':
      return coerceBooleanValue(value);

    case 'ZodArray':
    case 'ZodTuple': {
      const parsed = tryJsonParse(value);
      // Only accept a value that actually IS an array; malformed JSON or a JSON scalar
      // stays a string so z.array() rejects it loudly rather than silently dropping a filter.
      return Array.isArray(parsed) ? parsed : value;
    }

    case 'ZodObject':
    case 'ZodRecord': {
      const parsed = tryJsonParse(value);
      const isPlainObject =
        parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed);
      return isPlainObject ? parsed : value;
    }

    // A union that OFFERS an array shape (task_list's `stage: enum | enum[]`, the single-or-
    // array pattern the header comment at :1214 documents) gets the SAME JSON-array rescue a
    // bare ZodArray field gets above — narrowly: only triggers when an arm is actually an
    // array, so a genuinely ambiguous union (e.g. string | number, recall_thread.minTrust)
    // still falls through to DENY BY DEFAULT below. A plain scalar string (e.g. "draft") is
    // left untouched here and matches the enum arm at .parse() exactly as before.
    case 'ZodUnion': {
      const options: any[] = base?._def?.options ?? [];
      const hasArrayArm = options.some((opt) => {
        const t = unwrapZodType(opt)?._def?.typeName;
        return t === 'ZodArray' || t === 'ZodTuple';
      });
      if (!hasArrayArm) return value;
      const parsed = tryJsonParse(value);
      return Array.isArray(parsed) ? parsed : value;
    }

    // ZodDiscriminatedUnion / ZodAny / ZodUnknown / anything unrecognized:
    // ambiguous or untyped → DENY BY DEFAULT, leave the string for the validator to judge.
    default:
      return value;
  }
}

/** JSON.parse that yields a sentinel instead of throwing; a parse error must never be swallowed silently. */
const JSON_PARSE_FAILED = Symbol('json-parse-failed');
function tryJsonParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return JSON_PARSE_FAILED;
  }
}

/**
 * Walk a tool's declared object shape and coerce each stringified argument to its declared
 * type. Non-object schemas and undeclared keys are left entirely alone (the strict-key check
 * above is what rejects undeclared keys — coercion never has an opinion about them).
 */
export function coerceArgsToDeclaredTypes(schema: unknown, args: any): any {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return args;

  const shapeHolder = unwrapZodType(schema);
  if (shapeHolder?._def?.typeName !== 'ZodObject' || !shapeHolder.shape) return args;

  const shape = shapeHolder.shape;
  let mutated = false;
  const out: Record<string, any> = { ...args };

  for (const key of Object.keys(out)) {
    const declared = shape[key];
    if (!declared) continue; // undeclared → not ours to coerce
    const coerced = coerceValueToDeclaredType(declared, out[key]);
    if (coerced !== out[key]) {
      out[key] = coerced;
      mutated = true;
    }
  }

  return mutated ? out : args;
}

/**
 * Validate MCP tool arguments using Zod schemas
 * @param toolName Name of the MCP tool
 * @param args Arguments to validate
 * @returns Validated arguments or throws validation error
 */
export function validateToolArguments(toolName: string, args: any): any {
  const schema = validationSchemas[toolName as keyof typeof validationSchemas];

  if (!schema) {
    throw new Error(`No validation schema found for tool: ${toolName}`);
  }

  // Normalize synonyms for decision tools (AI-friendly parameter names). This runs
  // BEFORE the strict-key check so legitimate AI synonyms (reasoning→rationale, etc.)
  // are mapped to canonical names and never tripped as "unknown params".
  if (toolName === 'decision_record' || toolName === 'decision_search' || toolName === 'decision_update') {
    args = normalizeDecisionSynonyms(toolName, args);
  }

  // TOOL-SCOPED PARAM SYNONYMS (MCP-2026 rebuild Phase 3). The Phase-3
  // gateway canary showed the blind model reaching for the intuitive param name on two
  // ops (project.switch given `name`, decision.record given `type`) → strict-key-rejected.
  // Accept the intuitive name as an ADDITIVE alias, SCOPED per opId (keyed by toolName)
  // so it can never bleed onto a sibling op with a real param of that name. Runs BEFORE
  // the strict-key check so the alias is mapped, not tripped as an unknown param. Because
  // the gateway dispatcher delegates to validateToolArguments(opId, …), this one seam
  // covers BOTH the flat call and the gateway branch. See TOOL_PARAM_SYNONYMS.
  args = normalizeToolParamSynonyms(toolName, args);

  // ID-PARAM SYNONYM NORMALIZATION (MCP-2026 rebuild Phase 1).
  // The rebuild's gateway `$defs.Ref` unifies every record-handle param on the name `id`
  // (and the bulk list on `ids`). Phase 1 does NOT yet CHANGE the advertised param names —
  // that would break the byte-identical tools/list gate — so the drifted legacy names
  // (`contextId`/`decisionId`/`taskId`/`task_ids`) remain the ADVERTISED + zod-declared
  // canonical AND stay natively accepted. This shim additionally ACCEPTS the new
  // `id`/`ids` names by normalizing them onto whichever legacy name the op declares, so a
  // caller using the future canonical works today and no live caller breaks. When Phase 2
  // flips the declared canonical to `id`, this same seam maps the legacy names the other
  // direction (still no break). Runs BEFORE the strict-key check so `id`/`ids` are not
  // tripped as unknown params.
  const declared = declaredKeys(schema);
  if (declared) {
    args = normalizeIdSynonyms(args, declared);
  }

  // STRICT-MODE ENFORCEMENT: reject UNDECLARED params so the validator
  // matches the strict (additionalProperties:false) inputSchema the model is shown.
  // zod's .parse() silently STRIPS unknown keys (it doesn't reject them), which let the
  // advertised contract and the accepted contract drift; this closes that gap centrally.
  // Modeled as a ZodError so it flows through the SAME actionable-error formatter.
  if (args && typeof args === 'object' && !Array.isArray(args)) {
    const allowed = declared;
    if (allowed) {
      const unknownKeys = Object.keys(args).filter((k) => !allowed.has(k));
      if (unknownKeys.length > 0) {
        const zErr = new z.ZodError([
          {
            code: z.ZodIssueCode.unrecognized_keys,
            keys: unknownKeys,
            path: [],
            message: `Unrecognized key(s) in object: ${unknownKeys.map((k) => `'${k}'`).join(', ')}`,
          },
        ]);
        // Thread the branch's DECLARED REQUIRED param names so the actionable error names the
        // params that ARE required (Change B) — not just the bad one.
        throw new Error(formatZodErrorMessage(toolName, zErr, requiredKeys(schema)));
      }
    }
  }

  // SCHEMA-DRIVEN PARAM COERCION. Runs AFTER synonym/id normalization (so it
  // sees canonical names) and AFTER the strict-key check (so it never coerces a key that is
  // about to be rejected), and BEFORE .parse() so the validator judges real typed values.
  // Deny-by-default: anything not unambiguously convertible arrives at .parse() as the
  // original string and is rejected LOUDLY. See coerceArgsToDeclaredTypes.
  args = coerceArgsToDeclaredTypes(schema, args);

  try {
    return schema.parse(args);
  } catch (error) {
    if (error instanceof z.ZodError) {
      // ACTIONABLE ERRORS: drive a self-correcting message
      // from the structured zod issues — field + allowed values/expected type + a
      // corrected-call EXAMPLE — at this CENTRAL seam (not 30 bespoke strings). The
      // "Validation failed for <tool>" prefix + field names are preserved so existing
      // contract assertions stay green.
      throw new Error(formatZodErrorMessage(toolName, error));
    }
    throw error;
  }
}

/**
 * Validation middleware for MCP requests
 * @param toolName Name of the MCP tool
 * @param args Arguments to validate
 */
export function validationMiddleware(toolName: string, args: any) {
  try {
    const validatedArgs = validateToolArguments(toolName, args);
    return {
      success: true,
      data: validatedArgs,
      error: null
    };
  } catch (error) {
    const err = error as Error;
    return {
      success: false,
      data: null,
      error: err.message
    };
  }
}

/**
 * ID-param alias map (MCP-2026 rebuild Phase 1). Each pair is [legacyName → unifiedName]:
 * the drifted legacy record-handle names the rebuild's `$defs.Ref` unifies onto `id`
 * (and the bulk list onto `ids`). See normalizeIdSynonyms().
 */
const ID_PARAM_ALIASES: ReadonlyArray<readonly [legacy: string, unified: string]> = [
  ['contextId', 'id'],
  ['decisionId', 'id'],
  ['taskId', 'id'],
  ['task_ids', 'ids'],
];

/**
 * Accept the unified `id`/`ids` handle names on the ops that (in Phase 1) still DECLARE a
 * legacy `contextId`/`decisionId`/`taskId`/`task_ids` name — WITHOUT changing the advertised
 * surface (the legacy name stays the zod-declared + advertised canonical, so the tools/list
 * wire is byte-identical). For each pair, only when the op declares the LEGACY name: if the
 * caller supplied the unified alias (and not the legacy one), rewrite it onto the legacy name.
 * Old names keep working natively (the schema declares them); this only ADDS acceptance of
 * `id`/`ids`. Scoped to legacy-declaring ops so `id`-native ops (context_search, get_links)
 * are untouched. Non-mutating on the caller's object (clones on first rewrite).
 * (Phase 2 flips the declared canonical to `id` and this seam maps the legacy names inward.)
 */
function normalizeIdSynonyms(args: any, declared: Set<string>): any {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return args;
  let out = args;
  for (const [legacy, unified] of ID_PARAM_ALIASES) {
    if (!declared.has(legacy)) continue; // pair applies only to ops declaring the legacy name
    if (out[unified] !== undefined && out[legacy] === undefined) {
      if (out === args) out = { ...args }; // clone before first mutation
      out[legacy] = out[unified];
      delete out[unified];
    }
  }
  return out;
}

/**
 * TOOL-SCOPED PARAM SYNONYMS (MCP-2026 rebuild Phase 3).
 * The Phase-3 gateway canary surfaced the only recurring genuine first-call miss on the
 * gateway surface: the blind model reaches for the INTUITIVE param name. project.switch is
 * given `name` (the tool declares `project`); decision.record is given `type` (the tool
 * declares `decisionType`) — both then strict-key-rejected ("Unknown parameter"). Accept
 * the intuitive name as an ADDITIVE alias, SCOPED per opId (keyed by toolName) so it can
 * never bleed onto a sibling op that has a REAL param of that name:
 *   - project_switch `name`→`project`   — NOT project_create (its real `name` = the new
 *                                          project's name; project_create is absent here so
 *                                          it is never touched).
 *   - decision_record `type`→`decisionType` — NOT context_store / task_create (both declare
 *                                          a real `type`; absent here so never touched).
 * Each entry: toolName → [ [synonym, canonical], … ]. Additive/back-compat: the canonical
 * name keeps working natively (the schema declares it); this only ADDS acceptance of the
 * synonym. Mirrors the ID_PARAM_ALIASES precedent (a config table, not scattered branches).
 */
const TOOL_PARAM_SYNONYMS: Readonly<
  Record<string, ReadonlyArray<readonly [synonym: string, canonical: string]>>
> = {
  project_switch: [['name', 'project']],
  decision_record: [['type', 'decisionType']],
};

/**
 * Apply the tool-scoped param synonyms in TOOL_PARAM_SYNONYMS. For the given opId, for each
 * [synonym, canonical] pair: only when the caller supplied the synonym AND not the canonical,
 * rewrite the value onto the canonical name and drop the synonym. Ops absent from the table
 * (keyed by toolName) are returned untouched — so an op with a real param of that name (e.g.
 * project_create.name, context_store.type) is never remapped. Runs BEFORE the strict-key
 * check. Non-mutating on the caller's object (clones on first rewrite).
 */
function normalizeToolParamSynonyms(toolName: string, args: any): any {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return args;
  const pairs = TOOL_PARAM_SYNONYMS[toolName];
  if (!pairs) return args;
  let out = args;
  for (const [synonym, canonical] of pairs) {
    if (out[synonym] !== undefined && out[canonical] === undefined) {
      if (out === args) out = { ...args }; // clone before first mutation
      out[canonical] = out[synonym];
      delete out[synonym];
    }
  }
  return out;
}

/**
 * Normalize AI-friendly synonym parameters to canonical names
 * Enables natural language parameter variations without breaking validation
 */
function normalizeDecisionSynonyms(toolName: string, args: any): any {
  const normalized = { ...args };

  if (toolName === 'decision_record') {
    // rationale synonyms
    if (args.reasoning && !args.rationale) normalized.rationale = args.reasoning;
    if (args.reason && !args.rationale) normalized.rationale = args.reason;
    if (args.why && !args.rationale) normalized.rationale = args.why;

    // impactLevel synonyms
    if (args.impact && !args.impactLevel) normalized.impactLevel = args.impact;
    if (args.severity && !args.impactLevel) normalized.impactLevel = args.severity;
    if (args.priority && !args.impactLevel) normalized.impactLevel = args.priority;

    // alternativesConsidered synonyms.
    //
    // `options` is now ALSO a REAL, distinctly-shaped param (THE DECISION INBOX
    // and its follow-up): `[{key, label, pros, cons, recommended?}]`. Only treat it as the
    // legacy alternativesConsidered synonym when it does NOT look like a decision-inbox
    // options array — i.e. no entry carries `key` (the field decision_answer selects on,
    // and the one thing the legacy shape — bare strings, or {name, reasonRejected} — never
    // had). This is a SHAPE disambiguation, not a flag: a caller sending the real inbox
    // shape is never silently reinterpreted as "alternatives", and a caller sending the
    // old free-form shape is unaffected.
    const looksLikeInboxOptions = Array.isArray(args.options)
      && args.options.some((opt: any) => opt && typeof opt === 'object' && 'key' in opt);
    if (args.options && !args.alternativesConsidered && !looksLikeInboxOptions) {
      normalized.alternativesConsidered = Array.isArray(args.options)
        ? args.options.map((opt: any) => typeof opt === 'string'
            ? { name: opt, reasonRejected: 'Not selected' }
            : opt)
        : args.options;
      delete normalized.options;
    }
    if (args.alternatives && !args.alternativesConsidered) {
      normalized.alternativesConsidered = args.alternatives;
    }
    if (args.choices && !args.alternativesConsidered) {
      normalized.alternativesConsidered = args.choices;
    }

    // Clean up synonyms from normalized object
    delete normalized.reasoning;
    delete normalized.reason;
    delete normalized.why;
    delete normalized.impact;
    delete normalized.severity;
    delete normalized.priority;
    delete normalized.alternatives;
    delete normalized.choices;
  }

  if (toolName === 'decision_update') {
    // Back-compat / AI-friendly synonyms for the learning-loop fields. The tool
    // previously advertised `outcome`/`lessons`; accept them (and a few natural
    // variants) and map to the canonical param names the handler reads.
    if (args.outcome && !args.outcomeNotes) normalized.outcomeNotes = args.outcome;
    if (args.notes && !args.outcomeNotes) normalized.outcomeNotes = args.notes;
    if (args.lessons && !args.lessonsLearned) normalized.lessonsLearned = args.lessons;
    if (args.outcome_status && !args.outcomeStatus) normalized.outcomeStatus = args.outcome_status;

    delete normalized.outcome;
    delete normalized.notes;
    delete normalized.lessons;
    delete normalized.outcome_status;
  }

  if (toolName === 'decision_search') {
    // decisionType synonyms
    if (args.type && !args.decisionType) normalized.decisionType = args.type;

    // impactLevel synonyms
    if (args.impact && !args.impactLevel) normalized.impactLevel = args.impact;
    if (args.severity && !args.impactLevel) normalized.impactLevel = args.severity;

    // Clean up synonyms
    delete normalized.type;
    delete normalized.impact;
    delete normalized.severity;
  }

  return normalized;
}

export default validationMiddleware;
