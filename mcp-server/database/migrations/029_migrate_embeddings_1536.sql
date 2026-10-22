-- Migration 029: 384D to 1536D embeddings
-- Adds new embedding columns for larger embedding models

-- Step 1: Add new embedding column with 1536 dimensions
ALTER TABLE contexts ADD COLUMN IF NOT EXISTS embedding_1536 vector(1536);

-- Step 2: Add migration status column to track progress
ALTER TABLE contexts ADD COLUMN IF NOT EXISTS embedding_migrated boolean DEFAULT false;
