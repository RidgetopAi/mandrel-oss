-- =============================================
-- AIDIS Migration 022: Normalize Git Tracking Tables
-- =============================================
--
-- Phase 2.2: Git Table Normalization
--
-- CONTEXT:
-- - Previous analysis found ~20 missing columns across git tables
-- - Current database has 4,309 total records that must be preserved
-- - Database schema has evolved differently than migration 010 baseline
-- - Need to align current production schema with complete specification
--
-- OBJECTIVES:
-- 1. Add all missing columns with proper data types and constraints
-- 2. Preserve all existing data (zero data loss)
-- 3. Ensure idempotent operation using IF NOT EXISTS patterns
-- 4. Maintain performance with proper indexing
-- 5. Add validation and business logic constraints
--
-- SAFETY MEASURES:
-- - All operations use ADD COLUMN IF NOT EXISTS
-- - Default values provided for new columns
-- - Constraints added safely with existing data
-- - Rollback instructions included in comments
--
-- Author: AIDIS Phase 2.2 Refactoring Team
-- Date: 2025-09-17
-- Target: mandrel database

-- =============================================
-- PHASE 1: GIT_COMMITS TABLE NORMALIZATION
-- =============================================

-- Add missing columns to git_commits
-- These columns exist in migration 010 but are missing from current schema

-- Core git tracking columns
ALTER TABLE git_commits ADD COLUMN IF NOT EXISTS tree_sha VARCHAR(40);
ALTER TABLE git_commits ADD COLUMN IF NOT EXISTS repository_url TEXT;
ALTER TABLE git_commits ADD COLUMN IF NOT EXISTS merge_strategy VARCHAR(50);

-- AIDIS integration columns
ALTER TABLE git_commits ADD COLUMN IF NOT EXISTS discovered_by VARCHAR(100);
ALTER TABLE git_commits ADD COLUMN IF NOT EXISTS first_seen TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP;

-- Analysis tracking columns
ALTER TABLE git_commits ADD COLUMN IF NOT EXISTS is_analyzed BOOLEAN DEFAULT FALSE;
ALTER TABLE git_commits ADD COLUMN IF NOT EXISTS analysis_version INTEGER DEFAULT 1;

-- Add total_changes computed column if missing
-- Handle both existing computed column and new installation
DO $$
BEGIN
    -- Check if total_changes column exists
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'git_commits' AND column_name = 'total_changes'
    ) THEN
        -- Add as generated column
        ALTER TABLE git_commits ADD COLUMN total_changes INTEGER
            GENERATED ALWAYS AS (insertions + deletions) STORED;
    END IF;
END $$;

-- Add missing constraints for new columns
DO $$
BEGIN
    -- Add tree_sha format constraint if column exists and constraint doesn't
    IF EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_name = 'git_commits' AND column_name = 'tree_sha') THEN
        -- Check if constraint already exists
        IF NOT EXISTS (SELECT 1 FROM information_schema.check_constraints
                       WHERE constraint_name = 'git_commits_tree_sha_format') THEN
            ALTER TABLE git_commits ADD CONSTRAINT git_commits_tree_sha_format
                CHECK (tree_sha IS NULL OR tree_sha ~ '^[a-f0-9]{40}$');
        END IF;
    END IF;

    -- Add merge_strategy constraint
    IF EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_name = 'git_commits' AND column_name = 'merge_strategy') THEN
        IF NOT EXISTS (SELECT 1 FROM information_schema.check_constraints
                       WHERE constraint_name = 'git_commits_merge_strategy_values') THEN
            ALTER TABLE git_commits ADD CONSTRAINT git_commits_merge_strategy_values
                CHECK (merge_strategy IS NULL OR merge_strategy IN (
                    'recursive', 'ours', 'theirs', 'octopus', 'resolve', 'subtree'
                ));
        END IF;
    END IF;
END $$;

-- =============================================
-- PHASE 2: GIT_BRANCHES TABLE NORMALIZATION
-- =============================================

-- Add missing columns to git_branches
-- Note: current schema uses different column names than migration 010

-- Fix column name alignment (current: current_sha vs migration: current_commit_sha)
ALTER TABLE git_branches ADD COLUMN IF NOT EXISTS current_commit_sha VARCHAR(40);
-- Copy data from existing current_sha to new column if both exist
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'git_branches' AND column_name = 'current_sha')
       AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'git_branches' AND column_name = 'current_commit_sha') THEN
        UPDATE git_branches SET current_commit_sha = current_sha WHERE current_commit_sha IS NULL AND current_sha IS NOT NULL;
    END IF;
END $$;

-- Add missing metadata columns
ALTER TABLE git_branches ADD COLUMN IF NOT EXISTS full_ref_name VARCHAR(500);
ALTER TABLE git_branches ADD COLUMN IF NOT EXISTS is_default_branch BOOLEAN DEFAULT FALSE;
ALTER TABLE git_branches ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT TRUE;
ALTER TABLE git_branches ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP WITH TIME ZONE;

-- Fix column name alignment for is_default vs is_default_branch
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'git_branches' AND column_name = 'is_default')
       AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'git_branches' AND column_name = 'is_default_branch') THEN
        UPDATE git_branches SET is_default_branch = is_default WHERE is_default_branch IS FALSE AND is_default IS TRUE;
    END IF;
END $$;

-- Add branch statistics columns
ALTER TABLE git_branches ADD COLUMN IF NOT EXISTS commits_ahead INTEGER DEFAULT 0;
ALTER TABLE git_branches ADD COLUMN IF NOT EXISTS commits_behind INTEGER DEFAULT 0;
ALTER TABLE git_branches ADD COLUMN IF NOT EXISTS total_commits INTEGER DEFAULT 0;
ALTER TABLE git_branches ADD COLUMN IF NOT EXISTS unique_authors INTEGER DEFAULT 0;

-- Add missing relationship columns (some may already exist with different names)
-- session_id already exists, add associated_sessions array
ALTER TABLE git_branches ADD COLUMN IF NOT EXISTS associated_sessions UUID[] DEFAULT '{}';

-- Add branch tracking constraints
DO $$
BEGIN
    -- SHA format constraint for current_commit_sha if it doesn't exist for this column
    IF EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_name = 'git_branches' AND column_name = 'current_commit_sha') THEN
        IF NOT EXISTS (SELECT 1 FROM information_schema.check_constraints
                       WHERE constraint_name = 'git_branches_current_commit_sha_format') THEN
            ALTER TABLE git_branches ADD CONSTRAINT git_branches_current_commit_sha_format
                CHECK (current_commit_sha IS NULL OR current_commit_sha ~ '^[a-f0-9]{40}$');
        END IF;
    END IF;

    -- Statistics constraints
    IF NOT EXISTS (SELECT 1 FROM information_schema.check_constraints
                   WHERE constraint_name = 'git_branches_stats_positive') THEN
        ALTER TABLE git_branches ADD CONSTRAINT git_branches_stats_positive
            CHECK (commits_ahead >= 0 AND commits_behind >= 0 AND total_commits >= 0 AND unique_authors >= 0);
    END IF;

    -- Logical constraint for active/deleted branches
    IF NOT EXISTS (SELECT 1 FROM information_schema.check_constraints
                   WHERE constraint_name = 'git_branches_active_deleted_logic') THEN
        ALTER TABLE git_branches ADD CONSTRAINT git_branches_active_deleted_logic
            CHECK ((is_active = TRUE AND deleted_at IS NULL) OR (is_active = FALSE));
    END IF;
END $$;

-- =============================================
-- PHASE 3: GIT_FILE_CHANGES TABLE NORMALIZATION
-- =============================================

-- Add missing columns to git_file_changes

-- File metadata columns
ALTER TABLE git_file_changes ADD COLUMN IF NOT EXISTS file_type VARCHAR(50);
ALTER TABLE git_file_changes ADD COLUMN IF NOT EXISTS old_file_mode VARCHAR(10);
ALTER TABLE git_file_changes ADD COLUMN IF NOT EXISTS new_file_mode VARCHAR(10);

-- Code analysis integration
ALTER TABLE git_file_changes ADD COLUMN IF NOT EXISTS affects_exports BOOLEAN DEFAULT FALSE;
ALTER TABLE git_file_changes ADD COLUMN IF NOT EXISTS complexity_delta INTEGER DEFAULT 0;

-- Add computed column for total line changes
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'git_file_changes' AND column_name = 'lines_changed'
    ) THEN
        ALTER TABLE git_file_changes ADD COLUMN lines_changed INTEGER
            GENERATED ALWAYS AS (lines_added + lines_removed) STORED;
    END IF;
END $$;

-- Fix change_type constraint to include 'type_changed' (current has 'typechange')
DO $$
BEGIN
    -- Drop old constraint if it exists
    IF EXISTS (SELECT 1 FROM information_schema.check_constraints
               WHERE constraint_name = 'git_file_changes_change_type_check') THEN
        ALTER TABLE git_file_changes DROP CONSTRAINT git_file_changes_change_type_check;
    END IF;

    -- Add updated constraint
    ALTER TABLE git_file_changes ADD CONSTRAINT git_file_changes_change_type_check
        CHECK (change_type IN ('added', 'modified', 'deleted', 'renamed', 'copied', 'type_changed', 'typechange'));
END $$;

-- Add file analysis constraints
DO $$
BEGIN
    -- File mode format constraint
    IF NOT EXISTS (SELECT 1 FROM information_schema.check_constraints
                   WHERE constraint_name = 'git_file_changes_file_mode_format') THEN
        ALTER TABLE git_file_changes ADD CONSTRAINT git_file_changes_file_mode_format
            CHECK (
                (old_file_mode IS NULL OR old_file_mode ~ '^[0-7]{6}$') AND
                (new_file_mode IS NULL OR new_file_mode ~ '^[0-7]{6}$')
            );
    END IF;
END $$;

-- =============================================
-- PHASE 4: COMMIT_SESSION_LINKS TABLE NORMALIZATION
-- =============================================

-- Add missing columns to commit_session_links
-- Note: current schema has context_ids, migration 010 has relevant_context_ids

-- Add missing column with standard name
ALTER TABLE commit_session_links ADD COLUMN IF NOT EXISTS relevant_context_ids UUID[] DEFAULT '{}';

-- Copy data from existing context_ids to new column if both exist
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'commit_session_links' AND column_name = 'context_ids')
       AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'commit_session_links' AND column_name = 'relevant_context_ids') THEN
        UPDATE commit_session_links
        SET relevant_context_ids = context_ids
        WHERE relevant_context_ids = '{}' AND context_ids != '{}';
    END IF;
END $$;

-- Add missing tracking column
ALTER TABLE commit_session_links ADD COLUMN IF NOT EXISTS created_by VARCHAR(100);

-- Update link_type constraint to include migration 010 values
DO $$
BEGIN
    -- Drop existing constraint
    IF EXISTS (SELECT 1 FROM information_schema.check_constraints
               WHERE constraint_name = 'commit_session_links_link_type_check') THEN
        ALTER TABLE commit_session_links DROP CONSTRAINT commit_session_links_link_type_check;
    END IF;

    -- Add comprehensive constraint
    ALTER TABLE commit_session_links ADD CONSTRAINT commit_session_links_link_type_check
        CHECK (link_type IN (
            'contributed', 'reviewed', 'planned', 'discussed', 'debugged', 'tested',
            'mentioned', 'related'  -- Keep existing values
        ));
END $$;

-- =============================================
-- PHASE 5: ENHANCED INDEXING FOR NEW COLUMNS
-- =============================================

-- Indexes for new git_commits columns
CREATE INDEX IF NOT EXISTS idx_git_commits_tree_sha ON git_commits(tree_sha)
    WHERE tree_sha IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_git_commits_repository_url ON git_commits(repository_url)
    WHERE repository_url IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_git_commits_discovered_by ON git_commits(discovered_by)
    WHERE discovered_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_git_commits_first_seen ON git_commits(first_seen);
CREATE INDEX IF NOT EXISTS idx_git_commits_analysis_status ON git_commits(is_analyzed, analysis_version);

-- Indexes for new git_branches columns
CREATE INDEX IF NOT EXISTS idx_git_branches_current_commit_sha ON git_branches(current_commit_sha)
    WHERE current_commit_sha IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_git_branches_full_ref ON git_branches(full_ref_name)
    WHERE full_ref_name IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_git_branches_active_status ON git_branches(is_active, project_id);
CREATE INDEX IF NOT EXISTS idx_git_branches_default_branch ON git_branches(is_default_branch, project_id)
    WHERE is_default_branch = TRUE;
CREATE INDEX IF NOT EXISTS idx_git_branches_stats ON git_branches(total_commits DESC, commits_ahead DESC);
CREATE INDEX IF NOT EXISTS idx_git_branches_associated_sessions ON git_branches USING GIN(associated_sessions)
    WHERE associated_sessions != '{}';

-- Indexes for new git_file_changes columns
CREATE INDEX IF NOT EXISTS idx_git_file_changes_file_type ON git_file_changes(file_type, project_id)
    WHERE file_type IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_git_file_changes_affects_exports ON git_file_changes(affects_exports, project_id)
    WHERE affects_exports = TRUE;
CREATE INDEX IF NOT EXISTS idx_git_file_changes_complexity ON git_file_changes(complexity_delta)
    WHERE complexity_delta != 0;

-- Indexes for new commit_session_links columns
CREATE INDEX IF NOT EXISTS idx_commit_session_links_relevant_contexts ON commit_session_links USING GIN(relevant_context_ids)
    WHERE relevant_context_ids != '{}';
CREATE INDEX IF NOT EXISTS idx_commit_session_links_created_by ON commit_session_links(created_by)
    WHERE created_by IS NOT NULL;

-- =============================================
-- PHASE 6: DATA CONSISTENCY AND MIGRATION
-- =============================================

-- Update default values for existing records where appropriate

-- Set analysis defaults for existing commits
UPDATE git_commits
SET
    is_analyzed = FALSE,
    analysis_version = 1,
    first_seen = COALESCE(first_seen, created_at, CURRENT_TIMESTAMP)
WHERE is_analyzed IS NULL OR analysis_version IS NULL OR first_seen IS NULL;

-- Set branch defaults for existing branches
UPDATE git_branches
SET
    is_active = COALESCE(is_active, TRUE),
    is_default_branch = COALESCE(is_default_branch, FALSE),
    commits_ahead = COALESCE(commits_ahead, 0),
    commits_behind = COALESCE(commits_behind, 0),
    total_commits = COALESCE(total_commits, commit_count, 0),
    unique_authors = COALESCE(unique_authors, 0),
    associated_sessions = COALESCE(associated_sessions, '{}')
WHERE is_active IS NULL OR is_default_branch IS NULL OR commits_ahead IS NULL
   OR commits_behind IS NULL OR total_commits IS NULL OR unique_authors IS NULL
   OR associated_sessions IS NULL;

-- Set file change defaults
UPDATE git_file_changes
SET
    affects_exports = COALESCE(affects_exports, FALSE),
    complexity_delta = COALESCE(complexity_delta, 0)
WHERE affects_exports IS NULL OR complexity_delta IS NULL;

-- Set session link defaults
-- Note: context_ids column only exists in upgraded installs, not fresh installs
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_name = 'commit_session_links' AND column_name = 'context_ids') THEN
        -- Upgraded install: copy from old context_ids to new relevant_context_ids
        EXECUTE 'UPDATE commit_session_links
        SET
            relevant_context_ids = COALESCE(relevant_context_ids, context_ids, ''{}''),
            created_by = COALESCE(created_by, ''migration_022'')
        WHERE relevant_context_ids IS NULL OR created_by IS NULL';
    ELSE
        -- Fresh install: just set defaults
        UPDATE commit_session_links
        SET
            relevant_context_ids = COALESCE(relevant_context_ids, '{}'),
            created_by = COALESCE(created_by, 'migration_022')
        WHERE relevant_context_ids IS NULL OR created_by IS NULL;
    END IF;
END $$;

-- =============================================
-- PHASE 7: BUSINESS LOGIC TRIGGERS
-- =============================================

-- Create or replace validation trigger for git_commits
CREATE OR REPLACE FUNCTION validate_git_commits_normalized()
RETURNS TRIGGER AS $$
BEGIN
    -- Auto-generate tree_sha validation
    IF NEW.tree_sha IS NOT NULL AND NEW.tree_sha !~ '^[a-f0-9]{40}$' THEN
        RAISE EXCEPTION 'Invalid tree SHA format: %', NEW.tree_sha;
    END IF;

    -- Auto-set analysis defaults
    NEW.is_analyzed := COALESCE(NEW.is_analyzed, FALSE);
    NEW.analysis_version := COALESCE(NEW.analysis_version, 1);
    NEW.first_seen := COALESCE(NEW.first_seen, CURRENT_TIMESTAMP);

    -- Auto-detect repository URL from project if not set
    IF NEW.repository_url IS NULL THEN
        SELECT git_repo_url INTO NEW.repository_url
        FROM projects WHERE id = NEW.project_id;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Apply trigger if it doesn't exist
DROP TRIGGER IF EXISTS validate_git_commits_normalized_trigger ON git_commits;
CREATE TRIGGER validate_git_commits_normalized_trigger
    BEFORE INSERT OR UPDATE ON git_commits
    FOR EACH ROW
    EXECUTE FUNCTION validate_git_commits_normalized();

-- Create branch statistics update function
CREATE OR REPLACE FUNCTION update_git_branches_comprehensive()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'INSERT' OR TG_OP = 'UPDATE' THEN
        -- Update branch statistics when commits are added/updated
        UPDATE git_branches
        SET
            current_commit_sha = NEW.commit_sha,
            last_commit_date = GREATEST(COALESCE(last_commit_date, NEW.author_date), NEW.author_date),
            total_commits = total_commits + CASE WHEN TG_OP = 'INSERT' THEN 1 ELSE 0 END
        WHERE project_id = NEW.project_id
        AND branch_name = NEW.branch_name;

        -- Set first commit date if this is the first commit
        UPDATE git_branches
        SET first_commit_date = NEW.author_date
        WHERE project_id = NEW.project_id
        AND branch_name = NEW.branch_name
        AND (first_commit_date IS NULL OR first_commit_date > NEW.author_date);

        -- Update full_ref_name if not set
        UPDATE git_branches
        SET full_ref_name = 'refs/heads/' || branch_name
        WHERE project_id = NEW.project_id
        AND branch_name = NEW.branch_name
        AND full_ref_name IS NULL;
    END IF;

    RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

-- Apply trigger if it doesn't exist
DROP TRIGGER IF EXISTS update_git_branches_comprehensive_trigger ON git_commits;
CREATE TRIGGER update_git_branches_comprehensive_trigger
    AFTER INSERT OR UPDATE ON git_commits
    FOR EACH ROW
    EXECUTE FUNCTION update_git_branches_comprehensive();

-- =============================================
-- PHASE 8: VALIDATION AND SUMMARY
-- =============================================

-- Verify all expected columns exist
-- Note: using v_ prefix for variables to avoid ambiguity with information_schema columns
DO $$
DECLARE
    missing_columns TEXT[];
    v_table_name TEXT;
    v_column_name TEXT;
    expected_columns TEXT[][2] := ARRAY[
        ARRAY['git_commits', 'tree_sha'],
        ARRAY['git_commits', 'repository_url'],
        ARRAY['git_commits', 'merge_strategy'],
        ARRAY['git_commits', 'discovered_by'],
        ARRAY['git_commits', 'first_seen'],
        ARRAY['git_commits', 'is_analyzed'],
        ARRAY['git_commits', 'analysis_version'],
        ARRAY['git_branches', 'current_commit_sha'],
        ARRAY['git_branches', 'full_ref_name'],
        ARRAY['git_branches', 'is_default_branch'],
        ARRAY['git_branches', 'is_active'],
        ARRAY['git_branches', 'deleted_at'],
        ARRAY['git_branches', 'commits_ahead'],
        ARRAY['git_branches', 'commits_behind'],
        ARRAY['git_branches', 'total_commits'],
        ARRAY['git_branches', 'unique_authors'],
        ARRAY['git_branches', 'associated_sessions'],
        ARRAY['git_file_changes', 'file_type'],
        ARRAY['git_file_changes', 'old_file_mode'],
        ARRAY['git_file_changes', 'new_file_mode'],
        ARRAY['git_file_changes', 'affects_exports'],
        ARRAY['git_file_changes', 'complexity_delta'],
        ARRAY['commit_session_links', 'relevant_context_ids'],
        ARRAY['commit_session_links', 'created_by']
    ];
BEGIN
    missing_columns := ARRAY[]::TEXT[];

    FOR i IN 1..array_length(expected_columns, 1) LOOP
        v_table_name := expected_columns[i][1];
        v_column_name := expected_columns[i][2];

        IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns c
            WHERE c.table_name = v_table_name AND c.column_name = v_column_name
        ) THEN
            missing_columns := missing_columns || (v_table_name || '.' || v_column_name);
        END IF;
    END LOOP;

    IF array_length(missing_columns, 1) > 0 THEN
        RAISE EXCEPTION 'Migration 037 failed - missing columns: %', array_to_string(missing_columns, ', ');
    ELSE
        RAISE NOTICE 'Migration 037 validation passed - all expected columns present';
    END IF;
END $$;

-- Report current table sizes to confirm data preservation
SELECT
    'Data preservation verification' as status,
    (SELECT COUNT(*) FROM git_commits) as git_commits_count,
    (SELECT COUNT(*) FROM git_branches) as git_branches_count,
    (SELECT COUNT(*) FROM git_file_changes) as git_file_changes_count,
    (SELECT COUNT(*) FROM commit_session_links) as commit_session_links_count;

-- Report new column statistics
SELECT
    'New columns initialized' as status,
    (SELECT COUNT(*) FROM git_commits WHERE tree_sha IS NOT NULL) as commits_with_tree_sha,
    (SELECT COUNT(*) FROM git_commits WHERE is_analyzed = FALSE) as commits_pending_analysis,
    (SELECT COUNT(*) FROM git_branches WHERE is_active = TRUE) as active_branches,
    (SELECT COUNT(*) FROM git_file_changes WHERE affects_exports = TRUE) as files_affecting_exports;

-- Final success confirmation
SELECT 'Migration 022 completed successfully - Git tracking tables normalized' as final_status;

-- =============================================
-- ROLLBACK INSTRUCTIONS (EMERGENCY USE ONLY)
-- =============================================
/*
-- To rollback this migration (use with extreme caution):

-- Remove added columns (this will lose data in these columns):
ALTER TABLE git_commits DROP COLUMN IF EXISTS tree_sha;
ALTER TABLE git_commits DROP COLUMN IF EXISTS repository_url;
ALTER TABLE git_commits DROP COLUMN IF EXISTS merge_strategy;
ALTER TABLE git_commits DROP COLUMN IF EXISTS discovered_by;
ALTER TABLE git_commits DROP COLUMN IF EXISTS first_seen;
ALTER TABLE git_commits DROP COLUMN IF EXISTS is_analyzed;
ALTER TABLE git_commits DROP COLUMN IF EXISTS analysis_version;
ALTER TABLE git_commits DROP COLUMN IF EXISTS total_changes;

ALTER TABLE git_branches DROP COLUMN IF EXISTS current_commit_sha;
ALTER TABLE git_branches DROP COLUMN IF EXISTS full_ref_name;
ALTER TABLE git_branches DROP COLUMN IF EXISTS is_default_branch;
ALTER TABLE git_branches DROP COLUMN IF EXISTS is_active;
ALTER TABLE git_branches DROP COLUMN IF EXISTS deleted_at;
ALTER TABLE git_branches DROP COLUMN IF EXISTS commits_ahead;
ALTER TABLE git_branches DROP COLUMN IF EXISTS commits_behind;
ALTER TABLE git_branches DROP COLUMN IF EXISTS total_commits;
ALTER TABLE git_branches DROP COLUMN IF EXISTS unique_authors;
ALTER TABLE git_branches DROP COLUMN IF EXISTS associated_sessions;

ALTER TABLE git_file_changes DROP COLUMN IF EXISTS file_type;
ALTER TABLE git_file_changes DROP COLUMN IF EXISTS old_file_mode;
ALTER TABLE git_file_changes DROP COLUMN IF EXISTS new_file_mode;
ALTER TABLE git_file_changes DROP COLUMN IF EXISTS affects_exports;
ALTER TABLE git_file_changes DROP COLUMN IF EXISTS complexity_delta;
ALTER TABLE git_file_changes DROP COLUMN IF EXISTS lines_changed;

ALTER TABLE commit_session_links DROP COLUMN IF EXISTS relevant_context_ids;
ALTER TABLE commit_session_links DROP COLUMN IF EXISTS created_by;

-- Remove added triggers:
DROP TRIGGER IF EXISTS validate_git_commits_normalized_trigger ON git_commits;
DROP TRIGGER IF EXISTS update_git_branches_comprehensive_trigger ON git_commits;
DROP FUNCTION IF EXISTS validate_git_commits_normalized();
DROP FUNCTION IF EXISTS update_git_branches_comprehensive();

-- Remove added indexes (they will be recreated by other migrations if needed):
-- [List of DROP INDEX commands for all created indexes]
*/