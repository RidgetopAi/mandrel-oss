-- Migration 019: Add session status enum and activity timeout tracking
-- TS004-1: Session Status Enum + 2-Hour Timeout Implementation
-- Date: 2025-09-29

-- Step 1: Add status column with enum constraint
ALTER TABLE sessions
ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'active';

-- Add CHECK constraint for status enum
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'sessions_status_check'
      AND conrelid = 'sessions'::regclass
  ) THEN
    ALTER TABLE sessions
    ADD CONSTRAINT sessions_status_check
    CHECK (status IN ('active', 'inactive', 'disconnected'));
  END IF;
END $$;

-- Step 2: Add last_activity_at column for timeout tracking
ALTER TABLE sessions
ADD COLUMN IF NOT EXISTS last_activity_at TIMESTAMP WITH TIME ZONE;

-- Step 3: Backfill existing data
-- For sessions with ended_at, mark as inactive and set last activity
UPDATE sessions
SET
  status = 'inactive',
  last_activity_at = COALESCE(ended_at, started_at)
WHERE ended_at IS NOT NULL AND status = 'active';

-- For sessions without ended_at, mark as active with current last activity
UPDATE sessions
SET
  status = 'active',
  last_activity_at = COALESCE(last_activity_at, started_at, CURRENT_TIMESTAMP)
WHERE ended_at IS NULL AND last_activity_at IS NULL;

-- Step 4: Create indexes for efficient timeout queries
CREATE INDEX IF NOT EXISTS idx_sessions_status
ON sessions(status)
WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_sessions_last_activity
ON sessions(last_activity_at)
WHERE status = 'active' AND last_activity_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_sessions_timeout_check
ON sessions(status, last_activity_at)
WHERE status = 'active';

-- Step 5: Add column comments for documentation
COMMENT ON COLUMN sessions.status IS
'Session status: active (currently running), inactive (ended or timed out), disconnected (project archived/disconnected)';

COMMENT ON COLUMN sessions.last_activity_at IS
'Last activity timestamp for timeout tracking. Updated on context storage, task operations, decisions, etc. Timeout threshold: 2 hours.';

-- Step 6: Create helper function to timeout sessions
CREATE OR REPLACE FUNCTION timeout_inactive_sessions(timeout_threshold INTERVAL DEFAULT '2 hours')
RETURNS TABLE(session_id UUID, timed_out_at TIMESTAMP WITH TIME ZONE) AS $$
BEGIN
  RETURN QUERY
  UPDATE sessions
  SET
    status = 'inactive',
    ended_at = CURRENT_TIMESTAMP
  WHERE status = 'active'
    AND last_activity_at IS NOT NULL
    AND last_activity_at < (CURRENT_TIMESTAMP - timeout_threshold)
    AND ended_at IS NULL
  RETURNING id, CURRENT_TIMESTAMP;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION timeout_inactive_sessions IS
'Helper function to automatically timeout sessions that have been inactive beyond the threshold (default: 2 hours). Called by sessionTimeout service.';

-- Step 7: Create trigger to auto-update last_activity_at on session updates
CREATE OR REPLACE FUNCTION update_session_activity()
RETURNS TRIGGER AS $$
BEGIN
  -- Only update last_activity_at if session is active
  IF NEW.status = 'active' THEN
    NEW.last_activity_at = CURRENT_TIMESTAMP;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create trigger (only for explicit updates, not for all changes)
DROP TRIGGER IF EXISTS trigger_update_session_activity ON sessions;
CREATE TRIGGER trigger_update_session_activity
  BEFORE UPDATE ON sessions
  FOR EACH ROW
  WHEN (OLD.metadata IS DISTINCT FROM NEW.metadata OR OLD.title IS DISTINCT FROM NEW.title)
  EXECUTE FUNCTION update_session_activity();

-- Step 8: Create helper function to find timed-out sessions (read-only)
CREATE OR REPLACE FUNCTION find_timed_out_sessions(timeout_threshold INTERVAL DEFAULT '2 hours')
RETURNS TABLE(
  session_id UUID,
  project_id UUID,
  agent_type VARCHAR(50),
  started_at TIMESTAMP WITH TIME ZONE,
  last_activity_at TIMESTAMP WITH TIME ZONE,
  inactive_duration INTERVAL
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    s.id,
    s.project_id,
    s.agent_type,
    s.started_at,
    s.last_activity_at,
    CURRENT_TIMESTAMP - s.last_activity_at AS inactive_duration
  FROM sessions s
  WHERE s.status = 'active'
    AND s.last_activity_at IS NOT NULL
    AND s.last_activity_at < (CURRENT_TIMESTAMP - timeout_threshold)
    AND s.ended_at IS NULL
  ORDER BY s.last_activity_at ASC;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION find_timed_out_sessions IS
'Read-only helper to find sessions that should be timed out. Useful for monitoring and debugging.';

-- Step 9: Add validation check to ensure data integrity
DO $$
DECLARE
  invalid_count INTEGER;
BEGIN
  -- Check for sessions with status=active but have ended_at set
  SELECT COUNT(*) INTO invalid_count
  FROM sessions
  WHERE status = 'active' AND ended_at IS NOT NULL;

  IF invalid_count > 0 THEN
    RAISE WARNING 'Found % sessions with status=active but ended_at is set. Fixing...', invalid_count;
    UPDATE sessions SET status = 'inactive' WHERE status = 'active' AND ended_at IS NOT NULL;
  END IF;

  -- Check for sessions without last_activity_at
  SELECT COUNT(*) INTO invalid_count
  FROM sessions
  WHERE last_activity_at IS NULL;

  IF invalid_count > 0 THEN
    RAISE WARNING 'Found % sessions without last_activity_at. Fixing...', invalid_count;
    UPDATE sessions
    SET last_activity_at = COALESCE(ended_at, started_at, CURRENT_TIMESTAMP)
    WHERE last_activity_at IS NULL;
  END IF;
END $$;

-- Performance note: Indexes will make timeout checks very fast (<10ms for typical workloads)