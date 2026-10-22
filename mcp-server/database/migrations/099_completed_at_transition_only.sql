-- ═════════════════════════════════════════════════════════════════════════════════════════
-- 099 — `tasks.completed_at` stamps on the TRANSITION only; migration 094's NOT VALID CHECK
--       is dropped. (an earlier task. The same fix migration 098 made for `closed_at`.)
-- ═════════════════════════════════════════════════════════════════════════════════════════
--
-- ═══ WHAT WAS WRONG ═══
-- Migration 094 keyed its trigger on "does this row END UP completed with no stamp". That is
-- true of every unrelated UPDATE to a LEGACY unstamped row — so a retitle, a retag, a
-- priority change or a bulk sweep over one of the 208 pre-094 completed rows stamped it with
-- the date of the EDIT, and 094's `tasks_completed_needs_stamp` CHECK (NOT VALID) made that
-- fabrication MANDATORY: `NOT VALID` exempts existing rows from the one-time VALIDATE pass
-- and nothing else — every later UPDATE re-checks the row, so with the trigger off the same
-- edit fails SQLSTATE 23514. The only reachable outcomes were "fabricate" or "reject the
-- edit". Migration 098 measured exactly this on its first cut (a cancelled row given a
-- retitle came back closed_at = the retitle's date) and fixed itself; it NAMED 094 as
-- carrying the identical shape and deliberately left it for its own migration. This is it.
--
-- A NULL is visibly missing. A fabricated date is silently believed. Every lead-time and
-- throughput number reads this column, and the question it exists to answer ("when did this
-- close") becomes permanently unanswerable while LOOKING answered.
--
-- ═══ MEASURED ON PROD 2026-09-08, READ-ONLY, BEFORE THIS MIGRATION ═══
--   SELECT count(*) FROM tasks WHERE status='completed' AND completed_at IS NULL;   -- 208
-- 094 recorded 208 on 2026-08-25 and was applied 2026-08-26 19:26:25Z (_aidis_migrations).
-- Since 094 no new unstamped completed row can come into existence (INSERT and UPDATE both
-- stamp), so this count can only FALL — and every fall is either a delete or a fabricated
-- stamp. 208 -> 208 means ZERO of the legacy rows have been stamped by an unrelated edit so
-- far. The hazard was live for 13 days and did not fire; this migration closes it before it
-- does. No data repair is needed and none is shipped.
-- The weaker instrument was also read and is reported for honesty: 79 completed rows created
-- before 094 carry a completed_at after it. Those are REAL transitions (bulk closes on
-- 2026-08-26/27/28, in batches sharing one timestamp), not fabrications — the 208 invariant
-- above proves it, since a fabricated stamp would have moved a row OUT of the unstamped set.
-- `completed_at = updated_at` cannot be used as an instrument at all: 098's created_by fold
-- rewrote updated_at on every row at 2026-09-06 00:56:13Z.
--
-- ═══ THE RULE, AFTER THIS MIGRATION (mirrors 098's trg_tasks_closed_at_stamp) ═══
--   INSERT born completed with no stamp     -> CURRENT_TIMESTAMP (a caller-supplied value wins,
--                                              so a faithful restore carries real history in).
--   UPDATE crossing INTO completed          -> CURRENT_TIMESTAMP unless the caller supplied one.
--   UPDATE crossing OUT of completed        -> NULL.
--   EVERY OTHER UPDATE                      -> UNTOUCHED. That silence is the feature:
--     · a legacy unstamped row STAYS NULL through any number of unrelated edits;
--     · a re-save cannot move a stamp forward (094's rule (2), kept);
--     · an operator explicitly correcting completed_at on a completed row is HONORED —
--       including setting it to NULL. 094 recovered OLD.completed_at over a supplied NULL;
--       that branch silently defeats a repair script, which is the 098 finding, and it is
--       removed here for the same reason.
--
-- ═══ WHAT WE GIVE UP, PLAINLY ═══
-- Without the CHECK, if a future migration drops or disables trg_tasks_completed_at_stamp, a
-- completed row can be written with no stamp and nothing complains. That is a real loss and
-- it is the smaller one: the trigger is BEFORE INSERT OR UPDATE and unconditional, so it
-- covers every writer the CHECK would have — application, repair script, psql session — for
-- every ACTUAL completion. The CHECK protected only the case where the trigger was already
-- gone, and charged for it with a guaranteed falsification of history on every legacy row.
-- The honest invariant is "a completion is stamped WHEN IT HAPPENS", which is a statement
-- about a TRANSITION, and a CHECK cannot express a transition at all. Deletion is the fix
-- (CLASSES.md C6). 098 PART 1d makes the same argument at length.
--
-- Before dropping it:  grep -rn tasks_completed_needs_stamp --include='*.ts' --include='*.sql'
-- (excluding 094 and its rollback) hit only test files and a comment in 098; every test hit
-- is updated alongside this migration to assert the CHECK's ABSENCE.
--
-- The application layer's own COALESCE clauses (handlers/tasks.ts single + bulk) are
-- DELETED in the same change: they fired on any SUPPLIED status='completed', transition or
-- not, and a re-assert over a legacy NULL row fabricated a date through the app path — the
-- exact class this trigger closes. The trigger owns the column in both directions.
--
-- ═══ DEPLOY ═══
-- CN2, migration-bearing, ROLL-FORWARD ONLY — pinning code back does not revert schema.
-- Ships through the normal migration path (mcp-server/docker-entrypoint.sh owns migrations,
-- NOT fleet-deploy script).
-- IDEMPOTENT: CREATE OR REPLACE FUNCTION, DROP+CREATE TRIGGER, DROP CONSTRAINT IF EXISTS.
-- Re-running changes nothing.

-- ── The auto-stamp, transition-only ─────────────────────────────────────────────────────
-- Same function name as 094 so the existing trigger binding and every reference to it stay
-- valid; the body is replaced.
CREATE OR REPLACE FUNCTION tasks_stamp_completed_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status = 'completed' AND NEW.completed_at IS NULL THEN
      NEW.completed_at := CURRENT_TIMESTAMP;
    END IF;

  ELSIF NEW.status = 'completed' AND OLD.status <> 'completed' THEN
    -- TRANSITION IN — the only moment a completion actually happens.
    IF NEW.completed_at IS NULL THEN
      NEW.completed_at := CURRENT_TIMESTAMP;
    END IF;

  ELSIF NEW.status <> 'completed' AND OLD.status = 'completed' THEN
    -- TRANSITION OUT — the row is no longer completed, so it has no completion moment.
    NEW.completed_at := NULL;
  END IF;

  -- Every other UPDATE falls through untouched. See the header: a legacy unstamped row stays
  -- NULL, a re-save cannot move the stamp, an explicit correction is honored.
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION tasks_stamp_completed_at() IS
  'Stamps tasks.completed_at ON THE TRANSITION (migration 099, replaces the 094 body). INSERT born completed -> CURRENT_TIMESTAMP unless supplied. UPDATE crossing INTO completed -> CURRENT_TIMESTAMP unless supplied. UPDATE crossing OUT -> NULL. EVERY OTHER UPDATE IS UNTOUCHED: a legacy unstamped row stays NULL through unrelated edits instead of being stamped with today, a re-save cannot move a stamp forward, and an explicit correction (including to NULL) is honored.';

DROP TRIGGER IF EXISTS trg_tasks_completed_at_stamp ON tasks;
CREATE TRIGGER trg_tasks_completed_at_stamp
  BEFORE INSERT OR UPDATE ON tasks
  FOR EACH ROW
  EXECUTE FUNCTION tasks_stamp_completed_at();

-- ── The backstop is REMOVED — it forced the invariant to be violated ────────────────────
ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_completed_needs_stamp;

COMMENT ON COLUMN tasks.completed_at IS
  'When this task actually reached status=completed. Owned by trigger trg_tasks_completed_at_stamp, which since migration 099 stamps ONLY on a transition into completed and clears only on a transition out — never on an edit of an already-completed row, so the 208 legacy unstamped rows (measured 2026-08-25 and again 2026-09-08) stay NULL through unrelated updates instead of being stamped with the date of the edit. Migration 094''s CHECK tasks_completed_needs_stamp was dropped by 099: a CHECK has no OLD, cannot tell a legacy row from a new violation, and made that fabrication mandatory on every legacy-row UPDATE (098 PART 1d has the full argument). NULL here means "we did not record this", and it is never backfilled by inference.';

DO $$
DECLARE
  legacy_unstamped bigint;
  check_present    bigint;
BEGIN
  SELECT count(*) INTO legacy_unstamped
    FROM tasks WHERE status = 'completed' AND completed_at IS NULL;
  SELECT count(*) INTO check_present
    FROM pg_constraint WHERE conname = 'tasks_completed_needs_stamp';
  RAISE NOTICE '099: trg_tasks_completed_at_stamp is now TRANSITION-ONLY; CHECK tasks_completed_needs_stamp present after drop: % (expected 0). % legacy completed row(s) carry no stamp and will now STAY NULL through unrelated edits — their completion moments are unrecorded and are NOT backfilled.', check_present, legacy_unstamped;
END $$;
