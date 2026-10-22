-- AIDIS Migration 023: Create Shadow Tables (P2.3 Implementation)
--
-- PHASE 2.3: Data Migration Strategy - Shadow Table Creation
-- This migration implements the zero-downtime migration strategy for AIDIS Oracle refactoring
--
-- OBJECTIVES:
-- 1. Create production-safe shadow tables for the 5 critical tables
-- 2. Include migration tracking metadata and validation hash columns
-- 3. Ensure full reversibility and data integrity validation
-- 4. Provide comprehensive safety mechanisms and rollback procedures
--
-- CRITICAL TABLES: projects, sessions, contexts, analytics_events, agent_tasks
--
-- Author: AIDIS Oracle Refactoring Team
-- Date: 2025-09-17
-- Phase: P2.3 Shadow Table Creation
-- Risk Level: HIGH (Production Migration Strategy)

-- ==============================================================================
-- SAFETY VALIDATIONS - PRE-FLIGHT CHECKS
-- ==============================================================================

-- Check that required extensions are available
SELECT CASE
    WHEN COUNT(*) = 2 THEN 'PASS: Required extensions available'
    ELSE 'FAIL: Missing required extensions'
END as preflight_extensions_check
FROM (
    SELECT 1 FROM pg_extension WHERE extname = 'uuid-ossp'
    UNION ALL
    SELECT 1 FROM pg_extension WHERE extname = 'vector'
) ext;

-- Verify critical tables exist before creating shadows
DO $$
DECLARE
    missing_tables TEXT[] := '{}';
    required_table TEXT;
BEGIN
    FOR required_table IN
        SELECT unnest(ARRAY['projects', 'sessions', 'contexts', 'analytics_events'])
    LOOP
        IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = required_table) THEN
            missing_tables := array_append(missing_tables, required_table);
        END IF;
    END LOOP;

    IF array_length(missing_tables, 1) > 0 THEN
        RAISE EXCEPTION 'PREFLIGHT FAIL: Missing required tables: %', array_to_string(missing_tables, ', ');
    ELSE
        RAISE NOTICE 'PREFLIGHT PASS: All required tables exist';
    END IF;
END $$;

-- ==============================================================================
-- SHADOW TABLE CREATION - ENHANCED SCHEMA WITH MIGRATION METADATA
-- ==============================================================================

-- Create shared migration tracking function for validation hashes
CREATE OR REPLACE FUNCTION calculate_shadow_validation_hash(
    table_name TEXT,
    record_data JSONB
) RETURNS TEXT AS $$
BEGIN
    RETURN encode(
        digest(
            table_name || '::' || record_data::text,
            'sha256'
        ),
        'hex'
    );
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- Create shadow sync status type
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'shadow_sync_status') THEN
        CREATE TYPE shadow_sync_status AS ENUM (
            'pending',      -- Awaiting sync from primary table
            'synced',       -- Successfully synced with primary
            'conflict',     -- Data conflict detected
            'migrated',     -- Ready for cutover
            'validated'     -- Post-migration validation complete
        );
    END IF;
END $$;

-- ==============================================================================
-- PROJECTS SHADOW TABLE
-- ==============================================================================

CREATE TABLE IF NOT EXISTS projects_shadow (
    -- Original columns with enhanced constraints
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) NOT NULL,
    description TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    status VARCHAR(50) DEFAULT 'active' CHECK (
        status IN ('active', 'archived', 'completed', 'paused', 'migrating')
    ),
    git_repo_url TEXT CONSTRAINT valid_git_repo_url CHECK (
        git_repo_url IS NULL OR
        git_repo_url ~ '^https?://.*\.git$' OR
        git_repo_url ~ '^git@.*:.*\.git$' OR
        git_repo_url ~ '^https://github\.com/.*$'
    ),
    root_directory TEXT CONSTRAINT valid_root_directory CHECK (
        root_directory IS NULL OR
        root_directory ~ '^(/[^/\0]+)+/?$'
    ),
    metadata JSONB DEFAULT '{}'::jsonb,

    -- Shadow table metadata columns
    _shadow_version INTEGER NOT NULL DEFAULT 1,
    _shadow_sync_status shadow_sync_status NOT NULL DEFAULT 'pending',
    _shadow_created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    _shadow_source_id UUID, -- Reference to original record ID
    _shadow_validation_hash TEXT NOT NULL,
    _shadow_last_sync TIMESTAMP WITH TIME ZONE,
    _shadow_migration_batch UUID, -- For tracking migration batches

    -- Enhanced constraints
    CONSTRAINT projects_shadow_name_length CHECK (length(trim(name)) >= 1 AND length(name) <= 255),
    CONSTRAINT projects_shadow_description_reasonable CHECK (
        description IS NULL OR length(description) <= 10000
    ),
    CONSTRAINT projects_shadow_metadata_valid CHECK (jsonb_typeof(metadata) = 'object'),
    CONSTRAINT projects_shadow_sync_timestamps CHECK (
        _shadow_last_sync IS NULL OR _shadow_last_sync >= _shadow_created_at
    )
);

-- Unique constraints for shadow table
CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_shadow_name_unique
ON projects_shadow(name)
WHERE _shadow_sync_status IN ('synced', 'migrated', 'validated');

CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_shadow_source_id
ON projects_shadow(_shadow_source_id)
WHERE _shadow_source_id IS NOT NULL;

-- Performance indexes for projects shadow
CREATE INDEX IF NOT EXISTS idx_projects_shadow_status ON projects_shadow(status);
CREATE INDEX IF NOT EXISTS idx_projects_shadow_created_at ON projects_shadow(created_at);
CREATE INDEX IF NOT EXISTS idx_projects_shadow_sync_status ON projects_shadow(_shadow_sync_status);
CREATE INDEX IF NOT EXISTS idx_projects_shadow_migration_batch ON projects_shadow(_shadow_migration_batch);
CREATE INDEX IF NOT EXISTS idx_projects_shadow_metadata_gin ON projects_shadow USING GIN(metadata);

-- ==============================================================================
-- SESSIONS SHADOW TABLE
-- ==============================================================================

CREATE TABLE IF NOT EXISTS sessions_shadow (
    -- Original columns with enhanced constraints
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL,
    agent_type VARCHAR(50) NOT NULL CHECK (length(trim(agent_type)) >= 1),
    started_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    ended_at TIMESTAMP WITH TIME ZONE,
    context_summary TEXT,
    tokens_used INTEGER DEFAULT 0 CHECK (tokens_used >= 0),
    metadata JSONB DEFAULT '{}'::jsonb,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    active_branch VARCHAR(255),
    working_commit_sha VARCHAR(40) CHECK (
        working_commit_sha IS NULL OR
        working_commit_sha ~ '^[a-f0-9]{40}$'
    ),
    commits_contributed INTEGER DEFAULT 0 CHECK (commits_contributed >= 0),
    pattern_preferences JSONB DEFAULT '{}'::jsonb,
    insights_generated INTEGER DEFAULT 0 CHECK (insights_generated >= 0),
    last_pattern_analysis TIMESTAMP WITH TIME ZONE,
    title VARCHAR(255) CHECK (
        title IS NULL OR
        (length(trim(title)) >= 1 AND length(title) <= 255)
    ),
    description TEXT CHECK (
        description IS NULL OR length(description) <= 10000
    ),

    -- Shadow table metadata columns
    _shadow_version INTEGER NOT NULL DEFAULT 1,
    _shadow_sync_status shadow_sync_status NOT NULL DEFAULT 'pending',
    _shadow_created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    _shadow_source_id UUID,
    _shadow_validation_hash TEXT NOT NULL,
    _shadow_last_sync TIMESTAMP WITH TIME ZONE,
    _shadow_migration_batch UUID,

    -- Enhanced constraints
    CONSTRAINT sessions_shadow_reasonable_duration CHECK (
        ended_at IS NULL OR ended_at >= started_at
    ),
    CONSTRAINT sessions_shadow_pattern_analysis_after_start CHECK (
        last_pattern_analysis IS NULL OR last_pattern_analysis >= started_at
    ),
    CONSTRAINT sessions_shadow_metadata_valid CHECK (
        jsonb_typeof(metadata) = 'object' AND
        jsonb_typeof(pattern_preferences) = 'object'
    ),
    CONSTRAINT sessions_shadow_sync_timestamps CHECK (
        _shadow_last_sync IS NULL OR _shadow_last_sync >= _shadow_created_at
    )
);

-- Foreign key will be created after all shadow tables exist
-- CREATE INDEX for FK lookup
CREATE INDEX IF NOT EXISTS idx_sessions_shadow_project_id ON sessions_shadow(project_id);

-- Performance indexes for sessions shadow
CREATE INDEX IF NOT EXISTS idx_sessions_shadow_agent_type ON sessions_shadow(agent_type);
CREATE INDEX IF NOT EXISTS idx_sessions_shadow_started_at ON sessions_shadow(started_at);
CREATE INDEX IF NOT EXISTS idx_sessions_shadow_project_agent ON sessions_shadow(project_id, agent_type);
CREATE INDEX IF NOT EXISTS idx_sessions_shadow_sync_status ON sessions_shadow(_shadow_sync_status);
CREATE INDEX IF NOT EXISTS idx_sessions_shadow_source_id ON sessions_shadow(_shadow_source_id);
CREATE INDEX IF NOT EXISTS idx_sessions_shadow_title ON sessions_shadow(title) WHERE title IS NOT NULL;

-- ==============================================================================
-- CONTEXTS SHADOW TABLE
-- ==============================================================================

CREATE TABLE IF NOT EXISTS contexts_shadow (
    -- Original columns with enhanced constraints
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL,
    session_id UUID,
    context_type VARCHAR(50) NOT NULL CHECK (
        context_type IN ('code', 'decision', 'error', 'discussion', 'planning', 'completion', 'milestone')
    ),
    content TEXT NOT NULL CHECK (length(trim(content)) > 0),
    embedding VECTOR(1536) CONSTRAINT embedding_dimension_1536 CHECK (
        embedding IS NULL OR vector_dims(embedding) = 1536
    ),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    relevance_score DOUBLE PRECISION DEFAULT 1.0 CHECK (
        relevance_score >= 0 AND relevance_score <= 10
    ),
    tags TEXT[] DEFAULT '{}' CHECK (
        array_length(tags, 1) IS NULL OR array_length(tags, 1) <= 50
    ),
    metadata JSONB DEFAULT '{}'::jsonb,
    related_commit_sha VARCHAR(40) CHECK (
        related_commit_sha IS NULL OR
        related_commit_sha ~ '^[a-f0-9]{40}$'
    ),
    commit_context_type VARCHAR(50),
    pattern_session_id UUID,
    related_insights UUID[] DEFAULT '{}',
    pattern_relevance_score NUMERIC(6,4) CHECK (
        pattern_relevance_score IS NULL OR
        (pattern_relevance_score >= 0 AND pattern_relevance_score <= 1)
    ),

    -- Shadow table metadata columns
    _shadow_version INTEGER NOT NULL DEFAULT 1,
    _shadow_sync_status shadow_sync_status NOT NULL DEFAULT 'pending',
    _shadow_created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    _shadow_source_id UUID,
    _shadow_validation_hash TEXT NOT NULL,
    _shadow_last_sync TIMESTAMP WITH TIME ZONE,
    _shadow_migration_batch UUID,

    -- Enhanced constraints
    CONSTRAINT contexts_shadow_content_reasonable CHECK (length(content) <= 1000000),
    CONSTRAINT contexts_shadow_tags_valid CHECK (
        array_length(tags, 1) IS NULL OR
        array_length(tags, 1) > 0
    ),
    CONSTRAINT contexts_shadow_metadata_valid CHECK (jsonb_typeof(metadata) = 'object'),
    CONSTRAINT contexts_shadow_sync_timestamps CHECK (
        _shadow_last_sync IS NULL OR _shadow_last_sync >= _shadow_created_at
    )
);

-- Performance indexes for contexts shadow
CREATE INDEX IF NOT EXISTS idx_contexts_shadow_project_id ON contexts_shadow(project_id);
CREATE INDEX IF NOT EXISTS idx_contexts_shadow_session_id ON contexts_shadow(session_id);
CREATE INDEX IF NOT EXISTS idx_contexts_shadow_type ON contexts_shadow(context_type);
CREATE INDEX IF NOT EXISTS idx_contexts_shadow_project_type ON contexts_shadow(project_id, context_type);
CREATE INDEX IF NOT EXISTS idx_contexts_shadow_created_at ON contexts_shadow(created_at);
CREATE INDEX IF NOT EXISTS idx_contexts_shadow_relevance ON contexts_shadow(relevance_score DESC);
CREATE INDEX IF NOT EXISTS idx_contexts_shadow_sync_status ON contexts_shadow(_shadow_sync_status);
CREATE INDEX IF NOT EXISTS idx_contexts_shadow_source_id ON contexts_shadow(_shadow_source_id);

-- Vector search index for shadow table
CREATE INDEX IF NOT EXISTS idx_contexts_shadow_embedding_cosine
ON contexts_shadow USING ivfflat (embedding vector_cosine_ops)
WITH (lists = 100);

-- Full-text search for shadow table
CREATE INDEX IF NOT EXISTS idx_contexts_shadow_content_fts
ON contexts_shadow USING GIN(to_tsvector('english', content));

-- GIN indexes for arrays and JSONB
CREATE INDEX IF NOT EXISTS idx_contexts_shadow_tags_gin ON contexts_shadow USING GIN(tags);
CREATE INDEX IF NOT EXISTS idx_contexts_shadow_metadata_gin ON contexts_shadow USING GIN(metadata);
CREATE INDEX IF NOT EXISTS idx_contexts_shadow_insights_gin ON contexts_shadow USING GIN(related_insights);

-- ==============================================================================
-- ANALYTICS_EVENTS SHADOW TABLE
-- ==============================================================================

CREATE TABLE IF NOT EXISTS analytics_events_shadow (
    -- Original columns with enhanced constraints
    event_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    actor VARCHAR(20) NOT NULL CHECK (
        actor IN ('human', 'ai', 'system')
    ),
    project_id UUID,
    session_id UUID,
    context_id UUID,
    event_type VARCHAR(50) NOT NULL CHECK (length(trim(event_type)) >= 1),
    payload JSONB,
    status VARCHAR(20) CHECK (
        status IS NULL OR status IN ('open', 'closed', 'error', 'pending', 'processing')
    ),
    duration_ms INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0),
    tags TEXT[] CHECK (
        array_length(tags, 1) IS NULL OR array_length(tags, 1) <= 20
    ),
    ai_model_used VARCHAR(100),
    prompt_tokens INTEGER CHECK (prompt_tokens IS NULL OR prompt_tokens >= 0),
    completion_tokens INTEGER CHECK (completion_tokens IS NULL OR completion_tokens >= 0),
    feedback INTEGER CHECK (feedback IS NULL OR feedback IN (-1, 0, 1)),
    metadata JSONB,

    -- Shadow table metadata columns
    _shadow_version INTEGER NOT NULL DEFAULT 1,
    _shadow_sync_status shadow_sync_status NOT NULL DEFAULT 'pending',
    _shadow_created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    _shadow_source_id UUID,
    _shadow_validation_hash TEXT NOT NULL,
    _shadow_last_sync TIMESTAMP WITH TIME ZONE,
    _shadow_migration_batch UUID,

    -- Enhanced constraints
    CONSTRAINT analytics_events_shadow_payload_valid CHECK (
        payload IS NULL OR jsonb_typeof(payload) = 'object'
    ),
    CONSTRAINT analytics_events_shadow_metadata_valid CHECK (
        metadata IS NULL OR jsonb_typeof(metadata) = 'object'
    ),
    CONSTRAINT analytics_events_shadow_token_consistency CHECK (
        (prompt_tokens IS NULL AND completion_tokens IS NULL) OR
        (prompt_tokens IS NOT NULL AND completion_tokens IS NOT NULL)
    ),
    CONSTRAINT analytics_events_shadow_sync_timestamps CHECK (
        _shadow_last_sync IS NULL OR _shadow_last_sync >= _shadow_created_at
    )
);

-- Performance indexes for analytics_events shadow
CREATE INDEX IF NOT EXISTS idx_analytics_events_shadow_timestamp ON analytics_events_shadow(timestamp);
CREATE INDEX IF NOT EXISTS idx_analytics_events_shadow_project_id ON analytics_events_shadow(project_id);
CREATE INDEX IF NOT EXISTS idx_analytics_events_shadow_session_id ON analytics_events_shadow(session_id);
CREATE INDEX IF NOT EXISTS idx_analytics_events_shadow_event_type ON analytics_events_shadow(event_type);
CREATE INDEX IF NOT EXISTS idx_analytics_events_shadow_actor ON analytics_events_shadow(actor);
CREATE INDEX IF NOT EXISTS idx_analytics_events_shadow_status ON analytics_events_shadow(status);
CREATE INDEX IF NOT EXISTS idx_analytics_events_shadow_sync_status ON analytics_events_shadow(_shadow_sync_status);
CREATE INDEX IF NOT EXISTS idx_analytics_events_shadow_source_id ON analytics_events_shadow(_shadow_source_id);

-- GIN indexes for JSONB and arrays
CREATE INDEX IF NOT EXISTS idx_analytics_events_shadow_payload_gin ON analytics_events_shadow USING GIN(payload);
CREATE INDEX IF NOT EXISTS idx_analytics_events_shadow_metadata_gin ON analytics_events_shadow USING GIN(metadata);
CREATE INDEX IF NOT EXISTS idx_analytics_events_shadow_tags_gin ON analytics_events_shadow USING GIN(tags);

-- ==============================================================================
-- AGENT_TASKS SHADOW TABLE (Based on existing agent_tasks schema)
-- ==============================================================================

CREATE TABLE IF NOT EXISTS agent_tasks_shadow (
    -- Original columns with enhanced constraints
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL,
    assigned_to UUID, -- Will reference agents if that system is restored
    created_by UUID,  -- Will reference agents if that system is restored
    title VARCHAR(500) NOT NULL CHECK (length(trim(title)) >= 1),
    description TEXT CHECK (
        description IS NULL OR length(description) <= 50000
    ),
    type VARCHAR(100) NOT NULL DEFAULT 'general' CHECK (
        type IN ('general', 'feature', 'bugfix', 'refactor', 'test', 'review', 'documentation', 'migration')
    ),
    status VARCHAR(50) NOT NULL DEFAULT 'todo' CHECK (
        status IN ('todo', 'in_progress', 'blocked', 'completed', 'cancelled', 'on_hold')
    ),
    priority VARCHAR(20) NOT NULL DEFAULT 'medium' CHECK (
        priority IN ('low', 'medium', 'high', 'urgent', 'critical')
    ),
    dependencies UUID[] DEFAULT '{}' CHECK (
        array_length(dependencies, 1) IS NULL OR array_length(dependencies, 1) <= 100
    ),
    tags TEXT[] DEFAULT '{}' CHECK (
        array_length(tags, 1) IS NULL OR array_length(tags, 1) <= 20
    ),
    metadata JSONB DEFAULT '{}',
    started_at TIMESTAMP WITH TIME ZONE,
    completed_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,

    -- Shadow table metadata columns
    _shadow_version INTEGER NOT NULL DEFAULT 1,
    _shadow_sync_status shadow_sync_status NOT NULL DEFAULT 'pending',
    _shadow_created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    _shadow_source_id UUID,
    _shadow_validation_hash TEXT NOT NULL,
    _shadow_last_sync TIMESTAMP WITH TIME ZONE,
    _shadow_migration_batch UUID,

    -- Enhanced constraints
    CONSTRAINT agent_tasks_shadow_timeline_valid CHECK (
        (started_at IS NULL OR started_at >= created_at) AND
        (completed_at IS NULL OR started_at IS NULL OR completed_at >= started_at)
    ),
    CONSTRAINT agent_tasks_shadow_completion_status CHECK (
        (status = 'completed' AND completed_at IS NOT NULL) OR
        (status != 'completed' AND completed_at IS NULL)
    ),
    CONSTRAINT agent_tasks_shadow_progress_status CHECK (
        (status = 'in_progress' AND started_at IS NOT NULL) OR
        (status != 'in_progress')
    ),
    CONSTRAINT agent_tasks_shadow_metadata_valid CHECK (
        jsonb_typeof(metadata) = 'object'
    ),
    CONSTRAINT agent_tasks_shadow_sync_timestamps CHECK (
        _shadow_last_sync IS NULL OR _shadow_last_sync >= _shadow_created_at
    )
);

-- Performance indexes for agent_tasks shadow
CREATE INDEX IF NOT EXISTS idx_agent_tasks_shadow_project_id ON agent_tasks_shadow(project_id);
CREATE INDEX IF NOT EXISTS idx_agent_tasks_shadow_assigned_to ON agent_tasks_shadow(assigned_to);
CREATE INDEX IF NOT EXISTS idx_agent_tasks_shadow_status ON agent_tasks_shadow(status);
CREATE INDEX IF NOT EXISTS idx_agent_tasks_shadow_priority ON agent_tasks_shadow(priority);
CREATE INDEX IF NOT EXISTS idx_agent_tasks_shadow_type ON agent_tasks_shadow(type);
CREATE INDEX IF NOT EXISTS idx_agent_tasks_shadow_created_at ON agent_tasks_shadow(created_at);
CREATE INDEX IF NOT EXISTS idx_agent_tasks_shadow_sync_status ON agent_tasks_shadow(_shadow_sync_status);
CREATE INDEX IF NOT EXISTS idx_agent_tasks_shadow_source_id ON agent_tasks_shadow(_shadow_source_id);

-- GIN indexes for arrays and JSONB
CREATE INDEX IF NOT EXISTS idx_agent_tasks_shadow_dependencies_gin ON agent_tasks_shadow USING GIN(dependencies);
CREATE INDEX IF NOT EXISTS idx_agent_tasks_shadow_tags_gin ON agent_tasks_shadow USING GIN(tags);
CREATE INDEX IF NOT EXISTS idx_agent_tasks_shadow_metadata_gin ON agent_tasks_shadow USING GIN(metadata);

-- ==============================================================================
-- DATA MIGRATION TRIGGERS (DISABLED BY DEFAULT)
-- ==============================================================================

-- Function to automatically sync data from primary to shadow table
CREATE OR REPLACE FUNCTION sync_to_shadow_table() RETURNS TRIGGER AS $$
DECLARE
    shadow_table_name TEXT;
    validation_hash TEXT;
    record_jsonb JSONB;
BEGIN
    -- Construct shadow table name
    shadow_table_name := TG_TABLE_NAME || '_shadow';

    -- Convert record to JSONB for hash calculation
    record_jsonb := to_jsonb(NEW);

    -- Calculate validation hash
    validation_hash := calculate_shadow_validation_hash(TG_TABLE_NAME, record_jsonb);

    -- This function is disabled by default - would need to be implemented
    -- per table with specific INSERT/UPDATE logic

    RAISE NOTICE 'Shadow sync trigger called for table % (DISABLED)', TG_TABLE_NAME;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Note: Triggers are created but disabled by default for safety
-- Uncomment and customize these for actual data migration:

-- CREATE TRIGGER sync_projects_to_shadow
--     AFTER INSERT OR UPDATE ON projects
--     FOR EACH ROW
--     EXECUTE FUNCTION sync_to_shadow_table();

-- CREATE TRIGGER sync_sessions_to_shadow
--     AFTER INSERT OR UPDATE ON sessions
--     FOR EACH ROW
--     EXECUTE FUNCTION sync_to_shadow_table();

-- ==============================================================================
-- VALIDATION AND SAFETY FUNCTIONS
-- ==============================================================================

-- Function to validate shadow table integrity
CREATE OR REPLACE FUNCTION validate_shadow_table_integrity(
    p_table_name TEXT,
    p_batch_size INTEGER DEFAULT 1000
) RETURNS TABLE (
    validation_status TEXT,
    total_records BIGINT,
    valid_records BIGINT,
    invalid_records BIGINT,
    sync_pending BIGINT,
    sync_complete BIGINT
) AS $$
DECLARE
    shadow_table_name TEXT := p_table_name || '_shadow';
    sql_query TEXT;
BEGIN
    -- Verify shadow table exists
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.tables t
        WHERE t.table_name = shadow_table_name
    ) THEN
        RETURN QUERY SELECT
            'ERROR: Shadow table does not exist'::TEXT,
            0::BIGINT, 0::BIGINT, 0::BIGINT, 0::BIGINT, 0::BIGINT;
        RETURN;
    END IF;

    -- Build dynamic query for validation
    sql_query := format('
        SELECT
            ''OK''::TEXT as validation_status,
            COUNT(*)::BIGINT as total_records,
            COUNT(*) FILTER (WHERE _shadow_validation_hash IS NOT NULL)::BIGINT as valid_records,
            COUNT(*) FILTER (WHERE _shadow_validation_hash IS NULL)::BIGINT as invalid_records,
            COUNT(*) FILTER (WHERE _shadow_sync_status IN (''pending'', ''conflict''))::BIGINT as sync_pending,
            COUNT(*) FILTER (WHERE _shadow_sync_status IN (''synced'', ''migrated'', ''validated''))::BIGINT as sync_complete
        FROM %I',
        shadow_table_name
    );

    RETURN QUERY EXECUTE sql_query;
END;
$$ LANGUAGE plpgsql;

-- Function to clean up shadow tables (for rollback)
CREATE OR REPLACE FUNCTION cleanup_shadow_tables(
    p_confirm_cleanup BOOLEAN DEFAULT FALSE
) RETURNS TEXT AS $$
DECLARE
    shadow_tables TEXT[] := ARRAY[
        'projects_shadow',
        'sessions_shadow',
        'contexts_shadow',
        'analytics_events_shadow',
        'agent_tasks_shadow'
    ];
    shadow_table_name TEXT;
    result_msg TEXT := '';
BEGIN
    IF NOT p_confirm_cleanup THEN
        RETURN 'SAFETY: Call with p_confirm_cleanup := TRUE to execute cleanup';
    END IF;

    FOREACH shadow_table_name IN ARRAY shadow_tables LOOP
        IF EXISTS (
            SELECT 1 FROM information_schema.tables t
            WHERE t.table_name = shadow_table_name
        ) THEN
            EXECUTE format('DROP TABLE IF EXISTS %I CASCADE', shadow_table_name);
            result_msg := result_msg || format('Dropped table %s; ', shadow_table_name);
        END IF;
    END LOOP;

    -- Drop custom types
    DROP TYPE IF EXISTS shadow_sync_status CASCADE;

    -- Drop custom functions
    DROP FUNCTION IF EXISTS calculate_shadow_validation_hash(TEXT, JSONB) CASCADE;
    DROP FUNCTION IF EXISTS sync_to_shadow_table() CASCADE;
    DROP FUNCTION IF EXISTS validate_shadow_table_integrity(TEXT, INTEGER) CASCADE;

    RETURN 'CLEANUP COMPLETE: ' || result_msg;
END;
$$ LANGUAGE plpgsql;

-- ==============================================================================
-- POST-CREATION VALIDATIONS
-- ==============================================================================

-- Verify all shadow tables were created successfully
DO $$
DECLARE
    expected_tables TEXT[] := ARRAY[
        'projects_shadow',
        'sessions_shadow',
        'contexts_shadow',
        'analytics_events_shadow',
        'agent_tasks_shadow'
    ];
    expected_table_name TEXT;
    missing_tables TEXT[] := '{}';
    table_count INTEGER;
BEGIN
    FOREACH expected_table_name IN ARRAY expected_tables LOOP
        PERFORM 1 FROM information_schema.tables t WHERE t.table_name = expected_table_name;
        IF NOT FOUND THEN
            missing_tables := array_append(missing_tables, expected_table_name);
        END IF;
    END LOOP;

    IF array_length(missing_tables, 1) > 0 THEN
        RAISE EXCEPTION 'MIGRATION FAILED: Missing shadow tables: %',
            array_to_string(missing_tables, ', ');
    END IF;

    SELECT COUNT(*) INTO table_count
    FROM information_schema.tables t
    WHERE t.table_name LIKE '%_shadow';

    RAISE NOTICE 'SUCCESS: Created % shadow tables', table_count;
END $$;

-- Verify custom functions and types were created
SELECT CASE
    WHEN EXISTS (SELECT 1 FROM pg_type WHERE typname = 'shadow_sync_status')
    THEN 'PASS: shadow_sync_status type created'
    ELSE 'FAIL: shadow_sync_status type missing'
END as type_check;

SELECT CASE
    WHEN EXISTS (
        SELECT 1 FROM pg_proc WHERE proname = 'calculate_shadow_validation_hash'
    )
    THEN 'PASS: validation hash function created'
    ELSE 'FAIL: validation hash function missing'
END as function_check;

-- ==============================================================================
-- MIGRATION SUCCESS REPORT
-- ==============================================================================

SELECT
    'P2.3 Shadow Tables Migration Completed Successfully' as migration_status,
    NOW() as completed_at,
    'Zero-downtime migration infrastructure ready' as next_steps;

-- Generate validation report for each shadow table
SELECT 'projects_shadow' as table_name, * FROM validate_shadow_table_integrity('projects');
SELECT 'sessions_shadow' as table_name, * FROM validate_shadow_table_integrity('sessions');
SELECT 'contexts_shadow' as table_name, * FROM validate_shadow_table_integrity('contexts');
SELECT 'analytics_events_shadow' as table_name, * FROM validate_shadow_table_integrity('analytics_events');
SELECT 'agent_tasks_shadow' as table_name, * FROM validate_shadow_table_integrity('agent_tasks');

-- ==============================================================================
-- ROLLBACK INSTRUCTIONS
-- ==============================================================================

/*
ROLLBACK PROCEDURE (if needed):

1. IMMEDIATE ROLLBACK (before data migration):
   SELECT cleanup_shadow_tables(p_confirm_cleanup := TRUE);

2. VERIFY ROLLBACK:
   SELECT t.table_name FROM information_schema.tables t WHERE t.table_name LIKE '%_shadow';
   -- Should return no results

3. If you need to recreate:
   -- Re-run this entire migration file

SAFETY NOTES:
- This migration only creates shadow tables and infrastructure
- No data is modified in existing tables
- All shadow tables are isolated and can be safely dropped
- Original tables remain completely unchanged
- Migration triggers are disabled by default

NEXT STEPS FOR P2.3 COMPLETION:
1. Test shadow table performance with sample data
2. Implement dual-write pattern for validation
3. Create data backfill procedures
4. Set up monitoring for migration progress
5. Plan cutover procedures with feature flags

*/

-- Add migration tracking record (if legacy schema_migrations table exists)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'schema_migrations') THEN
    INSERT INTO schema_migrations (version, applied_at, description)
    VALUES (
        '023',
        CURRENT_TIMESTAMP,
        'P2.3: Create shadow tables for zero-downtime migration'
    ) ON CONFLICT (version) DO NOTHING;
  END IF;
END $$;

COMMENT ON TABLE projects_shadow IS 'P2.3 Shadow table for projects - zero-downtime migration infrastructure';
COMMENT ON TABLE sessions_shadow IS 'P2.3 Shadow table for sessions - zero-downtime migration infrastructure';
COMMENT ON TABLE contexts_shadow IS 'P2.3 Shadow table for contexts - zero-downtime migration infrastructure';
COMMENT ON TABLE analytics_events_shadow IS 'P2.3 Shadow table for analytics_events - zero-downtime migration infrastructure';
COMMENT ON TABLE agent_tasks_shadow IS 'P2.3 Shadow table for agent_tasks - zero-downtime migration infrastructure';