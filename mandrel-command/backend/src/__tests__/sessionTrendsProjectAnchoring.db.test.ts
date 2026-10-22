/**
 * DB test: the Workspace Activity series is anchored to the RECORD's project + day,
 * not to its owning SESSION's.
 *
 * ── THE DEFECT ──────────────────────────────────────────────────────────────────────
 * `SessionAnalyticsService.getSessionTrends` built its context/task series inside an
 * aggregate over `FROM sessions s WHERE s.project_id = <scope>`. A context therefore only
 * counted for project P if the SESSION that wrote it also belonged to P. Agents work in
 * one long-lived session and store records into whatever project the work is about, so
 * the two populations barely overlap.
 *
 * MEASURED on prod 2026-08-08 (live contexts created in the trailing 30 days, grouped by
 * the context's OWN project, split on whether its session shares that project):
 *     ctx project      | session same | session other | total
 *     riverbend       |         2078 |            49 |  2127
 *     mandrel       |            0 |            23 |    23
 *     daisy            |            0 |             6 |     6
 *     dev-desktop |            0 |             3 |     3
 *     acme            |            0 |             2 |     2
 *     personal         |            0 |             1 |     1
 * mandrel owns ZERO sessions, so its chart was a STRUCTURAL flat zero — not a low
 * number, an unreachable one.
 *
 * ── WHAT THIS SUITE PINS ────────────────────────────────────────────────────────────
 * The fixture is the exact divergent shape: ONE session owned by project S, which writes
 * contexts and tasks owned by project W, on a DAY LATER than the session started.
 *
 *   1. scoped to W  → the records appear, on the RECORD's day (the fix; RED before it)
 *   2. scoped to W  → session_count / tokens / duration stay ZERO (session-owned metrics
 *                     are deliberately NOT re-anchored)
 *   3. scoped to W  → the archived record is excluded
 *   4. scoped to S  → the session appears on the session's day and W's records do not
 *      leak in (the cross-project isolation contract, still intact)
 *   5. UNSCOPED     → the series is UNCHANGED: the fixture's contexts still land on the
 *      SESSION's start day, measured as a before/after DELTA against the same DB so it
 *      cannot be perturbed by whatever else lives there. This is the required regression
 *      guard — the unscoped path must keep its numbers byte-for-byte.
 *   6. the EMPTY scope (a caller with zero grants) returns an all-zero series, not a
 *      crash and not everything.
 *
 * Provision a throwaway migrated DB first:
 *   bash scripts/provision-test-db.sh ci_trends_anchor
 *   eval "$(bash scripts/provision-test-db.sh ci_trends_anchor --print-env)"
 *   npm test -- sessionTrendsProjectAnchoring
 *   bash scripts/provision-test-db.sh ci_trends_anchor --drop
 */
import { Pool } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import { SessionAnalyticsService, type SessionTrend } from '../services/sessionAnalytics';
import { describeDb, contractDbConfig } from './helpers/dbContractGate';
import { allProjects, projectsScope } from '../services/projectListScope';

/** Wide enough that the relative fixture days are always inside the window. */
const WINDOW_DAYS = 60;
const TZ = 'UTC';

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

describeDb('getSessionTrends — record-anchored project attribution', () => {
  let pool: Pool;

  // "S" owns the SESSION. "W" owns the WORK (contexts + tasks). The prod shape.
  const projectSessionHome = uuidv4();
  const projectWork = uuidv4();
  const sessionId = uuidv4();
  const liveContextIds = [uuidv4(), uuidv4(), uuidv4()];
  const archivedContextId = uuidv4();
  const taskIds = [uuidv4(), uuidv4()];

  // Resolved from Postgres so the expectation and the query agree on the calendar.
  let sessionDay = '';
  let recordDay = '';

  // The unscoped series as it was BEFORE this suite inserted anything.
  let unscopedBefore: Map<string, SessionTrend>;

  beforeAll(async () => {
    pool = new Pool(contractDbConfig);

    // (5) Baseline FIRST — the unscoped regression guard is a delta, so it must be read
    // before the fixture exists.
    unscopedBefore = byDay(
      await SessionAnalyticsService.getSessionTrends(allProjects, WINDOW_DAYS, undefined, TZ),
    );

    const { rows } = await pool.query(
      `SELECT to_char((now() - INTERVAL '5 days') AT TIME ZONE $1, 'YYYY-MM-DD') AS session_day,
              to_char((now() - INTERVAL '3 days') AT TIME ZONE $1, 'YYYY-MM-DD') AS record_day`,
      [TZ],
    );
    sessionDay = rows[0].session_day;
    recordDay = rows[0].record_day;
    // Guard the fixture's own premise: the records must land on a DIFFERENT day than the
    // session, or assertion (5) proves nothing.
    expect(recordDay > sessionDay).toBe(true);

    await pool.query(
      `INSERT INTO projects (id, name, description, status, created_at)
         VALUES ($1,$2,'trends anchoring: session home','active',NOW()),
                ($3,$4,'trends anchoring: work home','active',NOW())`,
      [
        projectSessionHome, `trends-anchor-S-${projectSessionHome.slice(0, 8)}`,
        projectWork, `trends-anchor-W-${projectWork.slice(0, 8)}`,
      ],
    );

    await pool.query(
      `INSERT INTO sessions (id, project_id, agent_type, display_id, started_at, ended_at, total_tokens)
         VALUES ($1, $2, 'mcp-server', $3, now() - INTERVAL '5 days', now() - INTERVAL '2 days', 4242)`,
      [sessionId, projectSessionHome, `ta-${sessionId.slice(0, 8)}`],
    );

    // 3 LIVE contexts owned by W, written by S's session, two days after it started.
    for (const cid of liveContextIds) {
      await pool.query(
        `INSERT INTO contexts (id, project_id, session_id, context_type, content, created_at)
           VALUES ($1, $2, $3, 'completion', 'trends anchoring fixture', now() - INTERVAL '3 days')`,
        [cid, projectWork, sessionId],
      );
    }
    // 1 ARCHIVED context, same shape — must NOT be counted.
    await pool.query(
      `INSERT INTO contexts (id, project_id, session_id, context_type, content, created_at, archived_at)
         VALUES ($1, $2, $3, 'completion', 'trends anchoring archived', now() - INTERVAL '3 days', now())`,
      [archivedContextId, projectWork, sessionId],
    );

    // 2 tasks owned by W, created by S's session, on the record day.
    for (const tid of taskIds) {
      await pool.query(
        `INSERT INTO tasks (id, project_id, session_id, title, type, status, priority, created_at)
           VALUES ($1, $2, $3, 'trends anchoring task', 'general', 'todo', 'medium', now() - INTERVAL '3 days')`,
        [tid, projectWork, sessionId],
      );
    }
  });

  afterAll(async () => {
    if (!pool) return;
    for (const pid of [projectWork, projectSessionHome]) {
      await pool.query('DELETE FROM tasks WHERE project_id = $1', [pid]);
      await pool.query('DELETE FROM contexts WHERE project_id = $1', [pid]);
      await pool.query('DELETE FROM sessions WHERE project_id = $1', [pid]);
      await pool.query('DELETE FROM projects WHERE id = $1', [pid]);
    }
    await pool.end();
  });

  describe('scoped to the project that OWNS the records', () => {
    it('counts them on the RECORD\'s own day, even though no session belongs to that project', async () => {
      const days = byDay(
        await SessionAnalyticsService.getSessionTrends(
          projectsScope([projectWork]), WINDOW_DAYS, undefined, TZ,
        ),
      );
      // THE FIX. Pre-fix this was 0 on every day of the series.
      expect(days.get(recordDay)?.total_contexts).toBe(3);
      expect(days.get(recordDay)?.total_tasks_created).toBe(2);
      // Nothing leaks onto the session's start day.
      expect(days.get(sessionDay)?.total_contexts).toBe(0);
      expect(days.get(sessionDay)?.total_tasks_created).toBe(0);
    });

    it('excludes the archived record (3 live, not 4)', async () => {
      const days = byDay(
        await SessionAnalyticsService.getSessionTrends(
          projectsScope([projectWork]), WINDOW_DAYS, undefined, TZ,
        ),
      );
      expect(days.get(recordDay)?.total_contexts).toBe(3);
    });

    it('leaves the SESSION-owned metrics alone — no session belongs here, so they are zero', async () => {
      const days = byDay(
        await SessionAnalyticsService.getSessionTrends(
          projectsScope([projectWork]), WINDOW_DAYS, undefined, TZ,
        ),
      );
      for (const d of [sessionDay, recordDay]) {
        expect(days.get(d)?.session_count).toBe(0);
        expect(days.get(d)?.total_tokens_used).toBe(0);
        expect(days.get(d)?.total_duration_minutes).toBe(0);
        expect(days.get(d)?.average_duration_minutes).toBe(0);
      }
    });
  });

  describe('scoped to the project that owns the SESSION', () => {
    it('shows the session on its start day and does NOT absorb the other project\'s records', async () => {
      const days = byDay(
        await SessionAnalyticsService.getSessionTrends(
          projectsScope([projectSessionHome]), WINDOW_DAYS, undefined, TZ,
        ),
      );
      expect(days.get(sessionDay)?.session_count).toBe(1);
      expect(days.get(sessionDay)?.total_tokens_used).toBe(4242);
      // The isolation contract: W's records must never be attributed to S.
      expect(days.get(sessionDay)?.total_contexts).toBe(0);
      expect(days.get(recordDay)?.total_contexts).toBe(0);
      expect(days.get(recordDay)?.total_tasks_created).toBe(0);
    });
  });

  describe('the UNSCOPED (all-projects) series stays SESSION-anchored — regression guard', () => {
    it('still buckets the fixture on the SESSION start day, not on the records\' own day', async () => {
      const after = byDay(
        await SessionAnalyticsService.getSessionTrends(allProjects, WINDOW_DAYS, undefined, TZ),
      );
      const delta = (day: string, k: keyof SessionTrend) =>
        Number(after.get(day)?.[k] ?? 0) - Number(unscopedBefore.get(day)?.[k] ?? 0);

      // Session-anchored, exactly as before: the contexts and BOTH tasks land on the
      // SESSION's start day, not on the day the records were actually created.
      expect(delta(sessionDay, 'session_count')).toBe(1);
      expect(delta(sessionDay, 'total_tasks_created')).toBe(2);
      expect(delta(sessionDay, 'total_tokens_used')).toBe(4242);

      // ...and nothing at all appears on the record day.
      expect(delta(recordDay, 'total_contexts')).toBe(0);
      expect(delta(recordDay, 'total_tasks_created')).toBe(0);
      expect(delta(recordDay, 'session_count')).toBe(0);
    });

    /**
     * THE ARCHIVED-SEMANTICS SPLIT (nit N3). The unscoped branch used to carry a
     * HAND-WRITTEN context subquery that omitted `archived_at IS NULL`, so this one
     * endpoint answered with two different archived rules depending on the scope: the
     * scoped series excluded archived contexts, the unscoped series counted them. It now
     * calls `contextCountSql` — the canonical builder — like the task counter beside it.
     *
     * The fixture seeds 3 LIVE + 1 ARCHIVED context on the same session, so 3 is the
     * discriminating value: the pre-fix subquery returns 4 here and nothing else about
     * the fixture distinguishes them.
     *
     * Measured on prod 2026-08-08: 2113 -> 2098 over the trailing 30 days (-15), matching
     * an independent count of 15 archived contexts on in-window sessions exactly.
     */
    it('excludes the archived context, matching the scoped path and sessionCounts.ts', async () => {
      const after = byDay(
        await SessionAnalyticsService.getSessionTrends(allProjects, WINDOW_DAYS, undefined, TZ),
      );
      const delta =
        Number(after.get(sessionDay)?.total_contexts ?? 0) -
        Number(unscopedBefore.get(sessionDay)?.total_contexts ?? 0);
      expect(delta).toBe(3);
    });

    it('the two scopes now agree on WHICH contexts count, differing only on WHICH DAY', async () => {
      // The whole point of N3: one endpoint, one archived rule. Scoped puts the 3 live
      // contexts on the record day; unscoped puts the same 3 on the session day.
      const scoped = byDay(
        await SessionAnalyticsService.getSessionTrends(
          projectsScope([projectWork]), WINDOW_DAYS, undefined, TZ,
        ),
      );
      const after = byDay(
        await SessionAnalyticsService.getSessionTrends(allProjects, WINDOW_DAYS, undefined, TZ),
      );
      const unscopedDelta =
        Number(after.get(sessionDay)?.total_contexts ?? 0) -
        Number(unscopedBefore.get(sessionDay)?.total_contexts ?? 0);
      expect(scoped.get(recordDay)?.total_contexts).toBe(unscopedDelta);
    });
  });

  describe('the EMPTY population', () => {
    it('a scope with zero grants returns a full all-zero series, not everything', async () => {
      const trends = await SessionAnalyticsService.getSessionTrends(
        projectsScope([]), WINDOW_DAYS, undefined, TZ,
      );
      // `WINDOW_DAYS`, not `WINDOW_DAYS + 1` (item 5). This line USED to
      // read `+ 1`, and that is a large part of why the off-by-one lasted: the inclusive
      // `generate_series` was not merely unnoticed, it was PINNED — a guard asserting the
      // defect protects it. The `+ 1` was never the property this test cares about (it
      // cares that an empty scope yields a FULL zero series rather than everything); it
      // was the implementation's length copied into an assertion.
      expect(trends).toHaveLength(WINDOW_DAYS);
      for (const t of trends) {
        expect(t.total_contexts).toBe(0);
        expect(t.total_tasks_created).toBe(0);
        expect(t.session_count).toBe(0);
      }
    });
  });
});
