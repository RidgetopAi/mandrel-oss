-- ROLLBACK for Migration 046: Add archived_at soft-delete/archive column.
--
-- Reverses 046 exactly: drops the partial live-row indexes and the archived_at
-- columns on contexts, technical_decisions, and tasks. Idempotent (IF EXISTS), so
-- safe to run whether or not 046 was applied. Dropping a nullable additive column is
-- itself non-destructive to the rest of the schema (it only removes the soft-delete
-- marker — any archived rows simply become indistinguishable from live rows again,
-- since soft-delete never removed them from the table).
--
-- NOTE: the migrate.ts runner only applies forward migrations and scans
-- database/migrations/ NON-recursively, so this file lives in the rollback/
-- subdirectory deliberately — it is the documented manual down-path and is NEVER
-- auto-run by the runner or the schema-contract gate. Apply by hand:
--   psql -d <db> -f database/migrations/rollback/046_add_archived_at_soft_delete_ROLLBACK.sql

DROP INDEX IF EXISTS idx_contexts_live;
DROP INDEX IF EXISTS idx_technical_decisions_live;
DROP INDEX IF EXISTS idx_tasks_live;

ALTER TABLE contexts             DROP COLUMN IF EXISTS archived_at;
ALTER TABLE technical_decisions  DROP COLUMN IF EXISTS archived_at;
ALTER TABLE tasks                DROP COLUMN IF EXISTS archived_at;

DO $$
BEGIN
  RAISE NOTICE '↩️  Rolled back 046: archived_at columns + live indexes dropped from contexts, technical_decisions, tasks.';
END $$;
