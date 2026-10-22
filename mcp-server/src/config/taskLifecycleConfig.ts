/**
 * taskLifecycleConfig — the NAMED constants for the task record's own LIFECYCLE: when it
 * closed, who filed it, and what it is waiting on.
 *
 * ═══ WHY THIS FILE EXISTS ═══
 * The task record could not answer basic questions about its own lifecycle. Answering
 * The operator's question — "do we generate more tasks than we close?" — cost 1,212 list records
 * plus 1,212 `task_details` calls, because the fields designed to answer it were empty,
 * absent, or not on the list. The board could not report on itself.
 *
 * Every value the fix needs is named HERE, per the standing no-hardcoded-variables rule and
 * matching config/blockedOnConfig.ts, which is this file's direct sibling: a column name
 * used by a probe, a migration reference used in an error message, and a TTL are exactly
 * the things that get typed twice and drift.
 *
 * ═══ THE `closed_at` NAMING DECISION (an earlier task gap 1) — WHY A NEW COLUMN ═══
 * Cancellation IS a close, and prod carried `completed_at IS NULL` on ALL 113 cancelled
 * tasks. Three options were on the table:
 *
 *   (a) STAMP `completed_at` ON CANCEL. Rejected: the field name becomes a lie. A column
 *       called `completed_at` that is non-null on a cancelled row makes every existing
 *       `WHERE completed_at IS NOT NULL` query — inside this product, in the Command
 *       backend, and in any customer's own SQL — start counting cancellations as
 *       completions, silently and retroactively. That is a semantic change to a shipped
 *       field disguised as a bug fix.
 *   (b) RENAME `completed_at` -> `closed_at`. Honest, and rejected on blast radius: it is a
 *       DDL rename across 8 live instances against code that reads the old name, plus
 *       migration 094's trigger and CHECK, plus the Command backend mirror, plus the public
 *       tool contract's `completedAt` field. A rename cannot be order-independent across a
 *       fleet roll; there is necessarily a window where one of the two names is wrong.
 *   (c) ADD `closed_at`, WRITTEN ON BOTH TERMINAL STATES. Chosen. Every name stays true:
 *       `completed_at` means "reached completed" and keeps its exact current semantics and
 *       every current consumer; `closed_at` means "left the board, by either door" and is
 *       the field a flow question actually wants. It is purely additive, so a pre-migration
 *       instance is unaffected, and the backfill for the completed rows is an EXACT COPY of
 *       `completed_at` rather than an inference.
 *
 * ⚠️ THE 113 CANCELLED ROWS ARE NOT BACKFILLED, AND THEIR CLOSE DATES ARE UNRECOVERABLE.
 * `updated_at` is NOT their cancellation moment — it is the last time anything touched the
 * row, so it is correct only for rows nothing has touched since, and there is no way to
 * tell which those are. Backfilling from it would be a guess wearing the costume of data,
 * and the single largest event in our backlog history (the 2026-08-19 cull of 107 tasks)
 * would acquire a precise-looking date that nothing measured. They stay NULL. NULL is
 * readable as "we did not record this"; a wrong timestamp is not readable as anything.
 * This is the same refusal migration 094 made for its 208 unstamped completed rows.
 */

/** Read a positive-integer env var, falling back to `fallback` on missing/garbage. */
function envInt(name: string, fallback: number): number {
  const raw = process.env[name]; // env-read: via-callers
  if (raw === undefined || raw === '') return fallback;
  const v = Number(raw);
  return Number.isInteger(v) && v > 0 ? v : fallback;
}

/**
 * The column migration 098 adds: when this task LEFT THE BOARD, by either terminal door.
 *
 * Named rather than typed as a literal because it is spoken by three different layers — the
 * schema probe, the `closedAfter` filter's WHERE clause, and the ORDER BY — and a column
 * name that appears as a string literal in three places is a rename waiting to half-happen.
 */
export const CLOSED_AT_COLUMN = 'closed_at';

/**
 * The migration that adds it. Quoted verbatim in the error a caller gets when they ask a
 * `closedAfter` question of a database that cannot answer it, so the message names the
 * remedy instead of describing the symptom.
 */
export const CLOSED_AT_MIGRATION = '098';

/**
 * THE TWO TERMINAL STATES — the statuses that mean "this task is off the board".
 *
 * This is the SINGLE declaration of that set for the application layer, and migration 098's
 * trigger holds the identical set one layer lower (CLASSES.md C1's instrument ladder: code
 * enforcement < DB constraint). Both are named here so a future third terminal status is a
 * one-line edit in two places that a reader can find, rather than a `status = 'completed' OR
 * status = 'cancelled'` scattered across handlers.
 *
 * `blocked` is deliberately NOT here. A blocked task is still on the board — that is the
 * whole point of gap 2 — and counting it as closed is exactly the arithmetic that made the
 * backlog look like it was draining when it was not.
 */
export const TASK_TERMINAL_STATUSES: readonly string[] = Object.freeze(['completed', 'cancelled']);

/**
 * How long the `closed_at` column-presence probe memoizes a PRESENT/ABSENT answer.
 *
 * Same default and the same reasoning as blockedOnConfig's TTL: a schema fact changes at
 * most once per deploy, and the probe is one catalog read. `unknown` is never cached — see
 * the probe itself. Set to 0 to probe on every call (what the contract tests do).
 *
 * env: MANDREL_TASK_CLOSED_AT_PROBE_TTL_MS
 */
export const READ_CLOSED_AT_CAPABILITY_TTL_MS = (): number =>
  envInt('MANDREL_TASK_CLOSED_AT_PROBE_TTL_MS', 60_000);

// ═════════════════════════════════════════════════════════════════════════════════════════
// GAP 3 — THE AUTHOR STAMP
// ═════════════════════════════════════════════════════════════════════════════════════════

/**
 * WHETHER AN UNRESOLVABLE AUTHOR MAY BE STAMPED AS THE FLAGGED `anonymous` ACTOR.
 *
 * FALSE, and this is the load-bearing half of gap 3 rather than a preference.
 * `created_by` was null on 116 of 154 open tasks. The obvious fix — "always write
 * SOMETHING" — replaces one honest hole with a field that is 100% populated and partly
 * fiction, and a fully-populated column is the one nobody re-checks. An unset author must
 * read as UNSET.
 *
 * `anonymous` is a real, deliberate, counted value elsewhere in this system (actorRegistry's
 * ACTOR_ANONYMOUS, stamped on SESSIONS so that actor coverage is measurable). It is right
 * there and wrong here, because the two fields answer different questions: a session must
 * exist and therefore must have some actor, while a task's author is a fact that either was
 * captured or was not. Writing `anonymous` into `created_by` would make
 * `GROUP BY created_by` report a prolific author who does not exist.
 *
 * Kept as a named constant rather than an unexplained `if` so that anyone who later wants
 * the opposite has to come here and read why. Not env-overridable: this is a data-integrity
 * invariant, not a tunable, and an env var would make it silently flippable per instance.
 */
export const TASK_AUTHOR_STAMP_ALLOWS_ANONYMOUS = false as const;
