-- ROLLBACK for 092 — restore idx_technical_decisions_content_fts.
--
-- Byte-identical to the definition migration 004 created and 000_baseline_schema.sql
-- records, so a restored database is indistinguishable from a never-migrated one. Copied
-- from the live catalog (`pg_indexes.indexdef` on prod, 2026-08-22), not retyped from the
-- migration, because the catalog is what the database actually had.
CREATE INDEX IF NOT EXISTS idx_technical_decisions_content_fts
  ON public.technical_decisions
  USING gin (to_tsvector('english'::regconfig,
    (((((((title)::text || ' '::text) || description) || ' '::text) || rationale) || ' '::text)
      || COALESCE(problem_statement, ''::text))));

DO $$
BEGIN
  RAISE NOTICE '↩️  092 ROLLBACK: idx_technical_decisions_content_fts restored.';
END $$;
