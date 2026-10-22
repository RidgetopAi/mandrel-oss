-- Migration 032: Add 'lessons' context type
-- Date: 2025-10-13
-- Purpose: Add 'lessons' as a valid context_type for storing learnings
-- Safe: Only adds a new type, no data changes, fully reversible

BEGIN;

-- Drop existing constraint
ALTER TABLE contexts DROP CONSTRAINT IF EXISTS contexts_context_type_check;

-- Recreate constraint with 'lessons' added
ALTER TABLE contexts ADD CONSTRAINT contexts_context_type_check
CHECK (
  context_type IN (
    'code',
    'decision',
    'error',
    'discussion',
    'planning',
    'completion',
    'milestone',
    'reflections',
    'handoff',
    'lessons'
  )
);

COMMIT;

-- Verify constraint updated
SELECT conname, pg_get_constraintdef(oid)
FROM pg_constraint
WHERE conrelid = 'contexts'::regclass
  AND conname = 'contexts_context_type_check';
