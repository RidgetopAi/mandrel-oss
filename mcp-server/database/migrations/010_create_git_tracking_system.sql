-- AIDIS Migration 010: Create Git Commit Tracking System
--
-- This creates comprehensive git commit tracking integrated with AIDIS:
-- - git_commits: Core commit tracking with full metadata
-- - git_branches: Branch lifecycle tracking
-- - git_file_changes: File-level change tracking per commit
-- - commit_session_links: Link commits to AIDIS sessions
-- - Integration columns in existing tables
--
-- This enables:
-- 1. Session-to-commit correlation for development context
-- 2. Multi-project git repository tracking
-- 3. Code change impact analysis
-- 4. Development timeline reconstruction
-- 5. AI agent commit attribution
--
-- Author: AIDIS Team - TC002 Implementation
-- Date: 2025-09-10

-- =============================================
-- GIT COMMITS TABLE - Core commit tracking
-- =============================================

CREATE TABLE IF NOT EXISTS git_commits (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    
    -- Git core identifiers
    commit_sha VARCHAR(40) NOT NULL, -- Full 40-char SHA-1 hash
    short_sha VARCHAR(12) NOT NULL, -- 12-char abbreviated hash
    tree_sha VARCHAR(40), -- Tree object SHA
    parent_shas VARCHAR(40)[] DEFAULT '{}', -- Array of parent commit SHAs (for merges)
    
    -- Commit metadata
    message TEXT NOT NULL,
    author_name VARCHAR(255) NOT NULL,
    author_email VARCHAR(255) NOT NULL,
    author_date TIMESTAMP WITH TIME ZONE NOT NULL,
    committer_name VARCHAR(255) NOT NULL,
    committer_email VARCHAR(255) NOT NULL,
    committer_date TIMESTAMP WITH TIME ZONE NOT NULL,
    
    -- Repository context
    repository_url TEXT, -- Can differ from project.git_repo_url for forks/mirrors
    branch_name VARCHAR(255), -- Branch where commit was first observed
    is_merge_commit BOOLEAN DEFAULT FALSE,
    merge_strategy VARCHAR(50), -- recursive, ours, theirs, etc.
    
    -- Change statistics
    files_changed INTEGER DEFAULT 0,
    insertions INTEGER DEFAULT 0,
    deletions INTEGER DEFAULT 0,
    total_changes INTEGER GENERATED ALWAYS AS (insertions + deletions) STORED,
    
    -- AIDIS integration
    discovered_by VARCHAR(100), -- Which system/agent discovered this commit
    first_seen TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    
    -- Analysis flags
    is_analyzed BOOLEAN DEFAULT FALSE, -- Has been processed by code analysis
    analysis_version INTEGER DEFAULT 1, -- Version of analysis schema used
    
    -- Commit classification
    commit_type VARCHAR(50) DEFAULT 'unknown' CHECK (commit_type IN (
        'unknown', 'feature', 'bugfix', 'refactor', 'test', 'docs', 
        'style', 'chore', 'merge', 'revert', 'hotfix', 'breaking'
    )),
    tags TEXT[] DEFAULT '{}', -- Semantic tags like ['frontend', 'api', 'urgent']
    
    -- Lifecycle tracking
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    
    -- Business constraints
    CONSTRAINT valid_sha_format CHECK (
        commit_sha ~ '^[a-f0-9]{40}$' AND 
        short_sha ~ '^[a-f0-9]{7,12}$'
    ),
    CONSTRAINT valid_dates CHECK (committer_date >= author_date),
    CONSTRAINT non_empty_message CHECK (length(trim(message)) > 0),
    CONSTRAINT valid_email_format CHECK (
        author_email ~ '^[^@]+@[^@]+\.[^@]+$' AND
        committer_email ~ '^[^@]+@[^@]+\.[^@]+$'
    ),
    
    -- Ensure uniqueness per project
    UNIQUE(project_id, commit_sha)
);

-- Add missing columns if table already exists (for partial migrations)
ALTER TABLE git_commits ADD COLUMN IF NOT EXISTS tree_sha VARCHAR(40);
ALTER TABLE git_commits ADD COLUMN IF NOT EXISTS repository_url TEXT;
ALTER TABLE git_commits ADD COLUMN IF NOT EXISTS merge_strategy VARCHAR(50);
ALTER TABLE git_commits ADD COLUMN IF NOT EXISTS discovered_by VARCHAR(100);
ALTER TABLE git_commits ADD COLUMN IF NOT EXISTS first_seen TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE git_commits ADD COLUMN IF NOT EXISTS is_analyzed BOOLEAN DEFAULT FALSE;
ALTER TABLE git_commits ADD COLUMN IF NOT EXISTS analysis_version INTEGER DEFAULT 1;

-- Add total_changes if it doesn't exist (handle both stored and regular column)
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name = 'git_commits' AND column_name = 'total_changes') THEN
        ALTER TABLE git_commits ADD COLUMN total_changes INTEGER GENERATED ALWAYS AS (insertions + deletions) STORED;
    END IF;
END $$;

-- =============================================
-- GIT BRANCHES TABLE - Branch lifecycle tracking
-- =============================================

CREATE TABLE IF NOT EXISTS git_branches (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    
    -- Branch identification
    branch_name VARCHAR(255) NOT NULL,
    full_ref_name VARCHAR(500) NOT NULL, -- refs/heads/main, refs/remotes/origin/feature
    
    -- Branch state
    current_commit_sha VARCHAR(40),
    is_default_branch BOOLEAN DEFAULT FALSE,
    is_protected BOOLEAN DEFAULT FALSE,
    is_active BOOLEAN DEFAULT TRUE, -- FALSE for deleted branches
    
    -- Branch relationships
    upstream_branch VARCHAR(255), -- The branch this was created from
    merge_target VARCHAR(255), -- Default merge target (usually main/develop)
    
    -- Lifecycle tracking
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    first_commit_date TIMESTAMP WITH TIME ZONE,
    last_commit_date TIMESTAMP WITH TIME ZONE,
    deleted_at TIMESTAMP WITH TIME ZONE, -- When branch was deleted
    
    -- Branch metadata
    description TEXT, -- Branch purpose/description
    branch_type VARCHAR(50) DEFAULT 'feature' CHECK (branch_type IN (
        'main', 'develop', 'feature', 'hotfix', 'release', 'bugfix', 'experimental'
    )),
    
    -- Statistics
    commit_count INTEGER DEFAULT 0,
    unique_authors INTEGER DEFAULT 0,
    
    -- AIDIS integration
    associated_sessions UUID[] DEFAULT '{}', -- Sessions that worked on this branch
    metadata JSONB DEFAULT '{}'::jsonb,
    
    UNIQUE(project_id, branch_name)
);

-- Add missing columns for git_branches if table already exists
ALTER TABLE git_branches ADD COLUMN IF NOT EXISTS current_commit_sha VARCHAR(40);
ALTER TABLE git_branches ADD COLUMN IF NOT EXISTS full_ref_name VARCHAR(500);
ALTER TABLE git_branches ADD COLUMN IF NOT EXISTS is_default_branch BOOLEAN DEFAULT FALSE;
ALTER TABLE git_branches ADD COLUMN IF NOT EXISTS is_protected BOOLEAN DEFAULT FALSE;
ALTER TABLE git_branches ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT TRUE;
ALTER TABLE git_branches ADD COLUMN IF NOT EXISTS upstream_branch VARCHAR(255);
ALTER TABLE git_branches ADD COLUMN IF NOT EXISTS merge_target VARCHAR(255);
ALTER TABLE git_branches ADD COLUMN IF NOT EXISTS first_commit_date TIMESTAMP WITH TIME ZONE;
ALTER TABLE git_branches ADD COLUMN IF NOT EXISTS last_commit_date TIMESTAMP WITH TIME ZONE;
ALTER TABLE git_branches ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE git_branches ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE git_branches ADD COLUMN IF NOT EXISTS branch_type VARCHAR(50) DEFAULT 'feature';
ALTER TABLE git_branches ADD COLUMN IF NOT EXISTS commits_ahead INTEGER DEFAULT 0;
ALTER TABLE git_branches ADD COLUMN IF NOT EXISTS commits_behind INTEGER DEFAULT 0;
ALTER TABLE git_branches ADD COLUMN IF NOT EXISTS total_commits INTEGER DEFAULT 0;
ALTER TABLE git_branches ADD COLUMN IF NOT EXISTS associated_sessions UUID[] DEFAULT '{}';
ALTER TABLE git_branches ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}'::jsonb;

-- =============================================
-- GIT FILE CHANGES TABLE - File-level change tracking
-- =============================================

CREATE TABLE IF NOT EXISTS git_file_changes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    commit_id UUID NOT NULL REFERENCES git_commits(id) ON DELETE CASCADE,
    
    -- File identification
    file_path TEXT NOT NULL,
    old_file_path TEXT, -- For renames/moves
    file_type VARCHAR(50), -- Derived from extension: js, ts, py, sql, etc.
    
    -- Change type
    change_type VARCHAR(20) NOT NULL CHECK (change_type IN (
        'added', 'modified', 'deleted', 'renamed', 'copied', 'type_changed'
    )),
    
    -- Change statistics
    lines_added INTEGER DEFAULT 0,
    lines_removed INTEGER DEFAULT 0,
    lines_changed INTEGER GENERATED ALWAYS AS (lines_added + lines_removed) STORED,
    
    -- File properties
    old_file_mode VARCHAR(10), -- File permissions (e.g., '100644')
    new_file_mode VARCHAR(10),
    is_binary BOOLEAN DEFAULT FALSE,
    is_generated BOOLEAN DEFAULT FALSE, -- Auto-generated files
    
    -- Code analysis integration
    component_id UUID REFERENCES code_components(id) ON DELETE SET NULL,
    affects_exports BOOLEAN DEFAULT FALSE, -- Does change affect exported symbols
    complexity_delta INTEGER DEFAULT 0, -- Change in complexity score
    
    -- Change context
    patch_preview TEXT, -- First few lines of diff for quick reference
    metadata JSONB DEFAULT '{}'::jsonb,
    
    CONSTRAINT valid_line_counts CHECK (
        lines_added >= 0 AND lines_removed >= 0
    )
);

-- Add missing columns for git_file_changes if table already exists
ALTER TABLE git_file_changes ADD COLUMN IF NOT EXISTS commit_id UUID;
ALTER TABLE git_file_changes ADD COLUMN IF NOT EXISTS old_file_path TEXT;
ALTER TABLE git_file_changes ADD COLUMN IF NOT EXISTS file_type VARCHAR(50);
ALTER TABLE git_file_changes ADD COLUMN IF NOT EXISTS change_type VARCHAR(20);
ALTER TABLE git_file_changes ADD COLUMN IF NOT EXISTS lines_added INTEGER DEFAULT 0;
ALTER TABLE git_file_changes ADD COLUMN IF NOT EXISTS lines_removed INTEGER DEFAULT 0;
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name = 'git_file_changes' AND column_name = 'lines_changed') THEN
        ALTER TABLE git_file_changes ADD COLUMN lines_changed INTEGER GENERATED ALWAYS AS (lines_added + lines_removed) STORED;
    END IF;
END $$;
ALTER TABLE git_file_changes ADD COLUMN IF NOT EXISTS old_file_mode VARCHAR(10);
ALTER TABLE git_file_changes ADD COLUMN IF NOT EXISTS new_file_mode VARCHAR(10);
ALTER TABLE git_file_changes ADD COLUMN IF NOT EXISTS is_binary BOOLEAN DEFAULT FALSE;
ALTER TABLE git_file_changes ADD COLUMN IF NOT EXISTS is_generated BOOLEAN DEFAULT FALSE;
ALTER TABLE git_file_changes ADD COLUMN IF NOT EXISTS component_id UUID;
ALTER TABLE git_file_changes ADD COLUMN IF NOT EXISTS affects_exports BOOLEAN DEFAULT FALSE;
ALTER TABLE git_file_changes ADD COLUMN IF NOT EXISTS complexity_delta INTEGER DEFAULT 0;
ALTER TABLE git_file_changes ADD COLUMN IF NOT EXISTS patch_preview TEXT;

-- =============================================
-- COMMIT SESSION LINKS TABLE - Session correlation
-- =============================================

CREATE TABLE IF NOT EXISTS commit_session_links (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    commit_id UUID NOT NULL REFERENCES git_commits(id) ON DELETE CASCADE,
    session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    
    -- Link metadata
    link_type VARCHAR(50) DEFAULT 'contributed' CHECK (link_type IN (
        'contributed', 'reviewed', 'planned', 'discussed', 'debugged', 'tested'
    )),
    confidence_score FLOAT DEFAULT 1.0 CHECK (confidence_score >= 0 AND confidence_score <= 1),
    
    -- Correlation evidence
    time_proximity_minutes INTEGER, -- How close in time session and commit were
    author_match BOOLEAN DEFAULT FALSE, -- Does session agent match commit author
    content_similarity FLOAT DEFAULT 0.0, -- Semantic similarity of session content to commit
    
    -- Context tracking
    relevant_context_ids UUID[] DEFAULT '{}', -- Context entries that relate to this commit
    decision_ids UUID[] DEFAULT '{}', -- Technical decisions implemented in this commit
    
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    created_by VARCHAR(100), -- Which system created this link
    
    UNIQUE(commit_id, session_id)
);

-- =============================================
-- SCHEMA EXTENSIONS TO EXISTING TABLES
-- =============================================

-- Add commit tracking to contexts table
ALTER TABLE contexts 
ADD COLUMN IF NOT EXISTS related_commit_sha VARCHAR(40),
ADD COLUMN IF NOT EXISTS commit_context_type VARCHAR(50) CHECK (
    commit_context_type IS NULL OR 
    commit_context_type IN ('pre_commit', 'post_commit', 'commit_discussion', 'commit_review')
);

-- Add commit tracking to sessions table  
ALTER TABLE sessions
ADD COLUMN IF NOT EXISTS active_branch VARCHAR(255),
ADD COLUMN IF NOT EXISTS working_commit_sha VARCHAR(40),
ADD COLUMN IF NOT EXISTS commits_contributed INTEGER DEFAULT 0;

-- Add commit tracking to technical decisions
ALTER TABLE technical_decisions
ADD COLUMN IF NOT EXISTS implementing_commits VARCHAR(40)[] DEFAULT '{}',
ADD COLUMN IF NOT EXISTS implementation_status VARCHAR(50) DEFAULT 'not_started' CHECK (
    implementation_status IN ('not_started', 'in_progress', 'completed', 'abandoned')
);

-- Add commit tracking to code components
ALTER TABLE code_components
ADD COLUMN IF NOT EXISTS last_modified_commit VARCHAR(40),
ADD COLUMN IF NOT EXISTS creation_commit VARCHAR(40),
ADD COLUMN IF NOT EXISTS modification_frequency INTEGER DEFAULT 0;

-- =============================================
-- PERFORMANCE INDEXES
-- =============================================

-- Git Commits Indexes
CREATE INDEX IF NOT EXISTS idx_git_commits_project ON git_commits(project_id);
CREATE INDEX IF NOT EXISTS idx_git_commits_sha ON git_commits(commit_sha);
CREATE INDEX IF NOT EXISTS idx_git_commits_short_sha ON git_commits(short_sha);
CREATE INDEX IF NOT EXISTS idx_git_commits_author_date ON git_commits(author_date DESC);
CREATE INDEX IF NOT EXISTS idx_git_commits_committer_date ON git_commits(committer_date DESC);
CREATE INDEX IF NOT EXISTS idx_git_commits_branch ON git_commits(branch_name);
CREATE INDEX IF NOT EXISTS idx_git_commits_author ON git_commits(author_email, author_date DESC);
CREATE INDEX IF NOT EXISTS idx_git_commits_type ON git_commits(commit_type, project_id);
CREATE INDEX IF NOT EXISTS idx_git_commits_merge ON git_commits(is_merge_commit, project_id);
CREATE INDEX IF NOT EXISTS idx_git_commits_analyzed ON git_commits(is_analyzed, project_id);
-- Create stats index (conditionally based on column existence)
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_name = 'git_commits' AND column_name = 'total_changes') THEN
        CREATE INDEX IF NOT EXISTS idx_git_commits_stats ON git_commits(files_changed DESC, total_changes DESC);
    ELSE
        CREATE INDEX IF NOT EXISTS idx_git_commits_stats ON git_commits(files_changed DESC, (insertions + deletions) DESC);
    END IF;
END $$;

-- Composite indexes for common queries
CREATE INDEX IF NOT EXISTS idx_git_commits_project_date ON git_commits(project_id, author_date DESC);
CREATE INDEX IF NOT EXISTS idx_git_commits_project_author ON git_commits(project_id, author_email, author_date DESC);
CREATE INDEX IF NOT EXISTS idx_git_commits_project_branch_date ON git_commits(project_id, branch_name, author_date DESC);

-- Git Branches Indexes
CREATE INDEX IF NOT EXISTS idx_git_branches_project ON git_branches(project_id);
CREATE INDEX IF NOT EXISTS idx_git_branches_name ON git_branches(branch_name);
CREATE INDEX IF NOT EXISTS idx_git_branches_current_commit ON git_branches(current_commit_sha);
CREATE INDEX IF NOT EXISTS idx_git_branches_active ON git_branches(is_active, project_id);
CREATE INDEX IF NOT EXISTS idx_git_branches_default ON git_branches(is_default_branch, project_id);
CREATE INDEX IF NOT EXISTS idx_git_branches_type ON git_branches(branch_type, project_id);
CREATE INDEX IF NOT EXISTS idx_git_branches_last_commit ON git_branches(last_commit_date DESC);

-- Git File Changes Indexes
CREATE INDEX IF NOT EXISTS idx_git_file_changes_project ON git_file_changes(project_id);
CREATE INDEX IF NOT EXISTS idx_git_file_changes_commit ON git_file_changes(commit_id);
CREATE INDEX IF NOT EXISTS idx_git_file_changes_path ON git_file_changes(file_path);
CREATE INDEX IF NOT EXISTS idx_git_file_changes_type ON git_file_changes(change_type, project_id);
CREATE INDEX IF NOT EXISTS idx_git_file_changes_file_type ON git_file_changes(file_type, project_id);
CREATE INDEX IF NOT EXISTS idx_git_file_changes_component ON git_file_changes(component_id);
CREATE INDEX IF NOT EXISTS idx_git_file_changes_stats ON git_file_changes(lines_changed DESC);

-- Composite indexes for file tracking
CREATE INDEX IF NOT EXISTS idx_git_file_changes_project_path ON git_file_changes(project_id, file_path);
CREATE INDEX IF NOT EXISTS idx_git_file_changes_path_type ON git_file_changes(file_path, change_type);

-- Commit Session Links Indexes  
CREATE INDEX IF NOT EXISTS idx_commit_session_links_project ON commit_session_links(project_id);
CREATE INDEX IF NOT EXISTS idx_commit_session_links_commit ON commit_session_links(commit_id);
CREATE INDEX IF NOT EXISTS idx_commit_session_links_session ON commit_session_links(session_id);
CREATE INDEX IF NOT EXISTS idx_commit_session_links_type ON commit_session_links(link_type, project_id);
CREATE INDEX IF NOT EXISTS idx_commit_session_links_confidence ON commit_session_links(confidence_score DESC);

-- Schema extension indexes
CREATE INDEX IF NOT EXISTS idx_contexts_commit_sha ON contexts(related_commit_sha) WHERE related_commit_sha IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_sessions_branch ON sessions(active_branch) WHERE active_branch IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_sessions_working_commit ON sessions(working_commit_sha) WHERE working_commit_sha IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_code_components_last_modified ON code_components(last_modified_commit) WHERE last_modified_commit IS NOT NULL;

-- =============================================
-- GIN INDEXES FOR ARRAY COLUMNS
-- =============================================

CREATE INDEX IF NOT EXISTS idx_git_commits_parent_shas ON git_commits USING GIN(parent_shas);
CREATE INDEX IF NOT EXISTS idx_git_commits_tags ON git_commits USING GIN(tags);
CREATE INDEX IF NOT EXISTS idx_git_branches_sessions ON git_branches USING GIN(associated_sessions);
CREATE INDEX IF NOT EXISTS idx_commit_session_links_contexts ON commit_session_links USING GIN(relevant_context_ids);
CREATE INDEX IF NOT EXISTS idx_commit_session_links_decisions ON commit_session_links USING GIN(decision_ids);
CREATE INDEX IF NOT EXISTS idx_technical_decisions_commits ON technical_decisions USING GIN(implementing_commits);

-- =============================================
-- FULL-TEXT SEARCH INDEXES
-- =============================================

-- Git commit message search
CREATE INDEX IF NOT EXISTS idx_git_commits_message_fts 
ON git_commits USING GIN(to_tsvector('english', message));

-- Combined commit search (message + author)
CREATE INDEX IF NOT EXISTS idx_git_commits_full_fts 
ON git_commits USING GIN(to_tsvector('english', 
    message || ' ' || author_name || ' ' || COALESCE(branch_name, '')
));

-- Branch description search
CREATE INDEX IF NOT EXISTS idx_git_branches_description_fts 
ON git_branches USING GIN(to_tsvector('english', COALESCE(description, '')));

-- =============================================
-- TRIGGERS FOR AUTOMATIC UPDATES
-- =============================================

-- Auto-update git_commits.updated_at
CREATE TRIGGER update_git_commits_updated_at
    BEFORE UPDATE ON git_commits
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- Auto-update git_branches.updated_at  
CREATE TRIGGER update_git_branches_updated_at
    BEFORE UPDATE ON git_branches
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- =============================================
-- DATA VALIDATION FUNCTIONS
-- =============================================

-- Function to validate commit SHA format and check for duplicates
CREATE OR REPLACE FUNCTION validate_commit_insertion()
RETURNS TRIGGER AS $$
BEGIN
    -- Validate SHA format
    IF NEW.commit_sha !~ '^[a-f0-9]{40}$' THEN
        RAISE EXCEPTION 'Invalid commit SHA format: %', NEW.commit_sha;
    END IF;
    
    -- Validate short SHA is prefix of full SHA
    IF NEW.short_sha != substring(NEW.commit_sha from 1 for length(NEW.short_sha)) THEN
        RAISE EXCEPTION 'Short SHA must be prefix of full SHA';
    END IF;
    
    -- Auto-generate short SHA if not provided
    IF NEW.short_sha IS NULL OR NEW.short_sha = '' THEN
        NEW.short_sha := substring(NEW.commit_sha from 1 for 12);
    END IF;
    
    -- Auto-classify commit type based on message
    IF NEW.commit_type = 'unknown' AND NEW.message IS NOT NULL THEN
        NEW.commit_type := CASE
            WHEN NEW.message ~* '^(feat|feature)(\(.*\))?:' THEN 'feature'
            WHEN NEW.message ~* '^(fix|bugfix)(\(.*\))?:' THEN 'bugfix'
            WHEN NEW.message ~* '^(refactor|refact)(\(.*\))?:' THEN 'refactor'
            WHEN NEW.message ~* '^(test|tests)(\(.*\))?:' THEN 'test'
            WHEN NEW.message ~* '^(docs|doc)(\(.*\))?:' THEN 'docs'
            WHEN NEW.message ~* '^(style|styles)(\(.*\))?:' THEN 'style'
            WHEN NEW.message ~* '^(chore|maintenance)(\(.*\))?:' THEN 'chore'
            WHEN NEW.message ~* '^(merge|Merge)' THEN 'merge'
            WHEN NEW.message ~* '^(revert|Revert)' THEN 'revert'
            WHEN NEW.message ~* '^(hotfix|hot-fix)(\(.*\))?:' THEN 'hotfix'
            WHEN NEW.message ~* 'breaking change|BREAKING CHANGE' THEN 'breaking'
            ELSE 'unknown'
        END;
    END IF;
    
    -- Set merge commit flag based on parent count
    IF array_length(NEW.parent_shas, 1) > 1 THEN
        NEW.is_merge_commit := TRUE;
    END IF;
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Apply validation trigger
CREATE TRIGGER validate_git_commit_data
    BEFORE INSERT OR UPDATE ON git_commits
    FOR EACH ROW
    EXECUTE FUNCTION validate_commit_insertion();

-- Function to update branch statistics
CREATE OR REPLACE FUNCTION update_branch_stats()
RETURNS TRIGGER AS $$
DECLARE
    branch_rec RECORD;
BEGIN
    -- Update branch statistics when commits are added
    IF TG_OP = 'INSERT' THEN
        UPDATE git_branches 
        SET 
            current_commit_sha = NEW.commit_sha,
            last_commit_date = NEW.author_date,
            commit_count = commit_count + 1
        WHERE project_id = NEW.project_id 
        AND branch_name = NEW.branch_name;
        
        -- Set first commit date if this is the first commit
        UPDATE git_branches 
        SET first_commit_date = NEW.author_date
        WHERE project_id = NEW.project_id 
        AND branch_name = NEW.branch_name
        AND first_commit_date IS NULL;
    END IF;
    
    RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

-- Apply branch stats trigger
CREATE TRIGGER update_git_branch_stats
    AFTER INSERT OR UPDATE ON git_commits
    FOR EACH ROW
    EXECUTE FUNCTION update_branch_stats();

-- =============================================
-- INITIAL DATA AND EXAMPLES
-- =============================================

-- Insert sample branch types for AIDIS project
DO $$
DECLARE
    aidis_project_id UUID;
BEGIN
    -- Get the AIDIS bootstrap project ID
    SELECT id INTO aidis_project_id FROM projects WHERE name = 'aidis-bootstrap';
    
    IF aidis_project_id IS NOT NULL THEN
        -- Create main branch entry
        INSERT INTO git_branches (
            project_id, branch_name, full_ref_name, is_default_branch, 
            is_protected, branch_type, description
        ) VALUES (
            aidis_project_id,
            'main',
            'refs/heads/main',
            TRUE,
            TRUE,
            'main',
            'Main development branch for AIDIS project'
        ) ON CONFLICT (project_id, branch_name) DO NOTHING;
        
        RAISE NOTICE 'Sample git tracking data initialized for AIDIS project';
    END IF;
END $$;

-- =============================================
-- VERIFICATION AND SUMMARY
-- =============================================

-- Verify migration success
SELECT 'Migration 010 completed successfully - Git tracking system created' as status;

-- Show table counts
SELECT 
    'git_commits' as table_name, COUNT(*) as row_count FROM git_commits
UNION ALL
SELECT 
    'git_branches' as table_name, COUNT(*) as row_count FROM git_branches
UNION ALL
SELECT 
    'git_file_changes' as table_name, COUNT(*) as row_count FROM git_file_changes
UNION ALL
SELECT 
    'commit_session_links' as table_name, COUNT(*) as row_count FROM commit_session_links;

-- Show new columns added to existing tables
SELECT 'Schema extensions completed - new columns added to contexts, sessions, technical_decisions, code_components' as extension_status;