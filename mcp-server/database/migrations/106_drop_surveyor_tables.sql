-- ═════════════════════════════════════════════════════════════════════════════════════════
-- 106 — drop the Surveyor tables. (layer 3 of 3.)
-- ═════════════════════════════════════════════════════════════════════════════════════════
-- The Surveyor gateway and its MCP tools (layer 1, 70c607cc) and the dashboard page/API
-- (layer 2, 1209a35a) are gone; nothing reads these tables. 000_baseline_schema.sql and
-- 053_create_surveyor_scans.sql are applied history and are NOT edited: a fresh database
-- creates the tables there and drops them here.
--
-- Children first; IF EXISTS everywhere so re-running (or running on a database that never
-- had them) is a no-op. The legacy denormalized view is dropped before the tables it reads.
DROP VIEW  IF EXISTS v_surveyor_scan_summaries;
DROP TABLE IF EXISTS surveyor_function_summaries;
DROP TABLE IF EXISTS surveyor_warnings;
DROP TABLE IF EXISTS surveyor_connections;
DROP TABLE IF EXISTS surveyor_nodes;
DROP TABLE IF EXISTS surveyor_scans;
