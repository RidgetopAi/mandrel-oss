-- Migration 046: Add archived_at soft-delete/archive column to contexts,
-- technical_decisions, and tasks.
--
-- WHY: There was NO tool to delete/clean up a context/decision/task — an agent had to
-- drop to raw SQL to remove a row, which violates the no-cheating bar (cleanup must be
-- reproducible through the public tool surface with ZERO SQL). This adds a REVERSIBLE
-- soft-delete: *_delete archives a row (sets archived_at), *_restore un-archives it.
-- Default list/search EXCLUDE archived rows; an includeArchived flag reveals them.
--
-- WHAT: a single nullable `archived_at timestamptz` column (default NULL) on each of
-- the three project-scoped entity tables. NULL = live (the only state today); a
-- timestamp = archived (when it was archived). This is:
--   * ADDITIVE — only adds a column, never alters/drops existing data.
--   * BACKWARD-COMPATIBLE — the column is NULLABLE with no default backfill, so every
--     existing row is `archived_at IS NULL` (live) exactly as before; today's
--     list/search behaviour is unchanged (nothing is archived yet).
--   * REVERSIBLE — soft, not hard: archiving sets the timestamp (the row STILL EXISTS
--     in the table); restoring clears it back to NULL. A matching down migration
--     (046_add_archived_at_soft_delete_ROLLBACK.sql) drops the columns + indexes.
--     Hard purge (irreversible DELETE) is deliberately OUT OF SCOPE.
--
-- This migration number (046) is ABOVE BASELINE_THROUGH (42), so it runs normally on
-- BOTH fresh builds (after the 000 baseline) and existing/already-baselined instances
-- (prod + tenants). Idempotent: ADD COLUMN IF NOT EXISTS + CREATE INDEX IF NOT EXISTS,
-- safe to re-run. The schema-contract reference (scripts/schema-reference.sql.txt) is
-- regenerated to reflect the 3 new columns + indexes so the CI drift gate (the CI gate stage
-- 0c) stays GREEN and honest.

-- Contexts: nullable archived_at (NULL = live).
ALTER TABLE contexts
  ADD COLUMN IF NOT EXISTS archived_at TIMESTAMP WITH TIME ZONE;

-- Technical decisions: nullable archived_at (NULL = live).
ALTER TABLE technical_decisions
  ADD COLUMN IF NOT EXISTS archived_at TIMESTAMP WITH TIME ZONE;

-- Tasks: nullable archived_at (NULL = live).
ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS archived_at TIMESTAMP WITH TIME ZONE;

-- Partial indexes on (project_id) WHERE archived_at IS NULL: the default list/search
-- path filters `archived_at IS NULL`, so a partial index keeps that hot path fast and
-- small (it indexes only the live rows). Mirrors the additive style of migration 045.
CREATE INDEX IF NOT EXISTS idx_contexts_live
  ON contexts (project_id)
  WHERE archived_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_technical_decisions_live
  ON technical_decisions (project_id)
  WHERE archived_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_tasks_live
  ON tasks (project_id)
  WHERE archived_at IS NULL;

COMMENT ON COLUMN contexts.archived_at IS
  'Soft-delete/archive marker. NULL = live; a timestamp = archived (when). Set by context_delete, cleared by context_restore. Default queries exclude archived rows (includeArchived to see them). Reversible — the row is never hard-deleted.';
COMMENT ON COLUMN technical_decisions.archived_at IS
  'Soft-delete/archive marker. NULL = live; a timestamp = archived (when). Set by decision_delete, cleared by decision_restore. Default queries exclude archived rows (includeArchived to see them). Reversible — the row is never hard-deleted.';
COMMENT ON COLUMN tasks.archived_at IS
  'Soft-delete/archive marker. NULL = live; a timestamp = archived (when). Set by task_delete, cleared by task_restore. Default queries exclude archived rows (includeArchived to see them). Reversible (distinct from the cancelled status, which is a lifecycle state, not a deletion).';

DO $$
BEGIN
  RAISE NOTICE '✅ archived_at (soft-delete) added to contexts, technical_decisions, tasks (nullable, NULL=live). Reversible via *_restore.';
END $$;
