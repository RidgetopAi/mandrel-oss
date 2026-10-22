-- =====================================================================
-- SSE Real-Time Updates - Database Triggers Migration
-- =====================================================================
-- Created: 2025-10-30
-- Purpose: Add PostgreSQL NOTIFY/LISTEN triggers for real-time events
-- 
-- This migration creates:
-- 1. Generic trigger function: notify_aidis_change()
-- 2. Triggers on 5 entity tables: contexts, agent_tasks, technical_decisions, 
--    projects, sessions
-- 3. NOTIFY channel: aidis_changes
--
-- Events are broadcast as JSON with minimal payload:
-- {
--   "entity": "tasks",
--   "action": "insert",
--   "id": "uuid-here",
--   "projectId": "uuid-here",
--   "at": "2025-10-30T21:00:00.000Z"
-- }
-- =====================================================================

-- Drop existing function and triggers if they exist (for re-running migration)
DROP TRIGGER IF EXISTS trg_contexts_notify ON contexts;
DROP TRIGGER IF EXISTS trg_agent_tasks_notify ON agent_tasks;
DROP TRIGGER IF EXISTS trg_technical_decisions_notify ON technical_decisions;
DROP TRIGGER IF EXISTS trg_projects_notify ON projects;
DROP TRIGGER IF EXISTS trg_sessions_notify ON sessions;
DROP FUNCTION IF EXISTS notify_aidis_change();

-- =====================================================================
-- Generic Trigger Function
-- =====================================================================
-- This function is called by triggers on all entity tables.
-- It emits a NOTIFY message on the 'aidis_changes' channel with
-- minimal JSON payload containing entity, action, id, projectId, and timestamp.
-- =====================================================================

CREATE OR REPLACE FUNCTION notify_aidis_change() RETURNS trigger AS $$
DECLARE
  v_id uuid;
  v_project_id uuid;
  v_entity text;
  v_action text;
BEGIN
  -- Get ID from NEW (insert/update) or OLD (delete)
  v_id := COALESCE(NEW.id, OLD.id);
  
  -- Get project_id if it exists (some tables may not have this column)
  BEGIN
    v_project_id := COALESCE(NEW.project_id, OLD.project_id);
  EXCEPTION WHEN undefined_column THEN
    v_project_id := NULL;
  END;
  
  -- Map table name to entity name (handle technical_decisions -> decisions, agent_tasks -> tasks)
  v_entity := CASE TG_TABLE_NAME
    WHEN 'technical_decisions' THEN 'decisions'
    WHEN 'agent_tasks' THEN 'tasks'
    ELSE TG_TABLE_NAME
  END;
  
  -- Map operation to action (INSERT -> insert, UPDATE -> update, DELETE -> delete)
  v_action := lower(TG_OP);
  
  -- Emit NOTIFY with JSON payload
  PERFORM pg_notify(
    'aidis_changes',
    json_build_object(
      'entity', v_entity,
      'action', v_action,
      'id', v_id,
      'projectId', v_project_id,
      'at', to_char(NOW() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    )::text
  );
  
  -- Trigger must return NULL for AFTER triggers
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- Add comment to function
COMMENT ON FUNCTION notify_aidis_change() IS 
  'Generic trigger function that emits NOTIFY events on the aidis_changes channel when database records change. Used for real-time SSE updates.';

-- =====================================================================
-- Create Triggers on Entity Tables
-- =====================================================================
-- After any INSERT, UPDATE, or DELETE on these tables, emit a NOTIFY event
-- =====================================================================

-- Contexts table
CREATE TRIGGER trg_contexts_notify
  AFTER INSERT OR UPDATE OR DELETE ON contexts
  FOR EACH ROW 
  EXECUTE FUNCTION notify_aidis_change();

COMMENT ON TRIGGER trg_contexts_notify ON contexts IS 
  'SSE real-time update trigger - emits NOTIFY on aidis_changes channel';

-- Agent Tasks table (exposed as 'tasks' entity)
CREATE TRIGGER trg_agent_tasks_notify
  AFTER INSERT OR UPDATE OR DELETE ON agent_tasks
  FOR EACH ROW 
  EXECUTE FUNCTION notify_aidis_change();

COMMENT ON TRIGGER trg_agent_tasks_notify ON agent_tasks IS 
  'SSE real-time update trigger - emits NOTIFY on aidis_changes channel';

-- Technical Decisions table (maps to 'decisions' entity)
CREATE TRIGGER trg_technical_decisions_notify
  AFTER INSERT OR UPDATE OR DELETE ON technical_decisions
  FOR EACH ROW 
  EXECUTE FUNCTION notify_aidis_change();

COMMENT ON TRIGGER trg_technical_decisions_notify ON technical_decisions IS 
  'SSE real-time update trigger - emits NOTIFY on aidis_changes channel';

-- Projects table
CREATE TRIGGER trg_projects_notify
  AFTER INSERT OR UPDATE OR DELETE ON projects
  FOR EACH ROW 
  EXECUTE FUNCTION notify_aidis_change();

COMMENT ON TRIGGER trg_projects_notify ON projects IS 
  'SSE real-time update trigger - emits NOTIFY on aidis_changes channel';

-- Sessions table
CREATE TRIGGER trg_sessions_notify
  AFTER INSERT OR UPDATE OR DELETE ON sessions
  FOR EACH ROW 
  EXECUTE FUNCTION notify_aidis_change();

COMMENT ON TRIGGER trg_sessions_notify ON sessions IS 
  'SSE real-time update trigger - emits NOTIFY on aidis_changes channel';

-- =====================================================================
-- Verification Query
-- =====================================================================
-- Run this to verify all triggers were created successfully:
--
-- SELECT 
--   tablename, 
--   triggername, 
--   tgtype 
-- FROM pg_trigger t
-- JOIN pg_class c ON t.tgrelid = c.oid
-- JOIN pg_namespace n ON c.relnamespace = n.oid
-- WHERE n.nspname = 'public'
--   AND triggername LIKE '%_notify'
-- ORDER BY tablename;
-- =====================================================================

-- Success message
DO $$
BEGIN
  RAISE NOTICE 'SSE Triggers Migration Complete!';
  RAISE NOTICE 'Created trigger function: notify_aidis_change()';
  RAISE NOTICE 'Created triggers on 5 tables: contexts, agent_tasks, technical_decisions, projects, sessions';
  RAISE NOTICE 'NOTIFY channel: aidis_changes';
  RAISE NOTICE '';
  RAISE NOTICE 'Test with: LISTEN aidis_changes;';
END$$;
