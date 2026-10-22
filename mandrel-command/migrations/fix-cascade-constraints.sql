BEGIN;

-- Fix analytics_events (PRIMARY BLOCKER - 6,829 records)
ALTER TABLE analytics_events
  DROP CONSTRAINT analytics_events_project_id_fkey,
  ADD CONSTRAINT analytics_events_project_id_fkey 
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;

-- Fix event_log (0 records)
ALTER TABLE event_log
  DROP CONSTRAINT event_log_project_id_fkey,
  ADD CONSTRAINT event_log_project_id_fkey 
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;

-- Fix pattern_operation_metrics
ALTER TABLE pattern_operation_metrics
  DROP CONSTRAINT pattern_operation_metrics_project_id_fkey,
  ADD CONSTRAINT pattern_operation_metrics_project_id_fkey 
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;

-- Remove duplicate constraint on sessions
ALTER TABLE sessions
  DROP CONSTRAINT fk_sessions_project;

-- Fix user_sessions (133 records)
ALTER TABLE user_sessions
  DROP CONSTRAINT user_sessions_project_id_fkey,
  ADD CONSTRAINT user_sessions_project_id_fkey 
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;

COMMIT;
