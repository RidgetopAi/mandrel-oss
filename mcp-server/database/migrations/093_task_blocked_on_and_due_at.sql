-- ═════════════════════════════════════════════════════════════════════════════════════════
-- 093 — `tasks.blocked_on` + `tasks.due_at`: "waiting on a human" becomes a FIELD
-- (P5.5, SCOPE §2 / §8.6. Mandrel task P5.5.)
-- ═════════════════════════════════════════════════════════════════════════════════════════
--
-- ═══ WHAT WAS WRONG ═══
-- The briefing's most valuable section for a human operator — "what is waiting on ME" —
-- had NO SERVER CONCEPT AT ALL. `grep -rn "blocked_on" mcp-server/src` over the product at
-- ea77f00 returned zero lines. Our own shell selected that section BY TAG, from a four-tag
-- vocabulary we invented (`needs-operator`, `needs:operator`, `decision-needed`, `decision-gate`),
-- and that vocabulary is itself defective: the first two are ONE CONCEPT SPELLED TWO WAYS,
-- both live, so any consumer that picks one spelling sees a fraction of the truth.
--
-- Asking a customer to invent and consistently apply a four-tag vocabulary in order to
-- unlock their most valuable section is the failure the whole P5 tranche exists to delete.
-- A `WHERE` clause needs no convention. A tag does.
--
-- ═══ WHY `blocked_on` IS NOT `status` ═══
-- `tasks.status` already has a `blocked` value, and it is NOT the same question.
--   status  = what phase of its life is this task in?      (todo / in_progress / blocked / …)
--   blocked_on = WHO or WHAT has to act next?              (human / agent / external)
-- The two are orthogonal: an `in_progress` task can be waiting on a human decision without
-- stopping, and a `blocked` task is usually waiting on another TASK, not on a person.
-- MEASURED on the authors' own project before this migration was written: of 13 tasks with
-- `status='blocked'`, exactly ONE was actually blocked on a human. That is ~8% precision,
-- which is why `status='blocked'` is shipped only as a DISCLOSED, LABELLED interim fallback
-- and never as the answer.
--
-- NULL IS THE DEFAULT AND IT MEANS SOMETHING: "not blocked on anyone in particular".
-- It is deliberately NOT a fourth enum value. A column whose default asserts a fact about
-- every pre-existing row would be a backfill disguised as a schema change.
--
-- ═══ WHY A CHECK CONSTRAINT AND NOT A NATIVE ENUM TYPE ═══
-- The three values are enforced at the LOWEST layer that can hold them against raw SQL, a
-- future handler, or an operator's psql session (CLASSES.md C1's instrument ladder:
-- `type alias < code enforcement < DB constraint < observed values`). A native `CREATE TYPE`
-- enum would enforce the same set, but altering one is a DDL migration with a lock profile
-- we do not want on a fleet of 8 live instances; a CHECK is edited by dropping and re-adding
-- one constraint. `tasks.status` is precedent for varchar-with-documented-values here, and
-- this column is strictly stricter than that one.
--
-- ═══ DEPLOY ORDERING ACROSS 8 LIVE INSTANCES — ORDER-INDEPENDENT BY CONSTRUCTION ═══
-- This is the tranche's only schema migration, so the ordering is stated here rather than
-- left to be discovered:
--
--   MIGRATION FIRST, CODE SECOND  → safe. The columns exist and nothing reads them. Every
--     existing query is `SELECT <named columns>` — there is no `SELECT *` in the briefing
--     path — so two new nullable columns are invisible to code that predates them.
--   CODE FIRST, MIGRATION SECOND  → safe. The reader probes `information_schema.columns`
--     before it selects (services/taskBlockedOnCapability.ts) and, on ABSENT, renders the
--     labelled `status='blocked'` fallback with an in-band note naming this migration.
--     It does not 500 and it does not silently render an empty section.
--   MIGRATION FAILS HALFWAY        → safe. The statements below are each `IF NOT EXISTS`
--     and the whole file runs in the migrator's transaction, so a partial application is
--     not reachable; a failed run leaves the columns absent, which is the CODE-FIRST case.
--
-- The property that buys all three is that the reader NEVER assumes the column. That is
-- asserted by an executed test against a database that does not have this migration
-- (src/tests/blockedOnAbsentColumn.contract.test.ts), not by this comment.
--
-- ═══ REVERSIBLE? YES, WITH ONE STATED CAVEAT ═══
-- The rollback (rollback/093_..._ROLLBACK.sql) drops both columns and the index, restoring
-- the pre-093 shape exactly. It is DDL-reversible and NOT data-reversible: dropping a column
-- destroys the values in it. Any `blocked_on`/`due_at` a customer set is lost on rollback and
-- is not recoverable from anywhere else in the schema — there is no shadow table and no
-- metadata mirror. Rolling back is therefore safe for the SCHEMA and lossy for the DATA;
-- take a dump of (id, blocked_on, due_at) first if the values matter.

-- ── The columns ──────────────────────────────────────────────────────────────────────────
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS blocked_on varchar(16);
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS due_at timestamp with time zone;

-- ── The value set, enforced at the lowest layer ──────────────────────────────────────────
-- NOT VALID is deliberately NOT used: the column was just created, so every existing row is
-- NULL and the validating scan is free. A NOT VALID constraint here would buy nothing and
-- leave a second `VALIDATE CONSTRAINT` step for someone to forget.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'tasks_blocked_on_check'
  ) THEN
    ALTER TABLE tasks
      ADD CONSTRAINT tasks_blocked_on_check
      CHECK (blocked_on IS NULL OR blocked_on IN ('human', 'agent', 'external'));
  END IF;
END $$;

-- ── The index the section's query actually uses ──────────────────────────────────────────
-- PARTIAL on `blocked_on IS NOT NULL`: the overwhelming majority of rows are NULL (every row
-- that exists today, and NULL stays the default forever), so a full index would be almost
-- entirely dead entries maintained on every task write. `project_id` leads because every
-- read in this product is project-scoped and the section's predicate is
-- `project_id = $1 AND blocked_on = $2 AND archived_at IS NULL`.
CREATE INDEX IF NOT EXISTS idx_tasks_project_blocked_on
  ON tasks (project_id, blocked_on)
  WHERE blocked_on IS NOT NULL AND archived_at IS NULL;

COMMENT ON COLUMN tasks.blocked_on IS
  'WHO must act next for this task to move: human | agent | external. NULL (the default) means "not blocked on anyone in particular" and is NOT a fourth value. Orthogonal to status: an in_progress task can be waiting on a human, and a status=blocked task is usually waiting on another TASK. Migration 093 (P5.5).';

COMMENT ON COLUMN tasks.due_at IS
  'The task DEADLINE, as a structured field. Authoritative and SORTABLE — the briefing''s "Waiting on a human" section orders by it. Distinct from a date found in a task''s PROSE, which the briefing labels `due?` and states is a hint, not a deadline. NULL = no deadline recorded. Migration 093 (P5.5).';

DO $$
BEGIN
  RAISE NOTICE '✅ 093: tasks.blocked_on {human|agent|external, nullable} + tasks.due_at added; partial index idx_tasks_project_blocked_on created. Readers tolerate the ABSENT column (see taskBlockedOnCapability.ts) so migration/code deploy order is free.';
END $$;
