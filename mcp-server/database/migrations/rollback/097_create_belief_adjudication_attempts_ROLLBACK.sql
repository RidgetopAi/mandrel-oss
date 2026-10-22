-- ROLLBACK for Migration 097: drop the belief adjudication ATTEMPT ledger.
--
-- Reverses 097 by dropping the append-only attempt-ledger table + its indexes. This DESTROYS the
-- recorded reliability history (attempted vs completed) — the ledger is telemetry, not belief/
-- graph state, so dropping it does not affect recall, edges, or verdicts (those live in links /
-- belief_adjudications). It DOES return the pipeline to the state where its own miss rate is
-- unobservable, which is the defect 097 exists to close.
--
-- NOTE: the migrate.ts runner only applies forward migrations and scans database/migrations/
-- NON-recursively, so this file lives in the rollback/ subdirectory deliberately — it is the
-- documented manual down-path, never auto-run by the runner or the schema-contract gate.
-- Apply by hand:
--   psql -d <db> -f database/migrations/rollback/097_create_belief_adjudication_attempts_ROLLBACK.sql

DROP INDEX IF EXISTS idx_belief_attempt_project_created;
DROP INDEX IF EXISTS idx_belief_attempt_failed;
DROP INDEX IF EXISTS idx_belief_attempt_created_at;
DROP TABLE IF EXISTS belief_adjudication_attempts;

DO $$
BEGIN
  RAISE NOTICE '↩️  Rolled back 097: belief_adjudication_attempts ledger dropped.';
END $$;
