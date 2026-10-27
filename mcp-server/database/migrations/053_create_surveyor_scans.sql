-- Migration 053: SURVEYOR INTEGRATION — persist a tenant codebase scan (Surveyor P4b).
--
-- WHY (locked Surveyor rebuild): Surveyor is a
-- SHARED service (built in P4a, @surveyor/server) that scans a codebase and returns a
-- ScanResult (nodes map + connections + warnings + stats, with per-function AI/behavioral
-- summaries). Mandrel is the SYSTEM OF RECORD: it CALLS the service, then PERSISTS the
-- result durably into the tenant's Postgres and exposes it via MCP tools (surveyor_scan
-- writes it, surveyor_get_graph reads it). The service's in-memory job store is explicitly
-- NOT durable (it evicts after Mandrel retrieves the result) — THIS schema is the durable
-- home.
--
-- WHAT: five additive tables, all scoped to a Mandrel project (projects.id) and normalized
-- by scan:
--   surveyor_scans              — one row per scan run (the scan record: project, status,
--                                 stats, source job/result ids, denormalized totals).
--   surveyor_nodes              — the graph NODES (file/function/class), full payload in
--                                 jsonb + extracted columns for querying.
--   surveyor_connections        — the graph EDGES (import/call/inheritance/...), keyed by
--                                 the source ScanResult node ids.
--   surveyor_warnings           — the findings (circular dep / orphan / etc.).
--   surveyor_function_summaries — the per-function behavioral/AI summaries (extracted from
--                                 FunctionNode.behavioral) — first-class so they're queryable
--                                 without unpacking every node blob.
--
-- The shape mirrors the @surveyor/core types (packages/core/src/types/: scan.types.ts,
-- node.types.ts, connection.types.ts, warning.types.ts). The original string ids the
-- service assigns to nodes/connections/warnings are stored as *_key columns (NOT used as
-- our PKs — our PKs are uuids) so the graph's internal references (source_key/target_key →
-- node_key) stay intact within a scan, while a row is globally addressable by its uuid.
--
-- NORMALIZATION: nodes/connections/warnings/summaries each live in their own table keyed by
-- scan_id (one-to-many from a scan), every child UNIQUE on (scan_id, <source key>) so a
-- re-persist of the same scan can't duplicate, and indexed by scan_id (+ the traversal
-- columns) for fast graph reads. The full original object is kept in a `data`/jsonb column
-- alongside the extracted columns so surveyor_get_graph can return faithful nodes/edges
-- while filters/joins use the typed columns.
--
-- ADDITIVE / IDEMPOTENT / SHAPE-GUARDED:
--   * CREATE TABLE IF NOT EXISTS + CREATE INDEX IF NOT EXISTS — the create half is safe to re-run.
--   * ON DELETE CASCADE from projects → scans → children, so deleting a project (or a scan)
--     reaps its whole subtree with no orphans.
--   * The ONLY destructive action is dropping the DEAD LEGACY surveyor schema, and it fires
--     ONLY when the legacy shape is positively detected (see guard below) — so a re-run on the
--     new normalized schema (or a fresh DB) does NOTHING destructive and CANNOT lose P4b data.
--
-- This migration number (053) is ABOVE BASELINE_THROUGH (42), so it runs normally on BOTH
-- fresh builds (after the 000 baseline) and existing/already-baselined instances. The
-- schema-contract reference (scripts/schema-reference.sql.txt) is regenerated to include
-- these tables so the CI drift gate (the CI gate stage 0c) stays GREEN and honest.
--
-- ⚠️  REBUILD — SUPERSEDES + DROPS A DEAD LEGACY SURVEYOR SCHEMA (the operator-approved, 2026-06-27).
-- The 000 baseline carries an EARLIER, abandoned Surveyor iteration: a denormalized single-table
-- `surveyor_scans` (with nodes/connections/clusters as jsonb columns + summary_l0/l1/l2), a
-- `surveyor_warnings` table, and a `v_surveyor_scan_summaries` view. A repo-wide search
-- (handlers/services/routes/command-ui) found ZERO code referencing any of them — they are
-- orphaned schema, and nothing reads/writes them. Production was verified to hold ONLY legacy
-- junk in these tables (surveyor_scans=72, surveyor_warnings=7077 rows of the abandoned
-- denormalized format). The operator's DECISION: DROP it — it is junk, superseded by the locked P4b
-- NORMALIZED design (separate nodes/connections/warnings/function_summaries
-- tables). So this rebuild DROPS the legacy schema REGARDLESS of row count and replaces it under
-- the same natural names rather than leaving two surveyor schemas to drift.
--
-- SHAPE-GUARDED DROP (idempotent + can NEVER destroy real NEW P4b data): we drop the legacy
-- tables/view ONLY when they are the LEGACY shape, detected by a legacy-ONLY signature —
-- `surveyor_scans` carrying a `clusters` or `summary_l0` column, or the legacy view
-- `v_surveyor_scan_summaries` existing. The new normalized `surveyor_scans` has NONE of those,
-- so if the new schema is already present (or the DB is fresh) the guard detects NO legacy shape
-- and performs NO destructive action — the create-IF-NOT-EXISTS half then no-ops and existing
-- normalized rows are preserved. (NOTHING deploys from this branch; Coordinator/Reviewer review this
-- drop, and prod is CN1-gated.)

-- ── SHAPE-GUARDED drop of the dead legacy schema (the operator-approved; drops junk regardless of rows) ──
DO $$
DECLARE
  has_legacy_view BOOLEAN;
  has_legacy_cols BOOLEAN;
BEGIN
  -- Legacy-ONLY signatures. The normalized P4b surveyor_scans has neither `clusters` nor
  -- `summary_l0`, and the v_surveyor_scan_summaries view belongs solely to the legacy schema.
  has_legacy_view := to_regclass('public.v_surveyor_scan_summaries') IS NOT NULL;
  has_legacy_cols := EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'surveyor_scans'
      AND column_name IN ('clusters', 'summary_l0')
  );

  IF has_legacy_view OR has_legacy_cols THEN
    -- LEGACY shape detected → drop the abandoned junk (the operator-approved), regardless of row
    -- count. View first (it depends on the legacy table), then the tables (CASCADE mops up
    -- any leftover dependents such as the legacy warnings FK + indexes).
    RAISE NOTICE 'Surveyor 053: LEGACY denormalized schema detected — dropping dead junk (the operator-approved): v_surveyor_scan_summaries, surveyor_warnings, surveyor_scans.';
    DROP VIEW  IF EXISTS public.v_surveyor_scan_summaries;
    DROP TABLE IF EXISTS public.surveyor_warnings CASCADE;
    DROP TABLE IF EXISTS public.surveyor_scans    CASCADE;
  ELSE
    -- No legacy shape: either the NEW normalized schema is already present (re-run) or the DB
    -- is fresh. Do NOTHING destructive — the create-IF-NOT-EXISTS half below is a safe no-op
    -- and any existing normalized P4b data is preserved.
    RAISE NOTICE 'Surveyor 053: no legacy schema present (new normalized schema or fresh DB) — no destructive action taken.';
  END IF;
END $$;

-- ── The scan record ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS surveyor_scans (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Project scope: a scan belongs to exactly one Mandrel project. CASCADE so deleting a
  -- project reaps its scans (and their graph) automatically.
  project_id    UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  -- The ScanResult.id the service assigned (provenance / cross-reference to a job run).
  source_scan_id TEXT,
  -- The path that was scanned + the service-derived project name (ScanResult.projectPath /
  -- .projectName) — kept for display + audit.
  project_path  TEXT NOT NULL,
  project_name  TEXT,
  -- Terminal scan status as reported by the service's ScanResult (ScanStatus): typically
  -- 'complete'; 'failed' is recorded too (a persisted record of a failed scan is still useful).
  status        TEXT NOT NULL DEFAULT 'complete',
  -- Full ScanStats blob (totals + warningsByLevel + nodesByType + analyzed counts).
  stats         JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- Denormalized top-line counts (from ScanStats) for cheap listing/summary without
  -- unpacking the jsonb. Kept in sync at write time by surveyor_scan.
  total_files       INTEGER NOT NULL DEFAULT 0,
  total_functions   INTEGER NOT NULL DEFAULT 0,
  total_classes     INTEGER NOT NULL DEFAULT 0,
  total_connections INTEGER NOT NULL DEFAULT 0,
  total_warnings    INTEGER NOT NULL DEFAULT 0,
  -- When the scan was persisted into Mandrel, and when the service finished it.
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at  TIMESTAMPTZ,
  metadata      JSONB NOT NULL DEFAULT '{}'::jsonb
);
-- "Latest scan for a project" is the hot read (surveyor_get_graph default) — index it.
CREATE INDEX IF NOT EXISTS idx_surveyor_scans_project_created
  ON surveyor_scans (project_id, created_at DESC);

-- ── Graph nodes ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS surveyor_nodes (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scan_id    UUID NOT NULL REFERENCES surveyor_scans(id) ON DELETE CASCADE,
  -- The node's id WITHIN the ScanResult (the key connections reference). Unique per scan.
  node_key   TEXT NOT NULL,
  -- Extracted, queryable columns (the rest of the node lives in `data`).
  node_type  TEXT NOT NULL,            -- 'file' | 'function' | 'class' (NodeType)
  name       TEXT NOT NULL,
  file_path  TEXT,
  line       INTEGER,
  end_line   INTEGER,
  -- The full original node object (FileNode | FunctionNode | ClassNode) for faithful read-back.
  data       JSONB NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT surveyor_nodes_scan_key_uniq UNIQUE (scan_id, node_key)
);
CREATE INDEX IF NOT EXISTS idx_surveyor_nodes_scan      ON surveyor_nodes (scan_id);
CREATE INDEX IF NOT EXISTS idx_surveyor_nodes_scan_type ON surveyor_nodes (scan_id, node_type);

-- ── Graph connections (edges) ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS surveyor_connections (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scan_id         UUID NOT NULL REFERENCES surveyor_scans(id) ON DELETE CASCADE,
  -- The connection's id within the ScanResult (Connection.id). Unique per scan.
  connection_key  TEXT NOT NULL,
  -- Endpoints reference surveyor_nodes.node_key within the SAME scan (Connection.sourceId /
  -- .targetId). Not FK-constrained to node_key (the service may reference an external/unknown
  -- symbol); kept as keys + indexed for traversal.
  source_key      TEXT NOT NULL,
  target_key      TEXT NOT NULL,
  connection_type TEXT NOT NULL,        -- import | function_call | inheritance | ... (ConnectionType)
  weight          DOUBLE PRECISION NOT NULL DEFAULT 1,
  metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT surveyor_connections_scan_key_uniq UNIQUE (scan_id, connection_key)
);
CREATE INDEX IF NOT EXISTS idx_surveyor_connections_scan        ON surveyor_connections (scan_id);
CREATE INDEX IF NOT EXISTS idx_surveyor_connections_scan_source ON surveyor_connections (scan_id, source_key);
CREATE INDEX IF NOT EXISTS idx_surveyor_connections_scan_target ON surveyor_connections (scan_id, target_key);

-- ── Warnings (findings) ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS surveyor_warnings (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scan_id       UUID NOT NULL REFERENCES surveyor_scans(id) ON DELETE CASCADE,
  warning_key   TEXT NOT NULL,          -- Warning.id within the ScanResult
  category      TEXT NOT NULL,          -- WarningCategory
  level         TEXT NOT NULL,          -- WarningLevel: info | warning | error
  title         TEXT NOT NULL,
  description   TEXT,
  -- The node keys this warning is about (Warning.affectedNodes) + the optional suggestion.
  affected_nodes JSONB NOT NULL DEFAULT '[]'::jsonb,
  suggestion    JSONB,
  source        TEXT,                   -- WarningSource: surveyor | knip | dependency-cruiser
  confidence    DOUBLE PRECISION,
  dismissible   BOOLEAN NOT NULL DEFAULT false,
  detected_at   TIMESTAMPTZ,
  CONSTRAINT surveyor_warnings_scan_key_uniq UNIQUE (scan_id, warning_key)
);
CREATE INDEX IF NOT EXISTS idx_surveyor_warnings_scan       ON surveyor_warnings (scan_id);
CREATE INDEX IF NOT EXISTS idx_surveyor_warnings_scan_level ON surveyor_warnings (scan_id, level);

-- ── Per-function behavioral / AI summaries ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS surveyor_function_summaries (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scan_id      UUID NOT NULL REFERENCES surveyor_scans(id) ON DELETE CASCADE,
  -- The function node this summary describes (FunctionNode id == surveyor_nodes.node_key).
  node_key     TEXT NOT NULL,
  summary      TEXT NOT NULL,
  -- BehavioralSummary.source: 'docstring' | 'ai' | 'manual' (SummarySource).
  summary_source TEXT,
  -- BehavioralSummary.flags (databaseRead/httpCall/hasSideEffects/...).
  flags        JSONB NOT NULL DEFAULT '{}'::jsonb,
  analyzed_at  TIMESTAMPTZ,
  CONSTRAINT surveyor_function_summaries_scan_key_uniq UNIQUE (scan_id, node_key)
);
CREATE INDEX IF NOT EXISTS idx_surveyor_function_summaries_scan ON surveyor_function_summaries (scan_id);

COMMENT ON TABLE surveyor_scans IS
  'Surveyor P4b: one row per persisted codebase scan. Mandrel is the system of record — it calls the shared Surveyor service and persists the ScanResult here, scoped to a Mandrel project.';
COMMENT ON TABLE surveyor_nodes IS
  'Surveyor graph nodes (file/function/class) for a scan. node_key = the id within the ScanResult; full payload in data jsonb.';
COMMENT ON TABLE surveyor_connections IS
  'Surveyor graph edges for a scan. source_key/target_key reference surveyor_nodes.node_key within the same scan.';
COMMENT ON TABLE surveyor_warnings IS
  'Surveyor findings (circular dep / orphan / large file / ...) for a scan.';
COMMENT ON TABLE surveyor_function_summaries IS
  'Per-function behavioral/AI summaries (FunctionNode.behavioral) extracted first-class for query.';

DO $$
BEGIN
  RAISE NOTICE '✅ Surveyor scan tables created (P4b): surveyor_scans + nodes/connections/warnings/function_summaries, project-scoped, CASCADE, indexed.';
END $$;
