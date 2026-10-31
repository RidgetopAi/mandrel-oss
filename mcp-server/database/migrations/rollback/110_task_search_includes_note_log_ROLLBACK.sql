-- ROLLBACK for 110_task_search_includes_note_log.sql: restore the 091 title+description
-- expression on tasks.search_tsv / search_idents, then drop the 110 function (columns first —
-- a generated column depends on the function in its expression). Re-running 110 restores the
-- note-log document; nothing here is lost that is not recomputable.
ALTER TABLE tasks DROP COLUMN IF EXISTS search_tsv, DROP COLUMN IF EXISTS search_idents;
ALTER TABLE tasks
  ADD COLUMN search_tsv tsvector
    GENERATED ALWAYS AS (mandrel_search_tsv(
      coalesce(title,'') || ' ' || coalesce(description,''))) STORED,
  ADD COLUMN search_idents tsvector
    GENERATED ALWAYS AS (mandrel_search_idents(
      coalesce(title,'') || ' ' || coalesce(description,''))) STORED;
CREATE INDEX IF NOT EXISTS idx_tasks_search_tsv    ON tasks USING gin (search_tsv);
CREATE INDEX IF NOT EXISTS idx_tasks_search_idents ON tasks USING gin (search_idents);
DROP FUNCTION IF EXISTS mandrel_task_search_text(text, text, jsonb);
