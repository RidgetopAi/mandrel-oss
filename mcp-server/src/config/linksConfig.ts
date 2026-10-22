/**
 * LINKS — first-class `links` parameter config (Mandrel Core Redesign T5a).
 *
 * THE PRINCIPLE (the operator, standing rule): NO HARDCODED VARIABLES. Any tunable for the
 * explicit-links write path lives HERE, once, with a sane default + a one-line note —
 * never inlined at the call site where it would silently drift.
 *
 * The edge-type VOCABULARY is NOT here — it stays sourced from config/edgeTypes.ts (the
 * single source the DB CHECK + zod both derive from). This module only holds the
 * write-path knobs (bounds), so the two concerns don't get tangled.
 */

/**
 * Max number of explicit `links` accepted in a SINGLE context_store / decision_record
 * call. A guard rail (anti-abuse / accidental fan-out), well above any realistic
 * hand-authored write. The zod schema derives its array `.max()` from this so the
 * advertised contract, the validator, and this config can never drift. Tunable here.
 */
export const MAX_LINKS_PER_WRITE = 25;
