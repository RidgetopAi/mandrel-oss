-- Phase 2.2: Standardize Embedding Dimensions
-- Aligns context embeddings with canonical 1536-dimension vectors and
-- prepares the database for regenerated embeddings at the new size.

-- Drop existing vector index so we can change the column definition safely
DROP INDEX IF EXISTS idx_contexts_embedding_cosine;

-- Change embedding column to vector(1536), clearing legacy values
ALTER TABLE contexts
  ALTER COLUMN embedding TYPE vector(1536)
  USING NULL::vector(1536);

-- Ensure embeddings respect the canonical dimensionality when populated
ALTER TABLE contexts
  DROP CONSTRAINT IF EXISTS embedding_dimension_check;

ALTER TABLE contexts
  ADD CONSTRAINT embedding_dimension_check
  CHECK (
    embedding IS NULL OR vector_dims(embedding) = 1536
  );

-- Recreate the IVFFlat index tuned for cosine similarity
CREATE INDEX idx_contexts_embedding_cosine
  ON contexts USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);

-- Provide visibility into migration execution
DO $$
BEGIN
  RAISE NOTICE '✅ Embedding column standardized to vector(1536). Existing values cleared for regeneration.';
END $$;
