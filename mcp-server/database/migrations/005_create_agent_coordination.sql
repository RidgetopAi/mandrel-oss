-- Migration 005: Create Agent Coordination System
-- This migration adds tables for multi-agent coordination

-- Agents table: Track individual AI agents
CREATE TABLE agents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) NOT NULL UNIQUE,
    type VARCHAR(100) NOT NULL DEFAULT 'ai_assistant', -- ai_assistant, code_reviewer, tester, etc.
    capabilities TEXT[] DEFAULT '{}', -- array of capabilities like ['coding', 'testing', 'review']
    status VARCHAR(50) NOT NULL DEFAULT 'active', -- active, busy, offline, error
    metadata JSONB DEFAULT '{}',
    last_seen TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Agent sessions: Link agents to specific sessions and projects
CREATE TABLE agent_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    session_id VARCHAR(255) NOT NULL,
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    status VARCHAR(50) NOT NULL DEFAULT 'active', -- active, idle, disconnected
    started_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    last_activity TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    metadata JSONB DEFAULT '{}',
    UNIQUE(agent_id, session_id, project_id)
);

-- Agent tasks: Work assignments and coordination
CREATE TABLE agent_tasks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    assigned_to UUID REFERENCES agents(id) ON DELETE SET NULL,
    created_by UUID REFERENCES agents(id) ON DELETE SET NULL,
    title VARCHAR(500) NOT NULL,
    description TEXT,
    type VARCHAR(100) NOT NULL DEFAULT 'general', -- feature, bugfix, refactor, test, review, documentation
    status VARCHAR(50) NOT NULL DEFAULT 'todo', -- todo, in_progress, blocked, completed, cancelled
    priority VARCHAR(20) NOT NULL DEFAULT 'medium', -- low, medium, high, urgent
    dependencies UUID[] DEFAULT '{}', -- array of task IDs this task depends on
    tags TEXT[] DEFAULT '{}',
    metadata JSONB DEFAULT '{}',
    started_at TIMESTAMP WITH TIME ZONE,
    completed_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Agent messages: Communication between agents
CREATE TABLE agent_messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    from_agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    to_agent_id UUID REFERENCES agents(id) ON DELETE CASCADE, -- NULL for broadcast messages
    message_type VARCHAR(100) NOT NULL DEFAULT 'info', -- info, request, response, alert, coordination
    title VARCHAR(500),
    content TEXT NOT NULL,
    context_refs UUID[] DEFAULT '{}', -- references to relevant context IDs
    task_refs UUID[] DEFAULT '{}', -- references to relevant task IDs
    metadata JSONB DEFAULT '{}',
    read_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Agent collaborations: Track collaborative work
CREATE TABLE agent_collaborations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    agents UUID[] NOT NULL, -- array of agent IDs involved
    type VARCHAR(100) NOT NULL DEFAULT 'general', -- pair_programming, code_review, planning, debugging
    title VARCHAR(500) NOT NULL,
    description TEXT,
    status VARCHAR(50) NOT NULL DEFAULT 'active', -- active, paused, completed
    result TEXT, -- outcome of the collaboration
    contexts UUID[] DEFAULT '{}', -- context IDs generated during collaboration
    tasks UUID[] DEFAULT '{}', -- task IDs related to this collaboration
    metadata JSONB DEFAULT '{}',
    started_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    completed_at TIMESTAMP WITH TIME ZONE,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for performance
CREATE INDEX idx_agents_name ON agents(name);
CREATE INDEX idx_agents_status ON agents(status);
CREATE INDEX idx_agents_type ON agents(type);
CREATE INDEX idx_agents_last_seen ON agents(last_seen);

CREATE INDEX idx_agent_sessions_agent ON agent_sessions(agent_id);
CREATE INDEX idx_agent_sessions_project ON agent_sessions(project_id);
CREATE INDEX idx_agent_sessions_session ON agent_sessions(session_id);
CREATE INDEX idx_agent_sessions_status ON agent_sessions(status);
CREATE INDEX idx_agent_sessions_activity ON agent_sessions(last_activity);

CREATE INDEX idx_agent_tasks_project ON agent_tasks(project_id);
CREATE INDEX idx_agent_tasks_assigned_to ON agent_tasks(assigned_to);
CREATE INDEX idx_agent_tasks_created_by ON agent_tasks(created_by);
CREATE INDEX idx_agent_tasks_status ON agent_tasks(status);
CREATE INDEX idx_agent_tasks_priority ON agent_tasks(priority);
CREATE INDEX idx_agent_tasks_type ON agent_tasks(type);
CREATE INDEX idx_agent_tasks_created_at ON agent_tasks(created_at);

CREATE INDEX idx_agent_messages_project ON agent_messages(project_id);
CREATE INDEX idx_agent_messages_from ON agent_messages(from_agent_id);
CREATE INDEX idx_agent_messages_to ON agent_messages(to_agent_id);
CREATE INDEX idx_agent_messages_type ON agent_messages(message_type);
CREATE INDEX idx_agent_messages_created_at ON agent_messages(created_at);

CREATE INDEX idx_agent_collaborations_project ON agent_collaborations(project_id);
CREATE INDEX idx_agent_collaborations_status ON agent_collaborations(status);
CREATE INDEX idx_agent_collaborations_type ON agent_collaborations(type);
CREATE INDEX idx_agent_collaborations_started_at ON agent_collaborations(started_at);

-- GIN indexes for array columns
CREATE INDEX idx_agent_tasks_dependencies ON agent_tasks USING GIN(dependencies);
CREATE INDEX idx_agent_tasks_tags ON agent_tasks USING GIN(tags);
CREATE INDEX idx_agent_messages_context_refs ON agent_messages USING GIN(context_refs);
CREATE INDEX idx_agent_messages_task_refs ON agent_messages USING GIN(task_refs);
CREATE INDEX idx_agent_collaborations_agents ON agent_collaborations USING GIN(agents);
CREATE INDEX idx_agent_collaborations_contexts ON agent_collaborations USING GIN(contexts);
CREATE INDEX idx_agent_collaborations_tasks ON agent_collaborations USING GIN(tasks);
