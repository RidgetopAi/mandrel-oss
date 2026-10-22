-- Migration 007: Add task progress column
-- This migration adds a progress column to agent_tasks table

-- Add progress column to track task completion percentage
ALTER TABLE agent_tasks ADD COLUMN progress INTEGER DEFAULT 0 CHECK (progress >= 0 AND progress <= 100);

-- Add index for progress column
CREATE INDEX idx_agent_tasks_progress ON agent_tasks(progress);

-- Update completed tasks to have 100% progress
UPDATE agent_tasks SET progress = 100 WHERE status = 'completed';
