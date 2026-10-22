-- Migration 045: Add semantic embeddings to technical_decisions
--
-- WHY: decision_search relied on trigram/ILIKE text matching only, so a clearly-
-- present decision could be MISSED by a semantically-equivalent query (the tool-use
-- eval's find_security_decision failed 8 turns: 'critical security decision' /
-- 'authentication' never surfaced a fail-closed-bearer-auth decision). Decisions are
-- the Mandrel moat — they must be findable the same way contexts are.
--
-- WHAT: mirror the contexts embedding column EXACTLY (vector(1536) + ivfflat cosine
-- index), so decision_record/decision_update can embed-on-write and decision_search
-- can rank by 1 - (embedding <=> query) like context_search. Reuses the SAME local
-- embedder (FREE, $0 — no paid API) and the SAME 1536 dimensionality contexts use
-- (see migrations 029/036). Additive + backward-compatible: the column is NULLABLE,
-- so existing un-embedded rows keep working (search degrades to the trgm fallback)
-- until backfilled (scripts/backfill-decision-embeddings.ts).
--
-- This migration is numbered ABOVE BASELINE_THROUGH (42), so it runs normally on
-- BOTH fresh builds and existing/baselined instances (prod + tenants). The
-- schema-contract reference (scripts/schema-reference.sql.txt) is regenerated to
-- reflect the new column + index so the CI drift gate (the CI gate stage 0c) stays GREEN.

-- Add the embedding column, matching contexts.embedding (vector(1536), nullable).
ALTER TABLE technical_decisions
  ADD COLUMN IF NOT EXISTS embedding vector(1536);

-- Enforce the canonical dimensionality when populated (mirrors the contexts
-- embedding_dimension_check from migration 036). NULL stays valid (un-embedded rows).
ALTER TABLE technical_decisions
  DROP CONSTRAINT IF EXISTS technical_decisions_embedding_dimension_check;

ALTER TABLE technical_decisions
  ADD CONSTRAINT technical_decisions_embedding_dimension_check
  CHECK (
    embedding IS NULL OR vector_dims(embedding) = 1536
  );

-- IVFFlat cosine index, tuned identically to contexts (lists = 100).
CREATE INDEX IF NOT EXISTS idx_technical_decisions_embedding_cosine
  ON technical_decisions USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);

DO $$
BEGIN
  RAISE NOTICE '✅ technical_decisions.embedding added (vector(1536) + ivfflat cosine index). Existing rows un-embedded until backfilled.';
END $$;
