/**
 * DB test: the trends payload's `total_tasks_completed` series is anchored on the TASK's
 * own `completed_at`.
 *
 * ── WHY THIS SUITE EXISTS ───────────────────────────────────────────────────────────
 * This series replaces the `MCP payload (est.)` metric on the Analytics hero + KPI strip.
 * That metric was deleted because most of it was drawn on the WRONG DAY: it summed a
 * whole session's estimated wire payload onto `DATE(started_at)`, and a session can run
 * for a week. A replacement that re-imports that defect is worse than no replacement, so
 * the anchoring is what this suite pins — nothing else.
 *
 * There are exactly two ways to get it wrong, and the fixture is built to catch both:
 *   - anchoring on `created_at` (the timestamp the sibling `dailyRecordCte` in the same
 *     query uses, so it is one copy-paste away), and
 *   - anchoring on the OWNING SESSION's day (the denormalized `sessions.tasks_completed`
 *     counter would do exactly this).
 *
 * ── THE DISCRIMINATING CASE ─────────────────────────────────────────────────────────
 * `LATE` is created 40 days BEFORE a 10-day window and completed INSIDE it. A
 * `created_at`-anchored series cannot see it at all. `MOVED` is created inside the window
 * on one day and completed on a LATER day inside it: it must read on the completion day
 * and ZERO on the creation day. Together those two cases separate `completed_at` from
 * `created_at` in both directions.
 *
 * Every task here belongs to project W while the only session belongs to project S and
 * started outside the completion days — so a session-anchored implementation lands them
 * on the wrong day too, and the same assertions catch it.
 *
 * Provision a throwaway migrated DB first:
 *   bash scripts/provision-test-db.sh ci_trends_completed
 *   eval "$(bash scripts/provision-test-db.sh ci_trends_completed --print-env)"
 *   npm test -- sessionTrendsTasksCompleted
 *   bash scripts/provision-test-db.sh ci_trends_completed --drop
 */
import { Pool } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import { SessionAnalyticsService, type SessionTrend } from '../services/sessionAnalytics';
import { TaskService } from '../services/task';
import { describeDb, contractDbConfig } from './helpers/dbContractGate';
import { allProjects, projectsScope } from '../services/projectListScope';

/** Narrow enough that "created 40 days ago" is unambiguously outside it. */
const WINDOW_DAYS = 10;
const TZ = 'UTC';
const ACTOR = 'ci-tasks-completed-actor';

/** Normalise a trend row's `date` (node-pg may give a Date at LOCAL midnight, or a string). */
function ymd(v: unknown): string {
  if (typeof v === 'string') return v.slice(0, 10);
  const dt = v as Date;
  const y = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2, '0');
  const day = String(dt.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function byDay(trends: SessionTrend[]): Map<string, SessionTrend> {
  return new Map(trends.map((t) => [ymd(t.date), t]));
}

import { withLegacyUnstampedTasksAllowed } from './helpers/legacyUnstampedTask';

describeDb('getSessionTrends — total_tasks_completed is anchored on completed_at', () => {
  let pool: Pool;

  // "S" owns the SESSION, "W" owns the WORK — the prod shape, and the shape that makes a
  // session-anchored implementation visibly wrong.
  const projectSessionHome = uuidv4();
  const projectWork = uuidv4();
  const sessionId = uuidv4();

  const taskLate = uuidv4();      // created 40d ago, completed 3d ago  -> day3
  const taskMoved = uuidv4();     // created 8d ago,  completed 2d ago  -> day2 (not day8)
  const taskOpen = uuidv4();      // created 5d ago,  never completed   -> nowhere
  const taskNoStamp = uuidv4();   // status 'completed', completed_at NULL -> nowhere
  const taskArchived = uuidv4();  // completed 4d ago but archived      -> nowhere

  // Resolved from Postgres so the expectation and the query agree on the calendar.
  let day2 = '';
  let day3 = '';
  let day4 = '';
  let day5 = '';
  let day8 = '';
  let sessionDay = '';

  /** The unscoped series as it was BEFORE this suite inserted anything. */
  let unscopedBefore: Map<string, SessionTrend>;

  beforeAll(async () => {
    pool = new Pool(contractDbConfig);

    // The unscoped guard is a DELTA, so the baseline must be read before the fixture exists.
    unscopedBefore = byDay(
      await SessionAnalyticsService.getSessionTrends(allProjects, WINDOW_DAYS, undefined, TZ),
    );

    const { rows } = await pool.query(
      `SELECT to_char((now() - INTERVAL '2 days') AT TIME ZONE $1, 'YYYY-MM-DD') AS d2,
              to_char((now() - INTERVAL '3 days') AT TIME ZONE $1, 'YYYY-MM-DD') AS d3,
              to_char((now() - INTERVAL '4 days') AT TIME ZONE $1, 'YYYY-MM-DD') AS d4,
              to_char((now() - INTERVAL '5 days') AT TIME ZONE $1, 'YYYY-MM-DD') AS d5,
              to_char((now() - INTERVAL '8 days') AT TIME ZONE $1, 'YYYY-MM-DD') AS d8,
              to_char((now() - INTERVAL '9 days') AT TIME ZONE $1, 'YYYY-MM-DD') AS sday`,
      [TZ],
    );
    day2 = rows[0].d2;
    day3 = rows[0].d3;
    day4 = rows[0].d4;
    day5 = rows[0].d5;
    day8 = rows[0].d8;
    sessionDay = rows[0].sday;

    // Guard the fixture's own premise: the days it discriminates between must be
    // DIFFERENT days, or the assertions below prove nothing.
    expect(new Set([day2, day3, day4, day5, day8, sessionDay]).size).toBe(6);

    await pool.query(
      `INSERT INTO projects (id, name, description, status, created_at)
         VALUES ($1,$2,'tasks-completed anchoring: session home','active',NOW()),
                ($3,$4,'tasks-completed anchoring: work home','active',NOW())`,
      [
        projectSessionHome, `tc-anchor-S-${projectSessionHome.slice(0, 8)}`,
        projectWork, `tc-anchor-W-${projectWork.slice(0, 8)}`,
      ],
    );

    await pool.query(
      `INSERT INTO sessions (id, project_id, agent_type, display_id, actor, started_at, ended_at)
         VALUES ($1, $2, 'mcp-server', $3, $4, now() - INTERVAL '9 days', now() - INTERVAL '1 days')`,
      [sessionId, projectSessionHome, `tc-${sessionId.slice(0, 8)}`, ACTOR],
    );

    const insertTask = (
      id: string,
      createdDaysAgo: number,
      completedDaysAgo: number | null,
      status: string,
      archived: boolean,
    ) =>
      pool.query(
        `INSERT INTO tasks (id, project_id, session_id, title, type, status, priority,
                            created_at, completed_at, archived_at)
           VALUES ($1, $2, $3, $4, 'general', $5, 'medium',
                   now() - make_interval(days => $6::int),
                   CASE WHEN $7::int IS NULL THEN NULL
                        ELSE now() - make_interval(days => $7::int) END,
                   CASE WHEN $8::boolean THEN now() ELSE NULL END)`,
        [id, projectWork, sessionId, `tc fixture ${id.slice(0, 8)}`, status,
         createdDaysAgo, completedDaysAgo, archived],
      );

    // THE DISCRIMINATING PAIR.
    await insertTask(taskLate, 40, 3, 'completed', false);   // created OUTSIDE, completed INSIDE
    await insertTask(taskMoved, 8, 2, 'completed', false);   // created day8, completed day2
    // The populations that slip through a careless guard.
    await insertTask(taskOpen, 5, null, 'todo', false);      // never completed
    // MIGRATION 094 made this state unreachable by an ordinary INSERT: the
    // auto-stamp trigger fills it in, and the CHECK rejects it even with the trigger off.
    // It is reproduced deliberately here because the 208 legacy rows it models STILL EXIST
    // on prod — 094 does not backfill them — so the exclusion below still has to hold.
    await withLegacyUnstampedTasksAllowed(
      (sql, params) => pool.query(sql, params),
      () => insertTask(taskNoStamp, 5, null, 'completed', false), // completed status, NO stamp
    );
    await insertTask(taskArchived, 6, 4, 'completed', true); // completed but archived

    // `taskNoStamp` is not hypothetical: measured on prod 2026-08-10,
    //   SELECT count(*) FROM tasks WHERE status='completed' AND completed_at IS NULL
    // returned 207 (re-measured 2026-08-25: 208). Counting by status alone would inflate
    // the series with rows that have no day to be counted on.
  });

  afterAll(async () => {
    if (!pool) return;
    for (const pid of [projectWork, projectSessionHome]) {
      await pool.query('DELETE FROM tasks WHERE project_id = $1', [pid]);
      await pool.query('DELETE FROM sessions WHERE project_id = $1', [pid]);
      await pool.query('DELETE FROM projects WHERE id = $1', [pid]);
    }
    await pool.end();
  });

  const scopedDays = async (actor?: string) =>
    byDay(
      await SessionAnalyticsService.getSessionTrends(
        projectsScope([projectWork]), WINDOW_DAYS, actor, TZ,
      ),
    );

  describe('THE ANCHOR: completed_at, not created_at and not the session day', () => {
    it('counts a task CREATED OUTSIDE the window but COMPLETED INSIDE it, on its completion day', async () => {
      const days = await scopedDays();
      // `created_at` anchoring cannot see this row at all — it was created 40 days ago,
      // 30 days before the window opens.
      expect(days.get(day3)?.total_tasks_completed).toBe(1);
    });

    it('counts a task on its COMPLETION day and reads ZERO on its CREATION day', async () => {
      const days = await scopedDays();
      expect(days.get(day2)?.total_tasks_completed).toBe(1);
      // `created_at` anchoring would put this row here instead.
      expect(days.get(day8)?.total_tasks_completed).toBe(0);
    });

    it('does not land anything on the owning SESSION\'s day', async () => {
      const days = await scopedDays();
      // The denormalized `sessions.tasks_completed` counter would put all of them here.
      expect(days.get(sessionDay)?.total_tasks_completed).toBe(0);
    });
  });

  describe('the populations that slip through', () => {
    it('excludes a task that was never completed, and one whose status says completed with no stamp', async () => {
      const days = await scopedDays();
      // taskOpen and taskNoStamp were both created on day5 and neither may be counted
      // anywhere in the series.
      expect(days.get(day5)?.total_tasks_completed).toBe(0);
    });

    it('excludes an ARCHIVED completed task', async () => {
      const days = await scopedDays();
      expect(days.get(day4)?.total_tasks_completed).toBe(0);
    });

    it('reads a real ZERO on every other day and totals exactly the two live rows', async () => {
      const days = await scopedDays();
      const rows = [...days.values()];
      expect(rows.length).toBe(WINDOW_DAYS);
      expect(rows.reduce((n, r) => n + r.total_tasks_completed, 0)).toBe(2);
      // Every day is a number, never undefined/null — the series is gap-filled.
      expect(rows.every((r) => Number.isInteger(r.total_tasks_completed))).toBe(true);
    });
  });

  describe('the actor slice keeps its meaning (correlate to the owning session)', () => {
    it('counts the rows for the session\'s actor and nothing for another actor', async () => {
      const mine = await scopedDays(ACTOR);
      expect(mine.get(day3)?.total_tasks_completed).toBe(1);
      expect(mine.get(day2)?.total_tasks_completed).toBe(1);

      const other = await scopedDays('ci-nobody-at-all');
      expect([...other.values()].reduce((n, r) => n + r.total_tasks_completed, 0)).toBe(0);
    });
  });

  describe('the UNSCOPED path is anchored on completed_at too', () => {
    it('moves exactly the two completion days, measured as a delta against the same DB', async () => {
      const after = byDay(
        await SessionAnalyticsService.getSessionTrends(allProjects, WINDOW_DAYS, undefined, TZ),
      );
      const delta = (day: string) =>
        (after.get(day)?.total_tasks_completed ?? 0) -
        (unscopedBefore.get(day)?.total_tasks_completed ?? 0);

      // The whole point of doing this on BOTH paths: a task completed today is completed
      // today regardless of which session closed it, so unscoped cannot be session-day
      // anchored the way session_count / tokens / duration deliberately still are.
      expect(delta(day3)).toBe(1);
      expect(delta(day2)).toBe(1);
      expect(delta(day8)).toBe(0);
      expect(delta(sessionDay)).toBe(0);
    });
  });

  describe('ONE definition of "completed per day" in the product', () => {
    it('agrees day-for-day with TaskService.getThroughputSeries, on every day', async () => {
      // Two different rules for "completed per day" is drift we keep paying for, so the
      // agreement is ASSERTED rather than described. `getSessionTrends` reuses
      // getThroughputSeries' anchoring rule verbatim (completed_at IS NOT NULL AND
      // status='completed', bucketed on the viewer-local completion date).
      //
      // THE AXIS THEY USED TO DIFFER ON IS GONE (2026-08-25). This block
      // used to expect exactly ONE disagreement — day4, where `taskArchived` completes —
      // because getSessionTrends excluded `archived_at IS NOT NULL` and
      // getThroughputSeries did not. That asymmetry was the defect; getThroughputSeries
      // now excludes archived rows too, so the two series agree on EVERY day.
      //
      // The assertion is deliberately still a computed disagreement LIST rather than a
      // pair of equal totals: a list names the day and both values when it breaks, and it
      // is the same shape that pinned the old divergence — so a NEW divergence, on any
      // axis, still surfaces here instead of being averaged away.
      const trends = await scopedDays();
      const throughput = await TaskService.getThroughputSeries(
        projectsScope([projectWork]), WINDOW_DAYS, TZ,
      );
      expect(throughput.length).toBe(WINDOW_DAYS);

      const disagreements = throughput
        .filter((p) => (trends.get(p.day)?.total_tasks_completed ?? -1) !== p.completed)
        .map((p) => ({
          day: p.day,
          throughput: p.completed,
          trends: trends.get(p.day)?.total_tasks_completed,
        }));

      expect(disagreements).toEqual([]);
      // POSITIVE CONTROL: both series actually SAW the archived task's day and both said
      // ZERO there — otherwise "they agree" could be two broken empties agreeing.
      expect(trends.get(day4)?.total_tasks_completed).toBe(0);
      expect(throughput.find((p) => p.day === day4)?.completed).toBe(0);
    });
  });
});
