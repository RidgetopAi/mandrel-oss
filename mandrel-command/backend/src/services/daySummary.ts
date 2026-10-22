import { db as pool } from '../database/connection';
import { logger } from '../config/logger';
import { DEFAULT_AGG_TIMEZONE } from '../config/analyticsTime';
import { ALL_PROJECTS, type ProjectListScope } from './projectListScope';
import { DAY_SUMMARY_CONFIG } from '../config/daySummary';
import { DailyRow, emptyDailyRow, queryDailySeries } from './dailySeries';
import { computeMomentum } from './momentum';

/**
 * DaySummaryService — assembles the Calendar DAY-SUMMARY report for one calendar date
 *. One method, one report, all from data we already have.
 *
 * TIMEZONE (an earlier task — whole-class per-day-in-UTC bug): every per-day bucket is computed
 * with `DATE(x AT TIME ZONE $tz)` where `$tz` is a VALIDATED IANA zone bound as a PARAMETER
 * (never string-interpolated → no injection surface). An evening-local record (e.g. 8pm-EDT =
 * 00:00Z the next day) therefore lands on its LOCAL calendar day, matching what the UI shows.
 * Absent/UTC tz reproduces the historical UTC bucketing byte-for-byte (regression guard). tz is
 * sanitized upstream in the controller via `resolveAggTimeZone`, exactly like the sibling
 * analytics endpoints (throughput / session trends).
 *
 * ATTRIBUTION: `byActor` counts the day's records (contexts, decisions,
 * completed tasks) grouped by the `actor` of the SESSION that recorded them — the single,
 * normalized "who ran this" identity. Records with no session / no stamped actor fall into the
 * locked default bucket `unattributed`. (Task completions are attributed via the recording
 * session's actor for a consistent one-model attribution; `assigned_to` remains a separate axis.)
 *
 * MOMENTUM: a transparent, baseline-relative 0-100 score — see `config/daySummary.ts` for the
 * full formula + the named weights/anchors (configs-not-hardcoded).
 */

export interface KpiValue {
  value: number;
  delta: number; // value − rolling baseline average, rounded
}

export interface DaySummary {
  date: string;
  tz: string;
  project: string; // 'all' or a project uuid
  headline: string | null;
  momentum: {
    score: number;
    delta: number;
    breakdown: { output: number; followThrough: number; depth: number };
  };
  kpis: {
    sessions: KpiValue;
    activeMinutes: KpiValue;
    contexts: KpiValue;
    decisions: KpiValue;
    tasksDone: KpiValue;
    filesTouched: KpiValue;
  };
  ribbon: Array<{ hour: number; count: number }>;
  highlights: Array<{ type: string; text: string; id: string }>;
  decisions: Array<{ title: string; id: string }>;
  tasksCompleted: { count: number; items: Array<{ title: string; id: string }> };
  byActor: Array<{ actor: string; count: number }>;
}

export class DaySummaryService {
  /**
   * Assemble the full day-summary report for `date` (YYYY-MM-DD) in the viewer's `tz`.
   * `scope` names the projects every panel may read — REQUIRED, no default. It used to be
   * `projectId?: string`, where an absent value meant EVERY project (an earlier task item 7).
   */
  static async getDaySummary(
    date: string,
    tz: string = DEFAULT_AGG_TIMEZONE,
    scope: ProjectListScope,
  ): Promise<DaySummary> {
    try {
      const window = DAY_SUMMARY_CONFIG.baselineWindowDays;
      const proj = scope;

      const [series, ribbon, highlightRows, decisionRows, taskRows, actorRows] = await Promise.all([
        queryDailySeries(date, tz, window, proj),
        this.getRibbon(date, tz, proj),
        this.getHighlights(date, tz, proj),
        this.getDecisions(date, tz, proj),
        this.getTasksCompleted(date, tz, proj),
        this.getByActor(date, tz, proj),
      ]);

      // Split the series into the target day + the trailing baseline window.
      const target = series.find((r) => r.day === date) ?? emptyDailyRow(date);
      const baseline = series.filter((r) => r.day < date); // the `window` days before `date`

      const avg = (pick: (r: DailyRow) => number): number => {
        // Rolling average over the fixed window (sum of prior days / window), so sparse
        // history correctly pulls the baseline down. Never divides by zero (window >= 1).
        const sum = baseline.reduce((s, r) => s + pick(r), 0);
        return window > 0 ? sum / window : 0;
      };

      const kpi = (value: number, baselineAvg: number): KpiValue => ({
        value,
        delta: Math.round(value - baselineAvg),
      });

      // ── Momentum: the SHARED formula (services/momentum.ts) — the same function the
      // Calendar per-cell momentum-series endpoint calls, so the card score and the cell
      // score for a day are identical by construction (no drift).
      const momentum = computeMomentum(target, baseline, window);

      const headline = this.composeHeadline(highlightRows);

      return {
        date,
        tz,
        project: scope.mode !== ALL_PROJECTS && scope.projectIds.length === 1
          ? scope.projectIds[0]
          : 'all',
        headline,
        momentum: {
          score: momentum.score,
          delta: momentum.delta,
          breakdown: momentum.breakdown,
        },
        kpis: {
          sessions: kpi(target.sessions, avg((r) => r.sessions)),
          activeMinutes: kpi(target.active_minutes, avg((r) => r.active_minutes)),
          contexts: kpi(target.contexts, avg((r) => r.contexts)),
          decisions: kpi(target.decisions, avg((r) => r.decisions)),
          tasksDone: kpi(target.tasks_done, avg((r) => r.tasks_done)),
          filesTouched: kpi(target.files_touched, avg((r) => r.files_touched)),
        },
        ribbon,
        highlights: highlightRows.map((h) => ({ type: h.type, text: h.content, id: h.id })),
        decisions: decisionRows,
        tasksCompleted: { count: taskRows.length, items: taskRows },
        byActor: actorRows,
      };
    } catch (error) {
      logger.error('Get day summary error', { error, date, tz, scope: scope.mode });
      throw new Error('Failed to get day summary');
    }
  }

  /** 24 hourly activity-density buckets for the target day (from session_activities). */
  private static async getRibbon(
    date: string,
    tz: string,
    scope: ProjectListScope,
  ): Promise<Array<{ hour: number; count: number }>> {
    const query = `
      WITH hours AS (SELECT generate_series(0, 23) AS hour),
      h AS (
        SELECT EXTRACT(HOUR FROM (sa.occurred_at AT TIME ZONE $2))::int AS hour, COUNT(*) AS n
        FROM session_activities sa
        JOIN sessions s ON s.id = sa.session_id
        WHERE (sa.occurred_at AT TIME ZONE $2)::date = $1::date
          AND ($4::boolean OR s.project_id = ANY($3::uuid[]))
        GROUP BY 1
      )
      SELECT hours.hour, COALESCE(h.n, 0)::int AS count
      FROM hours LEFT JOIN h ON h.hour = hours.hour
      ORDER BY hours.hour
    `;
    const unrestricted = scope.mode === ALL_PROJECTS;
    const result = await pool.query(query, [
      date,
      tz,
      unrestricted ? [] : [...scope.projectIds],
      unrestricted,
    ]);
    return result.rows.map((r: any) => ({ hour: r.hour, count: r.count }));
  }

  /**
   * The day's milestone + completion contexts, ordered milestones-first then by relevance
   * (headline source is row 0), most recent as tie-break.
   */
  private static async getHighlights(
    date: string,
    tz: string,
    scope: ProjectListScope,
  ): Promise<Array<{ id: string; type: string; content: string }>> {
    const query = `
      SELECT c.id, c.context_type AS type, c.content
      FROM contexts c
      WHERE c.archived_at IS NULL
        AND c.context_type IN ('milestone', 'completion')
        AND (c.created_at AT TIME ZONE $2)::date = $1::date
        AND ($4::boolean OR c.project_id = ANY($3::uuid[]))
      ORDER BY (c.context_type = 'milestone') DESC, c.relevance_score DESC NULLS LAST, c.created_at DESC
    `;
    const unrestricted = scope.mode === ALL_PROJECTS;
    const result = await pool.query(query, [
      date,
      tz,
      unrestricted ? [] : [...scope.projectIds],
      unrestricted,
    ]);
    return result.rows.map((r: any) => ({ id: r.id, type: r.type, content: r.content }));
  }

  /** Decisions recorded on the target day. */
  private static async getDecisions(
    date: string,
    tz: string,
    scope: ProjectListScope,
  ): Promise<Array<{ title: string; id: string }>> {
    const query = `
      SELECT d.id, d.title
      FROM technical_decisions d
      WHERE d.archived_at IS NULL
        AND (d.decision_date AT TIME ZONE $2)::date = $1::date
        AND ($4::boolean OR d.project_id = ANY($3::uuid[]))
      ORDER BY d.decision_date DESC
    `;
    const unrestricted = scope.mode === ALL_PROJECTS;
    const result = await pool.query(query, [
      date,
      tz,
      unrestricted ? [] : [...scope.projectIds],
      unrestricted,
    ]);
    return result.rows.map((r: any) => ({ id: r.id, title: r.title }));
  }

  /** Tasks completed on the target day. */
  private static async getTasksCompleted(
    date: string,
    tz: string,
    scope: ProjectListScope,
  ): Promise<Array<{ title: string; id: string }>> {
    const query = `
      SELECT t.id, t.title
      FROM tasks t
      WHERE t.archived_at IS NULL AND t.status = 'completed' AND t.completed_at IS NOT NULL
        AND (t.completed_at AT TIME ZONE $2)::date = $1::date
        AND ($4::boolean OR t.project_id = ANY($3::uuid[]))
      ORDER BY t.completed_at DESC
    `;
    const unrestricted = scope.mode === ALL_PROJECTS;
    const result = await pool.query(query, [
      date,
      tz,
      unrestricted ? [] : [...scope.projectIds],
      unrestricted,
    ]);
    return result.rows.map((r: any) => ({ id: r.id, title: r.title }));
  }

  /**
   * By-actor breakdown: the day's records (contexts + decisions + completed tasks) grouped by
   * the recording SESSION's `actor`. Null session/actor → `unattributed`.
   */
  private static async getByActor(
    date: string,
    tz: string,
    scope: ProjectListScope,
  ): Promise<Array<{ actor: string; count: number }>> {
    const query = `
      WITH recs AS (
        SELECT c.session_id
        FROM contexts c
        WHERE c.archived_at IS NULL
          AND (c.created_at AT TIME ZONE $2)::date = $1::date
          AND ($4::boolean OR c.project_id = ANY($3::uuid[]))
        UNION ALL
        SELECT d.session_id
        FROM technical_decisions d
        WHERE d.archived_at IS NULL
          AND (d.decision_date AT TIME ZONE $2)::date = $1::date
          AND ($4::boolean OR d.project_id = ANY($3::uuid[]))
        UNION ALL
        SELECT t.session_id
        FROM tasks t
        WHERE t.archived_at IS NULL AND t.status = 'completed' AND t.completed_at IS NOT NULL
          AND (t.completed_at AT TIME ZONE $2)::date = $1::date
          AND ($4::boolean OR t.project_id = ANY($3::uuid[]))
      )
      SELECT COALESCE(NULLIF(TRIM(s.actor), ''), 'unattributed') AS actor, COUNT(*)::int AS count
      FROM recs r
      LEFT JOIN sessions s ON s.id = r.session_id
      GROUP BY 1
      ORDER BY count DESC, actor ASC
    `;
    const unrestricted = scope.mode === ALL_PROJECTS;
    const result = await pool.query(query, [
      date,
      tz,
      unrestricted ? [] : [...scope.projectIds],
      unrestricted,
    ]);
    return result.rows.map((r: any) => ({ actor: r.actor as string, count: r.count }));
  }

  /**
   * Compose the auto-headline from the day's top milestone (else top completion) — the first
   * line of its content, collapsed to one line and ellipsized to the configured max length.
   * `null` when the day has no milestone/completion context (honest empty; the FE falls back).
   */
  private static composeHeadline(
    highlights: Array<{ type: string; content: string }>,
  ): string | null {
    if (highlights.length === 0) return null;
    const top = highlights[0]; // already ordered milestones-first, then by relevance
    const oneLine = (top.content ?? '').replace(/\s+/g, ' ').trim();
    if (!oneLine) return null;
    const max = DAY_SUMMARY_CONFIG.headlineMaxLength;
    return oneLine.length > max ? `${oneLine.slice(0, max - 1).trimEnd()}…` : oneLine;
  }
}
