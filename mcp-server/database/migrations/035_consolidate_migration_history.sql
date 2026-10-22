-- Phase 2.1: Consolidate legacy migration tracking into _aidis_migrations
-- Ensures that historical migrations recorded in schema_migrations are migrated
-- to the unified tracking table used by the TypeScript migration runner.

-- Guard: create _aidis_migrations if it was never initialized (e.g., legacy installs)
CREATE TABLE IF NOT EXISTS _aidis_migrations (
    id SERIAL PRIMARY KEY,
    filename VARCHAR(255) NOT NULL UNIQUE,
    migration_number INTEGER NOT NULL,
    applied_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    checksum VARCHAR(64)
);

CREATE INDEX IF NOT EXISTS idx_migrations_number
    ON _aidis_migrations (migration_number);

DO $$
DECLARE
    rec RECORD;
    mapped_filename TEXT;
    mapped_number INTEGER;
BEGIN
    IF EXISTS (
        SELECT 1
        FROM information_schema.tables
        WHERE table_name = 'schema_migrations'
          AND table_schema = 'public'
    ) THEN
        FOR rec IN SELECT version, description, applied_at FROM schema_migrations LOOP
            -- Map legacy version names to current file names (after renumbering)
            mapped_filename := CASE rec.version
                WHEN '2025_09_10_create_change_pattern_tables' THEN '030_create_change_pattern_tables.sql'
                WHEN '2025_09_10_create_development_metrics_tables' THEN '028_create_development_metrics_tables.sql'
                WHEN '2025_09_10_create_git_tracking_tables' THEN '010_create_git_tracking_system.sql'
                WHEN '2025_09_09_enforce_session_project_fk' THEN '014_enforce_session_project_fk.sql'
                WHEN '2025_09_10_add_session_title_description' THEN '017_add_session_title_description.sql'
                ELSE rec.version || '.sql'
            END;

            mapped_number := CASE rec.version
                WHEN '2025_09_10_create_change_pattern_tables' THEN 30
                WHEN '2025_09_10_create_development_metrics_tables' THEN 28
                WHEN '2025_09_10_create_git_tracking_tables' THEN 10
                WHEN '2025_09_09_enforce_session_project_fk' THEN 14
                WHEN '2025_09_10_add_session_title_description' THEN 17
                ELSE NULL
            END;

            IF mapped_number IS NULL THEN
                -- Fallback for unexpected legacy entries: assign a high sequence to avoid conflicts
                SELECT COALESCE(MAX(migration_number), 0) + 100
                INTO mapped_number
                FROM _aidis_migrations;
            END IF;

            INSERT INTO _aidis_migrations (filename, migration_number, applied_at)
            SELECT mapped_filename, mapped_number, COALESCE(rec.applied_at, CURRENT_TIMESTAMP)
            WHERE NOT EXISTS (
                SELECT 1 FROM _aidis_migrations WHERE filename = mapped_filename
            );
        END LOOP;

        -- Drop legacy tracking table now that history is consolidated
        DROP TABLE schema_migrations;
    END IF;
END $$;
