-- Migration 054: add the `related_to` weak edge type to links.edge_type (ST-1).
--
-- WHY (reliable-auto-threading, spec §E1): Component B (no-orphan
-- write-time inference) needs a LOW-CONFIDENCE, inferred edge type so a context_store is
-- never a silent orphan. `related_to` is that edge — deliberately NON-EVIDENCE: it is
-- kept OFF the trust path (services/trust.ts OUTCOME_OUT_EDGE_TYPES, guarded by a
-- load-time assertion) so minting it moves NO trust score.
--
-- EDGE-TYPE DOMAIN — SINGLE SOURCE OF TRUTH: the value list below is the MATERIALIZED
-- projection of mcp-server/src/config/edgeTypes.ts edgeTypeCheckSqlList() (EDGE_TYPES).
-- That module is the canonical domain; this migration only re-materializes it into the
-- DB CHECK. The typedEdges contract test (typedEdges.contract.test.ts) asserts this DB
-- CHECK and the config agree, so they cannot drift. No magic strings beyond this derived
-- list.
--
-- IDEMPOTENT / ADDITIVE / BACKWARD-COMPATIBLE:
--   * DROP CONSTRAINT IF EXISTS then ADD — safe to re-run; only WIDENS the allowed set
--     (every previously-valid row still satisfies the new CHECK), so no data can violate
--     it. Nothing is dropped from the domain.
--   * The inline column CHECK from migration 049 is auto-named `links_edge_type_check`
--     by Postgres; we replace it by that name.
--
-- This migration number (054) is ABOVE BASELINE_THROUGH, so it runs normally on both
-- fresh builds (after the 000 baseline) and existing/already-baselined instances. The
-- schema-contract reference (scripts/schema-reference.sql.txt) is regenerated to include
-- the new value so the CI drift gate (the CI gate stage 0c) stays GREEN and honest.

ALTER TABLE links DROP CONSTRAINT IF EXISTS links_edge_type_check;

ALTER TABLE links ADD CONSTRAINT links_edge_type_check CHECK (edge_type IN (
  'decided_by', 'caused', 'built_by', 'supersedes',
  'learned_from', 'proposed_by', 'informs', 'produced_outcome', 'related_to'
));

DO $$
BEGIN
  RAISE NOTICE '✅ links.edge_type CHECK extended with weak edge type `related_to` (ST-1, reliable-auto-threading).';
END $$;
