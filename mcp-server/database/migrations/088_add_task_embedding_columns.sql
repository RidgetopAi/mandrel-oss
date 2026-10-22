-- Migration 088: Add embedding columns to `tasks` — ADDITIVE, DUAL-COLUMN, NO INDEXES
--
-- WHY: smart_search's source union has listed 'task' since commit 1 (smartSearch.ts:21) but
-- `tasks` has never carried an embedding column, so the task source could never be enabled —
-- defect D3 of the smart_search complete fix (an earlier task / tranche 180faa38).
-- Measured baseline on prod: record-hit@1 0/10, and 5 of the 10 home records are TASKS,
-- unreachable by construction.
--
-- WHAT: add BOTH embedding columns that the two supported embedders write, mirroring the
-- shape migration 056 established on `contexts` + `technical_decisions`:
--   * `embedding        vector(1536)` — MiniLM (384-d padded to 1536), still SELECTABLE via
--     MANDREL_EMBEDDER=minilm.
--   * `embedding_gemma  vector(768)`  — embeddinggemma-300m.
-- BOTH ARE REQUIRED, not one. The clean gate runs the mcp-server suite twice: STAGE 1 pins
-- MANDREL_EMBEDDER=minilm and STAGE 1b re-runs the same suite under gemma (the CI gate).
-- A gemma-only column makes every minilm-side write/read of tasks reference a column that
-- does not exist, and STAGE 1 goes RED. Guard: mcp-server/src/tests/taskEmbedding.contract.test.ts (G11).
-- Deliberately NOT recorded here: which embedder is the code default, or which boxes run
-- which column. Both moved under this comment once already (the 08-19 gemma flip) and left
-- it asserting the opposite of the truth. The gate axes above are the durable reason.
--
-- Both columns are NULLABLE: every existing row stays valid and un-embedded until the
-- one-time backfill (scripts/reembed-gemma.ts, which now carries a `tasks` spec) populates
-- the ACTIVE column, and the self-heal worker (services/reembedWorker.ts) heals the rest.
--
-- DIMENSION CHECK on the gemma column only — mirroring 056 exactly. The legacy 1536-d
-- column predates the check convention on the other two tables and is left constraint-free
-- so all three tables carry the SAME shape (a task-only constraint would be drift, not rigor).
--
-- ── WHY THERE ARE NO ivfflat INDEXES HERE (deliberate; the auditor amendment A6) ────────────────
-- 056 creates `USING ivfflat (... vector_cosine_ops) WITH (lists = 100)` at migration time,
-- i.e. on a column with ZERO rows. ivfflat picks its centroids AT CREATE INDEX TIME by
-- k-means over the rows present, so an index built on an empty column has centroids trained
-- on nothing; after a backfill, approximate recall can be silently poor forever and the only
-- symptom is a slightly worse search result — nothing goes RED. Repeating that mistake here
-- would bake it into a THIRD table.
-- lists=100 is also wrong for this table's size: the pgvector rule of thumb is rows/1000 for
-- corpora under 1M rows, and `tasks` is ~3.5k rows fleet-wide → lists ≈ 4, not 100. At 100
-- lists over 3.5k rows each list holds ~35 vectors and the default probes setting reads a
-- vanishing fraction of the table.
-- THE PLAN: no index at all until the table is large enough for one to beat a sequential
-- scan. At 3.5k × 768-d a full scan is sub-millisecond and is EXACT; an ivfflat index at this
-- size trades exactness for nothing.
--
-- WHEN AN INDEX IS EVENTUALLY WARRANTED — recorded here, NOT executed, because this is the
-- file you are reading when you ask "why is there no index?". Create it as its OWN migration,
-- AFTER the backfill has populated the column, and derive `lists` from the row count at that
-- moment rather than copying 100 from 056:
--
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_tasks_embedding_gemma_cosine
--     ON tasks USING ivfflat (embedding_gemma vector_cosine_ops) WITH (lists = <rows/1000>);
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_tasks_embedding_cosine
--     ON tasks USING ivfflat (embedding vector_cosine_ops) WITH (lists = <rows/1000>);
--
-- CONCURRENTLY CANNOT RUN INSIDE A TRANSACTION BLOCK — Postgres rejects it outright. Today
-- the migration runner wraps nothing, so a migration file containing the above works as
-- written; but that is a property of THE RUNNER, not a guarantee, and a future runner that
-- wrapped each migration in BEGIN/COMMIT would turn these two statements into a hard error.
-- Check the runner before relying on it, or drop CONCURRENTLY and accept the write lock.
--
-- An index on an ALREADY-POPULATED column has correctly-trained centroids, which is the whole
-- point of deferring. If one is ever created early by accident, REINDEX after the backfill
-- fixes it. Either way, confirm with EXPLAIN (ANALYZE) that the search query actually USES the
-- index — at small row counts the planner prefers a seq scan and the index silently does
-- nothing, which looks exactly like success.
--
-- SCHEMA CONTRACT: the CI gate STAGE 0c diffs a fresh migrate against
-- scripts/schema-reference.sql.txt. This migration ships with that reference REGENERATED
-- (`bash scripts/schema-contract.sh regenerate`) and committed in the same commit.
--
-- Numbered ABOVE BASELINE_THROUGH (42) so it runs on fresh builds AND on existing/baselined
-- instances (prod + every tenant) via the standard db:migrate runner.
--
-- ROLLBACK: rollback/088_add_task_embedding_columns_ROLLBACK.sql. Reversible at any time —
-- it drops two columns that were NULL before this migration ran, so the only thing a
-- rollback can destroy is backfill COMPUTE TIME, never pre-existing data.

-- ── tasks.embedding (MiniLM, 1536-d — STAGE 1 axis) ───────────────────────────────────
ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS embedding vector(1536);

-- ── tasks.embedding_gemma (embeddinggemma-300m, 768-d — STAGE 1b axis) ────────────────
ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS embedding_gemma vector(768);

ALTER TABLE tasks
  DROP CONSTRAINT IF EXISTS tasks_embedding_gemma_dimension_check;
ALTER TABLE tasks
  ADD CONSTRAINT tasks_embedding_gemma_dimension_check
  CHECK (embedding_gemma IS NULL OR vector_dims(embedding_gemma) = 768);

DO $$
BEGIN
  RAISE NOTICE '✅ tasks: embedding vector(1536) + embedding_gemma vector(768) added (both embedders). NO ivfflat index by design — see this migration''s header (A6). Rows un-embedded until backfilled (scripts/reembed-gemma.ts) / healed (reembedWorker).';
END $$;
