-- AIDIS Migration 001: Create Projects Table
-- 
-- This creates the foundational projects table for AIDIS.
-- Every context, session, decision, and component is associated with a project.
--
-- Author: the operator & AIDIS Team
-- Date: 2025-08-15

-- Enable UUID extension if not already enabled
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Create projects table
CREATE TABLE IF NOT EXISTS projects (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) NOT NULL UNIQUE,
    description TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    status VARCHAR(50) DEFAULT 'active' CHECK (status IN ('active', 'archived', 'completed', 'paused')),
    git_repo_url TEXT,
    root_directory TEXT,
    metadata JSONB DEFAULT '{}'::jsonb
);

-- Create updated_at trigger function (reusable for other tables)
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Add trigger to automatically update updated_at
CREATE TRIGGER update_projects_updated_at
    BEFORE UPDATE ON projects
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_projects_name ON projects(name);
CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(status);
CREATE INDEX IF NOT EXISTS idx_projects_created_at ON projects(created_at);
CREATE INDEX IF NOT EXISTS idx_projects_metadata_gin ON projects USING GIN(metadata);

-- Insert a default project for testing
INSERT INTO projects (name, description, git_repo_url, root_directory, metadata) 
VALUES (
    'aidis-bootstrap', 
    'The AIDIS project itself - bootstrapping the AI Development Intelligence System',
    'https://github.com/your-username/aidis',
    '/path/to/aidis',
    '{"phase": "foundation", "tools": ["postgresql", "typescript", "mcp"], "learning_project": true}'::jsonb
) ON CONFLICT (name) DO NOTHING;

-- Verify the migration worked
SELECT 'Migration 001 completed successfully' as status;
SELECT COUNT(*) as project_count FROM projects;
