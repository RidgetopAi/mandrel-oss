-- Migration 008: Fix Task Type ENUM Constraint
-- This migration adds proper ENUM constraint for agent_tasks.type field
-- Aligns database schema with MCP tool validation requirements

-- Based on MCP tool description: 'feature, bugfix, refactor, test, review, documentation'
-- Plus existing database values: 'general', 'bug', 'docs', 'devops'

-- Create ENUM type for task types
CREATE TYPE task_type_enum AS ENUM (
    'feature',      -- New functionality
    'bug',          -- Bug fixes  
    'bugfix',       -- Bug fixes (alternative name)
    'refactor',     -- Code refactoring
    'test',         -- Testing tasks
    'review',       -- Code review tasks  
    'docs',         -- Documentation (short)
    'documentation',-- Documentation (full)
    'devops',       -- DevOps tasks
    'general'       -- General tasks (catch-all)
);

-- Update existing data to use valid enum values
UPDATE agent_tasks 
SET type = CASE 
    WHEN type = 'bugfix' OR type = 'bug' THEN 'bug'
    WHEN type = 'documentation' OR type = 'docs' THEN 'docs' 
    WHEN type NOT IN ('feature', 'bug', 'bugfix', 'refactor', 'test', 'review', 'docs', 'documentation', 'devops') 
    THEN 'general'
    ELSE type
END;

-- Add the ENUM constraint to the existing column (fix default casting)
ALTER TABLE agent_tasks 
DROP CONSTRAINT IF EXISTS agent_tasks_type_check;

-- Remove default temporarily, change type, then set new default
ALTER TABLE agent_tasks ALTER COLUMN type DROP DEFAULT;
ALTER TABLE agent_tasks ALTER COLUMN type TYPE task_type_enum USING type::task_type_enum;
ALTER TABLE agent_tasks ALTER COLUMN type SET DEFAULT 'general'::task_type_enum;

-- Create index for performance
CREATE INDEX IF NOT EXISTS idx_agent_tasks_type_enum ON agent_tasks(type);

-- Verify migration
SELECT 
    'Migration 008 completed successfully' as status,
    COUNT(*) as total_tasks,
    COUNT(DISTINCT type) as distinct_types,
    string_agg(DISTINCT type::text, ', ' ORDER BY type::text) as task_types
FROM agent_tasks;
