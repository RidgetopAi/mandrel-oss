-- ROLLBACK for 106 — re-creates the (empty) normalized Surveyor schema.
--
-- DATA-LOSS CAVEAT: migration 106 DROPPED the tables with whatever rows they held; this
-- rollback restores the SHAPE only. The rows are not recoverable except from the pg_dump
-- taken before 106 was applied (reload it data-only after running this file).
-- 053 is the single source of the table definitions (CREATE TABLE/INDEX IF NOT EXISTS, with a
-- shape guard that never drops real data), so it is replayed here rather than duplicated.
--
-- PSQL ONLY: `\ir` is a psql meta-command (include, resolved relative to THIS file). It is not
-- SQL — a driver (node-postgres, migrate.ts, a GUI) sent this file will fail on that line.
-- Run it with:  psql -v ON_ERROR_STOP=1 -d <db> -f <this file>

\ir ../053_create_surveyor_scans.sql

DO $$
BEGIN
  RAISE NOTICE '106 ROLLBACK: Surveyor tables re-created (empty) from 053.';
END $$;
