/**
 * TASK NOTE LOG + DESCRIPTION HISTORY — the tunables for an earlier task.
 *
 * WHY THIS FILE EXISTS: "add a status note to this task" had no home. The caller reached
 * for `notes`, strict mode rejected it, the caller read the schema, saw `description`, and
 * `description` is a SILENT FULL REPLACE — so the task's SPEC was destroyed with no
 * warning, no diff and no undo. Measured 2026-08-21: two independent actors hit that exact
 * sequence in one session; one of them destroyed a build spec.
 *
 * The affordance now exists (`notes`, which APPENDS), and the destructive act is now
 * RECOVERABLE (the replaced description is preserved). Both need bounds, and per house
 * doctrine a bound is a named config value, never a literal in a query.
 */

/** Where the append-only note log lives inside `tasks.metadata`. */
export const TASK_NOTE_LOG_KEY = 'noteLog';

/** Where a replaced `description` is preserved inside `tasks.metadata`. */
export const TASK_DESCRIPTION_HISTORY_KEY = 'descriptionHistory';

export const TASK_NOTES_CONFIG = {
  /**
   * How many note entries to keep. The log is append-only up to this bound, then the
   * OLDEST entries fall off — a status log's value is recency, and an unbounded array in
   * a jsonb column that is read on every task_details is a row that grows without limit.
   */
  maxNoteEntries: 100,

  /**
   * How many superseded descriptions to keep. Smaller than the note bound on purpose: a
   * description is orders of magnitude larger than a note, and the entry that matters is
   * almost always the one you just clobbered. This is a RECOVERY buffer, not an audit log
   * — it exists so the destroyed text is still reachable in the same record, not so the
   * full editorial history of a task is preserved forever.
   */
  maxDescriptionHistory: 5,
} as const;
