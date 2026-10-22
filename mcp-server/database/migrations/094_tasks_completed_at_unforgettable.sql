-- ═════════════════════════════════════════════════════════════════════════════════════════
-- 094 — `tasks.completed_at` becomes UNFORGETTABLE: an auto-stamping trigger plus a
--       CHECK backstop.
-- ═════════════════════════════════════════════════════════════════════════════════════════
--
-- ═══ WHAT WAS WRONG ═══
-- The completion-stamp rule lived ONLY in application code, in TWO codebases:
--   mandrel-command/backend/src/services/task.ts  (single update + bulk update)
--   mcp-server/src/handlers/tasks.ts              (single update + bulk update)
-- Four call sites, one rule, kept in sync by discipline. The DATABASE enforced nothing:
-- `completed_at` was a plain nullable column with no default, no trigger, and the only
-- CHECK on the table was `tasks_progress_check`.
--
-- Anything else that ever writes this table — a migration, a repair script, a new service,
-- an operator's psql session — silently produces `status='completed'` with no completion
-- time, and nothing complains. That state is PERMANENTLY UNRECOVERABLE: the moment is gone
-- and cannot be reconstructed. Every lead-time, cycle-time and throughput number in the
-- product reads this column.
--
-- MEASURED on prod 2026-08-25, before this migration:
--   SELECT count(*) FROM tasks WHERE status='completed' AND completed_at IS NULL;   -- 208
--   SELECT count(*) FROM tasks WHERE status<>'completed' AND completed_at IS NOT NULL; --  0
--   SELECT count(*) FROM tasks;                                                     -- 3585
-- So ~5.8% of the table is already in the bad state, and the inverse bad state (a stamp on
-- a non-completed row) does not occur.
--
-- ═══ THE RULE THIS ENCODES ═══
-- Deliberately the SAME rule the four application call sites already implement, so the two
-- layers cannot disagree — this is an encoding of existing behaviour at a lower layer, not
-- a new behaviour:
--
--   (1) row ends up `status='completed'` with `completed_at IS NULL`
--         -> keep the row's PREVIOUS stamp if it had one, else CURRENT_TIMESTAMP.
--            Mirrors `completed_at = COALESCE(completed_at, CURRENT_TIMESTAMP)`.
--            Preferring OLD.completed_at over now() is strictly better than the app layer:
--            it recovers the REAL moment when a caller blanks the column, instead of
--            inventing a fresh one.
--   (2) row is already completed and already stamped -> UNTOUCHED. Never overwrite a real
--            timestamp. This is the defect that `COALESCE` was introduced to fix (an earlier task
--            : a bare `completed_at = CURRENT_TIMESTAMP` moved the stamp forward on
--            every re-save, silently compressing every lead time computed from it).
--   (3) TRANSITION OUT of completed (UPDATE, OLD.status='completed', NEW.status<>'completed')
--         -> `completed_at := NULL`. Mirrors services/task.ts and handlers/tasks.ts.
--
-- ═══ WHAT IT DELIBERATELY DOES *NOT* DO ═══
-- It does NOT clear `completed_at` on every non-completed row. The rule above fires only on
-- an actual transition OUT of completed. A blanket "status<>'completed' implies completed_at
-- IS NULL" would be a WIDER rule than any application layer has ever enforced, and it would
-- destroy a real timestamp on an INSERT that carries one — a data-loss fix that introduces
-- data loss. Prod has zero such rows today, so the narrow rule costs nothing and the wide
-- one buys nothing.
--
-- ═══ A ROW INSERTED DIRECTLY AS `status='completed'` ═══
-- IT IS STAMPED with CURRENT_TIMESTAMP if it carries no `completed_at`. Stated explicitly
-- because it has a consequence worth knowing:
--
--   ⚠️ A `pg_restore` / `COPY` of the 208 legacy unstamped rows will give them RESTORE-TIME
--      stamps. That is fabricated history. It is still the right default, because the
--      alternative — not stamping on INSERT — leaves those rows to be REJECTED by the CHECK
--      below (which enforces on INSERT even while NOT VALID), and a restore that aborts is
--      worse than a restore that annotates.
--      To restore byte-faithfully, disable the trigger around the load:
--        ALTER TABLE tasks DISABLE TRIGGER trg_tasks_completed_at_stamp;
--        -- ... restore ...
--        ALTER TABLE tasks ENABLE TRIGGER trg_tasks_completed_at_stamp;
--      (The CHECK is NOT VALID, so it does not block the re-enable, but it DOES reject
--       unstamped completed INSERTs while the trigger is off — see the note on the ALTER.)
--
-- ═══ WHY BOTH A TRIGGER AND A CHECK ═══
-- They answer different questions and the pair is the point.
--   The TRIGGER is the AUTO-CORRECT: nothing fails, nobody has to remember. It is what makes
--   the column unforgettable rather than merely guarded.
--   The CHECK is the BACKSTOP that proves the trigger cannot be bypassed. A trigger can be
--   disabled, replaced, or dropped by a future migration without anyone noticing; a
--   violating row would then land silently. With the CHECK present, the bad state is
--   unreachable no matter what happens to the trigger — which is the whole reason this rule
--   is being moved down a layer in the first place (CLASSES.md C1's instrument ladder:
--   `code enforcement < DB constraint`).
--
-- ═══ WHY `NOT VALID`, AND WHY NO BACKFILL ═══
-- `NOT VALID` enforces the constraint on every INSERT and every UPDATE from now on, while
-- tolerating rows that already violate it. The 208 existing rows keep reading and — as long
-- as the trigger is present — keep UPDATING fine, because the trigger stamps them on the way
-- through.
--
-- DO NOT run `VALIDATE CONSTRAINT` and DO NOT backfill the 208. Backfilling means INVENTING
-- completion timestamps we do not have; that is the same fabrication we refused for the
-- unassigned-actor rows and for SES-2025-0086. History stays honest; the
-- future is made unreachable-if-wrong.
--
-- ═══ EXISTING TRIGGERS ON `tasks` (checked on prod, 2026-08-25) ═══
--   tasks_dual_write_trigger        AFTER  INSERT/UPDATE/DELETE
--   trg_tasks_notify                AFTER  INSERT/UPDATE/DELETE
--   trigger_update_tasks_updated_at BEFORE UPDATE
--   trigger_bump_tasks_version      BEFORE UPDATE
-- None reads or writes `status` or `completed_at`, so fire order against this one does not
-- change any outcome. The two AFTER triggers see the STAMPED row, which is what they should
-- publish.
--
-- ═══ DEPLOY ═══
-- CN2, migration-bearing, ROLL-FORWARD ONLY — pinning code back does not revert schema.
-- Ships through the normal migration path (mcp-server/docker-entrypoint.sh owns migrations,
-- NOT fleet-deploy script).
-- ORDER-INDEPENDENT: the application layer keeps its own COALESCE clauses (defence in depth,
-- see the task record), and they compute the same value the trigger would, so
-- migration-first and code-first both land in the same state.
--
-- IDEMPOTENT: CREATE OR REPLACE FUNCTION, DROP+CREATE TRIGGER, and a guarded ADD CONSTRAINT.
-- Re-running changes nothing.

-- ── The auto-correct ─────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION tasks_stamp_completed_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status = 'completed' THEN
    -- (1) + (2): first write wins. An existing stamp is never overwritten; a blanked
    -- stamp is recovered from the old row before we fall back to inventing "now".
    IF NEW.completed_at IS NULL THEN
      IF TG_OP = 'UPDATE' AND OLD.completed_at IS NOT NULL THEN
        NEW.completed_at := OLD.completed_at;
      ELSE
        NEW.completed_at := CURRENT_TIMESTAMP;
      END IF;
    END IF;
  ELSIF TG_OP = 'UPDATE' AND OLD.status = 'completed' THEN
    -- (3): transition OUT of completed clears the stamp, mirroring both writers.
    NEW.completed_at := NULL;
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION tasks_stamp_completed_at() IS
  'Makes tasks.completed_at unforgettable (migration 094). Ends-up-completed with no stamp -> previous stamp, else CURRENT_TIMESTAMP. Already stamped -> untouched. Transition OUT of completed -> NULL. Encodes the rule the four application call sites already implement, at a layer no caller can bypass.';

DROP TRIGGER IF EXISTS trg_tasks_completed_at_stamp ON tasks;
CREATE TRIGGER trg_tasks_completed_at_stamp
  BEFORE INSERT OR UPDATE ON tasks
  FOR EACH ROW
  EXECUTE FUNCTION tasks_stamp_completed_at();

-- ── The backstop ─────────────────────────────────────────────────────────────────────────
-- NOT VALID: enforced on every new and updated row; the 208 pre-existing violators are
-- tolerated and NOT rewritten. See the header — do not VALIDATE this.
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

COMMENT ON COLUMN tasks.completed_at IS
  'When this task actually reached status=completed. UNFORGETTABLE since migration 094: trigger trg_tasks_completed_at_stamp auto-stamps it and CHECK tasks_completed_needs_stamp (NOT VALID) makes an unstamped completed row unreachable for any new or updated row. The constraint is deliberately NOT VALIDATED — 208 legacy rows predate the rule and backfilling them would invent timestamps we do not have.';

DO $$
DECLARE
  legacy_unstamped bigint;
BEGIN
  SELECT count(*) INTO legacy_unstamped
    FROM tasks WHERE status = 'completed' AND completed_at IS NULL;
  RAISE NOTICE '094: trg_tasks_completed_at_stamp + CHECK tasks_completed_needs_stamp (NOT VALID) installed. % legacy completed row(s) carry no stamp; they are TOLERATED and NOT backfilled — an UPDATE through the trigger will stamp them with the update time, which is honest as "we first observed it completed then", not as the original completion moment.', legacy_unstamped;
END $$;
