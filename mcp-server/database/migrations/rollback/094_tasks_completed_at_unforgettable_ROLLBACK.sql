-- ═════════════════════════════════════════════════════════════════════════════════════════
-- ROLLBACK 094 — remove the completed_at auto-stamp trigger + CHECK backstop
-- ═════════════════════════════════════════════════════════════════════════════════════════
--
-- SCHEMA-REVERSIBLE, NOT DATA-REVERSIBLE. Dropping these does not un-stamp any row the
-- trigger stamped while it was live, and it should not: those stamps record real
-- transitions observed by the database. What comes back is the ABILITY to write
-- `status='completed'` with no completion time — i.e. the defect. After this runs, the rule
-- exists only in application code again (services/task.ts and handlers/tasks.ts), and any
-- other writer can silently produce unrecoverable rows.
--
-- To see what the trigger stamped while it was live, before dropping it:
--   SELECT id, title, completed_at FROM tasks
--    WHERE status='completed' AND completed_at >= '<the migration deploy time>';

DROP TRIGGER IF EXISTS trg_tasks_completed_at_stamp ON tasks;
ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_completed_needs_stamp;
DROP FUNCTION IF EXISTS tasks_stamp_completed_at();

DO $$
BEGIN
  RAISE NOTICE '094 ROLLBACK: trg_tasks_completed_at_stamp + tasks_completed_needs_stamp removed. completed_at is enforced by application code only again; stamps already written are kept.';
END $$;
