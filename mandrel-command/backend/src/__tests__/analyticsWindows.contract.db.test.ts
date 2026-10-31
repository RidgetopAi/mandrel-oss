/**
 * Contract tests for an earlier task — the three Analytics reads whose WINDOW was wrong or
 * absent, and the "who" column that was a constant.
 *
 * These run against the real migrated Postgres because every claim here is a statement
 * the DATABASE makes: how many rows a `generate_series` returns, whether a date predicate
 * excludes a row, what `s.actor` holds. A hand-modelled oracle for any of them would only
 * re-assert the assumption that produced the bug — the previous code was written by
 * someone who believed `generate_series(today - 30 days, today)` yields 30 rows.
 *
 * WHAT EACH SUITE PROBES ON PURPOSE — the populations that slip through:
 *   - a row EXACTLY on the window edge and one just outside it, so an off-by-one in the
 *     predicate is a different answer rather than coincidentally the same one;
 *   - a session with NO actor and one with an actor the registry does not know, because
 *     those are the two ways the "who" column can be empty rather than wrong;
 *   - the EMPTY window (a scope with nothing in it), because a windowed read that throws
 *     or returns a fabricated row on empty is worse than the all-time read it replaced.
 *
 * Requires a reachable Postgres — see __tests__/helpers/dbContractGate.ts. Never a
 * silent green.
 */
import { Pool } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import { SessionAnalyticsService } from '../services/sessionAnalytics';
import { TaskService } from '../services/task';
import { contractDbConfig, describeContract, assertDbReachable } from './helpers/dbContractGate';
import { projectsScope } from '../services/projectListScope';

describeContract('Analytics windows (contract)', () => {
  let pool: Pool;
  const project = uuidv4();
  const emptyProject = uuidv4();
  const scope = projectsScope([project]);
  const emptyScope = projectsScope([emptyProject]);

  /** Sessions placed by AGE IN DAYS, so each suite can name the edge it is testing. */
  const sInWindow = uuidv4(); //      2 days old   — inside every window below
  const sOnEdge = uuidv4(); //        6 days old   — inside a 7-day window, only just
  const sOutside = uuidv4(); //      45 days old   — outside 7 and 30, inside 90
  const sNoActor = uuidv4(); //       1 day old    — actor IS NULL
  const sUnknownActor = uuidv4(); //  1 day old    — actor the registry does not know

  beforeAll(async () => {
    pool = new Pool(contractDbConfig);
    await assertDbReachable(pool);
    const client = await pool.connect();
    try {
      for (const [id, name] of [
        [project, `windows-test-${project.slice(0, 8)}`],
        [emptyProject, `windows-empty-${emptyProject.slice(0, 8)}`],
      ] as const) {
        await client.query(
          `INSERT INTO projects (id, name, description, created_at) VALUES ($1, $2, 'windows', NOW())`,
          [id, name]
        );
      }

      const session = async (id: string, actor: string | null, ageDays: number) =>
        client.query(
          `INSERT INTO sessions (id, project_id, agent_type, actor, started_at, ended_at, total_tokens)
             VALUES ($1, $2, 'mcp-server', $3,
                     NOW() - make_interval(days => $4),
                     NOW() - make_interval(days => $4) + INTERVAL '1 hour', 5000)`, // reserved-port-ok: total_tokens fixture value, not a port
          [id, project, actor, ageDays]
        );
      // Context COUNT is the ranking metric, so the counts are deliberately distinct and
      // ordered against age: if the window were ignored, the oldest row would rank first.
      const contexts = async (sessionId: string, n: number, ageDays: number) => {
        for (let i = 0; i < n; i++) {
          await client.query(
            `INSERT INTO contexts (id, project_id, session_id, context_type, content, created_at)
               VALUES ($1, $2, $3, 'code', $4, NOW() - make_interval(days => $5))`,
            [uuidv4(), project, sessionId, `windows ctx ${sessionId.slice(0, 4)}-${i}`, ageDays]
          );
        }
      };

      await session(sInWindow, 'coordinator', 2);
      await contexts(sInWindow, 3, 2);
      await session(sOnEdge, 'coordinator-alert-sink', 6);
      await contexts(sOnEdge, 2, 6);
      await session(sOutside, 'operator', 45);
      await contexts(sOutside, 50, 45); // by far the LARGEST — an unwindowed read ranks it #1
      await session(sNoActor, null, 1);
      await contexts(sNoActor, 1, 1);
      await session(sUnknownActor, 'some-unregistered-bot', 1);
      await contexts(sUnknownActor, 1, 1);

      const task = async (status: string, ageDays: number) =>
        client.query(
          `INSERT INTO tasks (id, project_id, title, status, type, priority, created_at, updated_at)
             VALUES ($1, $2, $3, $4, 'feature', 'medium',
                     NOW() - make_interval(days => $5), NOW())`,
          [uuidv4(), project, `windows task ${status} ${ageDays}d`, status, ageDays]
        );
      await task('completed', 2);
      await task('todo', 2);
      await task('completed', 45); // outside 7 and 30 — and `updated_at` is NOW() on purpose
    } finally {
      client.release();
    }
  });

  afterAll(async () => {
    const client = await pool.connect();
    try {
      await client.query('DELETE FROM contexts WHERE project_id = ANY($1)', [[project, emptyProject]]);
      await client.query('DELETE FROM tasks WHERE project_id = ANY($1)', [[project, emptyProject]]);
      await client.query('DELETE FROM sessions WHERE project_id = ANY($1)', [[project, emptyProject]]);
      await client.query('DELETE FROM projects WHERE id = ANY($1)', [[project, emptyProject]]);
    } finally {
      client.release();
      await pool.end();
    }
  });

  // ── ITEM 5: the series length ──────────────────────────────────────────────────────
  describe('getSessionTrends returns EXACTLY `days` rows', () => {
    it.each([1, 7, 30, 90])('a %i-day request yields that many day buckets', async (days) => {
      // The bug: `generate_series(today - N days, today, '1 day')` is inclusive at BOTH
      // ends, so this returned N+1. Every consumer halves this array for its delta, and
      // an odd length handed the RECENT half a free extra day, every render.
      const rows = await SessionAnalyticsService.getSessionTrends(scope, days, undefined, 'UTC');
      expect(rows).toHaveLength(days);
    });

    it('the last bucket is TODAY and the first is `days - 1` back', async () => {
      // The frontend's delta drops the trailing bucket as "today, still in progress".
      // That is only sound if the series really does end today — asserted here, at the
      // source, rather than assumed in the browser.
      const days = 30;
      const rows = await SessionAnalyticsService.getSessionTrends(scope, days, undefined, 'UTC');
      const dayOf = (v: unknown) => new Date(v as string | Date).toISOString().slice(0, 10);
      const today = new Date();
      const expectedLast = today.toISOString().slice(0, 10);
      const expectedFirst = new Date(today.getTime() - (days - 1) * 86400000)
        .toISOString()
        .slice(0, 10);
      expect(dayOf(rows[rows.length - 1].date)).toBe(expectedLast);
      expect(dayOf(rows[0].date)).toBe(expectedFirst);
    });

    it('gap-fills an EMPTY scope rather than returning nothing', async () => {
      // The zero population: a project with no sessions must still yield a full-length
      // series of zeros, or the chart's x-axis silently changes width with the data.
      const rows = await SessionAnalyticsService.getSessionTrends(emptyScope, 7, undefined, 'UTC');
      expect(rows).toHaveLength(7);
      expect(rows.every((r) => r.session_count === 0)).toBe(true);
    });
  });

  // ── ITEM 3: the most-active-sessions window, actor, and metric ─────────────────────
  describe('getProductiveSessions is windowed and attributed', () => {
    it('EXCLUDES a session outside the window even though it is the largest', async () => {
      // The discriminating case: `sOutside` has 50 contexts against `sInWindow`'s 3, so
      // an unwindowed read ranks it FIRST. Prod's real top row was 213 days old.
      const rows = await SessionAnalyticsService.getProductiveSessions(scope, 50, 7);
      const ids = rows.map((r) => r.id);
      expect(ids).toContain(sInWindow);
      expect(ids).toContain(sOnEdge); // 6 days old — inside a 7-day window
      expect(ids).not.toContain(sOutside);
    });

    it('INCLUDES that same session once the window is wide enough', async () => {
      // The control leg: the exclusion above must be the WINDOW doing it, not the row
      // being unreachable for some other reason.
      const rows = await SessionAnalyticsService.getProductiveSessions(scope, 50, 90);
      expect(rows.map((r) => r.id)).toContain(sOutside);
    });

    it('is unbounded when `days` is null — the service default other callers rely on', async () => {
      const rows = await SessionAnalyticsService.getProductiveSessions(scope, 50, null);
      expect(rows.map((r) => r.id)).toContain(sOutside);
    });

    it('ranks by CONTEXT COUNT and carries no productivity_score', async () => {
      const rows = await SessionAnalyticsService.getProductiveSessions(scope, 50, 90);
      const counts = rows.map((r) => r.context_count);
      expect([...counts]).toEqual([...counts].sort((a, b) => b - a));
      expect(rows[0].id).toBe(sOutside); // 50 contexts, the largest in a 90-day window
      for (const r of rows) {
        expect(Object.prototype.hasOwnProperty.call(r, 'productivity_score')).toBe(false);
      }
    });

    it('returns the ACTOR and its registry kind — not one constant for every row', async () => {
      const rows = await SessionAnalyticsService.getProductiveSessions(scope, 50, 90);
      const byId = new Map(rows.map((r) => [r.id, r]));
      expect(byId.get(sInWindow)!.actor).toBe('coordinator');
      expect(byId.get(sInWindow)!.actor_kind).toBe('agent');
      expect(byId.get(sOnEdge)!.actor).toBe('coordinator-alert-sink');
      expect(byId.get(sOnEdge)!.actor_kind).toBe('automation');
      // The two absence shapes: no actor at all, and an actor no registry entry matches.
      expect(byId.get(sNoActor)!.actor).toBeNull();
      expect(byId.get(sNoActor)!.actor_kind).toBeNull();
      expect(byId.get(sUnknownActor)!.actor).toBe('some-unregistered-bot');
      expect(byId.get(sUnknownActor)!.actor_kind).toBeNull();
      // The whole point: the "who" is not one value repeated down the column.
      expect(new Set(rows.map((r) => r.actor)).size).toBeGreaterThan(1);
    });

    it('returns [] for an empty scope rather than throwing', async () => {
      await expect(
        SessionAnalyticsService.getProductiveSessions(emptyScope, 50, 30)
      ).resolves.toEqual([]);
    });
  });

  // ── ITEM 4: the work-mix window ────────────────────────────────────────────────────
  describe('getTaskStats honours the range window', () => {
    it('counts tasks CREATED in the window, not every task ever filed', async () => {
      const all = await TaskService.getTaskStats(scope, null);
      const recent = await TaskService.getTaskStats(scope, 7);
      expect(all.total).toBe(3);
      expect(recent.total).toBe(2);
      expect(recent.by_status!.completed).toBe(1);
      expect(recent.by_status!.todo).toBe(1);
    });

    it('CREATED, not TOUCHED — the 45-day-old task has updated_at = NOW()', async () => {
      // This is what makes the choice testable rather than a comment: the excluded row
      // was touched a moment ago, so an `updated_at` window would include it and this
      // assertion would fail. The panel subtitle says "created", and so does the SQL.
      const recent = await TaskService.getTaskStats(scope, 7);
      expect(recent.total).toBe(2);
      const touchedRecently = await pool.query(
        `SELECT COUNT(*)::int AS n FROM tasks
          WHERE project_id = $1 AND archived_at IS NULL
            AND updated_at >= NOW() - INTERVAL '7 days'`,
        [project]
      );
      expect(touchedRecently.rows[0].n).toBe(3);
    });

    it('an empty window is an honest zero, not a fabricated row', async () => {
      const none = await TaskService.getTaskStats(emptyScope, 30);
      expect(none.total).toBe(0);
      expect(none.by_status).toEqual({});
    });
  });
});
