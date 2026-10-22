-- ═════════════════════════════════════════════════════════════════════════════════════════
-- ROLLBACK 093 — remove tasks.blocked_on + tasks.due_at
-- ═════════════════════════════════════════════════════════════════════════════════════════
--
-- ⚠️ SCHEMA-REVERSIBLE, DATA-LOSSY. Dropping a column destroys its values, and nothing else
-- in the schema mirrors them (no shadow table, no metadata copy). If any customer has set
-- blocked_on / due_at, DUMP THEM FIRST:
--
--     COPY (SELECT id, blocked_on, due_at FROM tasks
--            WHERE blocked_on IS NOT NULL OR due_at IS NOT NULL)
--       TO '/tmp/tasks_093_values.csv' CSV HEADER;
--
-- After this runs, the reader degrades to the labelled `status='blocked'` fallback exactly
-- as it does on an instance that never had 093 — that path is exercised by
-- src/tests/blockedOnAbsentColumn.contract.test.ts, so the rollback lands in a state the
-- test suite covers rather than an untested one.

DROP INDEX IF EXISTS idx_tasks_project_blocked_on;
ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_blocked_on_check;
ALTER TABLE tasks DROP COLUMN IF EXISTS blocked_on;
ALTER TABLE tasks DROP COLUMN IF EXISTS due_at;

DO $$
BEGIN
  RAISE NOTICE '↩️  093 ROLLBACK: tasks.blocked_on + tasks.due_at dropped (values destroyed); readers fall back to status=''blocked'' with the in-band low-precision label.';
END $$;
