-- Migration 022: Add foreign key constraint to tasks.project_id
-- Prevents orphaned tasks at database level

-- Check and add foreign key constraint (if not exists)
DO $$
DECLARE
  orphan_count INTEGER;
BEGIN
  -- Skip if constraint already exists
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_tasks_project') THEN
    RAISE NOTICE 'Migration 022: FK constraint already exists, skipping';
    RETURN;
  END IF;

  -- Verify no orphaned tasks exist
  SELECT COUNT(*) INTO orphan_count
  FROM tasks t
  WHERE t.project_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM projects p WHERE p.id = t.project_id);

  IF orphan_count > 0 THEN
    RAISE EXCEPTION 'Cannot add constraint: % orphaned tasks found', orphan_count;
  END IF;

  -- Add foreign key constraint
  ALTER TABLE tasks
  ADD CONSTRAINT fk_tasks_project
  FOREIGN KEY (project_id)
  REFERENCES projects(id)
  ON DELETE CASCADE;

  RAISE NOTICE 'Migration 022: Added FK constraint';
END $$;

-- Add index for performance
CREATE INDEX IF NOT EXISTS idx_tasks_project_id ON tasks(project_id);
