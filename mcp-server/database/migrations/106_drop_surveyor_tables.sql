-- ═════════════════════════════════════════════════════════════════════════════════════════
-- 106 — drop the Surveyor tables. (an earlier decision layer 3 of 3.)
-- ═════════════════════════════════════════════════════════════════════════════════════════
-- Surveyor was removed from the MCP server, the dashboard and the docs; nothing reads or
-- writes these tables any more. Children first, then the parent, then the legacy view that
-- 053 left behind on databases which never carried the denormalized shape.
--
-- DESTRUCTIVE: row data in these tables is PERMANENTLY LOST. Take a pg_dump of the five
-- surveyor_* tables before applying this to a database that holds scans you want to keep.
-- 000_baseline_schema.sql and 053_create_surveyor_scans.sql are intentionally NOT edited:
-- a fresh database still creates the objects there and this migration removes them.
-- Every statement is IF EXISTS, so re-running is a no-op.
DROP VIEW  IF EXISTS v_surveyor_scan_summaries;
DROP TABLE IF EXISTS surveyor_function_summaries;
DROP TABLE IF EXISTS surveyor_warnings;
DROP TABLE IF EXISTS surveyor_connections;
DROP TABLE IF EXISTS surveyor_nodes;
DROP TABLE IF EXISTS surveyor_scans;
