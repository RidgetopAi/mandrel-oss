-- Migration 100: Add 'note' context type (the auditor recommendation)
-- Date: 2026-09-08
-- Purpose: give the GENERIC capture a real home. In the Phase-3 eval 5/7 stores guessed
--   type='fact' — an invalid value — because no generic type existed. `note` is that type.
--   Deliberately NOT added: 'fact' (no alias; a rejected write is honest, a silently
--   mislabelled one corrupts durable memory). The code-side copy of this list is
--   mcp-server/src/config/contextTypes.ts; mandrel-command's ContextTypeSchema is the third.
-- Shape: mirrors 032_add_lessons_context_type.sql — drop + recreate the CHECK.
-- Safe: only adds a value; no row can become invalid; fully reversible while no 'note'
--   rows exist (see rollback/100_add_note_context_type_ROLLBACK.sql for the data caveat).

BEGIN;

ALTER TABLE contexts DROP CONSTRAINT IF EXISTS contexts_context_type_check;

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
    'lessons',
    'note'
  )
);

COMMIT;

-- Verify constraint updated
SELECT conname, pg_get_constraintdef(oid)
FROM pg_constraint
WHERE conrelid = 'contexts'::regclass
  AND conname = 'contexts_context_type_check';
