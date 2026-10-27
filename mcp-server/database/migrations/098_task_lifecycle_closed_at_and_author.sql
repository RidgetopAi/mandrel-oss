-- ═════════════════════════════════════════════════════════════════════════════════════════
-- 098 — THE TASK RECORD LEARNS ITS OWN LIFECYCLE: `tasks.closed_at` (both terminal doors)
--       plus a one-time case-fold of `tasks.created_by`. (gaps 1+3.)
-- ═════════════════════════════════════════════════════════════════════════════════════════
--
-- ═══ WHAT WAS WRONG ═══
-- MEASURED on prod 2026-09-05, answering the operator's question "do we generate more tasks than we
-- close?":
--   * `completed_at` is NULL on ALL 113 cancelled tasks (0 of 113 populated). Cancellation is
--     a close and the record did not say when it happened. The single largest event in our
--     backlog history — the 2026-08-19 cull of 107 tasks — had its date INFERRED from
--     `updated_at`, which is wrong the moment anything else touches the row.
--   * `created_by` carries TWO SPELLINGS OF ONE ACTOR: `coordinator` (24 rows) and `Coordinator` (7).
--     Any `GROUP BY created_by` reports one person as two, and any `WHERE created_by='coordinator'`
--     silently drops 7 rows. Same class as the `needs-operator`/`needs:operator` collision that
--     migration 093's tranche reported, and as commit 55411b9.
--
-- ═══ PART 1 — `closed_at`: WHY A NEW COLUMN AND NOT A RENAME ═══
-- The full three-option argument (stamp completed_at / rename it / add closed_at) is written
-- once, in `mcp-server/src/config/taskLifecycleConfig.ts`, and is not repeated here. The
-- short form: stamping `completed_at` on cancel makes the NAME A LIE and retroactively
-- changes what every existing `WHERE completed_at IS NOT NULL` query counts, inside this
-- product and in any customer's own SQL. Renaming cannot be made order-independent across a
-- fleet roll. Adding is purely additive, so a not-yet-migrated instance is unaffected.
--
-- After this migration the two columns answer two different questions and both names are
-- true:
--   completed_at — when this task reached `completed`. UNCHANGED semantics, unchanged
--                  consumers, still governed by migration 094's trigger and CHECK.
--   closed_at    — when this task LEFT THE BOARD, by either terminal door. The field a flow
--                  question wants.
--
-- ═══ THE BACKFILL: WHAT IS COPIED AND WHAT IS REFUSED ═══
-- COPIED: `closed_at := completed_at` for every row that has a `completed_at`. This is an
-- EXACT COPY of a recorded fact, not an inference — a completed row's close moment IS its
-- completion moment, by the definition above. Zero invention.
--
-- ⚠️ REFUSED, AND THIS IS DELIBERATE: the 113 cancelled rows are NOT backfilled. `updated_at`
-- is NOT a cancellation timestamp — it is "the last time anything touched this row", so it
-- happens to be right only for rows nothing has touched since, and NOTHING IN THE SCHEMA CAN
-- TELL YOU WHICH THOSE ARE. A backfill from it would hand the 2026-08-19 cull a precise
-- date that no instrument ever measured, and it would be indistinguishable from a real one
-- forever after. Their close dates are UNRECOVERABLE. They stay NULL, because NULL is
-- readable as "we did not record this" and a wrong timestamp is not readable as anything.
-- This is the same refusal migration 094 made for its 208 unstamped completed rows, and the
-- same one the assignee stamp made for its 364 unattributed ones.
--
-- ═══ WHY A TRIGGER OWNS THE COLUMN, AND THE APPLICATION NEVER NAMES IT ═══
-- Migration 094 made `completed_at` unforgettable with a trigger + CHECK, and kept the
-- application's own COALESCE clauses as defence in depth. `closed_at` deliberately does NOT
-- get that second half, and the reason is ORDER-INDEPENDENCE ACROSS THE FLEET ROLL.
--
-- 094 could safely have both layers because `completed_at` already existed everywhere. This
-- column does not. A roll and a migration run are two separate acts on eight instances, so
-- for some window SOME instance runs new code against a database with no `closed_at` — and
-- an UPDATE naming a column that is not there is SQLSTATE 42703: not a degraded field, a
-- failed `task_update`. Migration 093's tranche paid for that lesson with a whole
-- column-presence probe.
--
-- By putting the rule ONLY in the trigger, the application's write statements are BYTE-
-- IDENTICAL to what they were before this migration, so the pre-098 window is not merely
-- tolerated, it is unreachable. Code-first and migration-first land in the same state.
-- The READ side (the `closedAfter` filter, the `closedAt` field) is where the probe lives —
-- see services/taskColumnPresence.ts. This is the trigger being STRICTLY BETTER than an
-- application clause, not a shortcut around one: it also stamps rows written by a repair
-- script, a future service, or an operator's psql session, none of which the app layer
-- reaches.
--
-- ═══ FIRST WRITE WINS, AND TRANSITION-OUT CLEARS ═══
-- The same state-machine semantics 094 established, for the same reasons:
--   (1) ends up terminal with no stamp -> keep the row's PREVIOUS stamp if it had one, else
--       CURRENT_TIMESTAMP. A re-save of an already-cancelled task must NOT move the stamp
--       forward, or the column records "last touched while closed" and every flow number
--       computed from it is silently compressed.
--   (2) already terminal and already stamped -> UNTOUCHED.
--   (3) transition OUT of terminal (cancelled -> todo, completed -> in_progress, and also
--       completed -> cancelled is NOT a transition out: both are terminal, so the ORIGINAL
--       close moment is KEPT) -> NULL.
--   Case (3)'s parenthetical is the one that differs from 094 and it is the point of the
--   whole column: a task that is cancelled after having been completed closed ONCE, and
--   `closed_at` must not be re-stamped by the second terminal move. That is why the
--   predicate is "was terminal / is terminal", not "was completed / is completed".
--
-- ═══ NO CHECK BACKSTOP — SEE PART 1d ═══
-- 094 pairs its trigger with a CHECK. This migration deliberately does not, because on THIS
-- column the CHECK forces the very fabrication the column exists to prevent. The full
-- argument, with the measurements, is at PART 1d.
--
-- ═══ PART 2 — THE `created_by` CASE FOLD ═══
-- This IS backfilled, and the distinction from the refusal above is the whole point:
-- lowercasing `Coordinator` to `coordinator` DESTROYS NO INFORMATION AND INVENTS NONE. It is a
-- deterministic function of a value that is already there. Backfilling a cancellation date
-- would invent a fact nothing measured; folding a spelling asserts nothing that was not
-- already asserted. Those are different acts and only one of them is a guess.
--
-- The SQL expression below is a translation of `normalizeActor()` in
-- src/config/actorRegistry.ts (trim -> lowercase -> whitespace runs to one hyphen -> collapse
-- repeated hyphens -> strip edge hyphens -> empty becomes NULL). Two representations of one
-- rule is the drift this codebase keeps paying for, so the two are pinned together by an
-- EXECUTED test — src/tests/taskAuthorStamp.contract.test.ts runs this exact expression and
-- normalizeActor() over one shared fixture list and asserts they agree value by value. If
-- you edit either, that test goes red.
--
-- ═══ DEPLOY ═══
-- CN2, migration-bearing, ROLL-FORWARD ONLY — pinning code back does not revert schema.
-- Ships through the normal migration path (mcp-server/docker-entrypoint.sh owns migrations).
-- ORDER-INDEPENDENT in both directions, by construction, per the
-- trigger argument above.
-- IDEMPOTENT: ADD COLUMN IF NOT EXISTS, CREATE OR REPLACE FUNCTION, DROP+CREATE TRIGGER, a
-- guarded ADD CONSTRAINT, and a backfill whose WHERE clause is self-limiting. Re-running
-- changes nothing.

-- ─────────────────────────────────────────────────────────────────────────────────────────
-- PART 1a — the column
-- ─────────────────────────────────────────────────────────────────────────────────────────
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ;

COMMENT ON COLUMN tasks.closed_at IS
  'When this task LEFT THE BOARD, by either terminal door (completed or cancelled). Added by migration 098 because completed_at was NULL on all 113 cancelled tasks, so no flow question could be answered without inferring a date from updated_at. Distinct from completed_at, which keeps its exact prior meaning ("reached completed") and all its consumers. Owned entirely by trigger trg_tasks_closed_at_stamp, which stamps only on a TRANSITION into or out of the terminal set — never on an edit of an already-closed row, so a legacy unstamped row stays NULL through any number of unrelated updates. The application layer never names this column in a write, which is what makes the fleet roll order-independent. There is deliberately NO CHECK constraint (see migration 098 PART 1d): a CHECK has no OLD, so it cannot tell a legacy row from a new violation and would force a fabricated close date onto the 113 pre-098 cancelled rows, whose real dates are unrecoverable.';

-- ─────────────────────────────────────────────────────────────────────────────────────────
-- PART 1b — the auto-stamp
-- ─────────────────────────────────────────────────────────────────────────────────────────
-- Reads and writes ONLY `status` and `closed_at`. Migration 094's trg_tasks_completed_at_stamp
-- reads and writes only `status` and `completed_at`. The two share no written column, so their
-- fire order against each other cannot change any outcome — stated because Postgres orders
-- same-timing triggers by NAME and `closed_at` sorts before `completed_at`, which is a fact a
-- reader would otherwise have to go and check.
CREATE OR REPLACE FUNCTION tasks_stamp_closed_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  -- The terminal set. Held identically by TASK_TERMINAL_STATUSES in
  -- src/config/taskLifecycleConfig.ts; a third terminal status is a two-place edit.
  terminal CONSTANT text[] := ARRAY['completed', 'cancelled'];
BEGIN
  -- ═══ IT STAMPS ON THE *TRANSITION*, NEVER ON AN EDIT OF AN ALREADY-CLOSED ROW ═══
  -- This is the whole correctness of the column and the first cut got it wrong. That version
  -- keyed on "does this row END UP terminal with no stamp", which is true of every unrelated
  -- UPDATE to a LEGACY row — so retitling one of the 113 pre-098 cancelled tasks stamped it
  -- with TODAY. MEASURED before this fix: a cancelled row with closed_at NULL, given a
  -- retitle, came back closed_at = 2026-09-05. That is a fabricated close date on the exact
  -- rows this migration's header promises to leave NULL, and it is worse than the NULL it
  -- replaced: a NULL is visibly missing, a plausible date is silently believed. Same argument
  -- that keeps a forced value out of `blocked_on` and `anonymous` out of `created_by`.
  IF TG_OP = 'INSERT' THEN
    -- A row born terminal closed at its own creation. A caller-supplied value still wins, so
    -- a faithful restore can carry real history in.
    IF NEW.status = ANY(terminal) AND NEW.closed_at IS NULL THEN
      NEW.closed_at := CURRENT_TIMESTAMP;
    END IF;

  ELSIF NEW.status = ANY(terminal) AND NOT (OLD.status = ANY(terminal)) THEN
    -- TRANSITION IN — the only moment a close actually happens. Stamp unless the caller
    -- supplied one.
    IF NEW.closed_at IS NULL THEN
      NEW.closed_at := CURRENT_TIMESTAMP;
    END IF;

  ELSIF NOT (NEW.status = ANY(terminal)) AND OLD.status = ANY(terminal) THEN
    -- TRANSITION OUT — the row is back on the board, so it has no close moment.
    NEW.closed_at := NULL;
  END IF;

  -- EVERY OTHER UPDATE FALLS THROUGH UNTOUCHED, and that silence is the feature:
  --   · terminal -> terminal (completed -> cancelled): closed_at carries over unchanged, so
  --     the ORIGINAL close moment survives. The task closed once.
  --   · a re-save or unrelated edit of a closed row: unchanged, so a stamp can never be moved
  --     forward and every lead/cycle time computed from it stays honest.
  --   · a LEGACY row with closed_at NULL: STAYS NULL, through any number of edits. That is
  --     the promise in this file's header, and it is now kept by construction rather than
  --     asserted in prose.
  --   · an operator explicitly correcting closed_at on a closed row: HONORED. The first cut
  --     recovered OLD.closed_at over any supplied value, which silently defeated repair.
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION tasks_stamp_closed_at() IS
  'Stamps tasks.closed_at ON THE TRANSITION (migration 098). INSERT born terminal -> CURRENT_TIMESTAMP unless supplied. UPDATE crossing INTO the terminal set -> CURRENT_TIMESTAMP unless supplied. UPDATE crossing OUT -> NULL. EVERY OTHER UPDATE IS UNTOUCHED, which is the point: completed -> cancelled keeps the ORIGINAL close moment, a re-save can never move a stamp forward, and a LEGACY row with closed_at NULL stays NULL through unrelated edits instead of being stamped with today. Deliberately the ONLY writer of this column: the application layer never names it, which is what makes the fleet roll order-independent in both directions.';

DROP TRIGGER IF EXISTS trg_tasks_closed_at_stamp ON tasks;
CREATE TRIGGER trg_tasks_closed_at_stamp
  BEFORE INSERT OR UPDATE ON tasks
  FOR EACH ROW
  EXECUTE FUNCTION tasks_stamp_closed_at();

-- ─────────────────────────────────────────────────────────────────────────────────────────
-- PART 1c — the backfill that is a COPY, not a guess
-- ─────────────────────────────────────────────────────────────────────────────────────────
-- Only rows that already carry a recorded completion moment. Nothing is derived from
-- updated_at, here or anywhere in this file. Self-limiting, so re-running is a no-op.
UPDATE tasks
   SET closed_at = completed_at
 WHERE completed_at IS NOT NULL
   AND closed_at IS NULL;

-- ─────────────────────────────────────────────────────────────────────────────────────
-- PART 1d — THERE IS DELIBERATELY NO CHECK CONSTRAINT, AND THIS IS THE REASON
-- ─────────────────────────────────────────────────────────────────────────────────────
-- The first cut of this migration carried `CHECK (status NOT IN ('completed','cancelled')
-- OR closed_at IS NOT NULL) NOT VALID`, mirroring migration 094's backstop. It is REMOVED,
-- because it did not back the invariant up — IT FORCED THE INVARIANT TO BE VIOLATED.
--
-- A CHECK constraint has no OLD. It cannot tell "this row has been unstamped since before
-- the column existed" from "someone just created an unstamped terminal row". NOT VALID
-- exempts pre-existing rows from the initial VALIDATE and NOTHING MORE: the moment anything
-- UPDATES one of the 113 legacy cancelled rows — a retitle, a re-tag, a priority change —
-- the constraint is re-checked against that row, and the write fails unless a value is
-- invented. So its only reachable outcomes were "the unrelated edit fails" or "the trigger
-- fabricates a close date". MEASURED, both: with the trigger enabled a retitle returned
-- closed_at = 2026-09-05 on a row that closed 2026-08-19; with the trigger disabled the same
-- retitle failed SQLSTATE 23514.
--
-- That is the exact harm this column exists to prevent, installed as a guard. The 2026-08-19
-- cull of 107 tasks is the largest event in our backlog history and the number gap 1 is FOR;
-- a column that silently stamps today onto it is worse than the NULL it replaced, because a
-- NULL is visibly missing and a plausible date is silently believed.
--
-- WHAT WE GIVE UP, PLAINLY: if a future migration drops or disables
-- trg_tasks_closed_at_stamp, a terminal row can be written with no close moment and nothing
-- complains. That is a real loss and it is the smaller one. The trigger is BEFORE INSERT OR
-- UPDATE and unconditional, so it covers every writer the CHECK would have — application,
-- repair script, psql session — for every ACTUAL close. The CHECK added protection only in
-- the case where the trigger is already gone, and it charged for that with a guaranteed
-- falsification of history on every legacy row. Deletion is the fix (CLASSES.md C6): the
-- honest invariant is "a close is stamped WHEN IT HAPPENS", which is a statement about a
-- TRANSITION, and a CHECK cannot express a transition at all.
--
-- Dropped explicitly rather than merely omitted, so re-running 098 over a database that got
-- the first cut removes it.
ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_terminal_needs_closed_at;

-- ⚠️ MIGRATION 094 HAS THE IDENTICAL SHAPE and is deliberately NOT touched here: its
-- `tasks_completed_needs_stamp` CHECK does the same thing to its own 208 legacy unstamped
-- COMPLETED rows. Named rather than fixed — that is a separate migration against a shipped
-- constraint on 8 live instances and belongs in its own task with its own gate run.

-- ─────────────────────────────────────────────────────────────────────────────────────────
-- PART 2 — the created_by case fold (a normalization, NOT an invention)
-- ─────────────────────────────────────────────────────────────────────────────────────────
-- Mirrors normalizeActor() in src/config/actorRegistry.ts. Pinned to it by an executed test
-- (src/tests/taskAuthorStamp.contract.test.ts), not by this comment.
UPDATE tasks
   SET created_by = NULLIF(
         regexp_replace(
           regexp_replace(
             regexp_replace(lower(btrim(created_by)), '\s+', '-', 'g'),
             '-+', '-', 'g'),
           '^-+|-+$', '', 'g'),
         '')
 WHERE created_by IS NOT NULL
   AND created_by IS DISTINCT FROM NULLIF(
         regexp_replace(
           regexp_replace(
             regexp_replace(lower(btrim(created_by)), '\s+', '-', 'g'),
             '-+', '-', 'g'),
           '^-+|-+$', '', 'g'),
         '');

-- ─────────────────────────────────────────────────────────────────────────────────────────
-- What actually happened, in the migration log
-- ─────────────────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  copied           bigint;
  unrecoverable    bigint;
  distinct_authors bigint;
BEGIN
  SELECT count(*) INTO copied
    FROM tasks WHERE closed_at IS NOT NULL;
  SELECT count(*) INTO unrecoverable
    FROM tasks WHERE status IN ('completed', 'cancelled') AND closed_at IS NULL;
  SELECT count(DISTINCT created_by) INTO distinct_authors
    FROM tasks WHERE created_by IS NOT NULL;
  RAISE NOTICE '098: tasks.closed_at added; trg_tasks_closed_at_stamp installed (transition-only; NO CHECK constraint by design — see PART 1d). % row(s) now carry a close moment (copied EXACTLY from completed_at, never inferred). % terminal row(s) carry NONE and are NOT backfilled — their close dates are UNRECOVERABLE (updated_at is not a cancellation time). created_by folded to one spelling per actor: % distinct author(s) remain.', copied, unrecoverable, distinct_authors;
END $$;
