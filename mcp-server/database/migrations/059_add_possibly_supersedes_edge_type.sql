-- Migration 059: add the `possibly_supersedes` SOFT belief edge type to links.edge_type (BL-3).
--
-- WHY (belief-layer two-tier v1, BL-3 / an earlier task): BL-2 added the
-- `soft_possibly_superseded` derivation outcome — a real supersession candidate that MISSES
-- the tight hard-mint bar (confidence and/or cosine short of the thresholds). BL-2 only
-- RECORDED it (belief_adjudications.derived_action, migration 058); nothing consumed it. BL-3
-- makes the soft outcome mint a DISTINCT edge — `possibly_supersedes`, the soft counterpart to
-- `supersedes` — so the soft signal is DATA, not an annotation. This migration widens the
-- links.edge_type CHECK to allow it. The edge is DELIBERATELY recall-inert this increment
-- (trust.ts matches the exact `supersedes` string; BL-4 is where trust reads the soft edge).
--
-- EDGE-TYPE DOMAIN — SINGLE SOURCE OF TRUTH: the value list below is the MATERIALIZED
-- projection of mcp-server/src/config/edgeTypes.ts edgeTypeCheckSqlList() (EDGE_TYPES). That
-- module is the canonical domain; this migration only re-materializes it into the DB CHECK.
-- The typedEdges contract test (typedEdges.contract.test.ts) asserts the DB CHECK and the
-- config agree, so they cannot drift. No magic strings beyond this derived list. (Same shape
-- as migration 054, which added `related_to`.)
--
-- IDEMPOTENT / ADDITIVE / BACKWARD-COMPATIBLE:
--   * DROP CONSTRAINT IF EXISTS then ADD — safe to re-run; only WIDENS the allowed set
--     (every previously-valid row still satisfies the new CHECK), so no data can violate it.
--     Nothing is dropped from the domain.
--   * The constraint added by migration 054 is named `links_edge_type_check`; we replace it
--     by that name.
--
-- This migration number (059) is ABOVE BASELINE_THROUGH (42), so it runs normally on both
-- fresh builds (after the 000 baseline) and existing/already-baselined instances. The
-- schema-contract reference (scripts/schema-reference.sql.txt) is regenerated to include the
-- new value so the CI drift gate (the CI gate stage 0c) stays GREEN and honest.

ALTER TABLE links DROP CONSTRAINT IF EXISTS links_edge_type_check;

ALTER TABLE links ADD CONSTRAINT links_edge_type_check CHECK (edge_type IN (
  'decided_by', 'caused', 'built_by', 'supersedes', 'possibly_supersedes',
  'learned_from', 'proposed_by', 'informs', 'produced_outcome', 'related_to'
));

DO $$
BEGIN
  RAISE NOTICE '✅ links.edge_type CHECK extended with SOFT belief edge type `possibly_supersedes` (BL-3, two-tier v1).';
END $$;
