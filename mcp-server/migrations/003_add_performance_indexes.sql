-- Performance Indexes for AIDIS Production
-- Add vector search and query optimization indexes

-- Vector search IVFFlat index (requires pgvector)
-- Improves semantic search performance on contexts table
CREATE INDEX IF NOT EXISTS idx_contexts_embedding 
  ON contexts USING ivfflat (embedding vector_l2_ops) 
  WITH (lists = 100);

-- BTree indexes for common queries
CREATE INDEX IF NOT EXISTS idx_contexts_project_id 
  ON contexts(project_id);

CREATE INDEX IF NOT EXISTS idx_contexts_created_at 
  ON contexts(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_contexts_type 
  ON contexts(context_type);

CREATE INDEX IF NOT EXISTS idx_contexts_session_id 
  ON contexts(session_id);

-- GIN index for tag array searches
CREATE INDEX IF NOT EXISTS idx_contexts_tags 
  ON contexts USING GIN(tags);

-- Composite indexes for common query patterns
CREATE INDEX IF NOT EXISTS idx_contexts_project_type 
  ON contexts(project_id, context_type);

CREATE INDEX IF NOT EXISTS idx_contexts_project_created 
  ON contexts(project_id, created_at DESC);

-- Decisions table indexes
CREATE INDEX IF NOT EXISTS idx_decisions_project_id 
  ON technical_decisions(project_id);

CREATE INDEX IF NOT EXISTS idx_decisions_created_at 
  ON technical_decisions(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_decisions_status 
  ON technical_decisions(status);

-- Tasks table indexes  
CREATE INDEX IF NOT EXISTS idx_tasks_project_id 
  ON tasks(project_id);

CREATE INDEX IF NOT EXISTS idx_tasks_status 
  ON tasks(status);

CREATE INDEX IF NOT EXISTS idx_tasks_priority 
  ON tasks(priority);

CREATE INDEX IF NOT EXISTS idx_tasks_assigned_to 
  ON tasks(assigned_to);

-- Sessions table indexes
CREATE INDEX IF NOT EXISTS idx_sessions_project_id 
  ON sessions(project_id);

CREATE INDEX IF NOT EXISTS idx_sessions_start_time 
  ON sessions(start_time DESC);

-- Projects table indexes
CREATE INDEX IF NOT EXISTS idx_projects_status 
  ON projects(status);

-- Analyze tables for query planner
ANALYZE contexts;
ANALYZE technical_decisions;
ANALYZE tasks;
ANALYZE sessions;
ANALYZE projects;
