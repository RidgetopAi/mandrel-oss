/**
 * Parameter-coercion configuration — an earlier task (P0).
 *
 * STANDING PRINCIPLE (the operator, binds this + all future builds): NO HARDCODED VARIABLES.
 * The string vocabularies + numeric grammars that decide whether a transport-stringified
 * argument can be safely converted back to its DECLARED type live HERE — one named value
 * each, with a comment — never a literal buried in a coercion branch.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS
 *
 * On the gateway surface the lazy inputSchema advertises only `action` + the branch's
 * required params; everything else rides `additionalProperties: true`. An MCP client
 * types its arguments against the advertised schema and STRINGIFIES anything it has no
 * declared type for. That client behaviour is legitimate and we do not try to change it.
 *
 * The server therefore has to convert those strings back using the type it DECLARED in
 * its own zod schema. These constants are the grammar of "can this string be converted
 * WITHOUT guessing?" — deliberately narrow, because the governing rule is DENY BY
 * DEFAULT: anything not matched here is left as the original string so the strict
 * validator rejects it LOUDLY. A value is never coerced to a wrong-but-plausible
 * substitute (no NaN, no 0, no silent [] — those are the silent-wrong-answer class this
 * task exists to kill).
 */

/**
 * String forms accepted as boolean TRUE (compared case-insensitively, after trim).
 * Kept in sync with the documented bridge forms; anything outside BOOL_TRUE/BOOL_FALSE
 * is left uncoerced for z.boolean() to reject (so "maybe" errors, it does not become true).
 */
export const BOOL_TRUE_STRINGS: readonly string[] = ['true', '1', 'yes', 'on'];

/**
 * String forms accepted as boolean FALSE. The empty string is included deliberately —
 * an omitted-but-present bridge param arrives as "" and means "not set", i.e. false.
 * NOTE this is exactly why z.coerce.boolean() is WRONG for our transport: it uses JS
 * truthiness, so the NON-EMPTY string "false" would coerce to `true` — a silent
 * correctness bug. Hence the explicit vocabulary.
 */
export const BOOL_FALSE_STRINGS: readonly string[] = ['false', '0', 'no', 'off', ''];

/**
 * A clean base-10 INTEGER string (optional leading `-`). Intentionally rejects exponents,
 * separators, hex, leading `+`, and whitespace-embedded forms — a param that arrives in
 * one of those shapes is far more likely a caller bug than an integer we should rescue.
 */
export const INT_STRING_PATTERN = /^-?\d+$/;

/**
 * A clean base-10 DECIMAL (or integer) string. Same deliberate narrowness as
 * INT_STRING_PATTERN: no exponent notation, no bare leading/trailing dot.
 */
export const FLOAT_STRING_PATTERN = /^-?\d+(\.\d+)?$/;
