-- =============================================================================
-- schema-fingerprint.sql — canonical, version-agnostic schema fingerprint
-- =============================================================================
-- Emits ONE sorted line per schema object (columns, constraints, indexes, views,
-- sequences, enums). Deterministic and stable across PostgreSQL 15 and 16 and
-- across pg_dump tool versions, because it reads catalog metadata directly rather
-- than relying on pg_dump's (version-sensitive) text formatting.
--
-- This is the single source of truth for BOTH:
--   * the committed CI reference   (scripts/schema-reference.sql.txt)
--   * the per-instance fleet audit  (a per-instance schema audit)
-- so a tenant on pg15 is compared apples-to-apples with a pg16-migrated reference.
--
-- Usage:  psql -d <db> -f scripts/schema-fingerprint.sql   (READ ONLY — pure SELECTs)
-- Restricted to schema 'public'. Sort the output for a stable diff (callers pipe
-- through `LC_ALL=C sort`).
-- =============================================================================
\pset format unaligned
\pset tuples_only on
\pset footer off
SET client_min_messages = warning;

-- --- COLUMNS: COLUMN <table>.<col> | <type>[(len)] | null=<Y/N> | default=<expr> -
-- Column defaults are stripped of their explicit ::type casts so the same logical
-- default reads identically on pg15 and pg16.
SELECT 'COLUMN ' || c.table_name || '.' || c.column_name
       || ' | ' || c.data_type
       || COALESCE('(' || c.character_maximum_length || ')', '')
       || ' | null=' || c.is_nullable
       || ' | default=' || COALESCE(regexp_replace(c.column_default, '::[a-zA-Z0-9_ \."\[\]]+', '', 'g'), '')
FROM information_schema.columns c
JOIN information_schema.tables t
  ON t.table_schema = c.table_schema AND t.table_name = c.table_name
 AND t.table_type = 'BASE TABLE'
WHERE c.table_schema = 'public'
ORDER BY 1;

-- --- CONSTRAINTS: CONSTRAINT <table> <type> <name> (<def>) ---------------------
-- PK / FK / UNIQUE / CHECK, by definition. pg_get_constraintdef is semantically
-- portable but COSMETICALLY version-sensitive: a CHECK ... IN (...) is rendered as
--   pg16:  ANY (ARRAY[('a'::character varying)::text, ...])
--   pg15:  ANY ((ARRAY['a'::character varying, ...])::text[])
-- and the SAME baseline can land in either form depending on when/how it was loaded.
-- To make the contract robust we NORMALIZE the def: strip every explicit ::cast and
-- all '(', ')', '[', ']', ' ' so both renderings collapse to the same token string.
-- This preserves the real content (the allowed values / FK target) while erasing the
-- pure-formatting variance that would otherwise show as false drift on pg15 tenants.
SELECT 'CONSTRAINT ' || rel.relname || ' '
       || CASE con.contype WHEN 'p' THEN 'PRIMARY_KEY'
                           WHEN 'f' THEN 'FOREIGN_KEY'
                           WHEN 'u' THEN 'UNIQUE'
                           WHEN 'c' THEN 'CHECK'
                           ELSE con.contype::text END
       || ' ' || con.conname
       || ' :: ' ||
       regexp_replace(
         regexp_replace(pg_get_constraintdef(con.oid),
                        '::[a-zA-Z0-9_ \."]+(\[\])?', '', 'g'),  -- drop ::type / ::type[] casts
         '[][() ]', '', 'g')                                      -- drop ()[] and spaces
FROM pg_constraint con
JOIN pg_class rel ON rel.oid = con.conrelid
JOIN pg_namespace ns ON ns.oid = rel.relnamespace
WHERE ns.nspname = 'public'
ORDER BY 1;

-- --- INDEXES: INDEX <table>.<index> :: <definition> ---------------------------
-- pg_get_indexdef is schema-qualified + stable; strip the leading schema noise so
-- it reads the same regardless of search_path.
SELECT 'INDEX ' || tablename || '.' || indexname || ' :: '
       || regexp_replace(indexdef, ' ON public\.', ' ON ')
FROM pg_indexes
WHERE schemaname = 'public'
ORDER BY 1;

-- --- VIEWS: VIEW <name> :: <normalized definition> ----------------------------
-- View defs are the MOST version-fragile object: pg15 vs pg16 differ in whitespace,
-- in whether output columns carry their source TABLE-ALIAS qualifier
-- (pg15 'gc.project_id' vs pg16 'project_id'), and in casts. We normalize all three:
--   1. collapse whitespace
--   2. strip '<alias>.' qualifiers (safe: views here are public-schema only and the
--      public. qualifier is already gone, so the remaining word. are table aliases)
--   3. strip ::type casts
-- so the SAME logical view reads identically on pg15 and pg16. (Verified: this turns
-- the 2-view "drift" seen on every pg15 tenant into a clean match.)
SELECT 'VIEW ' || table_name || ' :: '
       || regexp_replace(
            regexp_replace(
              regexp_replace(
                regexp_replace(view_definition, '\s+', ' ', 'g'),  -- 1. ws
                '::[a-zA-Z0-9_ \."\[\]]+', '', 'g'),                -- 3. casts
              '\m[a-z_][a-z0-9_]*\.', '', 'g'),                     -- 2. alias.
            '^ | $', '', 'g')
FROM information_schema.views
WHERE table_schema = 'public'
ORDER BY 1;

-- --- SEQUENCES: SEQUENCE <name> -----------------------------------------------
SELECT 'SEQUENCE ' || sequence_name
FROM information_schema.sequences
WHERE sequence_schema = 'public'
ORDER BY 1;

-- --- ENUM TYPES: ENUM <type> = <ordered labels> -------------------------------
SELECT 'ENUM ' || t.typname || ' = '
       || string_agg(e.enumlabel, ',' ORDER BY e.enumsortorder)
FROM pg_type t
JOIN pg_enum e ON e.enumtypid = t.oid
JOIN pg_namespace ns ON ns.oid = t.typnamespace
WHERE ns.nspname = 'public'
GROUP BY t.typname
ORDER BY 1;
