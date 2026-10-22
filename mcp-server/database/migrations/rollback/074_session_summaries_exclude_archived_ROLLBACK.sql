-- ROLLBACK for migration 074 -- restores the migration 070 view definition verbatim
-- (counts INCLUDE archived child rows again). See 074 for why that is wrong; this exists
-- so the change is reversible, not because reverting is advisable.

BEGIN;

DROP VIEW IF EXISTS v_session_summaries;

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
  -- Columns not in current schema - stubbed (unchanged from migration 048)
  NULL::text as session_goal,
  NULL::text[] as tags,
  NULL::numeric as productivity_score,
  -- ::int on every COUNT — see "WHY EVERY COUNT CARRIES AN EXPLICIT ::int" above.
  -- Without it node-pg returns these as STRINGS and calcCompletionRate renders "NaN%".
  COALESCE((SELECT COUNT(*) FROM tasks t WHERE t.session_id = s.id), 0)::int as tasks_created,
  COALESCE((SELECT COUNT(*) FROM tasks t WHERE t.session_id = s.id
                                           AND t.status = 'completed'), 0)::int as tasks_completed,
  CASE
    WHEN (SELECT COUNT(*) FROM tasks t WHERE t.session_id = s.id) > 0
      THEN ROUND(
        ((SELECT COUNT(*) FROM tasks t WHERE t.session_id = s.id AND t.status = 'completed')::numeric
         / (SELECT COUNT(*) FROM tasks t WHERE t.session_id = s.id)::numeric) * 100, 2)
    ELSE 0
  END as task_completion_rate,
  COALESCE((SELECT COUNT(*) FROM contexts c WHERE c.session_id = s.id), 0)::int as contexts_created,
  -- decisions_created had no runtime writer at all (permanently 0); expose the derived
  -- count so the tool/REST surfaces stop reporting a guaranteed zero. ::int for the same
  -- reason as its three siblings, and it matches sessions.decisions_created (integer).
  COALESCE((SELECT COUNT(*) FROM technical_decisions d WHERE d.session_id = s.id), 0)::int as decisions_created,
  -- Columns not in current schema - stubbed (unchanged from migration 048)
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
-- Exclude deploy-smoke litter sessions from ALL analytics reads (migration 048).
WHERE s.agent_type IS DISTINCT FROM 'deploy-smoke';

COMMENT ON VIEW v_session_summaries IS 'Pre-joined session data for reporting. Counts derived from child tables, NOT the denormalized sessions.*_created counters. Excludes agent_type = ''deploy-smoke'' litter.';

COMMIT;
