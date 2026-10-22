-- Migration 078: DECLARED LIMBS — materialise, per record, the limbs it declares.
-- an earlier decision Phase 1.
--
-- ── WHAT THIS IS FOR ─────────────────────────────────────────────────────────────────
-- A "limb" is a line of work identified by its ROOT record (a task or a decision). A
-- record declares limbs through its `task:`/`decision:`/`epic:` tags AND through 8-hex ids
-- named in its prose. Phase 2 (`recall_thread` terminality) reads this column to decide
-- whether a node may be EXPANDED through; the derivation itself lives in
-- src/services/declaredLimbs.ts and is pinned to the evaluated rule by a golden-file test.
--
-- ── THREE STATES, AND WHY THE COLUMN IS NULLABLE WITH NO DEFAULT ─────────────────────
--   NULL   → NOT DERIVED. The row predates this migration, or was written while the
--            write-time kill switch (MANDREL_LIMBS_WRITE_TIME_ENABLED) was off, or its
--            derivation errored. Work the backfill still owes.
--   '{}'   → DERIVED, and this record declares NOTHING. Unassignable, therefore terminal
--            under Phase 2. This is the MAJORITY of the riverbend corpus — a large and
--            EXPECTED population, not an error state. The measured proportion and the
--            query behind it are on deliberately not copied here:
--            a number in a comment goes stale without anything noticing.
--   {…}    → DERIVED, with limb roots.
-- A `NOT NULL DEFAULT '{}'` would collapse the first two into one value and destroy the
-- only signal that says whether the backfill has run — the "could not measure" state
-- sharing a value with "measured, nothing there".
--
-- ── THE DATA BACKFILL IS A SEPARATE, RE-RUNNABLE STEP ────────────────────────────────
-- This file is DDL only. The backfill cannot be written as SQL: resolving an 8-hex prefix
-- requires the same ambiguity handling as the write path, and a second implementation in
-- PL/pgSQL is exactly the drift the golden test exists to prevent. It runs as:
--     npx tsx scripts/backfill-declared-limbs.ts [--dry-run] [--project <name>]
-- which calls the SAME derivation the write path calls. It is idempotent and re-runnable:
-- it recomputes from the record's current tags and prose and overwrites.
--
-- ── ADDITIVE / IDEMPOTENT / BACKWARD-COMPATIBLE ──────────────────────────────────────
--   * ADD COLUMN IF NOT EXISTS / CREATE INDEX IF NOT EXISTS. Nothing existing is altered.
--   * No reader selects `*` into a fixed shape from these tables in a way a new nullable
--     column can break; every handler maps named columns.
--   * Until the Phase 2 flag is on, nothing reads these columns at all.

-- ── The columns ───────────────────────────────────────────────────────────────────────

ALTER TABLE contexts
    ADD COLUMN IF NOT EXISTS declared_limbs UUID[] NULL,
    ADD COLUMN IF NOT EXISTS declared_limbs_ambiguous_drops INTEGER NULL;

ALTER TABLE tasks
    ADD COLUMN IF NOT EXISTS declared_limbs UUID[] NULL,
    ADD COLUMN IF NOT EXISTS declared_limbs_ambiguous_drops INTEGER NULL;

ALTER TABLE technical_decisions
    ADD COLUMN IF NOT EXISTS declared_limbs UUID[] NULL,
    ADD COLUMN IF NOT EXISTS declared_limbs_ambiguous_drops INTEGER NULL;

COMMENT ON COLUMN contexts.declared_limbs IS
    'Limb roots (task/decision ids) this record declares, from its task:/decision:/epic: tags and the 8-hex ids named in its content. NULL = not yet derived (backfill owes it); empty array = derived and declares nothing (unassignable). Derived by src/services/declaredLimbs.ts, migration 078.';
COMMENT ON COLUMN tasks.declared_limbs IS
    'Limb roots this task declares — itself (a task IS a limb root), plus its task:/decision:/epic: tags and the 8-hex ids named in title+description. NULL = not yet derived; empty array is impossible for a live task since it always declares itself. Migration 078.';
COMMENT ON COLUMN technical_decisions.declared_limbs IS
    'Limb roots this decision declares — itself, plus its task:/decision:/epic: tags and the 8-hex ids named in title/description/rationale/problem_statement/outcome_notes. NULL = not yet derived. Migration 078.';

COMMENT ON COLUMN contexts.declared_limbs_ambiguous_drops IS
    'How many 8-hex mentions on this record were DROPPED because the prefix matched more than one record. Ambiguity is never guessed; it is dropped and counted here so the derivation''s own error rate is queryable rather than swallowed. Migration 078.';
COMMENT ON COLUMN tasks.declared_limbs_ambiguous_drops IS
    'Ambiguous 8-hex mentions dropped when deriving declared_limbs. See contexts.declared_limbs_ambiguous_drops. Migration 078.';
COMMENT ON COLUMN technical_decisions.declared_limbs_ambiguous_drops IS
    'Ambiguous 8-hex mentions dropped when deriving declared_limbs. See contexts.declared_limbs_ambiguous_drops. Migration 078.';

-- ── Resolution indexes ────────────────────────────────────────────────────────────────
-- Every derivation resolves the 8-hex ids a record names against ALL THREE tables
-- (`WHERE left(id::text,8) = ANY($1)`), and that happens on every context/task/decision
-- write. Without these it is three sequential scans per write, growing with the corpus.

CREATE INDEX IF NOT EXISTS idx_contexts_id8            ON contexts            ((left(id::text, 8)));
CREATE INDEX IF NOT EXISTS idx_tasks_id8               ON tasks               ((left(id::text, 8)));
CREATE INDEX IF NOT EXISTS idx_technical_decisions_id8 ON technical_decisions ((left(id::text, 8)));

-- ── Membership index ──────────────────────────────────────────────────────────────────
-- Phase 2 asks "which records declare this limb" and "does this record's limb set overlap
-- the anchor's cone" — both are array-containment/overlap predicates, which is what GIN
-- serves. Partial (WHERE NOT NULL) so the not-yet-derived rows cost nothing; the
-- derived-EMPTY majority still indexes as an empty array, which is what makes
-- "declares nothing" queryable rather than merely absent.

CREATE INDEX IF NOT EXISTS idx_contexts_declared_limbs
    ON contexts USING GIN (declared_limbs) WHERE declared_limbs IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tasks_declared_limbs
    ON tasks USING GIN (declared_limbs) WHERE declared_limbs IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_technical_decisions_declared_limbs
    ON technical_decisions USING GIN (declared_limbs) WHERE declared_limbs IS NOT NULL;

-- ── AMENDING MIGRATION 067's VERSION TRIGGER ──────────────────────────────────────────
-- READ THIS BEFORE CHANGING IT BACK. `tasks` carries `trigger_bump_tasks_version`, which
-- migration 067 wrote as DELIBERATELY UNCONDITIONAL: "any UPDATE of the row is a new
-- version, whatever columns it touched and WHICHEVER write path issued it."
--
-- THE PROBLEM THIS SOLVES (measured, not anticipated): materialising declared_limbs writes
-- the column back to the row after the handler's own UPDATE, so a single logical task write
-- bumped `version` TWICE. That was caught by 067's own contract test
-- (taskAtomicClaim.contract.test.ts, "the TRIGGER owns the bump" — expected 2, got 3), and
-- it matters: `version` is the optimistic-lock token for task_claim's expectedVersion CAS.
-- A caller that reads the version between the two statements presents a value the row has
-- already left, and its claim is refused for a change that never touched the task.
--
-- WHY EXCLUDING THE DERIVED COLUMNS DOES NOT WEAKEN 067's GUARANTEE. 067's fear is a write
-- that changes AUTHORED state without bumping — then a CAS passes while the task moved. The
-- predicate below cannot admit that case BY CONSTRUCTION: it holds only when every other
-- column of the row is IS NOT DISTINCT FROM its previous value. Any change to any authored
-- column, from any surface including raw psql, still bumps. What is excluded is a write that
-- changes NOTHING a caller authored — a recomputation of a cache the server derives from the
-- row's own tags and prose. `version` remains "the version of the authored task"; it stops
-- counting the server talking to itself.
--
-- NOT SURFACE-DEPENDENCE. 067's rejection was of a rule keyed on WHO issued the write; this
-- is keyed on WHAT CHANGED, evaluated in the trigger for every path equally.
--
-- WHAT ACTUALLY KEEPS THE HANDLER PATH BUMPING, precisely: `updateTaskStatus` seeds its SET
-- list with `updated_at = CURRENT_TIMESTAMP` (handlers/tasks.ts), so NEW.updated_at already
-- differs from OLD by the time this trigger runs and the row is never a no-op. It is NOT
-- `trigger_update_tasks_updated_at` doing that — same-timing triggers fire in NAME order, so
-- that one runs AFTER this one and cannot rescue a row from being classified here. An
-- earlier draft of this comment said otherwise; a future reader would have built on it.
-- `updated_at` is deliberately left un-excluded: a timestamp is a display field where an
-- extra touch is harmless, while `version` is a counter whose COUNT is the contract.
--
-- TWO HONEST NARROWINGS OF "BY CONSTRUCTION", both found in review:
--   1. Record comparison uses each column's EQUALITY operator, and jsonb equality is
--      SEMANTIC, not byte-exact: rewriting metadata {"n": 1} as {"n": 1.0} changes the
--      stored bytes and does NOT bump. Unreachable from the TypeScript handlers
--      (JSON.stringify(1.0) === "1"), so no live path can hit it, but the guarantee is
--      "no change any caller can distinguish", not "no change to the bytes".
--   2. The composite comparison needs an equality operator on EVERY column of `tasks`.
--      Adding a column of a type that has none (`json`, `point`) would make every UPDATE
--      of this table throw. That fails LOUD and immediately rather than silently skewing
--      the counter, which is the right failure — but it is a landmine worth naming.
CREATE OR REPLACE FUNCTION public.bump_tasks_version() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  probe public.tasks;
BEGIN
  -- Compare the incoming row against the old one with ONLY the derived columns (and version
  -- itself) neutralised. If they are then identical, this UPDATE authored nothing.
  probe := NEW;
  probe.declared_limbs := OLD.declared_limbs;
  probe.declared_limbs_ambiguous_drops := OLD.declared_limbs_ambiguous_drops;
  probe.version := OLD.version;
  IF probe IS NOT DISTINCT FROM OLD THEN
    NEW.version := OLD.version;
    RETURN NEW;
  END IF;

  NEW.version := OLD.version + 1;
  RETURN NEW;
END;
$$;

COMMENT ON COLUMN public.tasks.version IS
  'Optimistic-lock counter for the task claim''s expectedVersion CAS. Bumped by trigger_bump_tasks_version on every update that changes AUTHORED state, from every surface (migration 067). An update that changes only the server-derived declared_limbs columns leaves it alone (migration 078) — those are recomputed from the row''s own tags and prose and author nothing.';
