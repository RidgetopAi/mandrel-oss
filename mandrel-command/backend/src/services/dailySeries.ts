import { db as pool } from '../database/connection';
import { ALL_PROJECTS, type ProjectListScope } from './projectListScope';

/**
 * dailySeries — the ONE per-day metric-series query that both the Calendar DAY-SUMMARY
 * card (`services/daySummary.ts`) and the Calendar MOMENTUM-SERIES endpoint
 * (`services/momentumSeries.ts`) read from. Extracted here so the SQL lives in a SINGLE
 * place (no drift): the card's baseline series and the cells' heatmap series are computed
 * by byte-identical machinery, which is what guarantees the cell score == the card score
 * for the same day.
 *
 * TIMEZONE (an earlier task — the whole-class per-day-in-UTC bug): every per-day bucket is
 * `DATE(x AT TIME ZONE $tz)` where `$tz` is a VALIDATED IANA zone bound as a PARAMETER
 * (never string-interpolated → no injection surface). An evening-local record (e.g.
 * 8pm-EDT = 00:00Z the next day) lands on its LOCAL calendar day, matching the UI. tz is
 * sanitized upstream by the controllers via `resolveAggTimeZone`.
 */

/** One row of the per-day metric series (one calendar day, viewer-local bucketed). */
export interface DailyRow {
  day: string;
  sessions: number;
  contexts: number;
  decisions: number;
  tasks_done: number;
  tasks_opened: number;
  active_minutes: number;
  files_touched: number;
  milestones: number;
}

/** A fully-zeroed day (honest zeros for a day with no activity). */
export function emptyDailyRow(date: string): DailyRow {
  return {
    day: date,
    sessions: 0,
    contexts: 0,
    decisions: 0,
    tasks_done: 0,
    tasks_opened: 0,
    active_minutes: 0,
    files_touched: 0,
    milestones: 0,
  };
}

/**
 * The per-day metric series spanning `[endDate − spanDays, endDate]` (spanDays+1 rows),
 * each bucketed by the viewer-local day. One query, LEFT JOINed off a generated date
 * series so EVERY day in the span is present (honest zeros). Params: $1 end date,
 * $2 tz, $3 span in days, $4 allowed project uuid[], $5 ALL_PROJECTS flag (boolean).
 *
 * The day-summary card calls this with `spanDays = baselineWindowDays` (→ the target day
 * plus its trailing baseline window). The momentum-series endpoint calls it with a single
 * wider span covering `[from − baselineWindowDays, to]` so every in-range day carries its
 * own trailing baseline from ONE query (no N per-day round-trips).
 */
export async function queryDailySeries(
  endDate: string,
  tz: string,
  spanDays: number,
  scope: ProjectListScope,
): Promise<DailyRow[]> {
  const query = `
    WITH days AS (
      SELECT generate_series($1::date - $3::int, $1::date, interval '1 day')::date AS day
    ),
    sess AS (
      SELECT (s.started_at AT TIME ZONE $2)::date AS day,
             COUNT(*) AS sessions,
             COALESCE(SUM(s.files_modified_count), 0) AS files_touched
      FROM sessions s
      WHERE (s.started_at AT TIME ZONE $2)::date BETWEEN ($1::date - $3::int) AND $1::date
        AND ($5::boolean OR s.project_id = ANY($4::uuid[]))
      GROUP BY 1
    ),
    ctx AS (
      SELECT (c.created_at AT TIME ZONE $2)::date AS day,
             COUNT(*) AS contexts,
             COUNT(*) FILTER (WHERE c.context_type = 'milestone') AS milestones
      FROM contexts c
      WHERE c.archived_at IS NULL
        AND (c.created_at AT TIME ZONE $2)::date BETWEEN ($1::date - $3::int) AND $1::date
        AND ($5::boolean OR c.project_id = ANY($4::uuid[]))
      GROUP BY 1
    ),
    dec AS (
      SELECT (d.decision_date AT TIME ZONE $2)::date AS day, COUNT(*) AS decisions
      FROM technical_decisions d
      WHERE d.archived_at IS NULL
        AND (d.decision_date AT TIME ZONE $2)::date BETWEEN ($1::date - $3::int) AND $1::date
        AND ($5::boolean OR d.project_id = ANY($4::uuid[]))
      GROUP BY 1
    ),
    td AS (
      SELECT (t.completed_at AT TIME ZONE $2)::date AS day, COUNT(*) AS tasks_done
      FROM tasks t
      WHERE t.archived_at IS NULL AND t.status = 'completed' AND t.completed_at IS NOT NULL
        AND (t.completed_at AT TIME ZONE $2)::date BETWEEN ($1::date - $3::int) AND $1::date
        AND ($5::boolean OR t.project_id = ANY($4::uuid[]))
      GROUP BY 1
    ),
    topn AS (
      SELECT (t.created_at AT TIME ZONE $2)::date AS day, COUNT(*) AS tasks_opened
      FROM tasks t
      WHERE t.archived_at IS NULL AND t.created_at IS NOT NULL
        AND (t.created_at AT TIME ZONE $2)::date BETWEEN ($1::date - $3::int) AND $1::date
        AND ($5::boolean OR t.project_id = ANY($4::uuid[]))
      GROUP BY 1
    ),
    act AS (
      SELECT (sa.occurred_at AT TIME ZONE $2)::date AS day,
             COUNT(DISTINCT date_trunc('minute', sa.occurred_at AT TIME ZONE $2)) AS active_minutes
      FROM session_activities sa
      JOIN sessions s ON s.id = sa.session_id
      WHERE (sa.occurred_at AT TIME ZONE $2)::date BETWEEN ($1::date - $3::int) AND $1::date
        AND ($5::boolean OR s.project_id = ANY($4::uuid[]))
      GROUP BY 1
    )
    SELECT
      to_char(d.day, 'YYYY-MM-DD') AS day,
      COALESCE(sess.sessions, 0)::int       AS sessions,
      COALESCE(sess.files_touched, 0)::int  AS files_touched,
      COALESCE(ctx.contexts, 0)::int        AS contexts,
      COALESCE(ctx.milestones, 0)::int      AS milestones,
      COALESCE(dec.decisions, 0)::int       AS decisions,
      COALESCE(td.tasks_done, 0)::int       AS tasks_done,
      COALESCE(topn.tasks_opened, 0)::int   AS tasks_opened,
      COALESCE(act.active_minutes, 0)::int  AS active_minutes
    FROM days d
    LEFT JOIN sess ON sess.day = d.day
    LEFT JOIN ctx  ON ctx.day  = d.day
    LEFT JOIN dec  ON dec.day  = d.day
    LEFT JOIN td   ON td.day   = d.day
    LEFT JOIN topn ON topn.day = d.day
    LEFT JOIN act  ON act.day  = d.day
    ORDER BY d.day
  `;
  const unrestricted = scope.mode === ALL_PROJECTS;
  const result = await pool.query(query, [
    endDate,
    tz,
    spanDays,
    unrestricted ? [] : [...scope.projectIds],
    unrestricted,
  ]);
  return result.rows.map((r: any) => ({
    day: r.day as string,
    sessions: r.sessions,
    contexts: r.contexts,
    decisions: r.decisions,
    tasks_done: r.tasks_done,
    tasks_opened: r.tasks_opened,
    active_minutes: r.active_minutes,
    files_touched: r.files_touched,
    milestones: r.milestones,
  }));
}
