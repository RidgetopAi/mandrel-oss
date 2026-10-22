-- Migration: Exclude deploy-smoke sessions from session analytics
-- Date: 2026-06-20
-- Task: bc819ae5 (deploy-smoke leaves litter sessions)
-- Purpose:
--   The fleet deploy smoke (fleet-deploy script) POSTs /api/v2/sessions/start
--   to every instance on every deploy to prove the session write-path is alive.
--   That created a real, untitled, never-ended `sessions` row PER INSTANCE PER
--   DEPLOY — litter that polluted the sessions list and the session stats fleet-wide.
--
--   The smoke now MARKS those sessions with agent_type = 'deploy-smoke' (and ends
--   them immediately as best-effort cleanup). This migration is the DEFENSE-IN-DEPTH
--   half of the fix: it EXCLUDES any session marked 'deploy-smoke' from the
--   analytics surface at the view layer, so even if a smoke session is NOT cleaned
--   up (cleanup is best-effort / can fail on a flaky deploy), it can never count.
--
--   This guards the whole CLASS at the read boundary: v_session_summaries
--   feeds the sessions list, single-session detail, and the compare endpoint. The
--   stats query (SessionStatsService.getSessionStatsEnhanced) reads `FROM sessions`
--   directly and is guarded in code with the SAME predicate — the two read paths
--   share one marker, DEPLOY_SMOKE_AGENT_TYPE = 'deploy-smoke'.
--
--   IS DISTINCT FROM (not !=) so a NULL agent_type row is KEPT (NULL = 'x' is NULL,
--   which would wrongly drop legitimate legacy rows whose agent_type is null).

BEGIN;

-- DROP then CREATE (not CREATE OR REPLACE): CREATE OR REPLACE cannot change a
-- column's data type, and the baseline declares productivity_score as
-- numeric(5,2) while this view (like migration 031) stubs it as plain numeric —
-- so a replace fails with 42P16 "cannot change data type of view column".
-- A clean DROP + CREATE sidesteps that. No dependent objects rely on this view.
DROP VIEW IF EXISTS v_session_summaries;

-- Recreate v_session_summaries (identical to 031 + the deploy-smoke exclusion).
CREATE VIEW v_session_summaries AS
SELECT
  s.id,
  s.display_id,
  s.project_id,
  p.name as project_name,
  s.agent_type,
  s.started_at,
  s.ended_at,
  EXTRACT(EPOCH FROM (COALESCE(s.ended_at, NOW()) - s.started_at)) / 60 as duration_minutes,
  s.status,
  s.title,
  s.description,
  -- Columns not in current schema - stubbed
  NULL::text as session_goal,
  NULL::text[] as tags,
  NULL::numeric as productivity_score,
  s.tasks_created,
  s.tasks_completed,
  CASE
    WHEN s.tasks_created > 0 THEN ROUND((s.tasks_completed::numeric / s.tasks_created::numeric) * 100, 2)
    ELSE 0
  END as task_completion_rate,
  s.contexts_created,
  -- Columns not in current schema - stubbed
  0::integer as lines_added,
  0::integer as lines_deleted,
  0::integer as lines_net,
  0::integer as files_modified_count,
  0::integer as activity_count,
  s.input_tokens,
  s.output_tokens,
  s.total_tokens,
  NULL::text as ai_model,
  s.last_activity_at,
  s.metadata
FROM sessions s
LEFT JOIN projects p ON s.project_id = p.id
-- Exclude deploy-smoke litter sessions from ALL analytics reads.
WHERE s.agent_type IS DISTINCT FROM 'deploy-smoke';

COMMENT ON VIEW v_session_summaries IS 'Phase 3: Pre-joined session data with calculated fields for reporting. Excludes agent_type = ''deploy-smoke'' litter.';

COMMIT;
