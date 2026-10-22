-- ═════════════════════════════════════════════════════════════════════════════════════════
-- 103 — fix migration 101's two mint-to-`ready` sites for `blocked`, and make cancelling a
--        task actually clear its pick-lane stage. (Punch List
--        .)
-- ═════════════════════════════════════════════════════════════════════════════════════════
--
-- ═══ THE DEFECT THIS CLOSES ═══
-- Migration 101 minted `blocked` -> `ready` in TWO places: PART 2's one-time backfill (line 84)
-- and rule (a)'s INSERT branch (lines 104-106, "a bare INSERT with no stage backfills 'ready'").
-- `ready` is the picker's pick lane; a blocked task carries no metadata.punch by construction,
-- so it is BY DEFINITION not pickable, and it made every blocked task in every project (past
-- backfill, and every future one via the trigger) into permanent picker noise
-- (taskPunchCompleteness.ts's [PUNCH_INCOMPLETE] gate keeps rejecting it, forever).
--
-- Separately, rule (a) left `stage` UNTOUCHED on an UPDATE to `cancelled` — but 101's own
-- column comment (line 71) and its backfill (line 86) both already declare NULL as the
-- cancelled convention. A task cancelled out of `stage='ready'` stayed at `stage='ready'`,
-- so cancelling a task never removed it from the pick lane. The code contradicted its own
-- documentation.
--
-- ═══ THE FIX, NARROWLY ═══
-- (1) Both mint sites now target `draft` instead of `ready` for a blocked row born from
--     nothing: this data migration (below) for the one-time backfill's residue, and the
--     trigger function's INSERT branch for every future one. `draft` is an existing lane
--     member, means "not yet pickable", and the picker's own rule already rejects it with
--     reason=not-ready — no new stage member is introduced.
-- (2) The trigger's override-status branch now clears `stage` to NULL whenever
--     `NEW.status = 'cancelled'`, on INSERT or UPDATE alike, matching the documented
--     convention exactly. This is a new capability, not a relaxation of the carve-out below.
--
-- ═══ THE CARVE-OUT SURVIVES, UNCHANGED, FOR `blocked` ═══
-- Rule (a)'s reason for leaving stage alone on an UPDATE to `blocked` is untouched: a task can
-- be blocked while sitting in `claimed`, and unblocking it should not have to guess which stage
-- to resume at. This migration does not touch that path — only the mint-from-NULL branch
-- (blocked) and the override-status branch for cancelled change. Blocking a `claimed` task
-- still resumes at `claimed` (contract test CASE 3 in taskStageStatusSync.contract.test.ts,
-- and the new carve-out-control case added alongside this migration).
--
-- ═══ NO NEW TRIGGER, SO FIRING ORDER IS UNCHANGED ═══
-- This migration replaces `tasks_sync_stage_status()`'s BODY in place via CREATE OR REPLACE
-- FUNCTION. It does not drop/recreate the trigger and does not add a second trigger, so the
-- name `tasks_stage_status_sync` (still with no `trg_` prefix, still sorting before
-- `trg_tasks_closed_at_stamp` (098) and `trg_tasks_completed_at_stamp` (094/099) in Postgres's
-- same-timing BEFORE-trigger name order) is exactly as migration 101 left it. There is nothing
-- for this migration to reorder.
--
-- ═══ SCOPE ═══
-- This migration touches ONLY: the two mint sites, the cancel-clears-stage path, and a data
-- migration for rows already polluted by 101's backfill. It does not touch picker board.ts,
-- taskPunchCompleteness.ts, or the stage enum (no `blocked`/`cancelled` member added).
--
-- ═══ DEPLOY ═══
-- CN1 (per the task's DEPLOY NOTE) — reaches all 7 fleet instances. Build and merge only; the
-- roll is the operator's call, not the loop's. ROLL-FORWARD ONLY, idempotent (CREATE OR REPLACE
-- FUNCTION, a self-limiting UPDATE that only ever moves rows matching the exact polluted
-- signature). Re-running changes nothing once applied.

-- ─────────────────────────────────────────────────────────────────────────────────────────
-- PART 1 — data migration: move every row polluted by 101's backfill to the corrected target.
-- Signature is EXACTLY stage='ready' AND status='blocked' — the same signature the task
-- description identifies as "a row that reached the pick lane WITHOUT passing
-- taskPunchCompleteness.ts's [PUNCH_INCOMPLETE] gate". No other (stage, status) pair is
-- touched.
-- ─────────────────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  moved_count bigint;
BEGIN
  UPDATE tasks
     SET stage = 'draft'
   WHERE stage = 'ready' AND status = 'blocked';
  GET DIAGNOSTICS moved_count = ROW_COUNT;
  RAISE NOTICE '103 PART 1: data migration moved % row(s) from stage=ready AND status=blocked to stage=draft.', moved_count;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────────────────
-- PART 2 — the trigger function, corrected. Same function name, same trigger name/timing as
-- migration 101 — CREATE OR REPLACE only changes the body rules (a) executes.
-- ─────────────────────────────────────────────────────────────────────────────────────────
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
  'Keeps tasks.stage and tasks.status in sync (migrations 101, 103). stage is the source of truth: a stage-aware write derives status from stage (rule b, checked first so stage wins when both changed); a legacy status-only write, OR an INSERT naming no stage, derives stage from status (rules c/d, one shared branch — todo->ready, in_progress->claimed, completed->merged). Override statuses (rule a): blocked leaves an existing stage untouched on UPDATE (carve-out — a task blocked while claimed resumes at claimed) and mints a bare INSERT into draft, never ready (a blocked task is not pickable); cancelled always clears stage to NULL, on INSERT or UPDATE alike. Named WITHOUT a trg_ prefix so it sorts, and therefore FIRES, before trg_tasks_closed_at_stamp (098) and trg_tasks_completed_at_stamp (094/099) in Postgres BEFORE-trigger name order — those triggers must see the FINAL status this one computes. Migration 103 replaced this function''s body in place; it did not touch the trigger name or timing, so that firing order is unchanged.';

COMMENT ON COLUMN tasks.stage IS
  'The Punch List lane: draft/ready/claimed/verifying/evidence/merged/deployed, or NULL for a cancelled task. SOURCE OF TRUTH over `status`, kept in sync by trigger tasks_stage_status_sync (migrations 101, 103) in both directions — a stage-aware write derives status from stage, a legacy status-only write derives stage from status. blocked is an override status: an existing stage is left untouched on UPDATE (a task blocked while claimed resumes at claimed), and a bare INSERT with no stage mints draft, never ready (a blocked task is not pickable). cancelled is an override status whose stage is ALWAYS NULL, on INSERT or UPDATE alike (migration 103 fixed this to match the contract this comment already stated).';

-- ─────────────────────────────────────────────────────────────────────────────────────────
-- What actually happened, in the migration log
-- ─────────────────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  remaining_polluted bigint;
BEGIN
  SELECT count(*) INTO remaining_polluted FROM tasks WHERE stage = 'ready' AND status = 'blocked';
  RAISE NOTICE '103: tasks_sync_stage_status() replaced (blocked mints draft not ready; cancelled always clears stage to NULL). % row(s) remain at stage=ready AND status=blocked (expected 0).', remaining_polluted;
END $$;
