-- ═════════════════════════════════════════════════════════════════════════════════════════
-- 101 — `tasks.stage`: the PUNCH LIST's seven-stage lane, SOURCE OF TRUTH over `status`.
--       (Punch List, lane A.)
-- ═════════════════════════════════════════════════════════════════════════════════════════
--
-- ═══ WHAT THIS ADDS ═══
-- A new nullable `stage` column carrying one of seven values — draft, ready, claimed,
-- verifying, evidence, merged, deployed — plus a trigger that keeps the existing `status`
-- column DERIVED from it, so every reader that has ever filtered on `status` keeps working
-- unmodified while `stage` becomes the richer, punch-list-native lane a board actually needs
-- (a task that is `ready` vs `claimed` vs `verifying` are all `status='in_progress'`-adjacent
-- today and indistinguishable without this column).
--
-- ═══ WHY STAGE IS THE SOURCE OF TRUTH, NOT A MIRROR ═══
-- Two independent columns that both claim to describe "where is this task" drift the moment
-- two writers disagree (CLASSES.md C5). Rather than keep them independently writable and
-- reconcile after the fact, the trigger below makes ONE of them primary: a write that names
-- `stage` computes `status` from it; a legacy write that names only `status` (every caller
-- that predates this migration) computes `stage` from THAT, so the two agree by construction
-- in both directions. Neither a stage-aware writer nor a legacy status-only writer can put
-- the row in a state the other reads as contradictory.
--
-- ═══ WHY `blocked` AND `cancelled` ARE CARVED OUT ═══
-- `stage` has no member meaning "blocked" or "cancelled" — those are OVERRIDE statuses that
-- exist orthogonally to the punch-list lane a task is progressing through (a task can be
-- blocked while sitting in `claimed`, and unblocking it should not have to guess which stage
-- to resume at). So a write that sets status to either is honored VERBATIM and stage is left
-- alone (backfilled to 'ready' only on an INSERT that supplies neither, matching the
-- pre-existing status default). This is rule (a) below and it runs FIRST, before the
-- stage-wins / status-wins rules, so blocked/cancelled can never be silently overwritten by
-- a stage-derivation pass.
--
-- ═══ FIRING ORDER AGAINST MIGRATIONS 094/098/099 ═══
-- Postgres fires same-timing (BEFORE ROW) triggers on one table in NAME order. This
-- trigger is named `tasks_stage_status_sync` — no `trg_` prefix — which sorts BEFORE
-- `trg_tasks_closed_at_stamp` (098) and `trg_tasks_completed_at_stamp` (094/099) purely
-- because 't' < 't' is a tie broken by 'a' < 'r' at the next character ("tasks_..." vs
-- "trg_tasks_..."). That ordering is LOAD-BEARING: this trigger may rewrite NEW.status
-- (rules b/c/d below), and 094/098/099's triggers key their own stamps off NEW.status vs
-- OLD.status, so they must see the FINAL status this trigger computed, not the caller's raw
-- input. Verified by an executed test (taskStageStatusSync.contract.test.ts, case "stage=
-- merged sets status=completed AND closed_at") rather than left as an assertion — a stage=
-- merged write must stamp closed_at in the SAME statement, which only happens if 098's
-- trigger runs AFTER this one has already rewritten NEW.status to 'completed'.
--
-- ═══ DEPLOY ═══
-- CN2, migration-bearing, ROLL-FORWARD ONLY. Ships through the normal migration path
-- (mcp-server/docker-entrypoint.sh owns migrations).
-- IDEMPOTENT: guarded ADD COLUMN, guarded ADD CONSTRAINT, CREATE OR REPLACE FUNCTION,
-- DROP+CREATE TRIGGER, a self-limiting backfill. Re-running changes nothing.

-- ─────────────────────────────────────────────────────────────────────────────────────────
-- PART 1 — the column, its CHECK, and the filter index
-- ─────────────────────────────────────────────────────────────────────────────────────────
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS stage varchar(20);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'tasks_stage_check'
  ) THEN
    ALTER TABLE tasks
      ADD CONSTRAINT tasks_stage_check
      CHECK (stage IS NULL OR stage IN (
        'draft', 'ready', 'claimed', 'verifying', 'evidence', 'merged', 'deployed'
      ));
  END IF;
END $$;

COMMENT ON COLUMN tasks.stage IS
  'The Punch List lane: draft/ready/claimed/verifying/evidence/merged/deployed, or NULL for a cancelled task. SOURCE OF TRUTH over `status`, kept in sync by trigger tasks_stage_status_sync (migration 101) in both directions — a stage-aware write derives status from stage, a legacy status-only write derives stage from status. blocked/cancelled are override statuses that leave stage untouched.';

CREATE INDEX IF NOT EXISTS idx_tasks_project_stage ON tasks USING btree (project_id, stage);

-- ─────────────────────────────────────────────────────────────────────────────────────────
-- PART 2 — the backfill (existing rows, by CURRENT status, BEFORE the trigger exists)
-- ─────────────────────────────────────────────────────────────────────────────────────────
-- todo -> ready · in_progress -> claimed · blocked -> ready · completed -> merged ·
-- cancelled -> NULL (stays NULL; there is no member of the enum meaning "cancelled").
UPDATE tasks
   SET stage = CASE status
                 WHEN 'todo'        THEN 'ready'
                 WHEN 'in_progress' THEN 'claimed'
                 WHEN 'blocked'     THEN 'ready'
                 WHEN 'completed'   THEN 'merged'
                 WHEN 'cancelled'   THEN NULL
                 ELSE stage
               END
 WHERE stage IS NULL;

-- ─────────────────────────────────────────────────────────────────────────────────────────
-- PART 3 — the trigger. Runs BEFORE INSERT OR UPDATE; see the firing-order note above for
-- why the name has no `trg_` prefix.
-- ─────────────────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION tasks_sync_stage_status()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- (a) OVERRIDE STATUSES — blocked/cancelled are never rewritten by a stage-derivation
  -- pass, and they never rewrite stage EXCEPT to backfill a NULL stage on a bare INSERT
  -- (matching the pre-existing 'todo' default's backfill of 'ready').
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

  -- (c) LEGACY STATUS-ONLY WRITE: an UPDATE that changes status but not stage (a caller
  -- that has never heard of this column) derives stage from status, so an old MCP client
  -- or tenant stays truthful.
  --
  -- (d) INSERT with no stage supplied: an INSERT is a status "change" from nothing, so it
  -- takes the SAME derivation as (c) — a row born directly into e.g. status='completed'
  -- (a restore script, a seed, a legacy writer that has never heard of `stage`) derives
  -- stage='merged' rather than being left NULL, which is what made this a single shared
  -- branch rather than two: an INSERT-with-status is not a materially different event from
  -- an UPDATE-that-changes-status for the purpose of this derivation.
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

DROP TRIGGER IF EXISTS tasks_stage_status_sync ON tasks;
CREATE TRIGGER tasks_stage_status_sync
  BEFORE INSERT OR UPDATE ON tasks
  FOR EACH ROW
  EXECUTE FUNCTION tasks_sync_stage_status();

-- ─────────────────────────────────────────────────────────────────────────────────────────
-- What actually happened, in the migration log
-- ─────────────────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  by_stage text;
  null_stage bigint;
BEGIN
  SELECT string_agg(stage_val || '=' || cnt, ', ' ORDER BY stage_val NULLS LAST)
    INTO by_stage
    FROM (
      SELECT COALESCE(stage, '(null)') AS stage_val, count(*) AS cnt
        FROM tasks GROUP BY stage
    ) s;
  SELECT count(*) INTO null_stage FROM tasks WHERE stage IS NULL;
  RAISE NOTICE '101: tasks.stage added; tasks_stage_status_sync installed (fires before trg_tasks_closed_at_stamp / trg_tasks_completed_at_stamp by name order). Backfilled distribution: %. % row(s) have NULL stage (expected == cancelled row count).', by_stage, null_stage;
END $$;
