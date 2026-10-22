-- Migration 021: Link tasks to sessions with FK
-- TS005-1: Task-Session Linking (Phase 2)
-- Date: 2025-09-29

-- Step 1: Add session_id column to tasks table
ALTER TABLE tasks
ADD COLUMN IF NOT EXISTS session_id UUID;

-- Step 2: Add foreign key constraint to sessions table (if not exists)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_tasks_session_id'
  ) THEN
    ALTER TABLE tasks
    ADD CONSTRAINT fk_tasks_session_id
    FOREIGN KEY (session_id)
    REFERENCES sessions(id)
    ON DELETE SET NULL;
  END IF;
END $$;

-- Step 3: Create index for efficient joins and filtering
CREATE INDEX IF NOT EXISTS idx_tasks_session_id
ON tasks(session_id)
WHERE session_id IS NOT NULL;

-- Step 4: Time-based backfill for existing tasks
-- Match tasks to sessions based on timestamp proximity (±1 hour window)
DO $$
DECLARE
  backfill_count INTEGER := 0;
  task_record RECORD;
  matched_session_id UUID;
BEGIN
  RAISE NOTICE 'Starting time-based backfill of task session_id...';

  -- Process tasks without session_id
  FOR task_record IN
    SELECT id, created_at, project_id
    FROM tasks
    WHERE session_id IS NULL
    ORDER BY created_at ASC
  LOOP
    -- Find matching session:
    -- 1. Same project (if task has project_id)
    -- 2. Session was active during task creation (±1 hour window)
    -- 3. Prefer active sessions over inactive ones
    -- 4. Prefer closest timestamp match
    SELECT s.id INTO matched_session_id
    FROM sessions s
    WHERE
      -- Match project if task has one
      (task_record.project_id IS NULL OR s.project_id = task_record.project_id)
      -- Session existed during task creation (±1 hour window)
      AND s.started_at <= task_record.created_at + INTERVAL '1 hour'
      AND (s.ended_at IS NULL OR s.ended_at >= task_record.created_at - INTERVAL '1 hour')
    ORDER BY
      -- Prefer active sessions
      CASE WHEN s.status = 'active' THEN 0 ELSE 1 END,
      -- Prefer closer timestamp match
      ABS(EXTRACT(EPOCH FROM (s.started_at - task_record.created_at)))
    LIMIT 1;

    -- Update task if we found a matching session
    IF matched_session_id IS NOT NULL THEN
      UPDATE tasks
      SET
        session_id = matched_session_id,
        metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
          'backfilled_session_id', true,
          'backfill_timestamp', CURRENT_TIMESTAMP,
          'backfill_method', 'time_proximity'
        )
      WHERE id = task_record.id;

      backfill_count := backfill_count + 1;
    END IF;
  END LOOP;

  RAISE NOTICE 'Backfilled % tasks with session_id', backfill_count;
END $$;

-- Step 5: Add column comment
COMMENT ON COLUMN tasks.session_id IS 'Link to session where task was created. Nullable for tasks created outside of sessions or before migration. Used for session analytics and task filtering.';

-- Step 6: Verification query
DO $$
DECLARE
  total_tasks INTEGER;
  tasks_with_session INTEGER;
  backfill_percentage NUMERIC;
BEGIN
  -- Count total tasks
  SELECT COUNT(*) INTO total_tasks FROM tasks;

  -- Count tasks with session_id
  SELECT COUNT(*) INTO tasks_with_session
  FROM tasks
  WHERE session_id IS NOT NULL;

  -- Calculate percentage
  IF total_tasks > 0 THEN
    backfill_percentage := (tasks_with_session::NUMERIC / total_tasks::NUMERIC * 100);
  ELSE
    backfill_percentage := 0;
  END IF;

  RAISE NOTICE '=== Migration 021 Verification ===';
  RAISE NOTICE 'Total tasks: %', total_tasks;
  RAISE NOTICE 'Tasks with session_id: % (% percent)', tasks_with_session, ROUND(backfill_percentage, 1);

  IF tasks_with_session > 0 THEN
    RAISE NOTICE '✅ Migration successful - % percent of tasks linked to sessions', ROUND(backfill_percentage, 1);
  ELSE
    RAISE WARNING '⚠️  No tasks linked - this may be expected if no matching sessions found';
  END IF;
END $$;

-- Performance note: Index ensures O(log n) lookups when filtering tasks by session