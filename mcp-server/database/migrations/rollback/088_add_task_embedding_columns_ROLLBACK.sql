-- ROLLBACK for migration 088_add_task_embedding_columns.sql
--
-- WHAT IT DOES: drops the two embedding columns 088 added to `tasks` (and the gemma
-- dimension CHECK, which goes with its column automatically — dropped explicitly first so
-- this file is order-independent and re-runnable).
--
-- WHAT IT COSTS: both columns were NULL for every row before 088 ran, so nothing that
-- existed before this feature can be lost. What IS lost is the backfill's COMPUTE TIME
-- (~20-40 min fleet-wide at the measured ~0.35 s/row over ~3.5k rows). Re-running the
-- backfill fully restores the state. There is no data here that exists nowhere else: every
-- vector is a pure function of the task row's own type/priority/tags/title/description.
--
-- ORDER OF OPERATIONS if the task source is live: revert the source-list flip FIRST (it is
-- config-driven and revertable on its own), THEN run this. Dropping the column out from
-- under an enabled task source turns every smart_search into an error instead of an empty
-- result.
--
-- Uses IF EXISTS throughout: safe to run against an instance that never got 088.

ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_embedding_gemma_dimension_check;

ALTER TABLE tasks DROP COLUMN IF EXISTS embedding_gemma;
ALTER TABLE tasks DROP COLUMN IF EXISTS embedding;

DO $$
BEGIN
  RAISE NOTICE '↩️  tasks: embedding + embedding_gemma dropped. Re-run 088 + the backfill to restore (no pre-existing data was lost).';
END $$;

-- WHY THERE IS NO index-drop HERE: 088 creates no ivfflat index (see its header for the
-- reasoning and for the statements to use if one is ever warranted). Nothing to undo.
