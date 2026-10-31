-- Migration 110: a task's NOTE LOG is part of its lexical search document.
-- (an earlier task — recall_thread dogfood finding 3, evidence.)
--
-- WHY: the step that explains a task's story ("MERGE BLOCKED: repo:x main@... is RED on the
-- per-lane gate itself") lives ONLY in tasks.metadata.noteLog — entries {at, actor, note}
-- appended by task update `notes`. Migration 091's tsvectors cover title + description, so a
-- search for text that appears only in a note could not find the task.
--
-- WHAT: `mandrel_task_search_text(title, description, metadata)` is the ONE definition of a
-- task's searchable document — title ' ' description ' ' every noteLog entry's `note`, in log
-- order. search_tsv / search_idents are re-generated from it. The key 'noteLog' mirrors
-- TASK_NOTE_LOG_KEY in mcp-server/src/config/taskNotes.ts (held in lockstep by
-- taskNoteLogSearch.contract.test.ts). The log is bounded (TASK_NOTES_CONFIG.maxNoteEntries)
-- and both vectorizers truncate their input, so a long log cannot throw inside the GENERATED
-- column.
--
-- MECHANICS: PostgreSQL 16 cannot ALTER a generated expression in place, so the two columns
-- are dropped (their GIN indexes go with them) and re-added (the ADD backfills every row),
-- then the indexes are recreated. `bump_tasks_version` (091) neutralises these two columns by
-- NAME, so it needs no change. IDEMPOTENT: skipped when the columns already reference the new
-- function. ROLLBACK: rollback/110_task_search_includes_note_log_ROLLBACK.sql.

CREATE OR REPLACE FUNCTION mandrel_task_search_text(title text, description text, meta jsonb)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $fn$
  SELECT coalesce(title, '') || ' ' || coalesce(description, '') || ' ' ||
         coalesce(
           (SELECT string_agg(e.value ->> 'note', ' ' ORDER BY e.ordinality)
              FROM jsonb_array_elements(
                     CASE WHEN jsonb_typeof(meta -> 'noteLog') = 'array'
                          THEN meta -> 'noteLog' ELSE '[]'::jsonb END
                   ) WITH ORDINALITY AS e(value, ordinality)
             WHERE jsonb_typeof(e.value) = 'object'),
           '');
$fn$;

COMMENT ON FUNCTION mandrel_task_search_text(text, text, jsonb) IS
  'Migration 110: the task lexical document = title + description + every metadata.noteLog '
  'note. Key mirrors TASK_NOTE_LOG_KEY in mcp-server/src/config/taskNotes.ts.';

DO $$
DECLARE
  current_expr text;
BEGIN
  SELECT pg_get_expr(d.adbin, d.adrelid) INTO current_expr
    FROM pg_attrdef d
    JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum
   WHERE d.adrelid = 'public.tasks'::regclass AND a.attname = 'search_tsv' AND NOT a.attisdropped;

  IF current_expr IS NOT NULL AND current_expr LIKE '%mandrel_task_search_text%' THEN
    RAISE NOTICE '110: tasks lexical columns already include the note log — skipped';
    RETURN;
  END IF;

  ALTER TABLE tasks DROP COLUMN IF EXISTS search_tsv, DROP COLUMN IF EXISTS search_idents;
  ALTER TABLE tasks
    ADD COLUMN search_tsv tsvector
      GENERATED ALWAYS AS (mandrel_search_tsv(mandrel_task_search_text(title, description, metadata))) STORED,
    ADD COLUMN search_idents tsvector
      GENERATED ALWAYS AS (mandrel_search_idents(mandrel_task_search_text(title, description, metadata))) STORED;
  CREATE INDEX IF NOT EXISTS idx_tasks_search_tsv    ON tasks USING gin (search_tsv);
  CREATE INDEX IF NOT EXISTS idx_tasks_search_idents ON tasks USING gin (search_idents);
  RAISE NOTICE '110: tasks.search_tsv / search_idents regenerated over title + description + noteLog';
END $$;
