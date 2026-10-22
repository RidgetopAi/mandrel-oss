/**
 * INPUT HYGIENE — the single source of truth for the boundary-validation vocabulary
 * that keeps obviously-malformed input out of the store.
 *
 * STANDING PRINCIPLE (the operator, binds this + all future builds): NO HARDCODED VARIABLES.
 * The signatures/strings a validator matches against are a tunable vocabulary — they
 * live HERE as named values with a stated justification, never as literals buried in a
 * zod refinement. Mirrors config/fieldLimits.ts, config/edgeTypes.ts, config/taskConfig.ts.
 *
 * ── THE BUG CLASS THIS MODULE EXISTS TO KILL ──────────────────────────────────
 * On 2026-07-17 a DEGRADED client session (a normal condition — long sessions,
 * compaction — for us AND customers) created 12 tasks whose `description` ended with
 * RAW tool-call XML that leaked into the argument value: the field's own closing
 * wrapper tag (`</description>`) followed by the next serialized parameter
 * (`<parameter name="tags">[...]`), with `tags` stored EMPTY and `createdBy` the
 * literal STRING "null". Mandrel accepted every one silently. Because Mandrel is a
 * MEMORY product, silently storing poison corrupts every later session that reads it —
 * exactly the "bad state compounds" failure. Validate at the boundary, FAIL LOUD.
 *
 * ── WHY A CODE-SPAN-AWARE MATCH, NOT A BARE SUBSTRING (a past incident pt 4) ────────
 * A guard STRICTER than the real acceptance set is itself a bug. A legitimate
 * bug-report task/context/decision routinely QUOTES these exact tags as documentation
 * inside backticks or fenced code blocks — THIS TASK'S OWN description does. So the
 * detector (utils/inputHygiene.ts) strips fenced/inline code spans BEFORE matching:
 * quoted-in-backticks documentation passes; a RAW un-quoted structural leak is
 * rejected. The signatures below are therefore only ever matched against prose the
 * writer did not deliberately mark as code.
 */

/**
 * Substrings that, when they appear as RAW (non-code-span) text, mark a value as leaked
 * tool-call XML rather than legitimate content. These are the structural wrapper tags of
 * a serialized tool call — a human/agent writing prose never emits them un-quoted; they
 * only appear when the raw serialized invocation bled into an argument value.
 *
 * Kept deliberately tight (the exact artifacts seen in the incident + their direct
 * siblings) so the guard matches REALITY, not a broad XML-phobia. Case-insensitive match
 * (see utils/inputHygiene.ts). Extend here — never with a literal in a schema.
 *
 * env: MANDREL_TOOL_CALL_ARTIFACT_SIGNATURES (comma-separated) overrides the defaults.
 */
export const TOOL_CALL_ARTIFACT_SIGNATURES: readonly string[] = parseSignatureEnv(
  'MANDREL_TOOL_CALL_ARTIFACT_SIGNATURES',
  [
    '</description>',       // a field's own closing wrapper tag leaked into its value
    '<parameter name=',     // the serialized next-parameter opener (the incident's tell)
    '</parameter>',         // its closing sibling
    '<invoke name=',        // the tool-invocation opener (antml/MCP serialized call)
    '</invoke>',            // its closing sibling
    '<function_calls>',     // the tool-call block opener
    '</function_calls>',    // its closing sibling
  ],
);

/**
 * Identity fields (assignedTo, createdBy, and their siblings) are free-form strings, so a
 * bare `z.string()` happily stores the literal word "null" / "undefined" — the JS/JSON
 * value having been stringified upstream by a degraded client. These are NEVER a real
 * identity; a value that trims+lowercases to one of these is the bug, not a name.
 *
 * env: MANDREL_RESERVED_IDENTITY_STRINGS (comma-separated) overrides the defaults.
 */
export const RESERVED_IDENTITY_STRINGS: readonly string[] = parseSignatureEnv(
  'MANDREL_RESERVED_IDENTITY_STRINGS',
  ['null', 'undefined', 'nan', '[object object]'],
).map((s) => s.toLowerCase());

/**
 * Parse a comma-separated env override into a trimmed, non-empty string list; fall back to
 * `fallback` when the env var is missing/blank/all-empty. Same defensive posture as the
 * envInt readers in config/taskConfig.ts and config/fieldLimits.ts.
 */
function parseSignatureEnv(name: string, fallback: readonly string[]): string[] {
  const raw = process.env[name]; // env-read: via-callers
  if (raw === undefined || raw.trim() === '') return [...fallback];
  const parsed = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return parsed.length > 0 ? parsed : [...fallback];
}

/**
 * ── METADATA SUBTREE SCAN ────────────────────────────────────────────
 * `metadata` is a free-form jsonb bag on TEN write boundaries, and until this task NOTHING
 * inside it was scanned for the leak the prose fields beside it reject. The P4 L1 capture
 * contract makes that acute: it INSTRUCTS agents to paste "the command and its output" into
 * `metadata.capture.evidence`, i.e. we actively push raw tool output into the one field with
 * LESS hygiene than `content`. Fixing only `capture.evidence` would leave every sibling key
 * open, so the scan walks the WHOLE subtree (guard the class, not the instance).
 *
 * The two bounds below exist because the bag is caller-supplied and arbitrarily shaped: a
 * pathological payload must cost bounded work, and the traversal must terminate on a shape
 * we did not anticipate. They are TUNABLES, so they live here (configs-not-hardcoded), never
 * as literals in the walker.
 *
 * WHAT HAPPENS AT THE BOUND IS THE POINT (CLASSES.md C1 — an instrument has THREE states):
 * hitting a bound is "could not measure", not "clean". `findArtifactSignaturesDeep` reports
 * truncation to its caller rather than returning an empty (= looks-clean) list, so a deep or
 * huge bag can never quietly become a pass.
 */

/** Maximum object/array nesting depth walked inside a `metadata` bag. env: MANDREL_METADATA_SCAN_MAX_DEPTH */
export const METADATA_SCAN_MAX_DEPTH: number = parseCountEnv('MANDREL_METADATA_SCAN_MAX_DEPTH', 12);

/** Maximum number of nodes visited in one `metadata` bag. env: MANDREL_METADATA_SCAN_MAX_NODES */
export const METADATA_SCAN_MAX_NODES: number = parseCountEnv('MANDREL_METADATA_SCAN_MAX_NODES', 5000);

/**
 * Maximum number of offending PATHS named in one rejection message. The message is
 * model-facing prose that has to stay readable; naming the first few is actionable, naming
 * two hundred is a wall. env: MANDREL_METADATA_SCAN_MAX_REPORTED
 */
export const METADATA_SCAN_MAX_REPORTED: number = parseCountEnv('MANDREL_METADATA_SCAN_MAX_REPORTED', 5);

/** Parse a positive-integer env override; fall back on missing/blank/non-positive/NaN. */
function parseCountEnv(name: string, fallback: number): number {
  const raw = process.env[name]; // env-read: via-callers
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
