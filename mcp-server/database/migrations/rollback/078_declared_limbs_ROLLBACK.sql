-- ROLLBACK for 078_declared_limbs.sql
--
-- Drops the materialised limb columns and their indexes. SAFE ONLY IF the mcp-server
-- deployed alongside them has also been rolled back: the write paths UPDATE
-- declared_limbs on every context/decision/task write, so with this applied and that code
-- still running, every write logs a derivation error (the write itself still succeeds —
-- the derivation degrades rather than failing the user's record).
--
-- WHY THE WRITE PATHS SURVIVE IT, specifically — this is worth stating because it is
-- currently true by ACCIDENT rather than by design. The derivation runs AFTER the handler's
-- own INSERT/UPDATE has completed, and of the write paths only `bulkUpdateTasks` opens an
-- explicit transaction — whose write-back runs after its COMMIT. So the failing UPDATE
-- cannot roll back a user's record on any path; it is caught, logged, and the row is left
-- NOT-DERIVED. Verified against this rollback applied to a migrated database: all six write
-- paths (task create/update/bulk, context store/update, decision record/update) succeed and
-- their rows persist.
--
-- DESTRUCTIVE: the derived values are lost. They are fully RECOVERABLE by re-running
-- migration 078 and then `npx tsx scripts/backfill-declared-limbs.ts`, which recomputes
-- them from the records' own tags and prose. Nothing here holds authored data.

DROP INDEX IF EXISTS idx_contexts_declared_limbs;
DROP INDEX IF EXISTS idx_tasks_declared_limbs;
DROP INDEX IF EXISTS idx_technical_decisions_declared_limbs;

DROP INDEX IF EXISTS idx_contexts_id8;
DROP INDEX IF EXISTS idx_tasks_id8;
DROP INDEX IF EXISTS idx_technical_decisions_id8;

ALTER TABLE contexts
    DROP COLUMN IF EXISTS declared_limbs,
    DROP COLUMN IF EXISTS declared_limbs_ambiguous_drops;
ALTER TABLE tasks
    DROP COLUMN IF EXISTS declared_limbs,
    DROP COLUMN IF EXISTS declared_limbs_ambiguous_drops;
ALTER TABLE technical_decisions
    DROP COLUMN IF EXISTS declared_limbs,
    DROP COLUMN IF EXISTS declared_limbs_ambiguous_drops;

-- Restore migration 067's unconditional version bump. Safe unconditionally: with the
-- declared_limbs columns dropped above, no derived-only update can exist any more.
CREATE OR REPLACE FUNCTION public.bump_tasks_version() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.version := OLD.version + 1;
  RETURN NEW;
END;
$$;

COMMENT ON COLUMN public.tasks.version IS
  'Optimistic-lock counter. Bumped by trigger_bump_tasks_version on EVERY update (surface-independent). Used by the task claim''s optional expectedVersion CAS.';
