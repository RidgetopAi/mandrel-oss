-- ═════════════════════════════════════════════════════════════════════════════════════════
-- ROLLBACK 098 — remove tasks.closed_at (column + trigger + CHECK)
-- ═════════════════════════════════════════════════════════════════════════════════════════
--
-- ⚠️ SCHEMA-REVERSIBLE, DATA-LOSSY, AND ASYMMETRIC — read this before running it.
--
-- Dropping `closed_at` destroys every value in it, and only SOME of them are reconstructible:
--   * The COMPLETED rows' close moments survive, because 098 copied them FROM `completed_at`
--     and that column is untouched. Re-running 098 restores them exactly.
--   * The CANCELLED rows' close moments DO NOT SURVIVE, and re-running 098 will NOT bring
--     them back. `closed_at` is the only place a cancellation moment is ever recorded — that
--     is the entire reason the column exists. Every cancellation stamped since 098 was
--     applied is permanently lost by this script.
-- So dump first, always:
--
--     COPY (SELECT id, status, closed_at FROM tasks WHERE closed_at IS NOT NULL)
--       TO '/tmp/tasks_098_closed_at.csv' CSV HEADER;
--
-- After this runs, the read side degrades through the same column-presence probe a
-- never-migrated instance uses: `closedAt` disappears from the task record entirely (an
-- ABSENT key, not a null — services/taskColumnPresence.ts keeps those distinct) and a
-- `closedAfter` filter is REFUSED with a message naming migration 098 rather than silently
-- matching everything. That path is exercised by src/tests/taskClosedAtAbsentColumn.contract.test.ts,
-- so the rollback lands in a state the suite covers rather than an untested one.
--
-- ═══ PART 2 IS NOT REVERSED, AND CANNOT BE ═══
-- 098 also case-folded `tasks.created_by` (`Coordinator` -> `coordinator`). That is NOT undone here and
-- there is no script that could undo it: the original casing was destroyed by the fold, and
-- nothing recorded which of the folded rows had been capitalised. This is stated rather than
-- attempted — an "un-fold" that guessed which rows to re-capitalise would be the invention
-- 098 exists to refuse. The folded values are correct and canonical; the loss is cosmetic.

DROP TRIGGER IF EXISTS trg_tasks_closed_at_stamp ON tasks;
DROP FUNCTION IF EXISTS tasks_stamp_closed_at();
-- Kept as a belt-and-braces DROP even though 098 no longer ADDS this constraint: a database
-- that received the FIRST CUT of 098 still carries it, and this script must clean up after
-- that version too. Harmless where it was never created.
ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_terminal_needs_closed_at;
ALTER TABLE tasks DROP COLUMN IF EXISTS closed_at;
