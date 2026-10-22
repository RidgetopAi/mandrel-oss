-- ROLLBACK for Migration 059: remove the `possibly_supersedes` SOFT belief edge type from
-- the links.edge_type CHECK constraint.
--
-- Reverses 059 by restoring the pre-059 CHECK (the migration-054 domain, before
-- `possibly_supersedes`). Idempotent (DROP … IF EXISTS then ADD). NOTE: if any
-- `possibly_supersedes` edges have been minted, this ADD will FAIL (a row would violate the
-- narrowed CHECK) — that is deliberate: purge those edges first
-- (`DELETE FROM links WHERE edge_type = 'possibly_supersedes';`) before rolling back, so the
-- down-path can never silently leave orphaned invalid rows.
--
-- NOTE: the migrate.ts runner only applies forward migrations and scans
-- database/migrations/ NON-recursively, so this file lives in the rollback/ subdirectory
-- deliberately — it is the documented manual down-path and is NEVER auto-run by the runner
-- or the schema-contract gate. Apply by hand:
--   psql -d <db> -f database/migrations/rollback/059_add_possibly_supersedes_edge_type_ROLLBACK.sql

ALTER TABLE links DROP CONSTRAINT IF EXISTS links_edge_type_check;

ALTER TABLE links ADD CONSTRAINT links_edge_type_check CHECK (edge_type IN (
  'decided_by', 'caused', 'built_by', 'supersedes',
  'learned_from', 'proposed_by', 'informs', 'produced_outcome', 'related_to'
));

DO $$
BEGIN
  RAISE NOTICE '↩️  Rolled back 059: removed `possibly_supersedes` from links.edge_type CHECK (restored the migration-054 domain).';
END $$;
