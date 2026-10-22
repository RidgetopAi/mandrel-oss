-- Migration 018: Add agent_display_name column to sessions table
-- TS002-1: Agent Auto-Detection Implementation
-- Date: 2025-09-29

-- Add agent_display_name column to sessions table
-- This allows user-customizable display names for agents while keeping
-- machine-readable agent_type for analytics and filtering
ALTER TABLE sessions
ADD COLUMN IF NOT EXISTS agent_display_name VARCHAR(100);

-- Add index for filtering and analytics
CREATE INDEX IF NOT EXISTS idx_sessions_agent_display_name
ON sessions(agent_display_name)
WHERE agent_display_name IS NOT NULL;

-- Update existing records with default display names
-- Maps legacy agent_type values to human-readable display names
UPDATE sessions
SET agent_display_name = CASE agent_type
  WHEN 'claude-code-agent' THEN 'Claude Code'
  WHEN 'claude-code' THEN 'Claude Code'
  WHEN 'cline' THEN 'Cline'
  WHEN 'roo-code' THEN 'Roo Code'
  WHEN 'windsurf' THEN 'Windsurf'
  WHEN 'cursor' THEN 'Cursor'
  WHEN 'web' THEN 'Web UI'
  WHEN 'mcp' THEN 'MCP Client'
  WHEN 'mcp-client' THEN 'MCP Client'
  ELSE 'Unknown Agent'
END
WHERE agent_display_name IS NULL;

-- Add helpful comment for documentation
COMMENT ON COLUMN sessions.agent_display_name IS 'Human-readable agent display name (e.g., "Claude Code", "Cline", "Roo Code"). User-customizable for cross-platform analytics and identification. Auto-populated from agent_type on session creation.';

-- Normalize legacy agent_type values for consistency
UPDATE sessions
SET agent_type = 'claude-code'
WHERE agent_type = 'claude-code-agent';

UPDATE sessions
SET agent_type = 'web-ui'
WHERE agent_type = 'web';

UPDATE sessions
SET agent_type = 'mcp-client'
WHERE agent_type = 'mcp';

-- Add comment to agent_type column for clarity
COMMENT ON COLUMN sessions.agent_type IS 'Machine-readable agent type identifier (lowercase, hyphenated). Used for programmatic filtering and analytics. Examples: claude-code, cline, roo-code, windsurf, cursor, mcp-client';