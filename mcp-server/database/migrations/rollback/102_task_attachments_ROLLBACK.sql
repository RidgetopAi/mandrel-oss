-- ═════════════════════════════════════════════════════════════════════════════════════════
-- ROLLBACK 102 — drop task_attachments
-- ═════════════════════════════════════════════════════════════════════════════════════════
--
-- ⚠️ DATA LOSS: this DROPS the table, destroying any stored attachment bytes along with it.
-- There is no schema-only rollback for a table whose whole purpose is to hold data — unlike
-- migration 100's constraint-only rollback, there is nothing to "relabel" here. Only run
-- this if you intend to discard every stored attachment.

BEGIN;

DROP INDEX IF EXISTS public.idx_task_attachments_task_created;
DROP TABLE IF EXISTS public.task_attachments;

COMMIT;
