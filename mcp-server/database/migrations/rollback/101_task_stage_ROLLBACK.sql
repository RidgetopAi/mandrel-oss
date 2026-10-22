-- ═════════════════════════════════════════════════════════════════════════════════════════
-- ROLLBACK 101 — remove tasks.stage (trigger + index + CHECK + column)
-- ═════════════════════════════════════════════════════════════════════════════════════════
--
-- ⚠️ SCHEMA-REVERSIBLE, DATA-LOSSY. Dropping `stage` destroys the Punch List lane every row
-- carries; `status` is UNTOUCHED (this migration never rewrites it outside of the trigger's
-- own derivation, and that derivation is not undone by this rollback — a row's `status` stays
-- exactly what it was at the moment you run this). Re-running 101 does NOT restore the exact
-- prior `stage` values for rows that were edited in between; it re-backfills from whatever
-- `status` each row carries AT THAT TIME, per the same todo/in_progress/blocked/completed/
-- cancelled -> stage map the forward migration used. If a row's stage carried information not
-- recoverable from its status (e.g. distinguishing `claimed` from `verifying`, both
-- status='in_progress'), that distinction is lost by this rollback and NOT restored by
-- re-running 101.
--
-- Pair with reverting the mcp-server application layer (taskStageEnum in validation.ts,
-- the `stage`/`punch` params, services/taskPunchCompleteness.ts) and the Command backend
-- mirror, or the server will accept/return a field the DB no longer has.

BEGIN;

DROP TRIGGER IF EXISTS tasks_stage_status_sync ON tasks;
DROP FUNCTION IF EXISTS tasks_sync_stage_status();

DROP INDEX IF EXISTS idx_tasks_project_stage;

ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_stage_check;

ALTER TABLE tasks DROP COLUMN IF EXISTS stage;

COMMIT;
