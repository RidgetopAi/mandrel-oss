-- AIDIS Analytics Events Table Migration
-- Creates the canonical event logging table for all analytics tracking
-- Author: AIDIS System
-- Date: 2025-09-08

CREATE TABLE IF NOT EXISTS analytics_events (
    event_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    actor VARCHAR(20) NOT NULL, -- 'human' | 'ai' | 'system'
    project_id UUID REFERENCES projects(id),
    session_id UUID,
    context_id UUID REFERENCES contexts(id),
    event_type VARCHAR(50) NOT NULL, -- 'completion' | 'planning' | 'decision' | 'session_start' | 'session_end'
    payload JSONB,
    status VARCHAR(20), -- 'open' | 'closed' | 'error'
    duration_ms INTEGER,
    tags TEXT[],
    ai_model_used VARCHAR(100),
    prompt_tokens INTEGER,
    completion_tokens INTEGER,
    feedback INTEGER, -- -1 | 0 | 1 (thumbs down/none/up)
    metadata JSONB
);

CREATE INDEX IF NOT EXISTS idx_analytics_events_timestamp ON analytics_events(timestamp);
CREATE INDEX IF NOT EXISTS idx_analytics_events_project_id ON analytics_events(project_id);
CREATE INDEX IF NOT EXISTS idx_analytics_events_session_id ON analytics_events(session_id);
CREATE INDEX IF NOT EXISTS idx_analytics_events_event_type ON analytics_events(event_type);
CREATE INDEX IF NOT EXISTS idx_analytics_events_actor ON analytics_events(actor);

-- Add table comment
COMMENT ON TABLE analytics_events IS 'Canonical event logging table for AIDIS analytics tracking';
