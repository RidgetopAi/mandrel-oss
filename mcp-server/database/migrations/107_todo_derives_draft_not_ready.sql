-- ═════════════════════════════════════════════════════════════════════════════════════════
-- 107 — a stage DERIVED from status=todo is `draft`, never `ready`.
--        (Punch List, an earlier task.)
-- ═════════════════════════════════════════════════════════════════════════════════════════
--
-- ═══ THE DEFECT ═══
-- handlers/tasks.ts createTask runs assertPunchComplete only for the stage the CALLER passed.
-- A task created with NO stage (and no status) goes out with stage NULL, and rules (c)/(d) of
-- tasks_sync_stage_status() derived stage='ready' from status='todo' — landing in the picker's
-- pick lane with no metadata.punch, bypassing the completeness gate. The same derivation ran
-- on a legacy status-only UPDATE, so reopening a merged task with status=todo dropped it into
-- `ready` with whatever punch it had. 103 fixed the same hole for blocked and left todo.
--
-- ═══ THE FIX ═══
-- (1) Rules (c)/(d): todo -> draft. in_progress -> claimed and completed -> merged are
--     UNCHANGED. Explicit stage writes (rule b) are unchanged and stay gated by
--     assertPunchComplete; stage='ready' still derives status='todo'.
-- (2) Idempotent data repair: rows at stage='ready' with no metadata.punch.doneWhen move to
--     `draft`. Rows that HAVE a doneWhen are untouched. A second run moves 0 rows.
-- Function name, trigger name and timing are unchanged (the name-order firing note in 101 is
-- load-bearing: CREATE OR REPLACE only swaps the body). ROLL-FORWARD ONLY, idempotent.

DO $$
DECLARE
  moved_count bigint;
BEGIN
  UPDATE tasks
     SET stage = 'draft'
   WHERE stage = 'ready'
     AND (metadata #>> '{punch,doneWhen}') IS NULL;
  GET DIAGNOSTICS moved_count = ROW_COUNT;
  RAISE NOTICE '107: data repair moved % row(s) from stage=ready with no metadata.punch.doneWhen to stage=draft.', moved_count;
END $$;

CREATE OR REPLACE FUNCTION tasks_sync_stage_status()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- (a) OVERRIDE STATUSES — blocked/cancelled are never rewritten by a stage-derivation pass.
  --
  -- blocked: an UPDATE leaves stage exactly as it is (carve-out, migration 101 — a task
  -- blocked while `claimed` resumes at `claimed`, unchanged by this migration). A bare INSERT
  -- with no stage supplied mints `draft` — NOT `ready` — because a blocked task is not
  -- pickable by construction and has no metadata.punch to pass the picker's gate (migration
  -- 103).
  --
  -- cancelled: stage is ALWAYS cleared to NULL, on INSERT or UPDATE alike, matching the
  -- column's own documented contract ("or NULL for a cancelled task", migration 101 line 71)
  -- and the one-time backfill's own mapping (cancelled -> NULL, migration 101 line 86). Before
  -- migration 103 this branch left stage untouched on UPDATE, so cancelling a task out of
  -- stage='ready' never cleared it from the pick lane — that contradiction is what this closes.
  IF NEW.status IN ('blocked', 'cancelled') THEN
    IF TG_OP = 'INSERT' AND NEW.stage IS NULL AND NEW.status = 'blocked' THEN
      NEW.stage := 'draft';
    END IF;
    IF NEW.status = 'cancelled' THEN
      NEW.stage := NULL;
    END IF;
    RETURN NEW;
  END IF;

  -- (b) STAGE WINS: an INSERT that supplies a stage, or an UPDATE that CHANGES it, derives
  -- status from stage. Checked before (c) so a call that sets BOTH stage and status has
  -- stage govern, per the contract ("stage wins if both changed"). UNCHANGED from migration 101.
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

  -- (c) LEGACY STATUS-ONLY WRITE: an UPDATE that changes status but not stage (a caller
  -- that has never heard of this column) derives stage from status, so an old MCP client
  -- or tenant stays truthful.
  --
  -- (d) INSERT with no stage supplied: an INSERT is a status "change" from nothing, so it
  -- takes the SAME derivation as (c) — a row born directly into e.g. status='completed'
  -- (a restore script, a seed, a legacy writer that has never heard of `stage`) derives
  -- stage='merged' rather than being left NULL, which is what made this a single shared
  -- branch rather than two: an INSERT-with-status is not a materially different event from
  -- an UPDATE-that-changes-status for the purpose of this derivation. UNCHANGED from
  -- migration 101 — neither rule (c) nor (d) can ever see status IN ('blocked', 'cancelled'),
  -- rule (a) has already RETURNed for those.
  IF (TG_OP = 'UPDATE' AND OLD.status IS DISTINCT FROM NEW.status)
     OR (TG_OP = 'INSERT' AND NEW.stage IS NULL) THEN
    NEW.stage := CASE NEW.status
                   WHEN 'todo'        THEN 'draft'
                   WHEN 'in_progress' THEN 'claimed'
                   WHEN 'completed'   THEN 'merged'
                   ELSE NEW.stage
                 END;
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION tasks_sync_stage_status() IS
  'Keeps tasks.stage and tasks.status in sync (migrations 101, 103, 107). stage is the source of truth: a stage-aware write derives status from stage (rule b, checked first so stage wins when both changed); a legacy status-only write, OR an INSERT naming no stage, derives stage from status (rules c/d, one shared branch — todo->draft, in_progress->claimed, completed->merged). todo derives draft, NEVER ready: ready is the picker pick lane and is reachable only by an explicit stage write that passed the punch completeness gate (migration 107). Override statuses (rule a): blocked leaves an existing stage untouched on UPDATE (carve-out) and mints a bare INSERT into draft; cancelled always clears stage to NULL. Named WITHOUT a trg_ prefix so it sorts, and therefore FIRES, before trg_tasks_closed_at_stamp (098) and trg_tasks_completed_at_stamp (094/099) in Postgres BEFORE-trigger name order; migrations 103 and 107 replaced the body in place and did not touch the trigger name or timing.';

COMMENT ON COLUMN tasks.stage IS
  'The Punch List lane: draft/ready/claimed/verifying/evidence/merged/deployed, or NULL for a cancelled task. SOURCE OF TRUTH over `status`, kept in sync by trigger tasks_stage_status_sync (migrations 101, 103, 107) in both directions — a stage-aware write derives status from stage, a legacy status-only write derives stage from status: todo->draft (never ready; migration 107 — ready needs an explicit, punch-gated stage write), in_progress->claimed, completed->merged. blocked is an override status: an existing stage is left untouched on UPDATE, and a bare INSERT with no stage mints draft. cancelled is an override status whose stage is ALWAYS NULL.';
