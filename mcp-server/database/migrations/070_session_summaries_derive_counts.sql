-- Migration 070: v_session_summaries derives its counts from the child tables
-- Task: 3f9fb289 (session counter columns render 0 once a session ends)
--
-- WHY THIS VIEW IS IN SCOPE: it is the UPSTREAM of four surfaces that all rendered zeros —
-- `/api/v2/sessions` (list), `/api/v2/sessions/:id` (detail), `/api/v2/sessions/compare`
-- (all three via sessionAnalyticsController) and the `session_summary` MCP tool (via
-- SessionStatsService.generateSessionSummary → sessionFormatters). Fixing the formatters
-- would have been fixing four symptoms of one cause; the view IS the cause, so it is the
-- single place the rule belongs.
--
-- WHAT WAS WRONG: the view selected s.tasks_created / s.tasks_completed / s.contexts_created
-- straight from the denormalized counter columns, and derived task_completion_rate from
-- them. SessionRepo.finish() ABSOLUTE-SET those columns from an in-memory map that holds a
-- DELTA since the last 30 s flush — normally empty by then — so every finalized session's
-- counters were overwritten with zero (measured on prod 2026-07-26: 79 of 114 `ended`
-- sessions had contexts_created = 0 while their contexts still existed). The write path is
-- fixed in the same commit; this view additionally makes the READ correct for the ~79
-- historical rows whose counter columns are already destroyed and, unlike tokens, ARE
-- recomputable.
--
-- COUNT SEMANTICS — ONE RULE, THREE COPIES THAT MUST AGREE:
--   COPY 1  this view
--   COPY 2  SessionRepo.IDENTITY_SELECT + SessionRepo.getFinalCounts (mcp-server)
--   COPY 3  mandrel-command/backend/src/services/sessionCounts.ts
-- They cannot be collapsed into one accessor (a Postgres view cannot import TypeScript,
-- and mcp-server does not import backend code), so what keeps them agreeing is a pair of
-- contract tests — one per package, each building an EQUIVALENT cross-project fixture (same
-- shape, same expected literals) — that EXECUTE their copies and compare the numbers:
--   mcp-server/src/tests/sessionCountRule.contract.test.ts               (COPY 2, + this view)
--   mandrel-command/backend/src/__tests__/sessionCountRule.contract.test.ts (COPY 3, + this view)
-- Both halves assert the SAME literal expected counts and both pin THIS VIEW, so the view
-- is the shared link and the three copies are transitively locked together. Neither reads
-- this file as text — Postgres executes it, which is the only thing that proves behaviour
--. Their fixture deliberately gives the session child rows in a SECOND
-- project: with a single-project fixture the buggy `AND c.project_id = s.project_id` is
-- trivially true and a drifted copy passes green, so both suites assert that cross-project
-- spread as an explicit precondition.
--
-- The rule itself:
--   * contexts  → session linkage ONLY (c.session_id = s.id). We deliberately do NOT also
--     require c.project_id = s.project_id: long-running sessions did mid-session
--     project_switches, and that condition drops 1715 of 7271 legitimately session-linked
--     contexts on prod (24%). This view has no project filter, so it is the "global" rule.
--   * tasks     → t.session_id = s.id. NOT `s.id::text = t.created_by`, which the sessions
--     list used: `tasks.created_by` holds an ACTOR NAME (coordinator / system / curator / …), and
--     measured on prod 2026-07-26 that predicate matched 0 of 3195 tasks across 0 of 457
--     sessions, while t.session_id matched 2731 tasks across 205 sessions. Strictly a gain:
--     no session loses coverage, because no session had any.
--   * tokens    → the s.total_tokens COLUMN, unchanged. Tokens have no child table and are
--     NOT recomputable (recordTokenUsage writes only the in-memory TokenStore, and the
--     session_end analytics event omits them), so this column is their only durable record.
--     For sessions zeroed by the pre-fix finish(), token history is LOST. No backfill exists
--     and none is possible.
--
-- Correlated subqueries, not LEFT JOINs: two LEFT JOINs under one aggregate fan out
-- cartesian-style and inflate BOTH counts by the other's cardinality. Indexes:
-- idx_contexts_session_id (002), idx_tasks_session_id (021),
-- idx_technical_decisions_session_id (069, immediately preceding).
--
-- DROP + CREATE rather than CREATE OR REPLACE, for the same reason migration 048 gives:
-- a replace cannot change a view column's data type, and COUNT(*) returns bigint where the
-- underlying columns are integer. No dependent objects rely on this view.
--
-- ── WHY EVERY COUNT CARRIES AN EXPLICIT ::int (the reviewer B2) ───────────────────────────
-- `COUNT(*)` returns **bigint**. node-pg has no int8 parser by default (there is no
-- setTypeParser anywhere in this repo — both packages grepped), so it hands int8 back to
-- JavaScript as a **STRING**. Left uncast, this migration would have silently flipped four
-- view columns onto the string wire form, which is a BREAKING CHANGE for every mcp-server
-- consumer that issues `SELECT * FROM v_session_summaries` and then treats the result as a
-- number. Measured against this exact view on a migrated disposable DB with the real driver:
--
--     tasks_created  value='0'  typeof=string
--     sessionFormatters.calcCompletionRate({tasks_created:'0', ...})  ->  NaN
--     rendered:  "NaN% completion rate"
--
-- because `'0' === 0` is false, so the divide-by-zero guard never fires. That NaN reaches a
-- live bearer-authed surface (`/api/v2/sessions/compare`, healthServer.ts), and the raw
-- string counts reach `/api/v2/sessions` + `/api/v2/sessions/:id`, whose OpenAPI schema
-- declares these fields `type: 'integer'`.
--
-- The cast lives HERE, in the view, rather than at each consumer, for two reasons:
--   1. ONE place. There are four `SELECT *` consumers in mcp-server alone; coercing at each
--      is four copies that drift.
--   2. It restores the type PROD HAS TODAY, exactly. Measured on prod 2026-07-26:
--      tasks_created / tasks_completed / contexts_created are all `integer`. With ::int this
--      migration changes the SOURCE of those numbers without changing their TYPE, so no
--      downstream consumer has to know it happened. decisions_created is a NEW column and
--      ::int matches its base-table counterpart (sessions.decisions_created integer).
--   (A global `pg.types.setTypeParser(20, …)` was rejected: it would re-type every int8 in
--    the process — including ids and token totals — and silently lose precision above 2^53.)
--
-- DELIBERATELY NOT CAST — these are string-on-the-wire BY CONTRACT, unchanged from prod:
--   task_completion_rate  numeric (has decimals; ::int would destroy them). numeric on prod
--                         today, numeric here, declared `type: 'string'` in the OpenAPI
--                         schema. Casting it would be the change, not leaving it.
--   duration_minutes      numeric, unchanged from migration 048.
--   input/output/total_tokens   bigint on the BASE TABLE (sessions.total_tokens bigint), so
--                         already string today; re-typing them is a separate decision with a
--                         real overflow question, not this migration's business.
-- The guard that holds this line is sessionViewWireTypes.contract.test.ts, which SELECTs the
-- view UNCAST and classifies EVERY column — a new column in neither bucket is a RED.
--
-- ⚠️  THE CAST GOES OUTSIDE THE COALESCE — `COALESCE((SELECT COUNT(*) …), 0)::int`, NOT
--     `COALESCE((SELECT COUNT(*)::int …), 0)`. The two are semantically identical; do not
--     "tidy" it inward. scripts/schema-fingerprint.sql normalizes view definitions by
--     stripping casts with `::[a-zA-Z0-9_ \."\[\]]+` — a character class that INCLUDES
--     SPACES AND DOTS (it has to, for `::character varying` / `::timestamp with time zone`).
--     So the match does not stop at the type name; it runs on through whatever follows.
--     With the cast inside, `::int FROM tasks t WHERE t` is eaten as one match and the
--     fingerprint for this view degrades to:
--         COALESCE(( SELECT (count(*))(session_id = id)), 0) AS contexts_created,
--         COALESCE(( SELECT (count(*))(session_id = id)), 0) AS decisions_created,
--     — byte-IDENTICAL lines. The source table vanishes, so the schema-contract gate could
--     no longer tell `contexts` from `technical_decisions` in these subqueries: precisely
--     the count rule this whole task exists to protect. Measured, both placements, 2026-07-26.
--     Outside the COALESCE the cast is followed by `,` and the FROM clauses survive intact.
--     (The greedy regex is a PRE-EXISTING fingerprint bug — it is already why the stubbed
--     NULL columns render as a bare `NULL, NULL, NULL` in scripts/schema-reference.sql.txt
--     with their aliases eaten. Reported separately; this migration only declines to feed it.)

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
