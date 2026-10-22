-- Migration 049: TYPED-EDGE GRAPH — the `links` table (Mandrel Core Redesign T2a).
--
-- WHY (spec §4 Capability 1): replace string-tag threading
-- (unrepairable, typo-fragile, ANY-overlap) with a REAL, bidirectional, repairable
-- edge store. Tags can't enforce referential integrity, can't reverse-lookup, can't be
-- repaired — edges can. This is the structural foundation the moat (T2b trust +
-- T3 recall_thread) is built on. Tags STAY (demoted to the human-viewable lens/label
-- path: scope:/owner:/ref:); edges carry STRUCTURE.
--
-- WHAT: a single additive `links` table. Each row is a typed, directed edge
-- from_id → to_id, scoped to a project, deduped by UNIQUE(from_id, to_id, edge_type),
-- with both-direction traversal indexes.
--
-- EDGE-TYPE DOMAIN — SINGLE SOURCE OF TRUTH: the CHECK below MUST match
-- mcp-server/src/config/edgeTypes.ts (EDGE_TYPES). That module is the canonical domain;
-- the zod validation derives from it, and a contract test (typedEdges.contract.test.ts)
-- asserts this DB CHECK and the config agree, so they cannot drift. No magic strings:
-- the list here is the materialized projection of that named config.
--
-- ADDITIVE / IDEMPOTENT / BACKWARD-COMPATIBLE:
--   * CREATE TABLE IF NOT EXISTS + CREATE INDEX IF NOT EXISTS — safe to re-run.
--   * Adds a brand-new table; nothing existing is altered or dropped.
--   * No data migration here (existing edges are backfilled by the separate idempotent
--     backfill script, run by the coordinator after deploy — never folded into this migration).
--
-- This migration number (049) is ABOVE BASELINE_THROUGH (42), so it runs normally on
-- BOTH fresh builds (after the 000 baseline) and existing/already-baselined instances.
-- The schema-contract reference (scripts/schema-reference.sql.txt) is regenerated to
-- include this table so the CI drift gate (the CI gate stage 0c) stays GREEN and honest.

CREATE TABLE IF NOT EXISTS links (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Endpoints span three tables (contexts/decisions/tasks); we store the id + its kind
  -- rather than a polymorphic FK (Postgres can't FK to a union of tables). The kind
  -- columns are CHECK-constrained to the resolvable entity set so a typo can't store a
  -- nonsense endpoint type.
  from_id     UUID NOT NULL,
  from_type   TEXT NOT NULL CHECK (from_type IN ('context', 'decision', 'task')),
  to_id       UUID NOT NULL,
  to_type     TEXT NOT NULL CHECK (to_type IN ('context', 'decision', 'task')),
  -- The typed edge. CHECK derives from src/config/edgeTypes.ts (EDGE_TYPES) — keep in
  -- sync (the typedEdges contract test enforces it).
  edge_type   TEXT NOT NULL CHECK (edge_type IN (
                'decided_by', 'caused', 'built_by', 'supersedes',
                'learned_from', 'proposed_by', 'informs', 'produced_outcome'
              )),
  -- Project scope: edges are project-scoped so traversal/trust stays within a tenant.
  -- Nullable for robustness (an edge whose endpoints predate project scoping), but
  -- normally set to the minting record's project.
  project_id  UUID REFERENCES projects(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Provenance: 'auto:context_store' / 'auto:decision_record' / 'link' (explicit) /
  -- 'backfill', so we can tell minted-at-write from explicitly-curated edges.
  created_by  TEXT,
  metadata    JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- DEDUPE: the same directed typed edge is stored once. The backfill + auto-mint paths
  -- rely on this (ON CONFLICT DO NOTHING) for idempotency.
  CONSTRAINT links_from_to_edge_uniq UNIQUE (from_id, to_id, edge_type)
);

-- BOTH-DIRECTION TRAVERSAL: index (from_id, edge_type) for forward walks and
-- (to_id, edge_type) for reverse walks, so get_links / recall_thread can fetch a
-- record's edges in either direction without a sequential scan.
CREATE INDEX IF NOT EXISTS idx_links_from ON links (from_id, edge_type);
CREATE INDEX IF NOT EXISTS idx_links_to   ON links (to_id, edge_type);
-- Project-scoped sweeps (backfill audits / trust passes) hit project_id directly.
CREATE INDEX IF NOT EXISTS idx_links_project ON links (project_id);

COMMENT ON TABLE links IS
  'Typed-edge graph (Mandrel Core Redesign T2a). Directed, bidirectionally-indexed, repairable edges between contexts/decisions/tasks. Edges carry STRUCTURE; tags carry labels. edge_type domain is single-sourced in src/config/edgeTypes.ts.';
COMMENT ON COLUMN links.edge_type IS
  'Typed edge value. Allowed set = src/config/edgeTypes.ts EDGE_TYPES (DB CHECK kept in sync by the typedEdges contract test).';
COMMENT ON COLUMN links.created_by IS
  'Edge provenance: auto:<tool> (minted at write-time), link (explicit link tool), or backfill.';

DO $$
BEGIN
  RAISE NOTICE '✅ links table created (typed-edge graph T2a): UNIQUE(from_id,to_id,edge_type), both-direction indexes, edge_type CHECK.';
END $$;
