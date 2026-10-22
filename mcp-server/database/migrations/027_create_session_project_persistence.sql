-- AIDIS Migration 017: Create Session-Project Persistence
--
-- This creates the session_project_mappings table to solve the restart persistence issue.
-- When MCP server restarts, all session-to-project mappings are lost because they're
-- stored in memory. This table provides persistent storage for session state.
--
-- Problem: MCP server uses in-memory Map() for session states
-- Solution: Database-backed persistent session-project mappings
--
-- Author: AIDIS Team
-- Date: 2025-09-27

-- Create session_project_mappings table
CREATE TABLE IF NOT EXISTS session_project_mappings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id VARCHAR(255) NOT NULL,
    project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    metadata JSONB DEFAULT '{}'::jsonb,
    
    -- Ensure one mapping per session (latest wins)
    CONSTRAINT unique_session_mapping UNIQUE (session_id)
);

-- Performance indexes
CREATE INDEX IF NOT EXISTS idx_session_mappings_session_id ON session_project_mappings(session_id);
CREATE INDEX IF NOT EXISTS idx_session_mappings_project_id ON session_project_mappings(project_id);
CREATE INDEX IF NOT EXISTS idx_session_mappings_updated_at ON session_project_mappings(updated_at DESC);

-- Add updated_at trigger
CREATE TRIGGER update_session_mappings_updated_at
    BEFORE UPDATE ON session_project_mappings
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- Migrate existing in-memory session states if any
-- This migration will be handled by the ProjectHandler during initialization

-- Verify migration success
SELECT 'Migration 017 completed successfully - Session persistence ready' as status;
SELECT COUNT(*) as mapping_table_exists FROM information_schema.tables 
WHERE table_name = 'session_project_mappings';
