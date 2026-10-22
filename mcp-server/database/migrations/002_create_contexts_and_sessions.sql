-- AIDIS Migration 002: Create Contexts and Sessions Tables
--
-- This creates the core context management tables:
-- - sessions: Track AI agent sessions and their activities
-- - contexts: Store development context with vector embeddings for semantic search
--
-- These tables are the HEART of AIDIS - they solve the AI context loss problem!
--
-- Author: the operator & AIDIS Team  
-- Date: 2025-08-15

-- Create sessions table - tracks AI agent activities
CREATE TABLE IF NOT EXISTS sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
    agent_type VARCHAR(50) NOT NULL,
    started_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    ended_at TIMESTAMP WITH TIME ZONE,
    context_summary TEXT,
    tokens_used INTEGER DEFAULT 0,
    metadata JSONB DEFAULT '{}'::jsonb,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,

    -- Performance constraint: sessions should have reasonable duration
    CONSTRAINT reasonable_session_duration 
    CHECK (ended_at IS NULL OR ended_at >= started_at)
);

-- Create contexts table - the AI memory storage with vector search
CREATE TABLE IF NOT EXISTS contexts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
    session_id UUID REFERENCES sessions(id) ON DELETE SET NULL,
    
    -- Context classification
    context_type VARCHAR(50) NOT NULL CHECK (
        context_type IN ('code', 'decision', 'error', 'discussion', 'planning', 'completion')
    ),
    
    -- The actual content and its semantic representation
    content TEXT NOT NULL,
    embedding VECTOR(1536), -- OpenAI ada-002 embedding size
    
    -- Metadata and organization
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    relevance_score FLOAT DEFAULT 1.0 CHECK (relevance_score >= 0 AND relevance_score <= 10),
    tags TEXT[] DEFAULT '{}',
    metadata JSONB DEFAULT '{}'::jsonb,
    
    -- Content should not be empty
    CONSTRAINT content_not_empty CHECK (length(trim(content)) > 0)
);

-- Performance indexes for sessions
CREATE INDEX IF NOT EXISTS idx_sessions_project_id ON sessions(project_id);
CREATE INDEX IF NOT EXISTS idx_sessions_agent_type ON sessions(agent_type);
CREATE INDEX IF NOT EXISTS idx_sessions_started_at ON sessions(started_at);
CREATE INDEX IF NOT EXISTS idx_sessions_project_agent ON sessions(project_id, agent_type);

-- Performance indexes for contexts  
CREATE INDEX IF NOT EXISTS idx_contexts_project_id ON contexts(project_id);
CREATE INDEX IF NOT EXISTS idx_contexts_session_id ON contexts(session_id);
CREATE INDEX IF NOT EXISTS idx_contexts_type ON contexts(context_type);
CREATE INDEX IF NOT EXISTS idx_contexts_project_type ON contexts(project_id, context_type);
CREATE INDEX IF NOT EXISTS idx_contexts_created_at ON contexts(created_at);
CREATE INDEX IF NOT EXISTS idx_contexts_relevance ON contexts(relevance_score DESC);

-- Vector search index - THIS IS THE MAGIC for semantic search!
CREATE INDEX IF NOT EXISTS idx_contexts_embedding_cosine 
ON contexts USING ivfflat (embedding vector_cosine_ops) 
WITH (lists = 100);

-- Full-text search index for traditional keyword search  
CREATE INDEX IF NOT EXISTS idx_contexts_content_fts 
ON contexts USING GIN(to_tsvector('english', content));

-- GIN index for tags array searching
CREATE INDEX IF NOT EXISTS idx_contexts_tags_gin ON contexts USING GIN(tags);

-- GIN index for metadata JSONB searching
CREATE INDEX IF NOT EXISTS idx_contexts_metadata_gin ON contexts USING GIN(metadata);

-- Add updated_at trigger to sessions
CREATE TRIGGER update_sessions_updated_at
    BEFORE UPDATE ON sessions  
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- Insert sample data for testing
DO $$
DECLARE
    test_project_id UUID;
    test_session_id UUID;
BEGIN
    -- Get our bootstrap project ID
    SELECT id INTO test_project_id FROM projects WHERE name = 'aidis-bootstrap';
    
    -- Create a sample session
    INSERT INTO sessions (project_id, agent_type, context_summary, metadata)
    VALUES (
        test_project_id,
        'aidis-bootstrap-agent',
        'Initial AIDIS system setup - Phase 1 foundation completed',
        '{"phase": "foundation", "completed_tasks": ["database_setup", "mcp_server", "migrations"]}'::jsonb
    ) RETURNING id INTO test_session_id;
    
    -- Create sample contexts (without embeddings for now - we'll add those via the embedding service)
    INSERT INTO contexts (project_id, session_id, context_type, content, tags, relevance_score, metadata) VALUES
    (
        test_project_id,
        test_session_id,
        'completion',
        'Successfully set up PostgreSQL with pgvector extension for vector search capabilities. This enables semantic search across all stored contexts.',
        ARRAY['postgresql', 'pgvector', 'database', 'setup'],
        9.0,
        '{"components": ["postgresql", "pgvector"], "status": "completed"}'::jsonb
    ),
    (
        test_project_id, 
        test_session_id,
        'code',
        'Created MCP server with TypeScript using @modelcontextprotocol/sdk. Server responds to ping and status tools, ready for AI agent connections.',
        ARRAY['mcp', 'typescript', 'server', 'tools'],
        8.5,
        '{"language": "typescript", "framework": "mcp-sdk", "tools": ["ping", "status"]}'::jsonb
    ),
    (
        test_project_id,
        test_session_id, 
        'planning',
        'Phase 2 planning: Implement core context management with vector embeddings, context storage/search tools, and agent session tracking.',
        ARRAY['planning', 'phase-2', 'context-management', 'roadmap'],
        7.0,
        '{"phase": 2, "focus": "context_management", "priority": "high"}'::jsonb
    );
END $$;

-- Verify migration success
SELECT 'Migration 002 completed successfully' as status;
SELECT 
    (SELECT COUNT(*) FROM sessions) as session_count,
    (SELECT COUNT(*) FROM contexts) as context_count,
    (SELECT COUNT(*) FROM contexts WHERE embedding IS NOT NULL) as contexts_with_embeddings;
