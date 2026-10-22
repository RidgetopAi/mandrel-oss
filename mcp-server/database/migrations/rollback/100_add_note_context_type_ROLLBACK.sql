-- ═════════════════════════════════════════════════════════════════════════════════════════
-- ROLLBACK 100 — remove 'note' from contexts_context_type_check (restore 032's list)
-- ═════════════════════════════════════════════════════════════════════════════════════════
--
-- ⚠️ SCHEMA-REVERSIBLE ONLY WHILE NO 'note' ROW EXISTS. ADD CONSTRAINT validates every
-- existing row, so with any `note` context stored this script fails 23514 and changes
-- nothing — which is the correct outcome: there is no honest type to relabel a note AS
-- (relabelling is exactly the silent mislabel the forward migration refused to do). If you
-- truly need the old constraint back, decide per row first; this script will not do it.
--
-- Pair with reverting mcp-server/src/config/contextTypes.ts and mandrel-command's
-- ContextTypeSchema, or the server will accept a value the DB rejects (a 500, not a 400).

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
    'lessons'
  )
);

COMMIT;
