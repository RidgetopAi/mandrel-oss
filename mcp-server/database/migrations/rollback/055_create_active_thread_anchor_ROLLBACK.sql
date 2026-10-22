-- ROLLBACK for Migration 055: drop the `active_thread_anchors` table (ST-3).
--
-- Reverses 055 by dropping the durable-anchor table (and its index, dropped with the table).
-- Idempotent (DROP … IF EXISTS). Deleting the table discards all persisted anchors; the
-- in-memory cache is unaffected and the system degrades to the pre-ST-3 in-memory-only anchor
-- (lost on restart) — no data other than the anchors themselves is touched.
--
-- NOTE: the migrate.ts runner only applies forward migrations and scans
-- database/migrations/ NON-recursively, so this file lives in the rollback/ subdirectory
-- deliberately — it is the documented manual down-path and is NEVER auto-run by the runner
-- or the schema-contract gate. Apply by hand:
--   psql -d <db> -f database/migrations/rollback/055_create_active_thread_anchor_ROLLBACK.sql

DROP TABLE IF EXISTS active_thread_anchors;

DO $$
BEGIN
  RAISE NOTICE '↩️  Rolled back 055: dropped active_thread_anchors (durable anchor). Anchor persistence reverts to in-memory-only.';
END $$;
