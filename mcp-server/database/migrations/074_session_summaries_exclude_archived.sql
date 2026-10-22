-- Migration 074: v_session_summaries excludes ARCHIVED child rows from its counts.
--
-- WHY. Every session count in this view -- tasks_created, tasks_completed,
-- task_completion_rate, contexts_created, decisions_created -- counted soft-deleted
-- (archived_at IS NOT NULL) child rows, while context_search / decision_search / task_list
-- exclude them by default. Measured on live prod 2026-07-30: 18 archived contexts, 429
-- archived decisions, 23 archived tasks were inflating these numbers.
--
-- THIS IS COPY 1 OF A THREE-COPY RULE. The other two are patched in the SAME change:
--   COPY 2  mcp-server/src/services/session/infra/db/SessionRepo.ts (IDENTITY_SELECT,
--           getFinalCounts, the productivity read, countDecisions) + SessionManagementHandler
--           + SessionStatsService
--   COPY 3  mandrel-command/backend/src/services/sessionCounts.ts
-- Patching fewer than all three would create exactly the divergence
-- sessionCountRule.contract.test.ts exists to prevent -- and that guard could NOT have
-- caught it, because its fixture archives nothing. The fixture is extended in this change
-- so the archived axis is guarded from now on.
--
-- SHAPE: CREATE OR REPLACE is deliberately NOT used -- migration 070 documents that a
-- replace cannot change a view column's data type. This drops and recreates, exactly as 070
-- did, and every column keeps its name, order, and type (the ::int casts are preserved
-- verbatim, including the "cast OUTSIDE the COALESCE" rule 070 calls out). The ONLY change
-- is an added AND <alias>.archived_at IS NULL inside each count subquery.
--
-- SAFETY: these are correlated SUBQUERIES, not joins, so narrowing them can only move a
-- count toward 0. COALESCE(...,0) already covers the no-rows case, so a session with zero
-- live child rows still reports 0 -- no session can vanish from the view or go NULL.
-- The deploy-smoke exclusion and the LEFT JOIN to projects are untouched.
--
-- REVERSIBLE: database/migrations/rollback/074_session_summaries_exclude_archived_ROLLBACK.sql
-- restores the 070 definition verbatim.

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
  COALESCE((SELECT COUNT(*) FROM tasks t WHERE t.session_id = s.id
                                           AND t.archived_at IS NULL), 0)::int as tasks_created,
  COALESCE((SELECT COUNT(*) FROM tasks t WHERE t.session_id = s.id
                                           AND t.archived_at IS NULL
                                           AND t.status = 'completed'), 0)::int as tasks_completed,
  CASE
    WHEN (SELECT COUNT(*) FROM tasks t WHERE t.session_id = s.id
                                           AND t.archived_at IS NULL) > 0
      THEN ROUND(
        ((SELECT COUNT(*) FROM tasks t WHERE t.session_id = s.id
                                           AND t.archived_at IS NULL AND t.status = 'completed')::numeric
         / (SELECT COUNT(*) FROM tasks t WHERE t.session_id = s.id
                                           AND t.archived_at IS NULL)::numeric) * 100, 2)
    ELSE 0
  END as task_completion_rate,
  COALESCE((SELECT COUNT(*) FROM contexts c WHERE c.session_id = s.id
                                           AND c.archived_at IS NULL), 0)::int as contexts_created,
  -- decisions_created had no runtime writer at all (permanently 0); expose the derived
  -- count so the tool/REST surfaces stop reporting a guaranteed zero. ::int for the same
  -- reason as its three siblings, and it matches sessions.decisions_created (integer).
  COALESCE((SELECT COUNT(*) FROM technical_decisions d WHERE d.session_id = s.id
                                           AND d.archived_at IS NULL), 0)::int as decisions_created,
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
