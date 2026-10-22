-- AIDIS Migration 003: Update Embedding Dimensions
--
-- This updates our vector embeddings to use 384 dimensions (local model size)
-- instead of 1536 dimensions (OpenAI size). This enables cost-free local embeddings!
--
-- Author: the operator & AIDIS Team
-- Date: 2025-08-15

-- Drop the existing vector index (we'll recreate it)
DROP INDEX IF EXISTS idx_contexts_embedding_cosine;

-- Update the embedding column to use 384 dimensions
ALTER TABLE contexts ALTER COLUMN embedding TYPE VECTOR(384);

-- Recreate the vector search index with new dimensions
CREATE INDEX idx_contexts_embedding_cosine 
ON contexts USING ivfflat (embedding vector_cosine_ops) 
WITH (lists = 100);

-- Clear existing embeddings (they were 1536D and need to be regenerated as 384D)
-- The context handler will regenerate them as needed
UPDATE contexts SET embedding = NULL WHERE embedding IS NOT NULL;

-- Update any existing test data or sample embeddings if needed
-- (This ensures a clean slate for our new 384-dimensional embeddings)

-- Verify the changes
SELECT 
    'Migration 003 completed successfully' as status,
    COUNT(*) as total_contexts,
    COUNT(*) FILTER (WHERE embedding IS NOT NULL) as contexts_with_embeddings,
    '384 dimensions (local model compatible)' as new_embedding_format
FROM contexts;
