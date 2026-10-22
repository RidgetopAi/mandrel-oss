-- Migration 026: Add Session Activity Tracking
-- TS007-2: Track task and context activity per session
-- Following TS006-2 token tracking pattern
-- Created: 2025-09-30

BEGIN;

-- ============================================================================
-- PART 1: Add activity columns to sessions table
-- ============================================================================

-- Add task activity tracking columns
ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS tasks_created INTEGER DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS tasks_updated INTEGER DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS tasks_completed INTEGER DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS contexts_created INTEGER DEFAULT 0 NOT NULL;

-- Add comments for documentation
COMMENT ON COLUMN sessions.tasks_created IS 'Number of tasks created during this session';
COMMENT ON COLUMN sessions.tasks_updated IS 'Number of task updates during this session';
COMMENT ON COLUMN sessions.tasks_completed IS 'Number of tasks completed during this session';
COMMENT ON COLUMN sessions.contexts_created IS 'Number of contexts created during this session';

-- ============================================================================
-- PART 2: Add same columns to user_sessions for consistency
-- ============================================================================

-- Check if user_sessions table exists before modifying
DO $$
BEGIN
  IF EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'user_sessions') THEN
    ALTER TABLE user_sessions
      ADD COLUMN IF NOT EXISTS tasks_created INTEGER DEFAULT 0 NOT NULL,
      ADD COLUMN IF NOT EXISTS tasks_updated INTEGER DEFAULT 0 NOT NULL,
      ADD COLUMN IF NOT EXISTS tasks_completed INTEGER DEFAULT 0 NOT NULL,
      ADD COLUMN IF NOT EXISTS contexts_created INTEGER DEFAULT 0 NOT NULL;

    COMMENT ON COLUMN user_sessions.tasks_created IS 'Number of tasks created during this session';
    COMMENT ON COLUMN user_sessions.tasks_updated IS 'Number of task updates during this session';
    COMMENT ON COLUMN user_sessions.tasks_completed IS 'Number of tasks completed during this session';
    COMMENT ON COLUMN user_sessions.contexts_created IS 'Number of contexts created during this session';
  END IF;
END $$;

-- ============================================================================
-- PART 3: Backfill historical data from actual counts
-- ============================================================================

-- Backfill tasks_created by counting tasks linked to each session
UPDATE sessions s
SET tasks_created = COALESCE(
  (SELECT COUNT(*)::INTEGER FROM tasks t WHERE t.session_id = s.id),
  0
)
WHERE tasks_created = 0;

-- Backfill contexts_created by counting contexts linked to each session
UPDATE sessions s
SET contexts_created = COALESCE(
  (SELECT COUNT(*)::INTEGER FROM contexts c WHERE c.session_id = s.id),
  0
)
WHERE contexts_created = 0;

-- Note: tasks_updated and tasks_completed cannot be backfilled accurately
-- as we don't have historical update/completion logs. These will start
-- tracking from now forward.

-- ============================================================================
-- PART 4: Create indexes for performance
-- ============================================================================

-- Index for filtering/sorting by activity
CREATE INDEX IF NOT EXISTS idx_sessions_tasks_created ON sessions(tasks_created) WHERE tasks_created > 0;
CREATE INDEX IF NOT EXISTS idx_sessions_contexts_created ON sessions(contexts_created) WHERE contexts_created > 0;

-- Composite index for activity-based queries
CREATE INDEX IF NOT EXISTS idx_sessions_activity_summary ON sessions(tasks_created, tasks_completed, contexts_created);

-- ============================================================================
-- PART 5: Verification
-- ============================================================================

-- Display summary of changes
DO $$
DECLARE
  total_sessions INTEGER;
  sessions_with_tasks INTEGER;
  sessions_with_contexts INTEGER;
  total_tasks_backfilled INTEGER;
  total_contexts_backfilled INTEGER;
BEGIN
  -- Get counts
  SELECT COUNT(*) INTO total_sessions FROM sessions;
  SELECT COUNT(*) INTO sessions_with_tasks FROM sessions WHERE tasks_created > 0;
  SELECT COUNT(*) INTO sessions_with_contexts FROM sessions WHERE contexts_created > 0;
  SELECT COALESCE(SUM(tasks_created), 0) INTO total_tasks_backfilled FROM sessions;
  SELECT COALESCE(SUM(contexts_created), 0) INTO total_contexts_backfilled FROM sessions;

  -- Display results
  RAISE NOTICE '';
  RAISE NOTICE '════════════════════════════════════════════════════════════';
  RAISE NOTICE 'Migration 026: Session Activity Tracking - COMPLETE';
  RAISE NOTICE '════════════════════════════════════════════════════════════';
  RAISE NOTICE '';
  RAISE NOTICE 'Columns Added:';
  RAISE NOTICE '  ✅ tasks_created';
  RAISE NOTICE '  ✅ tasks_updated';
  RAISE NOTICE '  ✅ tasks_completed';
  RAISE NOTICE '  ✅ contexts_created';
  RAISE NOTICE '';
  RAISE NOTICE 'Backfill Results:';
  RAISE NOTICE '  📊 Total sessions: %', total_sessions;
  RAISE NOTICE '  📋 Sessions with tasks: % (% tasks total)', sessions_with_tasks, total_tasks_backfilled;
  RAISE NOTICE '  💬 Sessions with contexts: % (% contexts total)', sessions_with_contexts, total_contexts_backfilled;
  RAISE NOTICE '';
  RAISE NOTICE 'Indexes Created:';
  RAISE NOTICE '  ✅ idx_sessions_tasks_created';
  RAISE NOTICE '  ✅ idx_sessions_contexts_created';
  RAISE NOTICE '  ✅ idx_sessions_activity_summary';
  RAISE NOTICE '';
  RAISE NOTICE '════════════════════════════════════════════════════════════';
END $$;

COMMIT;
