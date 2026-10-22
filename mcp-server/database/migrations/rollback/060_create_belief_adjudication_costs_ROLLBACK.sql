-- ROLLBACK for Migration 060: drop the belief adjudicator cost ledger.
--
-- Reverses 060 by dropping the append-only cost-ledger table + its indexes. This DESTROYS the
-- recorded per-call spend history — the ledger is telemetry, not belief/graph state, so dropping
-- it does not affect recall, edges, or verdicts (those live in links / belief_adjudications).
-- Only run this if you are intentionally removing cost accounting.
--
-- NOTE: the migrate.ts runner only applies forward migrations and scans database/migrations/
-- NON-recursively, so this file lives in the rollback/ subdirectory deliberately — it is the
-- documented manual down-path, never auto-run by the runner or the schema-contract gate.
-- Apply by hand:
--   psql -d <db> -f database/migrations/rollback/060_create_belief_adjudication_costs_ROLLBACK.sql

DROP INDEX IF EXISTS idx_belief_cost_project_created;
DROP INDEX IF EXISTS idx_belief_cost_created_at;
DROP TABLE IF EXISTS belief_adjudication_costs;

DO $$
BEGIN
  RAISE NOTICE '↩️  Rolled back 060: belief_adjudication_costs cost ledger dropped.';
END $$;
