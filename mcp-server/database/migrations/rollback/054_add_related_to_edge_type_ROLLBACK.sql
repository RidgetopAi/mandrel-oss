-- ROLLBACK for Migration 054: remove the `related_to` weak edge type from the
-- links.edge_type CHECK constraint.
--
-- Reverses 054 by restoring the pre-054 8-value CHECK (the migration-049 domain, before
-- `related_to`). Idempotent (DROP … IF EXISTS then ADD). NOTE: if any `related_to` edges
-- have been minted, this ADD will FAIL (a row would violate the narrowed CHECK) — that is
-- deliberate: purge those edges first (`DELETE FROM links WHERE edge_type = 'related_to';`)
-- before rolling back, so the down-path can never silently leave orphaned invalid rows.
--
-- NOTE: the migrate.ts runner only applies forward migrations and scans
-- database/migrations/ NON-recursively, so this file lives in the rollback/ subdirectory
-- deliberately — it is the documented manual down-path and is NEVER auto-run by the runner
-- or the schema-contract gate. Apply by hand:
--   psql -d <db> -f database/migrations/rollback/054_add_related_to_edge_type_ROLLBACK.sql

ALTER TABLE links DROP CONSTRAINT IF EXISTS links_edge_type_check;

ALTER TABLE links ADD CONSTRAINT links_edge_type_check CHECK (edge_type IN (
  'decided_by', 'caused', 'built_by', 'supersedes',
  'learned_from', 'proposed_by', 'informs', 'produced_outcome'
));

DO $$
BEGIN
  RAISE NOTICE '↩️  Rolled back 054: removed `related_to` from links.edge_type CHECK (restored the 8-value migration-049 domain).';
END $$;
