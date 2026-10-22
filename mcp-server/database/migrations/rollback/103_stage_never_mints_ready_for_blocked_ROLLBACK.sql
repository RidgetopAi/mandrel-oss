-- ═════════════════════════════════════════════════════════════════════════════════════════
-- ROLLBACK 103 — restore migration 101's original trigger body (blocked mints ready on a bare
-- INSERT; cancelled leaves stage untouched), and best-effort revert the data migration.
-- ═════════════════════════════════════════════════════════════════════════════════════════
--
-- ⚠️ DATA-LOSSY, LIKE EVERY OTHER ROLLBACK IN THIS DIRECTORY. The UPDATE below reverts every
-- row currently at stage='draft' AND status='blocked' back to stage='ready'. It cannot
-- distinguish a row that reached that state because 103's mint fix put it there from a row an
-- operator legitimately moved to draft while blocked AFTER 103 shipped — both are reverted
-- uniformly. That is the same class of caveat 101's own rollback already documents for its
-- backfill: re-deriving from current state is not the same as replaying history.
--
-- Pair with reverting the mcp-server application layer if it has since started relying on
-- draft-mints-instead-of-ready or cancel-clears-stage behavior.

BEGIN;

CREATE OR REPLACE FUNCTION tasks_sync_stage_status()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- (a) OVERRIDE STATUSES — blocked/cancelled are never rewritten by a stage-derivation
  -- pass, and they never rewrite stage EXCEPT to backfill a NULL stage on a bare INSERT
  -- (matching the pre-existing 'todo' default's backfill of 'ready'). [migration 101 original]
  IF NEW.status IN ('blocked', 'cancelled') THEN
    IF TG_OP = 'INSERT' AND NEW.stage IS NULL AND NEW.status = 'blocked' THEN
      NEW.stage := 'ready';
    END IF;
    RETURN NEW;
  END IF;

  -- (b) STAGE WINS: an INSERT that supplies a stage, or an UPDATE that CHANGES it, derives
  -- status from stage. Checked before (c) so a call that sets BOTH stage and status has
  -- stage govern, per the contract ("stage wins if both changed").
  IF (TG_OP = 'INSERT' AND NEW.stage IS NOT NULL)
     OR (TG_OP = 'UPDATE' AND OLD.stage IS DISTINCT FROM NEW.stage) THEN
    NEW.status := CASE NEW.stage
                    WHEN 'draft'     THEN 'todo'
                    WHEN 'ready'     THEN 'todo'
                    WHEN 'claimed'    THEN 'in_progress'
                    WHEN 'verifying'  THEN 'in_progress'
                    WHEN 'evidence'   THEN 'in_progress'
                    WHEN 'merged'     THEN 'completed'
                    WHEN 'deployed'   THEN 'completed'
                    ELSE NEW.status
                  END;
    RETURN NEW;
  END IF;

  -- (c)/(d) LEGACY STATUS-ONLY WRITE / INSERT with no stage supplied.
  IF (TG_OP = 'UPDATE' AND OLD.status IS DISTINCT FROM NEW.status)
     OR (TG_OP = 'INSERT' AND NEW.stage IS NULL) THEN
    NEW.stage := CASE NEW.status
                   WHEN 'todo'        THEN 'ready'
                   WHEN 'in_progress' THEN 'claimed'
                   WHEN 'completed'   THEN 'merged'
                   ELSE NEW.stage
                 END;
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION tasks_sync_stage_status() IS
  'Keeps tasks.stage and tasks.status in sync (migration 101). stage is the source of truth: a stage-aware write derives status from stage (rule b, checked first so stage wins when both changed); a legacy status-only write, OR an INSERT naming no stage, derives stage from status (rules c/d, one shared branch — todo->ready, in_progress->claimed, completed->merged). blocked/cancelled are override statuses left untouched in either direction (rule a). Named WITHOUT a trg_ prefix so it sorts, and therefore FIRES, before trg_tasks_closed_at_stamp (098) and trg_tasks_completed_at_stamp (094/099) in Postgres BEFORE-trigger name order — those triggers must see the FINAL status this one computes.';

COMMENT ON COLUMN tasks.stage IS
  'The Punch List lane: draft/ready/claimed/verifying/evidence/merged/deployed, or NULL for a cancelled task. SOURCE OF TRUTH over `status`, kept in sync by trigger tasks_stage_status_sync (migration 101) in both directions — a stage-aware write derives status from stage, a legacy status-only write derives stage from status. blocked/cancelled are override statuses that leave stage untouched.';

-- Best-effort revert of the data migration (see the data-lossy caveat above).
UPDATE tasks SET stage = 'ready' WHERE stage = 'draft' AND status = 'blocked';

COMMIT;
