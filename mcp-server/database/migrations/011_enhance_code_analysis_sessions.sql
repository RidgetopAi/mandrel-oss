-- AIDIS Migration 011: Enhance Code Analysis Sessions for TC005
--
-- Transform code_analysis_sessions into a powerful tracking system linking:
-- - Code analysis activities to development sessions
-- - Code analysis to git commits and working state
-- - Analysis performance metrics and optimization data
-- - Trigger metadata and analysis context
--
-- This enables:
-- 1. Session-aware code analysis tracking
-- 2. Git commit correlation with analysis activities  
-- 3. Performance monitoring and optimization
-- 4. Analysis trigger pattern recognition
-- 5. Development workflow insights
--
-- Author: AIDIS Team - TC005 Implementation
-- Date: 2025-09-10

-- =============================================
-- ENHANCE CODE_ANALYSIS_SESSIONS TABLE
-- =============================================

-- First, check current state and add new columns
-- Since table has 0 records, we can safely alter structure

-- Add git integration columns
ALTER TABLE code_analysis_sessions 
ADD COLUMN IF NOT EXISTS commit_sha VARCHAR(40),
ADD COLUMN IF NOT EXISTS branch_name VARCHAR(255),
ADD COLUMN IF NOT EXISTS working_directory TEXT,
ADD COLUMN IF NOT EXISTS git_status_clean BOOLEAN DEFAULT NULL;

-- Add session correlation columns  
ALTER TABLE code_analysis_sessions
ADD COLUMN IF NOT EXISTS development_session_id UUID REFERENCES sessions(id) ON DELETE SET NULL,
ADD COLUMN IF NOT EXISTS session_correlation_confidence FLOAT DEFAULT 0.0 CHECK (session_correlation_confidence >= 0 AND session_correlation_confidence <= 1),
ADD COLUMN IF NOT EXISTS analysis_context TEXT; -- What prompted this analysis

-- Add performance and optimization metrics
ALTER TABLE code_analysis_sessions
ADD COLUMN IF NOT EXISTS files_changed_count INTEGER DEFAULT 0,
ADD COLUMN IF NOT EXISTS new_components_count INTEGER DEFAULT 0,
ADD COLUMN IF NOT EXISTS updated_components_count INTEGER DEFAULT 0,
ADD COLUMN IF NOT EXISTS deleted_components_count INTEGER DEFAULT 0,
ADD COLUMN IF NOT EXISTS cache_hit_rate FLOAT DEFAULT 0.0,
ADD COLUMN IF NOT EXISTS parse_duration_ms INTEGER DEFAULT 0,
ADD COLUMN IF NOT EXISTS database_duration_ms INTEGER DEFAULT 0;

-- Add trigger metadata
ALTER TABLE code_analysis_sessions
ADD COLUMN IF NOT EXISTS trigger_type VARCHAR(100) DEFAULT 'manual' CHECK (trigger_type IN (
    'manual', 'commit_hook', 'file_watch', 'scheduled', 'session_start', 
    'request_analysis', 'git_status_change', 'branch_switch'
)),
ADD COLUMN IF NOT EXISTS triggered_by_agent UUID REFERENCES agents(id) ON DELETE SET NULL,
ADD COLUMN IF NOT EXISTS auto_triggered BOOLEAN DEFAULT FALSE,
ADD COLUMN IF NOT EXISTS trigger_metadata JSONB DEFAULT '{}'::jsonb;

-- Add analysis scope and context
ALTER TABLE code_analysis_sessions
ADD COLUMN IF NOT EXISTS analysis_scope VARCHAR(100) DEFAULT 'full' CHECK (analysis_scope IN (
    'full', 'incremental', 'targeted', 'file_specific', 'commit_diff', 'branch_diff'
)),
ADD COLUMN IF NOT EXISTS target_files TEXT[] DEFAULT '{}',
ADD COLUMN IF NOT EXISTS excluded_patterns TEXT[] DEFAULT '{}',
ADD COLUMN IF NOT EXISTS language_filter VARCHAR(50);

-- Add result metrics
ALTER TABLE code_analysis_sessions
ADD COLUMN IF NOT EXISTS total_complexity_delta INTEGER DEFAULT 0,
ADD COLUMN IF NOT EXISTS total_loc_delta INTEGER DEFAULT 0,
ADD COLUMN IF NOT EXISTS dependency_changes_count INTEGER DEFAULT 0,
ADD COLUMN IF NOT EXISTS quality_score FLOAT;

-- Add analysis versioning and compatibility
ALTER TABLE code_analysis_sessions
ADD COLUMN IF NOT EXISTS analyzer_version VARCHAR(50) DEFAULT '1.0.0',
ADD COLUMN IF NOT EXISTS schema_version INTEGER DEFAULT 1,
ADD COLUMN IF NOT EXISTS compatibility_flags JSONB DEFAULT '{}'::jsonb;

-- Update metadata to be more structured (keeping existing default)
ALTER TABLE code_analysis_sessions 
ALTER COLUMN metadata SET DEFAULT '{
    "performance": {},
    "triggers": {},
    "analysis_config": {},
    "git_context": {},
    "session_context": {}
}'::jsonb;

-- =============================================
-- ADD FOREIGN KEY TO GIT COMMITS
-- =============================================

-- Add foreign key constraint to git_commits if it exists
-- Use conditional approach since git_commits might not exist in all environments
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'git_commits') THEN
        -- Check if constraint already exists before adding
        IF NOT EXISTS (
            SELECT 1 FROM information_schema.table_constraints
            WHERE constraint_name = 'fk_code_analysis_sessions_commit'
            AND table_name = 'code_analysis_sessions'
        ) THEN
            -- Add foreign key to git_commits
            ALTER TABLE code_analysis_sessions
            ADD CONSTRAINT fk_code_analysis_sessions_commit
            FOREIGN KEY (project_id, commit_sha)
            REFERENCES git_commits(project_id, commit_sha)
            ON DELETE SET NULL;

            RAISE NOTICE 'Added foreign key constraint to git_commits table';
        ELSE
            RAISE NOTICE 'Foreign key constraint already exists - skipping';
        END IF;
    ELSE
        RAISE NOTICE 'git_commits table not found - skipping foreign key constraint';
    END IF;
END $$;

-- =============================================
-- CREATE NEW INDEXES FOR PERFORMANCE
-- =============================================

-- Git integration indexes
CREATE INDEX IF NOT EXISTS idx_code_analysis_sessions_commit_sha 
ON code_analysis_sessions(commit_sha) WHERE commit_sha IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_code_analysis_sessions_branch 
ON code_analysis_sessions(branch_name) WHERE branch_name IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_code_analysis_sessions_git_clean 
ON code_analysis_sessions(git_status_clean) WHERE git_status_clean IS NOT NULL;

-- Session correlation indexes
CREATE INDEX IF NOT EXISTS idx_code_analysis_sessions_dev_session 
ON code_analysis_sessions(development_session_id) WHERE development_session_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_code_analysis_sessions_correlation 
ON code_analysis_sessions(session_correlation_confidence DESC) 
WHERE session_correlation_confidence > 0;

-- Performance tracking indexes
CREATE INDEX IF NOT EXISTS idx_code_analysis_sessions_performance 
ON code_analysis_sessions(analysis_duration_ms DESC, files_analyzed) 
WHERE analysis_duration_ms IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_code_analysis_sessions_cache_rate 
ON code_analysis_sessions(cache_hit_rate DESC) WHERE cache_hit_rate IS NOT NULL;

-- Trigger analysis indexes
CREATE INDEX IF NOT EXISTS idx_code_analysis_sessions_trigger 
ON code_analysis_sessions(trigger_type, auto_triggered);

CREATE INDEX IF NOT EXISTS idx_code_analysis_sessions_triggered_by 
ON code_analysis_sessions(triggered_by_agent) WHERE triggered_by_agent IS NOT NULL;

-- Analysis scope and results
CREATE INDEX IF NOT EXISTS idx_code_analysis_sessions_scope 
ON code_analysis_sessions(analysis_scope, project_id);

CREATE INDEX IF NOT EXISTS idx_code_analysis_sessions_quality 
ON code_analysis_sessions(quality_score DESC) WHERE quality_score IS NOT NULL;

-- Composite indexes for common queries
CREATE INDEX IF NOT EXISTS idx_code_analysis_sessions_project_session 
ON code_analysis_sessions(project_id, development_session_id, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_code_analysis_sessions_project_commit 
ON code_analysis_sessions(project_id, commit_sha, started_at DESC) 
WHERE commit_sha IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_code_analysis_sessions_recent_activity 
ON code_analysis_sessions(project_id, started_at DESC, status);

-- =============================================
-- GIN INDEXES FOR ARRAY AND JSONB COLUMNS  
-- =============================================

-- Arrays for files and patterns
CREATE INDEX IF NOT EXISTS idx_code_analysis_sessions_target_files 
ON code_analysis_sessions USING GIN(target_files) WHERE target_files != '{}';

CREATE INDEX IF NOT EXISTS idx_code_analysis_sessions_excluded 
ON code_analysis_sessions USING GIN(excluded_patterns) WHERE excluded_patterns != '{}';

-- JSONB indexes for metadata search
CREATE INDEX IF NOT EXISTS idx_code_analysis_sessions_trigger_metadata 
ON code_analysis_sessions USING GIN(trigger_metadata);

CREATE INDEX IF NOT EXISTS idx_code_analysis_sessions_compatibility 
ON code_analysis_sessions USING GIN(compatibility_flags);

-- Enhanced metadata index (update existing)
DROP INDEX IF EXISTS idx_code_analysis_sessions_metadata;
CREATE INDEX idx_code_analysis_sessions_metadata 
ON code_analysis_sessions USING GIN(metadata);

-- =============================================
-- ADD UPDATE TRIGGER
-- =============================================

-- Ensure updated_at column exists and add trigger
-- First add updated_at if it doesn't exist
ALTER TABLE code_analysis_sessions 
ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP;

-- Add update trigger for updated_at
DROP TRIGGER IF EXISTS update_code_analysis_sessions_updated_at ON code_analysis_sessions;
CREATE TRIGGER update_code_analysis_sessions_updated_at
    BEFORE UPDATE ON code_analysis_sessions
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- =============================================
-- VALIDATION AND HELPER FUNCTIONS
-- =============================================

-- Function to validate analysis session data
CREATE OR REPLACE FUNCTION validate_code_analysis_session()
RETURNS TRIGGER AS $$
BEGIN
    -- Validate correlation confidence
    IF NEW.session_correlation_confidence IS NOT NULL AND 
       (NEW.session_correlation_confidence < 0 OR NEW.session_correlation_confidence > 1) THEN
        RAISE EXCEPTION 'session_correlation_confidence must be between 0 and 1';
    END IF;
    
    -- Validate performance metrics
    IF NEW.cache_hit_rate IS NOT NULL AND 
       (NEW.cache_hit_rate < 0 OR NEW.cache_hit_rate > 1) THEN
        RAISE EXCEPTION 'cache_hit_rate must be between 0 and 1';
    END IF;
    
    -- Auto-set session correlation if development_session_id is provided
    IF NEW.development_session_id IS NOT NULL AND NEW.session_correlation_confidence = 0 THEN
        NEW.session_correlation_confidence := 0.9; -- High confidence for explicit linking
    END IF;
    
    -- Auto-detect trigger context
    IF NEW.trigger_type = 'manual' AND NEW.development_session_id IS NOT NULL THEN
        NEW.trigger_type := 'session_start';
        NEW.auto_triggered := FALSE;
    END IF;
    
    -- Calculate total analysis duration if components are provided
    IF NEW.parse_duration_ms > 0 AND NEW.database_duration_ms > 0 THEN
        NEW.analysis_duration_ms := NEW.parse_duration_ms + NEW.database_duration_ms;
    END IF;
    
    -- Set git status clean flag based on working directory
    IF NEW.working_directory IS NOT NULL AND NEW.git_status_clean IS NULL THEN
        -- This would be set by the analysis service based on actual git status
        NEW.git_status_clean := FALSE; -- Conservative default
    END IF;
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Apply validation trigger
DROP TRIGGER IF EXISTS validate_code_analysis_session_data ON code_analysis_sessions;
CREATE TRIGGER validate_code_analysis_session_data
    BEFORE INSERT OR UPDATE ON code_analysis_sessions
    FOR EACH ROW
    EXECUTE FUNCTION validate_code_analysis_session();

-- =============================================
-- ANALYSIS METRICS AND AGGREGATION FUNCTIONS
-- =============================================

-- Function to calculate session analysis summary
DROP FUNCTION IF EXISTS get_session_analysis_summary(UUID);
CREATE OR REPLACE FUNCTION get_session_analysis_summary(session_uuid UUID)
RETURNS TABLE (
    total_analyses INTEGER,
    avg_duration_ms FLOAT,
    total_files_analyzed INTEGER,
    total_components_found INTEGER,
    avg_cache_hit_rate FLOAT,
    most_common_trigger VARCHAR(100),
    quality_trend FLOAT
) AS $$
BEGIN
    RETURN QUERY
    SELECT 
        COUNT(*)::INTEGER as total_analyses,
        AVG(cas.analysis_duration_ms)::FLOAT as avg_duration_ms,
        SUM(array_length(cas.files_analyzed, 1))::INTEGER as total_files_analyzed,
        SUM(cas.components_found)::INTEGER as total_components_found,
        AVG(cas.cache_hit_rate)::FLOAT as avg_cache_hit_rate,
        MODE() WITHIN GROUP (ORDER BY cas.trigger_type) as most_common_trigger,
        CASE 
            WHEN COUNT(*) > 1 THEN 
                (LAST_VALUE(cas.quality_score) OVER (ORDER BY cas.started_at ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING) - 
                 FIRST_VALUE(cas.quality_score) OVER (ORDER BY cas.started_at ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING))
            ELSE NULL 
        END as quality_trend
    FROM code_analysis_sessions cas
    WHERE cas.development_session_id = session_uuid
    AND cas.status = 'completed';
END;
$$ LANGUAGE plpgsql;

-- Function to get project analysis insights
DROP FUNCTION IF EXISTS get_project_analysis_insights(UUID, INTEGER);
CREATE OR REPLACE FUNCTION get_project_analysis_insights(proj_id UUID, days_back INTEGER DEFAULT 30)
RETURNS TABLE (
    total_sessions INTEGER,
    avg_session_duration_ms FLOAT,
    most_active_branch VARCHAR(255),
    top_trigger_type VARCHAR(100),
    performance_trend FLOAT,
    files_per_session FLOAT
) AS $$
BEGIN
    RETURN QUERY
    SELECT 
        COUNT(*)::INTEGER as total_sessions,
        AVG(cas.analysis_duration_ms)::FLOAT as avg_session_duration_ms,
        MODE() WITHIN GROUP (ORDER BY cas.branch_name) as most_active_branch,
        MODE() WITHIN GROUP (ORDER BY cas.trigger_type) as top_trigger_type,
        CASE 
            WHEN COUNT(*) > 1 THEN
                -- Calculate performance trend (positive = getting faster)
                (FIRST_VALUE(cas.analysis_duration_ms) OVER (ORDER BY cas.started_at DESC ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING) -
                 LAST_VALUE(cas.analysis_duration_ms) OVER (ORDER BY cas.started_at DESC ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING)) * -1.0
            ELSE 0.0
        END as performance_trend,
        AVG(array_length(cas.files_analyzed, 1))::FLOAT as files_per_session
    FROM code_analysis_sessions cas
    WHERE cas.project_id = proj_id
    AND cas.started_at >= CURRENT_TIMESTAMP - INTERVAL '1 day' * days_back
    AND cas.status = 'completed';
END;
$$ LANGUAGE plpgsql;

-- =============================================
-- CREATE ANALYSIS SESSION LINKS TABLE
-- =============================================

-- Table to link analysis sessions with specific development contexts
CREATE TABLE IF NOT EXISTS analysis_session_links (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    analysis_session_id UUID NOT NULL REFERENCES code_analysis_sessions(id) ON DELETE CASCADE,
    
    -- Link targets
    development_session_id UUID REFERENCES sessions(id) ON DELETE CASCADE,
    context_id UUID REFERENCES contexts(id) ON DELETE SET NULL,
    decision_id UUID REFERENCES technical_decisions(id) ON DELETE SET NULL,
    
    -- Link metadata
    link_type VARCHAR(50) DEFAULT 'analysis' CHECK (link_type IN (
        'analysis', 'validation', 'impact_assessment', 'quality_check', 
        'pre_commit', 'post_commit', 'debugging', 'refactoring'
    )),
    confidence_score FLOAT DEFAULT 1.0 CHECK (confidence_score >= 0 AND confidence_score <= 1),
    
    -- Correlation evidence
    time_correlation_score FLOAT DEFAULT 0.0, -- How close in time
    content_correlation_score FLOAT DEFAULT 0.0, -- Semantic similarity
    git_correlation_score FLOAT DEFAULT 0.0, -- Git state correlation
    
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    created_by VARCHAR(100),
    metadata JSONB DEFAULT '{}'::jsonb,
    
    UNIQUE(analysis_session_id, development_session_id, link_type)
);

-- Indexes for analysis session links
CREATE INDEX IF NOT EXISTS idx_analysis_session_links_project 
ON analysis_session_links(project_id);

CREATE INDEX IF NOT EXISTS idx_analysis_session_links_analysis 
ON analysis_session_links(analysis_session_id);

CREATE INDEX IF NOT EXISTS idx_analysis_session_links_development 
ON analysis_session_links(development_session_id) WHERE development_session_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_analysis_session_links_context 
ON analysis_session_links(context_id) WHERE context_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_analysis_session_links_type 
ON analysis_session_links(link_type, confidence_score DESC);

-- =============================================
-- UPDATE EXISTING RELATED TABLES
-- =============================================

-- Add analysis session tracking to code_components
ALTER TABLE code_components
ADD COLUMN IF NOT EXISTS last_analysis_session_id UUID REFERENCES code_analysis_sessions(id) ON DELETE SET NULL,
ADD COLUMN IF NOT EXISTS analysis_frequency INTEGER DEFAULT 0;

-- Add analysis session tracking to code_metrics
ALTER TABLE code_metrics
ADD COLUMN IF NOT EXISTS analysis_session_id UUID REFERENCES code_analysis_sessions(id) ON DELETE CASCADE;

-- Create index for new columns
CREATE INDEX IF NOT EXISTS idx_code_components_last_analysis 
ON code_components(last_analysis_session_id) WHERE last_analysis_session_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_code_metrics_analysis_session 
ON code_metrics(analysis_session_id) WHERE analysis_session_id IS NOT NULL;

-- =============================================
-- EXAMPLE DATA AND TESTING HELPERS
-- =============================================

-- Function to create a sample analysis session for testing
DROP FUNCTION IF EXISTS create_sample_analysis_session(UUID, UUID, VARCHAR(40));
CREATE OR REPLACE FUNCTION create_sample_analysis_session(
    proj_id UUID,
    session_id UUID DEFAULT NULL,
    commit_hash VARCHAR(40) DEFAULT NULL
)
RETURNS UUID AS $$
DECLARE
    new_analysis_id UUID;
    sample_files TEXT[];
BEGIN
    -- Create sample file list
    sample_files := ARRAY['src/server.ts', 'src/handlers/codeAnalysis.ts', 'src/config/database.ts'];
    
    INSERT INTO code_analysis_sessions (
        project_id,
        development_session_id,
        commit_sha,
        branch_name,
        session_type,
        analysis_scope,
        files_analyzed,
        target_files,
        components_found,
        dependencies_found,
        analysis_duration_ms,
        parse_duration_ms,
        database_duration_ms,
        cache_hit_rate,
        trigger_type,
        auto_triggered,
        session_correlation_confidence,
        analysis_context,
        quality_score,
        status,
        analyzer_version,
        metadata
    ) VALUES (
        proj_id,
        session_id,
        commit_hash,
        'main',
        'incremental',
        'targeted', 
        sample_files,
        sample_files,
        12,
        8,
        2500,
        2000,
        500,
        0.75,
        CASE WHEN session_id IS NOT NULL THEN 'session_start' ELSE 'manual' END,
        session_id IS NOT NULL,
        CASE WHEN session_id IS NOT NULL THEN 0.9 ELSE 0.0 END,
        'Sample analysis session for TC005 testing',
        85.5,
        'completed',
        '1.1.0',
        '{
            "performance": {"cache_hits": 6, "cache_misses": 2},
            "git_context": {"clean_working_dir": true, "staged_files": 0},
            "session_context": {"active_development": true},
            "analysis_config": {"language_filter": "typescript", "complexity_threshold": 10}
        }'::jsonb
    ) RETURNING id INTO new_analysis_id;
    
    RAISE NOTICE 'Created sample analysis session: %', new_analysis_id;
    RETURN new_analysis_id;
END;
$$ LANGUAGE plpgsql;

-- =============================================
-- VERIFICATION AND SUMMARY
-- =============================================

-- Verify migration success
SELECT 'Migration 011 completed successfully - Code analysis sessions enhanced for TC005' as status;

-- Show row counts
SELECT
    'code_analysis_sessions' as table_name, COUNT(*) as row_count
FROM code_analysis_sessions
UNION ALL
SELECT
    'analysis_session_links' as table_name, COUNT(*) as row_count
FROM analysis_session_links;

-- Test the helper functions exist
SELECT 'Helper functions created successfully' as function_status
WHERE EXISTS (
    SELECT 1 FROM information_schema.routines
    WHERE routine_name IN ('get_session_analysis_summary', 'get_project_analysis_insights', 'create_sample_analysis_session')
);

-- Show new indexes created
SELECT
    schemaname, tablename, indexname
FROM pg_indexes
WHERE tablename IN ('code_analysis_sessions', 'analysis_session_links', 'code_components', 'code_metrics')
AND indexname LIKE '%analysis%'
ORDER BY tablename, indexname;