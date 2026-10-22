-- ═════════════════════════════════════════════════════════════════════════════════════════
-- ROLLBACK 099 — restore migration 094's end-state trigger body and its NOT VALID CHECK
-- ═════════════════════════════════════════════════════════════════════════════════════════
--
-- ⚠️ THIS REINSTATES THE DEFECT 099 FIXED. Read that before running it.
--
-- SCHEMA-REVERSIBLE, and the schema it reverses TO is the one that fabricates completion
-- dates: with the 094 body back, any unrelated UPDATE to one of the legacy unstamped
-- completed rows stamps it with the date of the edit, and the re-added NOT VALID CHECK
-- makes that mandatory (with the trigger off the same edit fails 23514). Nothing 099 wrote
-- to data needs undoing — 099 changes no row — so the only reason to run this is a defect
-- in 099's trigger body itself, and the honest response to that is a forward migration, not
-- this script.
--
-- Stamps written while 099 was live are real transitions and are kept.

CREATE OR REPLACE FUNCTION tasks_stamp_completed_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status = 'completed' THEN
    IF NEW.completed_at IS NULL THEN
      IF TG_OP = 'UPDATE' AND OLD.completed_at IS NOT NULL THEN
        NEW.completed_at := OLD.completed_at;
      ELSE
        NEW.completed_at := CURRENT_TIMESTAMP;
      END IF;
    END IF;
  ELSIF TG_OP = 'UPDATE' AND OLD.status = 'completed' THEN
    NEW.completed_at := NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_tasks_completed_at_stamp ON tasks;
CREATE TRIGGER trg_tasks_completed_at_stamp
  BEFORE INSERT OR UPDATE ON tasks
  FOR EACH ROW
  EXECUTE FUNCTION tasks_stamp_completed_at();

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'tasks_completed_needs_stamp'
  ) THEN
    ALTER TABLE tasks
      ADD CONSTRAINT tasks_completed_needs_stamp
      CHECK (status <> 'completed' OR completed_at IS NOT NULL) NOT VALID;
  END IF;
END $$;

DO $$
BEGIN
  RAISE NOTICE '099 ROLLBACK: 094 trigger body + NOT VALID CHECK tasks_completed_needs_stamp restored. Unrelated UPDATEs to legacy unstamped completed rows will fabricate completion dates again.';
END $$;
