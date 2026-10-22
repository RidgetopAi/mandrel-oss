import { db as pool } from '../database/connection';
import { logger } from '../config/logger';
import {
  scopeParamRef,
  scopePredicate,
  type ProjectListScope,
} from './projectListScope';

import { DEFAULT_AGG_TIMEZONE } from '../config/analyticsTime';
import { knownActorKind, type ActorKind } from '../config/actorRegistry';
import { clampSessionListLimit } from '../config/sessionList';
import {
  contextCountSql,
  taskCountSql,
  completedTaskCountSql,
  decisionCountSql,
  taskCompletionRateSql,
} from './sessionCounts';

export interface SessionAnalytics {
  total_sessions: number;
  total_duration_minutes: number;
  average_duration_minutes: number;
  total_contexts: number;
  average_contexts_per_session: number;
  total_tokens_used: number;
  average_tokens_per_session: number;
  active_sessions_today: number;
  sessions_this_week: number;
  sessions_this_month: number;
}

export interface SessionTrend {
  date: string;
  session_count: number;
  total_duration_minutes: number;
  total_contexts: number;
  total_tokens_used: number;
  total_tasks_created: number;
  /**
   * Tasks COMPLETED that local day, counted by `tasks.completed_at` — the record's own
   * timestamp, never the owning session's date and never `created_at`.
   * Same anchoring rule as `TaskService.getThroughputSeries`.
   */
  total_tasks_completed: number;
  average_duration_minutes: number;
}

/**
 * One row of the "most active sessions" ranking (GET /api/sessions/productive).
 *
 * `productivity_score` IS GONE (item 3c). It was
 * `contexts*2.0 + LEAST(hours,8)*3.0 + LEAST(tokens/1000,10)*1.0` — presented as a blend,
 * but the two non-context terms are HARD-CAPPED at 24 and 10 points while the context term
 * is unbounded, so the blend degenerates the moment a session is at all busy. Measured on
 * prod 2026-08-10, the top-ranked row scored 2324.0 of which 2300.0 — 98.97% — was
 * `context_count * 2`. A weighted score that is 99% one term is not a weighted score; it is
 * a context count wearing a costume, and the costume is what invites a reader to trust it.
 *
 * Re-weighting was the alternative and was rejected: any set of normalisation constants
 * that makes hours, payload bytes and contexts commensurate would have to be invented here,
 * and an invented constant is exactly the kind of number nothing on this page can falsify.
 * Deletion states the same ranking honestly — and in the SAME unit the "Activity by actor"
 * panel already counts in (ACTOR_ACTIVITY.metric = 'contexts'), so the page now has one
 * unit of work rather than two.
 *
 * A second defect died with it: the score's duration term read
 * `COALESCE(ended_at, CURRENT_TIMESTAMP)`, so a session that never ends accrues score
 * forever — 4 such sessions were open on prod at the time of measurement.
 */
export interface ProductiveSession {
  id: string;
  project_id: string;
  project_name?: string;
  /** The owning principal, verbatim. `null` when the session carries no actor. */
  actor: string | null;
  /**
   * The actor's kind from the first-party registry, or `null` when unknown/absent.
   * Classified here for the same reason `ActorContextCount.kind` is — see that field.
   */
  actor_kind: ActorKind | null;
  created_at: string;
  duration_minutes: number;
  context_count: number;
  tokens_used: number;
  context_summary?: string;
}

/** One actor's share of the CONTEXTS CREATED in the window. Verbatim actor slug. */
export interface ActorContextCount {
  actor: string;
  context_count: number;
  /**
   * The actor's principal kind from the FIRST-PARTY registry (config/actorRegistry.ts),
   * or `null` when the registry does not know this actor.
   *
   * Classified HERE and not in the browser on purpose: the registry is already mirrored
   * in two files behind a set-equality drift guard, and a third copy shipped to the
   * frontend would be a copy that guard does not cover. The frontend gets the ANSWER.
   */
  kind: ActorKind | null;
}

/**
 * The by-actor read model (GET /api/sessions/contexts-by-actor). The bars and the
 * coverage figures come from ONE aggregation, in ONE unit (contexts), so they cannot
 * disagree: `attributed_contexts` is exactly the sum of `actors[].context_count`, and
 * `total_contexts` is every context in the window+scope regardless of attribution.
 */
export interface ContextsByActor {
  /** Every attributed actor, count DESC. NOT truncated — the caller rolls up the tail. */
  actors: ActorContextCount[];
  attributed_contexts: number;
  /** Contexts whose owning session has no actor, plus contexts with no session at all. */
  unattributed_contexts: number;
  total_contexts: number;
  /**
   * The USER-vs-AUTOMATION split of `attributed_contexts` (item 3), using
   * the EXISTING ActorKind taxonomy rather than a new one:
   *   user_driven  = human + agent — a person, or an agent a person dispatched;
   *   automated    = automation    — machinery that runs whether anyone is here or not;
   *   unknown_kind = an actor the registry does not recognise.
   *
   * The three sum to `attributed_contexts`, exactly. `unknown_kind` is NOT a third series:
   * it is the absence of the classification, so the panel folds it into the coverage line
   * the same way `unattributed_contexts` already is — the design call an earlier task made
   * for the missing-actor case, applied one level up.
   */
  user_driven_contexts: number;
  automated_contexts: number;
  unknown_kind_contexts: number;
  /** The window actually used, after clamping — so the caller can label it honestly. */
  days: number;
}

export interface TokenUsagePattern {
  hour: number;
  total_tokens: number;
  session_count: number;
  average_tokens_per_session: number;
}

export class SessionAnalyticsService {
  /**
   * Get overall session analytics
   */
  static async getSessionAnalytics(
    scope: ProjectListScope,
    actor?: string,
    tz: string = DEFAULT_AGG_TIMEZONE,
  ): Promise<SessionAnalytics> {
    try {
      // Build the WHERE incrementally so the optional actor slice composes with the
      // project filter. tz is bound FIRST ($1) for the viewer-local "today" bucketing
      //; projectId/actor follow, and the context-project JOIN below
      // references projectId's resolved index.
      const params: any[] = [tz];
      const tzIdx = 1;
      const conditions: string[] = [];
      const projRef = scopeParamRef(scope, params);
      if (projRef) {
        conditions.push(`s.project_id = ${projRef}`);
      }
      if (actor) {
        params.push(actor);
        conditions.push(`s.actor = $${params.length}`);
      }
      const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

      // Context counting rules (both must hold):
      //  1) GLOBAL total (no project filter): count EVERY context linked to a session
      //     by session_id — the work-unit linkage. We must NOT also force
      //     c.project_id = s.project_id, because pre-SR-1 long-running sessions did
      //     mid-session project_switches; that filter dropped ~1700 legitimately-
      //     session-linked contexts and made Total Contexts under-report (3858 vs 5561
      //     on prod).
      //  2) PROJECT-FILTERED total: a context only counts for project P if the
      //     CONTEXT itself belongs to P (c.project_id = $1). This preserves the
      //     cross-project isolation contract (a mid-switch session bound to project A
      //     must not attribute its project-B contexts to A). When unfiltered, the JOIN
      //     condition collapses to session_id only.
      const contextProjectJoin = projRef ? `AND c.project_id = ${projRef}` : '';
      const query = `
        WITH session_stats AS (
          SELECT
            s.id,
            s.project_id,
            s.started_at,
            s.ended_at,
            COALESCE(s.total_tokens, 0) AS tokens_used,
            EXTRACT(EPOCH FROM (COALESCE(s.ended_at, CURRENT_TIMESTAMP) - s.started_at)) / 60 as duration_minutes,
            COUNT(c.id) as context_count
          FROM sessions s
          -- LIVE contexts only. The predicate lives in the ON, not the
          -- WHERE, or this LEFT JOIN degenerates to an INNER JOIN and every session with
          -- no live context vanishes from the analytics entirely. It sits BEFORE the
          -- caller's project narrowing for the same reason it does in the sibling paths:
          -- nothing may be inserted between the join and the archive test.
          LEFT JOIN contexts c
            ON s.id = c.session_id AND c.archived_at IS NULL ${contextProjectJoin}
          ${whereClause}
          GROUP BY s.id, s.project_id, s.started_at, s.ended_at, tokens_used
        )
        SELECT 
          COUNT(*) as total_sessions,
          COALESCE(SUM(duration_minutes), 0) as total_duration_minutes,
          COALESCE(AVG(duration_minutes), 0) as average_duration_minutes,
          COALESCE(SUM(context_count), 0) as total_contexts,
          COALESCE(AVG(context_count), 0) as average_contexts_per_session,
          COALESCE(SUM(tokens_used), 0) as total_tokens_used,
          COALESCE(AVG(tokens_used), 0) as average_tokens_per_session,
          COUNT(CASE WHEN (started_at AT TIME ZONE $${tzIdx})::date = (now() AT TIME ZONE $${tzIdx})::date THEN 1 END) as active_sessions_today,
          COUNT(CASE WHEN started_at >= CURRENT_DATE - INTERVAL '7 days' THEN 1 END) as sessions_this_week,
          COUNT(CASE WHEN started_at >= CURRENT_DATE - INTERVAL '30 days' THEN 1 END) as sessions_this_month
        FROM session_stats
      `;

      const result = await pool.query(query, params);
      const row = result.rows[0];

      return {
        total_sessions: parseInt(row.total_sessions) || 0,
        total_duration_minutes: Math.round(parseFloat(row.total_duration_minutes) || 0),
        average_duration_minutes: Math.round(parseFloat(row.average_duration_minutes) || 0),
        total_contexts: parseInt(row.total_contexts) || 0,
        average_contexts_per_session: Math.round(parseFloat(row.average_contexts_per_session) || 0),
        total_tokens_used: parseInt(row.total_tokens_used) || 0,
        average_tokens_per_session: Math.round(parseFloat(row.average_tokens_per_session) || 0),
        active_sessions_today: parseInt(row.active_sessions_today) || 0,
        sessions_this_week: parseInt(row.sessions_this_week) || 0,
        sessions_this_month: parseInt(row.sessions_this_month) || 0
      };
    } catch (error) {
      logger.error('Get session analytics error', { error });
      throw new Error('Failed to get session analytics');
    }
  }

  /**
   * Get session trends over time (daily aggregation)
   */
  static async getSessionTrends(
    scope: ProjectListScope,
    days: number = 30,
    actor?: string,
    tz: string = DEFAULT_AGG_TIMEZONE,
  ): Promise<SessionTrend[]> {
    // TODO (Sessions Foundation Phase 3 — analytics accuracy, the auditor review §4.2 failure-mode
    // (a)): with the dormant lifecycle a session can now legitimately span
    // MULTIPLE days (active → dormant → resume). This daily aggregation buckets a session's
    // ENTIRE duration/token/context total into DATE(started_at) (see `GROUP BY DATE(s.started_at)`
    // + the duration SUM below), so a week-spanning session dumps a full week of work onto its
    // start day and shows zero on the days it actually spanned. The correct grain is to segment
    // by ACTIVITY timestamps (the session_activities table already records per-action times) so a
    // day's metrics reflect what happened THAT day. Deferred here on purpose (it's a substantial
    // rewrite of every daily/period aggregation in this file + sessionDetail.ts, out of Phase 3's
    // lifecycle scope) — flagged in the Phase 3 report so it isn't lost.
    try {
      // Bucketing timezone (an earlier task — whole-class per-day-in-UTC bug): the day
      // buckets AND the "today"-anchored window are computed in the VIEWER's tz so an
      // evening-local record lands on the correct LOCAL calendar day (Postgres runs UTC).
      // Bound as $1 (a validated IANA zone) — never string-interpolated (no injection).
      // Absent/UTC tz reproduces the historical bucketing byte-for-byte (regression guard).
      // projectId/actor are bound AFTER tz; the context-project subquery references
      // projectId's resolved index. The actor slice filters/groups the series to a single
      // "who" (the UI groups by actor by requesting one actor at a time).
      const params: any[] = [tz];
      const tzIdx = 1;
      let whereClause = '';
      const projRef = scopeParamRef(scope, params);
      if (projRef) {
        whereClause += ` AND s.project_id = ${projRef}`;
      }
      let actorRef: string | undefined;
      if (actor) {
        params.push(actor);
        actorRef = `$${params.length}`;
        whereClause += ` AND s.actor = ${actorRef}`;
      }

      // ── THE WINDOW: BOUND, AND `days - 1` WIDE (items 1 + 5) ────────────
      // Two defects in one expression, which used to be the SPLICED literal
      // `INTERVAL '${days} days'` in three places:
      //
      //  (1) SPLICED, so `parseInt('abc')` upstream reached Postgres as the literal
      //      `INTERVAL 'NaN days'` and raised. Bound through `make_interval(days => $n)`
      //      — matching `getContextsByActor` — a NaN cannot be bound at all.
      //
      //  (2) OFF BY ONE. `generate_series(today - N days, today, '1 day')` is inclusive at
      //      BOTH ends, so a "30d" request returned 31 rows. Every consumer of this series
      //      then split it in half for its delta and `floor(31/2) = 15` gave the RECENT
      //      half a free extra day (15 prior vs 16 recent). Measured on prod contexts
      //      2026-08-10: prior-15 1048 vs recent-16 1095 prints ▲4%, while the honest
      //      equal-half comparison is a different number entirely. `days - 1` makes the
      //      series exactly `days` rows — asserted below, because an off-by-one that only
      //      shows up as a slightly-too-flattering percentage is invisible without one.
      //
      // ONE expression, referenced by all three predicates, so they cannot drift apart.
      params.push(days);
      const daysIdx = params.length;
      const windowStart = `((SELECT local_today FROM bounds) - make_interval(days => $${daysIdx}::int - 1))`;

      // ════════════════════════════════════════════════════════════════════════════════
      //  WHY THE CONTEXT/TASK SERIES IS NOT SESSION-ANCHORED WHEN PROJECT-SCOPED
      // 
      // ════════════════════════════════════════════════════════════════════════════════
      // `daily_sessions` below can only ever see rows whose OWNING SESSION is in scope
      // (`FROM sessions s WHERE s.project_id = <scope>`). Counting a project's contexts
      // from inside that aggregate therefore asks a strictly narrower question than the
      // chart claims: "contexts belonging to project P that were written by a session
      // ALSO belonging to P". Those are different populations, and on real data they
      // barely overlap — an agent works in one long `riverbend` session and stores
      // contexts into whatever project the work is about.
      //
      // MEASURED on prod 2026-08-08, live contexts created in the trailing 30 days,
      // grouped by the context's own project and whether its session shares that project
      // (`scripts`-free one-off; the query is reproduced in the task report):
      //     ctx project      | session same | session other | total
      //     riverbend       |         2078 |            49 |  2127
      //     mandrel       |            0 |            23 |    23
      //     assistant-agent     |            5 |             2 |     7
      //     daisy            |            0 |             6 |     6
      //     dev-desktop |            0 |             3 |     3
      //     acme            |            0 |             2 |     2
      //     personal         |            0 |             1 |     1
      // mandrel owns ZERO sessions, so its Workspace Activity chart was a structural
      // flat line — not a low number, an unreachable one. 42 of the 43 non-riverbend
      // contexts were invisible.
      //
      // THE FIX: when scoped, count contexts (and tasks) by the RECORD's own project_id
      // and bucket on the RECORD's own created_at, in a separate CTE that is LEFT JOINed
      // onto date_series alongside daily_sessions. It is a separate CTE and NOT a join
      // into the session aggregate on purpose — see the fan-out autopsy below; anything
      // that multiplies session rows re-breaks the token/duration sums.
      //
      // WHAT DELIBERATELY DID NOT CHANGE:
      //  * session_count / total_duration_minutes / total_tokens_used /
      //    average_duration_minutes are genuinely session-owned. They stay anchored to
      //    the session and its start day.
      //  * THE UNSCOPED (ALL_PROJECTS) PATH IS STILL SESSION-ANCHORED. Switching it to
      //    record-anchoring would move its numbers a lot (measured: up to -295/+86
      //    contexts on a single day over the same 30-day window), because unscoped is
      //    where the multi-day-session bucketing distortion described in the TODO at the
      //    head of this method actually bites. That is a real defect and a real
      //    conversation, but it is a DIFFERENT one. Guarded by
      //    `sessionTrendsProjectAnchoring.db.test.ts`, which asserts the unscoped series
      //    still buckets a cross-day fixture on the SESSION's start day.
      //
      //  * The actor slice still means "work produced by this actor", so when an actor is
      //    named the record-anchored CTEs keep the session correlation for the ACTOR only
      //    (EXISTS on the owning session), never for the project.
      //
      // WHAT CHANGED ON *BOTH* PATHS OF THIS ENDPOINT: ARCHIVED ROWS ARE EXCLUDED
      // (`archived_at IS NULL`), matching services/sessionCounts.ts. The old inline context
      // subquery here did NOT exclude them — it had silently drifted from contextCountSql,
      // which is that rule's canonical statement — so this ONE endpoint answered with TWO
      // different archived-semantics depending on the scope.
      //
      // "THIS ENDPOINT", not "every read on this backend" — that wider claim was here and
      // was FALSE. Other read paths still hand-write a per-session child count and bypass
      // the builder, so this change makes THIS endpoint disagree with them about archived
      // rows. WHICH paths, and what each one currently answers, is asserted by
      // __tests__/sessionCountRule.contract.test.ts — not listed here. Tracked: 760f700b.
      //
      // There is no prose enumeration at this line ON PURPOSE. One lived here and was
      // rewritten three times; every rewrite fixed its predecessor's false statement and
      // introduced a new one — a function that had never existed, then a line number
      // pointing into a different function, then a population that was narrow again, then
      // a "pre-existing, not created" that was false at the merge-base. The clean gate was
      // GREEN through all of it, because a gate cannot measure a sentence. A contract test
      // can: it cannot cite a wrong line, cannot name a function that does not exist, and
      // cannot silently omit a path, because its number would differ.
      //
      // Measured on
      // prod 2026-08-08, unscoped 30-day series: 2113 -> 2098 contexts (-15), moving on 6
      // of 31 days, largest single-day move -6. An independent count of archived contexts
      // attached to a session that started in that window returns exactly 15, so the whole
      // delta is accounted for. Sessions (149), tokens and durations are untouched, and
      // the task counter was already derived from the builder, so it is unaffected (421
      // before and after).
      //
      // Per-session context counting rules for the UNSCOPED branch (mirror
      // getSessionAnalytics):
      //  - count contexts via session_id (work-unit linkage), NOT a project-equality
      //    JOIN, so mid-session project_switch contexts are not dropped.
      // Critically, the per-session context count is computed in a SCALAR SUBQUERY,
      // NOT a JOIN. The previous JOIN fanned each session row out once per context,
      // which multiplied SUM(total_tokens)/SUM(duration) by the context count and
      // badly INFLATED the daily token + duration trend (e.g. 26.1M vs the correct
      // 3.53M tokens on 30 days of prod data). The subquery keeps session-level sums
      // counted exactly once.

      /**
       * A record-anchored daily CTE for a child table that carries its own project_id
       * and created_at. One builder for both contexts and tasks so the two series can
       * never drift into different day/project semantics.
       */
      const dailyRecordCte = (name: string, table: string, alias: string) => `
      ${name} AS (
        SELECT
          (${alias}.created_at AT TIME ZONE $${tzIdx})::date AS record_date,
          COUNT(*) AS record_count
        FROM ${table} ${alias}
        WHERE ${alias}.archived_at IS NULL
          AND ${alias}.project_id = ${projRef}
          AND (${alias}.created_at AT TIME ZONE $${tzIdx})::date >= ${windowStart}
          AND (${alias}.created_at AT TIME ZONE $${tzIdx})::date <= (SELECT local_today FROM bounds)
          ${
            actorRef
              ? `AND EXISTS (SELECT 1 FROM sessions sa WHERE sa.id = ${alias}.session_id AND sa.actor = ${actorRef})`
              : ''
          }
        GROUP BY 1
      ),`;

      // The two shapes. `projRef` is the ONE switch: scoped ⇒ record-anchored series,
      // unscoped ⇒ the historical session-anchored aggregate, unchanged.
      const recordCtes = projRef
        ? `${dailyRecordCte('daily_contexts', 'contexts', 'c')}${dailyRecordCte('daily_tasks', 'tasks', 't')}`
        : '';
      const contextsExpr = projRef
        ? 'COALESCE(dc.record_count, 0)'
        : 'COALESCE(ds.total_contexts, 0)';
      const tasksExpr = projRef
        ? 'COALESCE(dt.record_count, 0)'
        : 'COALESCE(ds.total_tasks_created, 0)';
      const recordJoins = projRef
        ? `LEFT JOIN daily_contexts dc ON d.date = dc.record_date
        LEFT JOIN daily_tasks dt ON d.date = dt.record_date`
        : '';

      // ════════════════════════════════════════════════════════════════════════════════
      //  TASKS COMPLETED — TIME-ANCHORED ON `completed_at` ON *BOTH* PATHS
      // ════════════════════════════════════════════════════════════════════════════════
      // This series replaces the `MCP payload (est.)` metric on the Analytics hero + KPI
      // strip. That metric was deleted because ~70% of it was plotted on the wrong day:
      // it summed a whole session's estimated wire payload onto DATE(started_at), and a
      // session can span a week (see the TODO at the head of this method).
      //
      // So the ONE thing this series must not do is inherit that. Two traps:
      //  (a) `sessions.tasks_completed` is a DENORMALIZED per-session counter. Using it
      //      would re-anchor the series on the session's start day — the exact defect.
      //      It is not read here.
      //  (b) `created_at` is the wrong timestamp for a COMPLETED series and is the one a
      //      copy-paste of `dailyRecordCte` above would have used. The anchoring is
      //      pinned by sessionTrendsTasksCompleted.db.test.ts, whose discriminating case
      //      is a task created OUTSIDE the window and completed INSIDE it.
      //
      // THE RULE IS NOT INVENTED HERE. It is `TaskService.getThroughputSeries`'s `comp`
      // CTE, which already feeds the Tasks → Analytics throughput chart:
      //   completed_at IS NOT NULL AND status = 'completed', bucketed on
      //   (completed_at AT TIME ZONE <viewer tz>)::date.
      // Restating it identically is deliberate — two different definitions of "completed
      // per day" in one product is the drift we keep paying for. The two are asserted to
      // agree, on the same DB, by that suite's cross-check against getThroughputSeries.
      //
      // WHY BOTH PATHS ARE TIME-ANCHORED THE SAME WAY, where contexts/tasks-created are
      // not: the documented dual-anchoring model (see the block above) splits on whether
      // a metric is SESSION-OWNED. session_count / duration / tokens are — they are facts
      // about a session, so they belong on the session's day. A task's completion is not
      // a fact about whatever session happened to close it; it is a fact about the task,
      // and the task carries its own timestamp. So `completed_at` governs the DAY in both
      // scoped and unscoped mode. The PROJECT anchoring still follows the model exactly:
      // scoped filters the record's own `project_id`, unscoped filters nothing. The actor
      // slice keeps the same meaning it has in `dailyRecordCte` — correlate to the owning
      // session's actor, never to its project.
      //
      // ARCHIVED rows are excluded, matching `dailyRecordCte` in this same query, so the
      // two task series on one chart cannot answer different archived-semantics.
      const dailyTasksCompletedCte = `
      daily_tasks_completed AS (
        SELECT
          (tc.completed_at AT TIME ZONE $${tzIdx})::date AS record_date,
          COUNT(*) AS record_count
        FROM tasks tc
        WHERE tc.archived_at IS NULL
          AND tc.completed_at IS NOT NULL
          AND tc.status = 'completed'
          ${projRef ? `AND tc.project_id = ${projRef}` : ''}
          AND (tc.completed_at AT TIME ZONE $${tzIdx})::date >= ${windowStart}
          AND (tc.completed_at AT TIME ZONE $${tzIdx})::date <= (SELECT local_today FROM bounds)
          ${
            actorRef
              ? `AND EXISTS (SELECT 1 FROM sessions sa WHERE sa.id = tc.session_id AND sa.actor = ${actorRef})`
              : ''
          }
        GROUP BY 1
      ),`;
      // Only the unscoped branch still derives these inside the session aggregate.
      // BOTH counters come from services/sessionCounts.ts — the canonical statement of
      // "how many contexts / tasks does this session have". The context half used to be a
      // HAND-WRITTEN subquery here, and it had silently drifted: it omitted
      // `archived_at IS NULL`, so the unscoped series counted archived contexts while the
      // scoped one (and every other read on this backend) did not. Calling the builder
      // instead of restating the rule is what stops it drifting a second time.
      const sessionChildCounts = projRef
        ? ''
        : `,
      SUM(${contextCountSql('s')}) as total_contexts,
      -- Derived from the child table, exactly like total_contexts above. This was the
      -- last denormalized counter in this query: SUM(s.tasks_created) summed a column
      -- that finish() zeroed on every session end, so the daily "tasks created" trend
      -- flat-lined for any day whose sessions had all ended.
      SUM(${taskCountSql('s')}) as total_tasks_created`;

      const query = `
      WITH bounds AS (
        SELECT (now() AT TIME ZONE $${tzIdx})::date AS local_today
      ),
      date_series AS (
      SELECT generate_series(
      ${windowStart},
      (SELECT local_today FROM bounds),
      INTERVAL '1 day'
      )::date as date
      ),
      ${recordCtes}${dailyTasksCompletedCte}
      daily_sessions AS (
      SELECT
      (s.started_at AT TIME ZONE $${tzIdx})::date as session_date,
      COUNT(*) as session_count,
      SUM(EXTRACT(EPOCH FROM (COALESCE(s.ended_at, CURRENT_TIMESTAMP) - s.started_at)) / 60) as total_duration_minutes,
      SUM(COALESCE(s.total_tokens, 0)) as total_tokens_used${sessionChildCounts}
      FROM sessions s
      WHERE (s.started_at AT TIME ZONE $${tzIdx})::date >= ${windowStart}
      ${whereClause}
          GROUP BY (s.started_at AT TIME ZONE $${tzIdx})::date
        )
        SELECT
          d.date,
          COALESCE(ds.session_count, 0) as session_count,
          COALESCE(ds.total_duration_minutes, 0) as total_duration_minutes,
          ${contextsExpr} as total_contexts,
          COALESCE(ds.total_tokens_used, 0) as total_tokens_used,
          ${tasksExpr} as total_tasks_created,
          COALESCE(dtc.record_count, 0) as total_tasks_completed,
          CASE
            WHEN COALESCE(ds.session_count, 0) > 0
            THEN COALESCE(ds.total_duration_minutes, 0) / ds.session_count
            ELSE 0
          END as average_duration_minutes
        FROM date_series d
        LEFT JOIN daily_sessions ds ON d.date = ds.session_date
        LEFT JOIN daily_tasks_completed dtc ON d.date = dtc.record_date
        ${recordJoins}
        ORDER BY d.date
      `;

      const result = await pool.query(query, params);

      // THE ASSERTION THAT MAKES THE OFF-BY-ONE VISIBLE (item 5).
      // A `days`-wide request must return exactly `days` gap-filled rows. The previous
      // bug returned days+1 and was invisible for months, because a series one row too
      // long still draws a plausible chart — it only surfaces downstream, as a delta
      // whose halves are unequal. Consumers split this series in half and divide; that
      // arithmetic is only honest if the length is the one they were told. A wrong length
      // is a programming error in THIS query, not a data condition, so it throws rather
      // than being clamped away.
      if (result.rows.length !== days) {
        throw new Error(
          `getSessionTrends: expected ${days} day rows, got ${result.rows.length}`,
        );
      }

      return result.rows.map(row => ({
        date: row.date,
        session_count: parseInt(row.session_count) || 0,
        total_duration_minutes: Math.round(parseFloat(row.total_duration_minutes) || 0),
        total_contexts: parseInt(row.total_contexts) || 0,
        total_tokens_used: parseInt(row.total_tokens_used) || 0,
        total_tasks_created: parseInt(row.total_tasks_created) || 0,
        total_tasks_completed: parseInt(row.total_tasks_completed) || 0,
        average_duration_minutes: Math.round(parseFloat(row.average_duration_minutes) || 0)
      }));
    } catch (error) {
      logger.error('Get session trends error', { error });
      throw new Error('Failed to get session trends');
    }
  }

  /**
   * Get most productive sessions (ranked by contexts, duration, and tokens)
   *
   * ── A MISSED READER, FOUND DURING THE 3f9fb289 REMEDIATION ───────────────────────────
   * This one still joined `LEFT JOIN contexts c ON s.id = c.session_id AND c.project_id =
   * s.project_id` — the exact wrong predicate the rest of that task deleted, and it is NOT
   * in the task's own list of fixed readers. It is live: GET /api/v2/sessions/productive.
   *
   * The damage here was worse than an under-count. `HAVING COUNT(c.id) > 0` used the SAME
   * guarded count, so a session whose contexts all belong to a project it switched INTO
   * scored 0 and was DROPPED from the ranking entirely — invisible, not merely low.
   *
   * Now uses the shared builder (./sessionCounts), so it follows the same two-rule
   * semantics as every other reader: RULE 1 when unfiltered, RULE 2 (the CHILD's own
   * project) when the caller filters by project. The aggregate is gone with the join — the
   * correlated subquery needs no GROUP BY, so `HAVING` becomes a plain outer WHERE.
   * Guarded by __tests__/sessionCountRule.contract.test.ts.
   */
  static async getProductiveSessions(
    scope: ProjectListScope,
    limit: number = 10,
    days: number | null = null,
  ): Promise<ProductiveSession[]> {
    try {
      const params: any[] = [limit];
      // The project filter when present → RULE 2 (filter on the CONTEXT's own project).
      // Absent (ALL_PROJECTS only) → RULE 1 (session linkage only). Never `s.project_id`.
      const projParamRef = scopeParamRef(scope, params);
      const conditions: string[] = [];
      if (projParamRef) conditions.push(`s.project_id = ${projParamRef}`);

      // ── THE WINDOW (item 3a) ─────────────────────────────────────────
      // This read had NO date predicate at all while its panel sat under the page's
      // 7d/30d/90d control, so it answered ALL TIME under a range label. Measured on prod
      // 2026-08-10 the top row was a session that started 213 days before the request.
      // Bound via make_interval — never a spliced INTERVAL literal.
      //
      // `null` is the UNBOUNDED window and remains the SERVICE default, because callers
      // that are not this panel (the sessionCountRule contract registry) ask an all-time
      // question. The ROUTE always resolves a real window through resolveRangeDays, so
      // the HTTP surface is never unbounded.
      if (days !== null) {
        params.push(days);
        conditions.push(`s.started_at >= NOW() - make_interval(days => $${params.length})`);
      }
      const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
      const contextCount = contextCountSql('s', projParamRef);

      const query = `
        WITH session_productivity AS (
          SELECT
            s.id,
            s.project_id,
            p.name as project_name,
            -- The "who". This column used to be absent, so the panel rendered
            -- project_name as its who-column — on a project-scoped page that is the
            -- SAME STRING on every row, i.e. a constant presented as a dimension.
            s.actor,
            s.started_at as created_at,
            s.context_summary,
            COALESCE(s.total_tokens, 0) AS tokens_used,
            EXTRACT(EPOCH FROM (COALESCE(s.ended_at, CURRENT_TIMESTAMP) - s.started_at)) / 60 as duration_minutes,
            ${contextCount} as context_count
          FROM sessions s
          LEFT JOIN projects p ON s.project_id = p.id
          ${whereClause}
        )
        SELECT
          id,
          project_id,
          project_name,
          actor,
          created_at,
          duration_minutes,
          context_count,
          tokens_used,
          context_summary
        FROM session_productivity
        -- Was HAVING COUNT(c.id) > 0 on the aggregate; same filter, now on the derived
        -- column. Sessions with no contexts stay out of the ranking.
        WHERE context_count > 0
        -- Ranked by the unit the panel actually shows. created_at DESC is the tie-break
        -- so equal-count rows have a stable, meaningful order (newest first) rather than
        -- whatever the plan happens to emit.
        ORDER BY context_count DESC, created_at DESC
        LIMIT $1
      `;

      const result = await pool.query(query, params);

      return result.rows.map(row => {
        // NULLIF(TRIM()) semantics applied in JS rather than SQL so a blank actor and an
        // absent one collapse to the same `null` the type promises — the same folding
        // getContextsByActor does at its own boundary.
        const rawActor = typeof row.actor === 'string' ? row.actor.trim() : '';
        const actor = rawActor === '' ? null : rawActor;
        return {
          id: row.id,
          project_id: row.project_id,
          project_name: row.project_name,
          actor,
          actor_kind: actor ? knownActorKind(actor) : null,
          created_at: row.created_at,
          duration_minutes: Math.round(parseFloat(row.duration_minutes) || 0),
          context_count: parseInt(row.context_count) || 0,
          tokens_used: parseInt(row.tokens_used) || 0,
          context_summary: row.context_summary
        };
      });
    } catch (error) {
      logger.error('Get productive sessions error', { error });
      throw new Error('Failed to get productive sessions');
    }
  }

  /**
   * SESSIONS STARTED, BY HOUR OF DAY — the 24-bucket histogram behind the Analytics
   * rhythm panel. Two defects fixed here (item 2):
   *
   * 1. TIMEZONE. It was an un-zoned `EXTRACT(HOUR FROM ...)` against a server running
   *    `Etc/UTC`, so every bucket was a UTC hour while the viewer reads local hours —
   *    a 10:00 peak is 06:00 Eastern. Now bucketed with `AT TIME ZONE $tz`, PARAM-BOUND,
   *    exactly like `getSessionTrends` and `getContextsByActor` already do.
   * 2. WINDOW. There was none: the query scanned the whole table while sitting under a
   *    7d/30d/90d control that changed nothing. Now bounded by the same local-day window
   *    the sibling reads use.
   *
   * ── WHAT THIS PANEL MAY HONESTLY CLAIM (item 2's open question, decided) ─────────────
   * `session_count` is the bucket this data supports. `total_tokens` is NOT: a session's
   * WHOLE token figure is attributed to the single hour the session STARTED, and mean
   * session length on prod is 10.3 hours (the task's measurement). So a "tokens by hour"
   * reading of this shape claims work happened in an hour it demonstrably did not — and
   * fixing only the timezone would have made that claim PRECISELY wrong instead of
   * vaguely wrong, which is worse, because a plausible chart is the one people act on.
   *
   * `total_tokens` therefore STAYS IN THE PAYLOAD (it is a true statement about sessions
   * that started in that hour, and it is what the tooltip prints) but the panel is drawn
   * and titled in `session_count`. Attributing tokens to the hours a session actually
   * SPANNED is a different query over a per-call token ledger that does not exist yet
   * (the task's out-of-scope item 5), not a relabelling of this one.
   */
  static async getTokenUsagePatterns(
    scope: ProjectListScope,
    days: number,
    tz: string = DEFAULT_AGG_TIMEZONE,
  ): Promise<TokenUsagePattern[]> {
    try {
      // $1 = tz (a validated IANA zone), $2 = the clamped window, then the scope array.
      const params: any[] = [tz, days];
      const tzIdx = 1;
      const daysIdx = 2;
      const projRef = scopeParamRef(scope, params);
      const scopeClause = projRef ? `AND s.project_id = ${projRef}` : '';

      const query = `
        WITH bounds AS (
          SELECT (now() AT TIME ZONE $${tzIdx})::date AS local_today
        ),
        hourly_usage AS (
          SELECT
            EXTRACT(HOUR FROM (s.started_at AT TIME ZONE $${tzIdx})) as hour,
            SUM(COALESCE(s.total_tokens, 0)) as total_tokens,
            COUNT(*) as session_count
          FROM sessions s
          WHERE (s.started_at AT TIME ZONE $${tzIdx})::date
                  >= (SELECT local_today FROM bounds) - make_interval(days => $${daysIdx})
            AND (s.started_at AT TIME ZONE $${tzIdx})::date <= (SELECT local_today FROM bounds)
            ${scopeClause}
          GROUP BY EXTRACT(HOUR FROM (s.started_at AT TIME ZONE $${tzIdx}))
        ),
        hour_series AS (
          SELECT generate_series(0, 23) as hour
        )
        SELECT 
          hs.hour,
          COALESCE(hu.total_tokens, 0) as total_tokens,
          COALESCE(hu.session_count, 0) as session_count,
          CASE 
            WHEN COALESCE(hu.session_count, 0) > 0 
            THEN COALESCE(hu.total_tokens, 0) / hu.session_count 
            ELSE 0 
          END as average_tokens_per_session
        FROM hour_series hs
        LEFT JOIN hourly_usage hu ON hs.hour = hu.hour
        ORDER BY hs.hour
      `;

      const result = await pool.query(query, params);
      
      return result.rows.map(row => ({
        hour: parseInt(row.hour),
        total_tokens: parseInt(row.total_tokens) || 0,
        session_count: parseInt(row.session_count) || 0,
        average_tokens_per_session: Math.round(parseFloat(row.average_tokens_per_session) || 0)
      }));
    } catch (error) {
      logger.error('Get token usage patterns error', { error });
      throw new Error('Failed to get token usage patterns');
    }
  }

  /**
   * CONTEXTS CREATED, GROUPED BY THE OWNING SESSION'S ACTOR.
   *
   * ── WHY THIS IS A NEW METHOD AND NOT A PARAMETER ─────────────────────────────────────
   * Everything else in this file that mentions `actor` is a FILTER — `s.actor = $n` — and
   * the comment in getSessionTrends says so out loud: "the UI groups by actor by requesting
   * one actor at a time". That is N round-trips to draw one chart, it cannot see an actor
   * the caller did not already know to ask for, and the "how much is attributed at all"
   * figure is not expressible in it at any N. This is the GROUP BY.
   *
   * ── ATTRIBUTION: THE SAME RULE THE REST OF THE PAGE ALREADY USES ──────────────────────
   * A context's actor is its OWNING SESSION's `actor` (`contexts.session_id -> sessions`),
   * which is the correlation `getSessionTrends`'s record-anchored CTE already makes for
   * its actor slice (`EXISTS (SELECT 1 FROM sessions sa WHERE sa.id = c.session_id AND
   * sa.actor = …)`). The predicates are deliberately identical to that CTE, with the actor
   * moved from the WHERE into the GROUP BY:
   *   - `archived_at IS NULL`      — matches services/sessionCounts.ts;
   *   - the CONTEXT's own project  — RULE 2, via the shared scope helper, never a
   *                                  correlation to the SESSION's project;
   *   - the CONTEXT's own created_at, bucketed in the viewer's tz — the same day window
   *     the chart's range control means.
   * A LEFT JOIN, not an inner one: a context with no session at all must land in the
   * UNATTRIBUTED total rather than vanish from the denominator. That population is real —
   * 1557 of 9860 live contexts on prod carried no `session_id` (measured 2026-08-10).
   *
   * ── THE COVERAGE TOTALS SHIP WITH THE ROWS, FROM ONE READ ─────────────────────────────
   * `attributed` / `unattributed` are derived from the SAME result set as `actors`, not a
   * second query. The panel renders "N of M contexts attributed" directly above the bars,
   * and a second read is how those two numbers come to disagree (different window, different
   * scope, one cache warm and one cold). They are also in the SAME UNIT as the bars —
   * contexts, never sessions — because a coverage line counted in a different unit from the
   * thing it claims to cover is the quiet lie this endpoint exists to remove.
   *
   * NO top-N truncation happens here: the caller gets every actor and rolls the tail up,
   * because a server-side cap would silently drop rows out of a total the same payload
   * asserts. The `actor` values are returned VERBATIM (`builder-6ca299d9` stays itself) —
   * collapsing generated ids into a family is a semantic claim, out of scope by design.
   */
  static async getContextsByActor(
    scope: ProjectListScope,
    days: number,
    tz: string = DEFAULT_AGG_TIMEZONE,
  ): Promise<ContextsByActor> {
    try {
      // $1 = tz (validated IANA zone), $2 = window in days (a clamped integer), then the
      // scope array. Every one is BOUND — the day count via make_interval() rather than
      // spliced into an INTERVAL literal, so a non-integer cannot reach the planner at all.
      const params: any[] = [tz, days];
      const tzIdx = 1;
      const daysIdx = 2;
      const scopeFilter = scopePredicate(scope, 'c.project_id', params);

      const query = `
        WITH bounds AS (
          SELECT (now() AT TIME ZONE $${tzIdx})::date AS local_today
        )
        SELECT
          NULLIF(TRIM(s.actor), '') AS actor,
          COUNT(*) AS context_count
        FROM contexts c
        LEFT JOIN sessions s ON s.id = c.session_id
        WHERE c.archived_at IS NULL
          AND (c.created_at AT TIME ZONE $${tzIdx})::date
              >= (SELECT local_today FROM bounds) - make_interval(days => $${daysIdx})
          AND (c.created_at AT TIME ZONE $${tzIdx})::date <= (SELECT local_today FROM bounds)
          ${scopeFilter}
        GROUP BY 1
        ORDER BY context_count DESC, actor ASC
      `;

      const result = await pool.query(query, params);

      const actors: ActorContextCount[] = [];
      let unattributed = 0;
      let userDriven = 0;
      let automated = 0;
      let unknownKind = 0;
      for (const row of result.rows) {
        const count = parseInt(row.context_count, 10) || 0;
        // NULLIF(TRIM(...)) above folds a blank actor into NULL, so "" and "   " land in
        // the unattributed bucket instead of rendering an unlabelled bar.
        if (row.actor === null || row.actor === undefined) {
          unattributed += count;
          continue;
        }
        const actor = String(row.actor);
        const kind = knownActorKind(actor);
        // human + agent are ONE group: an agent runs because a person dispatched it, so
        // its work is user-driven work. Only `automation` is the other side.
        if (kind === 'human' || kind === 'agent') userDriven += count;
        else if (kind === 'automation') automated += count;
        else unknownKind += count;
        actors.push({ actor, context_count: count, kind });
      }
      const attributed = actors.reduce((sum, a) => sum + a.context_count, 0);

      return {
        actors,
        attributed_contexts: attributed,
        unattributed_contexts: unattributed,
        total_contexts: attributed + unattributed,
        user_driven_contexts: userDriven,
        automated_contexts: automated,
        unknown_kind_contexts: unknownKind,
        days,
      };
    } catch (error) {
      logger.error('Get contexts by actor error', { error });
      throw new Error('Failed to get contexts by actor');
    }
  }

  /**
   * Get sessions list with filtering for the dashboard
   */
  static async getSessionsList(options: {
    scope: ProjectListScope;
    status?: string;
    actor?: string;
    limit?: number;
    offset?: number;
  }): Promise<{
    sessions: any[];
    total: number;
  }> {
    try {
      // Default page size: the UI pages far smaller than 1000, and every row now carries
      // four correlated count subqueries. 1000 was a latent foot-gun for any caller that
      // omitted `limit` (spec §8). SESSIONS_LIST_DEFAULT_LIMIT lives in named config, not
      // as a literal here (configs-not-hardcoded).
      const { scope, status, actor, offset = 0 } = options;
      const limit = clampSessionListLimit(options.limit);

      const whereConditions: string[] = [];
      const params: any[] = [];
      let paramIndex = 1;

      // No filtering needed - we only have 'mcp-server' and 'AI Model' session types now

      const projParamRefList = scopeParamRef(scope, params);
      if (projParamRefList) {
        whereConditions.push(`s.project_id = ${projParamRefList}`);
        paramIndex = params.length + 1;
      }

      // Slice by ACTOR (the "who" dimension, Sessions Foundation). Additive filter:
      // an exact match on the stamped actor slug (already normalized by parseActorParam
      // at the route). Bound param → no injection surface.
      if (actor) {
        whereConditions.push(`s.actor = $${paramIndex}`);
        params.push(actor);
        paramIndex++;
      }

      // Map frontend status to session status logic
      if (status && status !== 'all') {
        if (status === 'active') {
          whereConditions.push(`s.ended_at IS NULL`);
        } else if (status === 'inactive') {
          whereConditions.push(`s.ended_at IS NOT NULL`);
        }
      }
      
      const whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';
      
      // Get total count for pagination
      const countQuery = `
        SELECT COUNT(*) as total
        FROM sessions s
        LEFT JOIN projects p ON s.project_id = p.id
        ${whereClause}
      `;
      
      const countResult = await pool.query(countQuery, params);
      const total = parseInt(countResult.rows[0].total) || 0;
      
      // ── COUNTS COME FROM THE CHILD TABLES, NOT THE DENORMALIZED COLUMNS
      // s.contexts_created / s.tasks_created / s.tasks_completed were absolute-SET to an
      // in-memory delta by SessionRepo.finish(), so they read 0 on 79 of 114 finalized prod
      // sessions. The rule (two-rule project semantics, t.session_id linkage, correlated
      // subqueries instead of fan-out-prone JOINs) lives in ONE place: ./sessionCounts.
      //
      // `projIdx` is a bound-parameter reference, present only when the caller asked for a
      // PROJECT-FILTERED view — that is RULE 2 (filter on the CHILD's own project). When
      // absent, RULE 1 applies (session linkage only). We never correlate the child's
      // project to s.project_id; that was the actual bug and it drops 24% of prod contexts.
      const projParamRef = projParamRefList;

      // Get sessions with details (TS006-2: includes token tracking columns, TS007-2: includes activity columns)
      const sessionsQuery = `
        SELECT
          s.id,
          s.display_id,
          s.project_id,
          s.title,
          s.description,
          s.session_goal,
          s.tags,
          s.updated_at,
          s.started_at,
          s.ended_at,
          s.last_activity_at,
          -- Tokens stay on the column: no child table, not recomputable, and for sessions
          -- zeroed by the pre-fix finish() that history is permanently lost (spec §9).
          s.input_tokens,
          s.output_tokens,
          s.total_tokens,
          -- tasks_updated has no child-table equivalent (an update leaves no per-session
          -- row), so it stays a counter column — correct now that only the incrementing
          -- choke point writes it.
          s.tasks_updated,
          s.lines_added,
          s.lines_deleted,
          s.lines_net,
          s.files_modified_count,
          s.productivity_score,
          s.activity_count,
          p.name as project_name,
          EXTRACT(EPOCH FROM (COALESCE(s.ended_at, CURRENT_TIMESTAMP) - s.started_at)) / 60 as duration_minutes,
          ${contextCountSql('s', projParamRef)} as contexts_count,
          ${taskCountSql('s', projParamRef)} as tasks_count,
          ${completedTaskCountSql('s', projParamRef)} as tasks_completed_count,
          ${decisionCountSql('s', projParamRef)} as decisions_count,
          s.status,  -- Use actual status column, not calculated
          s.agent_type as type,
          s.ai_model,
          s.actor,
          ${taskCompletionRateSql('s', projParamRef)} as task_completion_rate
        FROM sessions s
        LEFT JOIN projects p ON s.project_id = p.id
        ${whereClause}
        -- TOTAL ORDER (the MCP-server half is 14dff41a). s.started_at is
        -- NOT UNIQUE — sessions started in the same instant tie, and this list is
        -- LIMIT/OFFSET paged below. Page 1 and page 2 are two independent sorts of the same
        -- tied block, so a partial order can hand the caller one session twice and never
        -- show another. The tiebreaker is the PRIMARY KEY: unique (makes the composite
        -- total), STABLE (does not move when the row is updated, so a page boundary cannot
        -- shift under a concurrent write — which is why it is not updated_at), and cheap
        -- (the PK btree already exists).
        ORDER BY s.started_at DESC, s.id DESC
        LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
      `;
      
      params.push(limit, offset);
      const sessionsResult = await pool.query(sessionsQuery, params);
      
      const sessions = sessionsResult.rows.map(row => ({
        // Identification
        id: row.id,
        display_id: row.display_id,

        // Project association
        project_id: row.project_id,
        project_name: row.project_name,

        // Basic info
        title: row.title,
        description: row.description,
        session_goal: row.session_goal,
        tags: row.tags || [],

        // Timestamps - CRITICAL FOR ACTIVE/ENDED STATUS
        created_at: row.started_at,  // Sessions table uses started_at, not created_at
        updated_at: row.updated_at,
        started_at: row.started_at,
        ended_at: row.ended_at,  // CRITICAL: Must include ended_at!
        last_activity_at: row.last_activity_at,
        last_context_at: row.last_activity_at,

        // Status and type
        status: row.status,
        session_type: row.type,
        agent_type: row.type,
        ai_model: row.ai_model,

        // The "who" dimension — the stable principal that owns the session
        // (Sessions Foundation, migration 062). NULL until a session was stamped
        // (pre-062 rows / header-less callers); serialized as null so callers can
        // group/slice by it.
        actor: row.actor ?? null,

        // File metrics
        lines_added: row.lines_added || 0,
        lines_deleted: row.lines_deleted || 0,
        lines_net: row.lines_net || 0,
        files_modified_count: row.files_modified_count || 0,

        // Task metrics — derived (child table), NOT the denormalized columns.
        // `tasks_created` keeps its API field name for compatibility, but its VALUE now
        // comes from the same subquery as `task_count`, so a consumer writing the
        // defensive `tasks_created ?? task_count` can no longer be handed a poisoned 0.
        tasks_created: parseInt(row.tasks_count) || 0,
        task_count: parseInt(row.tasks_count) || 0,
        tasks_updated: row.tasks_updated || 0,
        tasks_completed: parseInt(row.tasks_completed_count) || 0,
        task_completion_rate: row.task_completion_rate?.toString() || '0',

        // Context metrics — same rule: both names, one derived source.
        contexts_created: parseInt(row.contexts_count) || 0,
        context_count: parseInt(row.contexts_count) || 0,

        // Decision metrics. `sessions.decisions_created` has NO runtime writer at all
        // (migration 042's `SET decisions_created = 0` is the only assignment in the
        // tree), so it was a guaranteed 0 and the list never surfaced decisions. Derived.
        decisions_created: parseInt(row.decisions_count) || 0,
        decision_count: parseInt(row.decisions_count) || 0,

        // Duration and productivity
        duration_minutes: row.duration_minutes?.toString(),
        productivity_score: row.productivity_score?.toString() || '0',
        activity_count: row.activity_count || 0,

        // Token usage
        input_tokens: row.input_tokens?.toString() || '0',
        output_tokens: row.output_tokens?.toString() || '0',
        total_tokens: row.total_tokens?.toString() || '0',

        // Legacy fields for backward compatibility
        startedAt: row.started_at,
        lastActivity: row.ended_at || row.started_at,
        duration: Math.round(parseFloat(row.duration_minutes) || 0),
        contextsCount: parseInt(row.contexts_count) || 0,
        tasksCount: parseInt(row.tasks_count) || 0,
      }));
      
      return {
        sessions,
        total
      };
    } catch (error) {
      logger.error('Get sessions list error', { error });
      throw new Error('Failed to get sessions list');
    }
  }

  /**
   * Get session statistics for dashboard
   */
  static async getSessionStats(
    scope: ProjectListScope,
    tz: string = DEFAULT_AGG_TIMEZONE,
  ): Promise<{
    totalSessions: number;
    activeSessions: number;
    todaySessions: number;
    averageDuration: number;
  }> {
    try {
      // tz is bound $1 (viewer-local "today" bucketing); projectId follows.
      const params: any[] = [tz];
      const projRef = scopeParamRef(scope, params);
      const whereClause = projRef ? `WHERE s.project_id = ${projRef}` : '';

      const query = `
        SELECT
          COUNT(*) as total_sessions,
          COUNT(CASE WHEN s.ended_at IS NULL THEN 1 END) as active_sessions,
          COUNT(CASE WHEN (s.started_at AT TIME ZONE $1)::date = (now() AT TIME ZONE $1)::date THEN 1 END) as today_sessions,
          COALESCE(AVG(EXTRACT(EPOCH FROM (COALESCE(s.ended_at, CURRENT_TIMESTAMP) - s.started_at)) / 60), 0) as avg_duration_minutes
        FROM sessions s
        ${whereClause}
      `;
      
      const result = await pool.query(query, params);
      const row = result.rows[0];
      
      return {
        totalSessions: parseInt(row.total_sessions) || 0,
        activeSessions: parseInt(row.active_sessions) || 0,
        todaySessions: parseInt(row.today_sessions) || 0,
        averageDuration: Math.round(parseFloat(row.avg_duration_minutes) || 0),
      };
    } catch (error) {
      logger.error('Get session stats error', { error });
      throw new Error('Failed to get session stats');
    }
  }
}