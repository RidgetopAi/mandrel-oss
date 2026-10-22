-- Migration 047: Add a `metadata` jsonb column to technical_decisions.
--
-- WHY: The decision_record tool ADVERTISES a `metadata` param (decisionSchemas.record),
-- but technical_decisions had NO metadata column and neither the route (handleRecord)
-- nor the handler (recordDecision) persisted it — so a decision recorded WITH metadata
-- silently dropped it and returned success (advertised-but-not-accepted route-layer
-- drift, the same class routeContractDrift.contract.test.ts guards). Every OTHER
-- project-scoped entity that advertises metadata already has a backing jsonb column
-- (contexts.metadata, tasks.metadata, projects.metadata) — technical_decisions was the
-- lone exception. Rather than DEPRECATE (drop a genuinely-useful, schema-consistent
-- capability), we IMPLEMENT the backing column so advertised == accepted == persisted.
--
-- WHAT: a single `metadata jsonb NOT NULL DEFAULT '{}'::jsonb` column — IDENTICAL in
-- shape/default to contexts.metadata and tasks.metadata so the three entities stay
-- uniform. This is:
--   * ADDITIVE — only adds a column, never alters/drops existing data.
--   * BACKWARD-COMPATIBLE — DEFAULT '{}'::jsonb backfills every existing row to an empty
--     object, exactly matching how the handler treats an omitted metadata (no metadata
--     == {}). No existing read/write path changes behaviour; callers who never set
--     metadata are unaffected.
--   * IDEMPOTENT — ADD COLUMN IF NOT EXISTS, safe to re-run.
--
-- This migration number (047) is ABOVE BASELINE_THROUGH (42), so it runs normally on
-- BOTH fresh builds (after the 000 baseline) and existing/already-baselined instances
-- (prod + tenants). The schema-contract reference (scripts/schema-reference.sql.txt) is
-- regenerated to reflect the new column so the CI drift gate (the CI gate stage 0c) stays
-- GREEN and honest.

ALTER TABLE technical_decisions
  ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN technical_decisions.metadata IS
  'Arbitrary structured annotations for a decision (jsonb, default {}). Mirrors contexts.metadata / tasks.metadata. Set via decision_record(metadata:{...}); returned in decision_get / decision_search detail. NOT NULL with default {} so an omitted metadata is an empty object, never NULL.';

DO $$
BEGIN
  RAISE NOTICE '✅ metadata (jsonb, default {}) added to technical_decisions. decision_record.metadata now persists.';
END $$;
