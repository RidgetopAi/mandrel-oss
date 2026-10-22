-- Migration 056: Add embeddinggemma-300m (768-d) embedding columns — ADDITIVE dual-column
--
-- WHY: an earlier decision (D1) adopts embeddinggemma-300m as Mandrel's embedder, replacing
-- all-MiniLM-L6-v2. gemma is native 768-d (vs MiniLM's 384-padded-to-1536). The bake-off
-- measured +8.5 strict coverage. See an earlier task.
--
-- WHAT: add a SEPARATE `embedding_gemma vector(768)` column (+ ivfflat cosine index) on the
-- two embedded tables — `contexts` and `technical_decisions`. This is DUAL-COLUMN /
-- ADDITIVE by design (NOT an in-place `ALTER COLUMN ... TYPE`): the legacy 1536-d
-- `embedding` column and its data are PRESERVED untouched, so:
--   • cutover = flip MANDREL_EMBEDDER=gemma (+ backfill), zero downtime;
--   • rollback = flip MANDREL_EMBEDDER=minilm — the MiniLM vectors are still there.
-- The column is NULLABLE: existing rows stay valid and un-embedded-for-gemma until the
-- one-time backfill (scripts/reembed-gemma.ts) populates them.
--
-- Numbered ABOVE BASELINE_THROUGH (42), so it runs on fresh builds AND existing/baselined
-- instances (prod + tenants) via the standard db:migrate runner.
--
-- NOTE ON ivfflat LISTS: kept at 100 to mirror the existing indexes (config default
-- MANDREL_GEMMA_INDEX_LISTS). The recall knob `ivfflat.probes` is set at
-- CONNECTION time from config (see src/config/database.ts), not baked into the index.

-- ── contexts.embedding_gemma ───────────────────────────────────────────────────────────
ALTER TABLE contexts
  ADD COLUMN IF NOT EXISTS embedding_gemma vector(768);

ALTER TABLE contexts
  DROP CONSTRAINT IF EXISTS contexts_embedding_gemma_dimension_check;
ALTER TABLE contexts
  ADD CONSTRAINT contexts_embedding_gemma_dimension_check
  CHECK (embedding_gemma IS NULL OR vector_dims(embedding_gemma) = 768);

CREATE INDEX IF NOT EXISTS idx_contexts_embedding_gemma_cosine
  ON contexts USING ivfflat (embedding_gemma vector_cosine_ops)
  WITH (lists = 100);

-- ── technical_decisions.embedding_gemma ─────────────────────────────────────────────────
ALTER TABLE technical_decisions
  ADD COLUMN IF NOT EXISTS embedding_gemma vector(768);

ALTER TABLE technical_decisions
  DROP CONSTRAINT IF EXISTS technical_decisions_embedding_gemma_dimension_check;
ALTER TABLE technical_decisions
  ADD CONSTRAINT technical_decisions_embedding_gemma_dimension_check
  CHECK (embedding_gemma IS NULL OR vector_dims(embedding_gemma) = 768);

CREATE INDEX IF NOT EXISTS idx_technical_decisions_embedding_gemma_cosine
  ON technical_decisions USING ivfflat (embedding_gemma vector_cosine_ops)
  WITH (lists = 100);

DO $$
BEGIN
  RAISE NOTICE '✅ embedding_gemma (vector(768) + ivfflat cosine) added to contexts + technical_decisions. Legacy 1536-d embedding preserved. Rows un-embedded for gemma until backfilled (scripts/reembed-gemma.ts).';
END $$;
