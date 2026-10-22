-- Migration 066: add the `depends_on` task→task edge type to links.edge_type.
--
-- WHY (task-source edge minting, Q2): tasks were the ONLY pure-sink record type in the graph
-- — task_create minted NO edges, so the record our convention calls the SPINE was the one node
-- that could not point at anything (706 tasks affected). This migration widens the edge-type
-- domain with the ONE strong task→task type that work adds: `depends_on`.
--
-- WHY EXACTLY ONE NEW TYPE: `depends_on` is justified by an UNAMBIGUOUS signal that already
-- exists — the typed, resolver-validated, capped `dependencies` field on task_create. A strong
-- edge earns its strength from a strong signal. A `task:<id8>` TAG on a task is by contrast
-- genuinely ambiguous (subtask-of / follow-up-of / blocks / duplicates / same-workstream), so
-- it mints a weak `related_to` carrying source_tag provenance instead — losslessly upgradeable
-- by a later migration once usage evidence exists. Spending a vocabulary slot on a guess would
-- repeat the original sin in mirror image.
--
-- NOT AN OUTCOME EDGE: `depends_on` must never enter services/trust.ts OUTCOME_OUT_EDGE_TYPES.
-- A dependency is SCHEDULING STRUCTURE, not evidence — task A depending on task B says nothing
-- about whether B's outcome is A's evidence. That invariant is enforced by a load-time
-- assertion in trust.ts (mirroring the existing `related_to` guard) and pinned literally by
-- trustExcludesRelatedTo.contract.test.ts.
--
-- EDGE-TYPE DOMAIN — SINGLE SOURCE OF TRUTH: the value list below is the MATERIALIZED
-- projection of mcp-server/src/config/edgeTypes.ts edgeTypeCheckSqlList() (EDGE_TYPES). That
-- module is the canonical domain; this migration only re-materializes it into the DB CHECK.
-- The typedEdges contract test asserts the DB CHECK and the config agree, so they cannot
-- drift. No magic strings beyond this derived list. (Same shape as 054 and 059.)
--
-- IDEMPOTENT / ADDITIVE / BACKWARD-COMPATIBLE:
--   * DROP CONSTRAINT IF EXISTS then ADD — safe to re-run; only WIDENS the allowed set
--     (every previously-valid row still satisfies the new CHECK), so no data can violate it.
--     Nothing is dropped from the domain.
--   * The constraint is replaced by its established name `links_edge_type_check`.
--
-- This migration number (066) is ABOVE BASELINE_THROUGH (42), so it runs normally on both
-- fresh builds (after the 000 baseline) and existing/already-baselined instances. The
-- schema-contract reference (scripts/schema-reference.sql.txt) is regenerated to include the
-- new value so the CI drift gate (the CI gate stage 0c) stays GREEN and honest.

ALTER TABLE links DROP CONSTRAINT IF EXISTS links_edge_type_check;

ALTER TABLE links ADD CONSTRAINT links_edge_type_check CHECK (edge_type IN (
  'decided_by', 'caused', 'built_by', 'supersedes', 'possibly_supersedes',
  'learned_from', 'proposed_by', 'informs', 'produced_outcome', 'depends_on', 'related_to'
));

DO $$
BEGIN
  RAISE NOTICE '✅ links.edge_type CHECK extended with task→task scheduling edge `depends_on`.';
END $$;
