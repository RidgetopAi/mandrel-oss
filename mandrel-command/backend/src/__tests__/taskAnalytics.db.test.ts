/**
 * DB-integration tests for the Tasks page BACKEND work:
 *
 *   1. (was: completed_at LIFECYCLE on the Command write paths — removed by an earlier task
 *      when those paths became delegations; the rule is now a DB trigger + CHECK, guarded
 *      in completedAtUnforgettable.db.test.ts. See the note where the block used to be.)
 *   2. LIST pagination — the list honours a bounded `limit`/`offset` server-side, while
 *      `/tasks/stats` stays an uncapped COUNT.
 *   3. RANGE-AWARE lead-time — a 7d window excludes older completions; `all` includes them.
 *   4. THROUGHPUT series — per-day completed/created buckets, range-filtered, honest-empty.
 *   5. COMPLETED-BY-ACTOR — completions grouped by assignee, range-filtered, honest-empty.
 *
 * These exercise the real TaskService methods (not raw SQL) so each assertion FAILS if the
 * corresponding change is reverted (mutation-resistant — tests-are-the-rock). We SEED exact
 * rows with explicit created_at/completed_at and assert them back; nothing is fabricated.
 *
 * Provision a throwaway migrated DB first (creates the tasks schema + extensions):
 *   bash scripts/provision-test-db.sh ci_tasks_be_fm
 *   eval "$(bash scripts/provision-test-db.sh ci_tasks_be_fm --print-env)"
 *   npm test -- taskAnalytics
 *   bash scripts/provision-test-db.sh ci_tasks_be_fm --drop
 *
 * Gated by describeDb (helpers/dbContractGate): runs whenever Postgres is
 * reachable, and FAILS LOUDLY rather than skipping when it is not.
 */

import { Pool } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import { TaskService } from '../services/task';
import { describeDb } from './helpers/dbContractGate';
import { projectsScope } from '../services/projectListScope';


/** Insert a task with fully explicit fields (times as SQL expressions, e.g. `NOW() - INTERVAL '3 days'`). */
async function seedTask(
  pool: Pool,
  opts: {
    projectId: string;
    title?: string;
    status?: string;
    priority?: string;
    assignedTo?: string | null;
    createdExpr?: string; // SQL expression for created_at
    completedExpr?: string | null; // SQL expression for completed_at, or null
  },
): Promise<string> {
  const id = uuidv4();
  const {
    projectId,
    title = 'seed task',
    status = 'todo',
    priority = 'medium',
    assignedTo = null,
    createdExpr = 'NOW()',
    completedExpr = null,
  } = opts;
  await pool.query(
    `INSERT INTO tasks (id, project_id, title, type, status, priority, assigned_to, tags, created_at, completed_at)
     VALUES ($1,$2,$3,'general',$4,$5,$6,'{}', ${createdExpr}, ${completedExpr ?? 'NULL'})`,
    [id, projectId, title, status, priority, assignedTo],
  );
  return id;
}

describeDb('Tasks backend — analytics + correctness (DB integration)', () => {
  let pool: Pool;

  // Disjoint throwaway projects per concern so they never count each other's rows.
  const pList = uuidv4();
  const pLead = uuidv4();
  const pThroughput = uuidv4();
  const pCreatedOnly = uuidv4();
  const pActor = uuidv4();
  const pEmpty = uuidv4();
  const allProjects = [pList, pLead, pThroughput, pCreatedOnly, pActor, pEmpty];

  beforeAll(async () => {
    pool = new Pool({
      user: process.env.DATABASE_USER || 'mandrel',
      host: process.env.DATABASE_HOST || 'localhost',
      database: process.env.DATABASE_NAME || 'mandrel',
      password: process.env.DATABASE_PASSWORD || '',
      port: parseInt(process.env.DATABASE_PORT || '5432'),
    });

    for (const pid of allProjects) {
      await pool.query(
        `INSERT INTO projects (id, name, description, status, created_at) VALUES ($1,$2,$3,'active',NOW())`,
        [pid, `tasks-be-test-${pid.slice(0, 8)}`, 'tasks backend test'],
      );
    }
  });

  afterAll(async () => {
    for (const pid of allProjects) {
      await pool.query('DELETE FROM tasks WHERE project_id = $1', [pid]);
      await pool.query('DELETE FROM projects WHERE id = $1', [pid]);
    }
    await pool.end();
  });

  // ── 1. completed_at lifecycle — MOVED OUT ──────────────────
  // These four cases drove `TaskService.updateTask` / `bulkUpdateStatus` and read the
  // stamp back. Both methods now DELEGATE to the mcp-server `task_update` /
  // `task_bulk_update` tools, so this suite can no longer produce the write without
  // standing up an MCP server — and a case whose RED would mean "port 8080 is closed" is // reserved-port-ok: prose naming prod's bind; this suite starts no listener
  // not a guard.
  //
  // The rule outlived the tests. `completed_at` is enforced by a TRIGGER + CHECK on the
  // table itself (migration 094) against ANY writer, delegated or not, and that is
  // exercised with raw SQL in completedAtUnforgettable.db.test.ts. The lead-time /
  // throughput / completed-by-actor cases BELOW still read `completed_at` off seeded rows,
  // so the column staying meaningful is still asserted in this file.
  // ──────────────────────────────────────────────────────────────────────────

  // ── 2. list pagination ─────────────────────────────────────────────────────
  describe('list limit + offset (stats stays uncapped)', () => {
    const TOTAL = 12;
    beforeAll(async () => {
      for (let i = 0; i < TOTAL; i++) {
        await seedTask(pool, { projectId: pList, title: `list-${i}`, priority: 'medium' });
      }
    });

    it('honours a limit smaller than the row count', async () => {
      const { tasks: rows } = await TaskService.getTasks({ scope: projectsScope([pList]), limit: 5 });
      expect(rows).toHaveLength(5);
    });

    it('offset pages past the first window', async () => {
      const { tasks: first } = await TaskService.getTasks({ scope: projectsScope([pList]), limit: 5, offset: 0 });
      const { tasks: second } = await TaskService.getTasks({ scope: projectsScope([pList]), limit: 5, offset: 5 });
      const firstIds = new Set(first.map((t) => t.id));
      // No overlap between page 1 and page 2.
      expect(second.every((t) => !firstIds.has(t.id))).toBe(true);
    });

    // PER-COLUMN PAGING — `total` is the TRUE row count matching the
    // filter, computed in the SAME query (`COUNT(*) OVER()`), not the capped page length.
    // This is what lets a board column show "N of TOTAL" / render a load-more affordance
    // instead of mistaking a short page for an empty or exhausted column.
    it('total is the TRUE row count, not the capped page length', async () => {
      const { tasks: rows, total } = await TaskService.getTasks({ scope: projectsScope([pList]), limit: 5 });
      expect(rows).toHaveLength(5);
      expect(total).toBeGreaterThanOrEqual(TOTAL);
    });

    it('stats total is the FULL count, uncapped by the list limit', async () => {
      const stats = await TaskService.getTaskStats(projectsScope([pList]));
      expect(stats.total).toBe(TOTAL);
    });
  });

  // ── 3. range-aware lead-time ───────────────────────────────────────────────
  describe('range-aware lead-time', () => {
    beforeAll(async () => {
      // Recent completion: created 3d ago, completed 1d ago (in the 7d window).
      await seedTask(pool, {
        projectId: pLead,
        status: 'completed',
        createdExpr: "NOW() - INTERVAL '3 days'",
        completedExpr: "NOW() - INTERVAL '1 day'",
      });
      // Old completion: completed 40d ago (outside the 7d window, inside All).
      await seedTask(pool, {
        projectId: pLead,
        status: 'completed',
        createdExpr: "NOW() - INTERVAL '45 days'",
        completedExpr: "NOW() - INTERVAL '40 days'",
      });
    });

    it('7d window EXCLUDES the 40-day-old completion', async () => {
      const res = await TaskService.getLeadTimeDistribution(projectsScope([pLead]), 7);
      expect(res.stats.totalTasks).toBe(1);
    });

    it('All (null) window INCLUDES both completions', async () => {
      const res = await TaskService.getLeadTimeDistribution(projectsScope([pLead]), null);
      expect(res.stats.totalTasks).toBe(2);
    });
  });

  // ── 4. throughput series ───────────────────────────────────────────────────
  describe('throughput series (per-day, range-filtered, honest-empty)', () => {
    beforeAll(async () => {
      // Two completed on the SAME recent day (created earlier), one completed 40d ago.
      await seedTask(pool, {
        projectId: pThroughput,
        status: 'completed',
        createdExpr: "NOW() - INTERVAL '3 days'",
        completedExpr: "NOW() - INTERVAL '1 day'",
      });
      await seedTask(pool, {
        projectId: pThroughput,
        status: 'completed',
        createdExpr: "NOW() - INTERVAL '3 days'",
        completedExpr: "NOW() - INTERVAL '1 day'",
      });
      await seedTask(pool, {
        projectId: pThroughput,
        status: 'completed',
        createdExpr: "NOW() - INTERVAL '45 days'",
        completedExpr: "NOW() - INTERVAL '40 days'",
      });
      // Created-but-NOT-completed in the window (real activity, no completion yet).
      await seedTask(pool, {
        projectId: pCreatedOnly,
        status: 'todo',
        createdExpr: "NOW() - INTERVAL '2 days'",
      });
    });

    it('7d series buckets both recent completions on one day and totals 2 completed', async () => {
      const series = await TaskService.getThroughputSeries(projectsScope([pThroughput]), 7);
      expect(series.length).toBe(7); // one point per day across the window
      const totalCompleted = series.reduce((s, p) => s + p.completed, 0);
      expect(totalCompleted).toBe(2); // the 40-day-old one is excluded
      const oneDay = series.filter((p) => p.completed === 2);
      expect(oneDay).toHaveLength(1); // both landed on the same day
    });

    it('All window includes the 40-day-old completion (total 3)', async () => {
      const series = await TaskService.getThroughputSeries(projectsScope([pThroughput]), null);
      const totalCompleted = series.reduce((s, p) => s + p.completed, 0);
      expect(totalCompleted).toBe(3);
    });

    it('lights up on created-but-NOT-completed activity (non-empty series, completed=0)', async () => {
      const series = await TaskService.getThroughputSeries(projectsScope([pCreatedOnly]), 7);
      expect(series.length).toBe(7); // window is populated, not empty
      const totalCompleted = series.reduce((s, p) => s + p.completed, 0);
      const totalCreated = series.reduce((s, p) => s + p.created, 0);
      expect(totalCompleted).toBe(0); // nothing completed
      expect(totalCreated).toBe(1); // but the created line is present
    });

    it('honest empty: [] only when there is ZERO activity of either kind', async () => {
      const series = await TaskService.getThroughputSeries(projectsScope([pEmpty]), null);
      expect(series).toEqual([]);
    });
  });

  // ── 5. completed-by-actor ──────────────────────────────────────────────────
  describe('completed-by-actor (grouped by assignee, range-filtered)', () => {
    beforeAll(async () => {
      const recent = "NOW() - INTERVAL '1 day'";
      const old = "NOW() - INTERVAL '40 days'";
      await seedTask(pool, { projectId: pActor, status: 'completed', assignedTo: 'coordinator', completedExpr: recent });
      await seedTask(pool, { projectId: pActor, status: 'completed', assignedTo: 'coordinator', completedExpr: recent });
      await seedTask(pool, { projectId: pActor, status: 'completed', assignedTo: 'builder', completedExpr: recent });
      await seedTask(pool, { projectId: pActor, status: 'completed', assignedTo: null, completedExpr: recent });
      // An OLD completion by coordinator — only counted in the All window.
      await seedTask(pool, { projectId: pActor, status: 'completed', assignedTo: 'coordinator', completedExpr: old });
      // A TODO by coordinator — never counted (not completed).
      await seedTask(pool, { projectId: pActor, status: 'todo', assignedTo: 'coordinator' });
    });

    it('7d window groups completions by assignee (coordinator 2, builder 1, unassigned 1)', async () => {
      const rows = await TaskService.getCompletedByActor(projectsScope([pActor]), 7);
      const map = Object.fromEntries(rows.map((r) => [r.actor, r.count]));
      expect(map).toEqual({ coordinator: 2, builder: 1, unassigned: 1 });
    });

    it('All window includes the old coordinator completion (coordinator 3)', async () => {
      const rows = await TaskService.getCompletedByActor(projectsScope([pActor]), null);
      const coordinator = rows.find((r) => r.actor === 'coordinator');
      expect(coordinator?.count).toBe(3);
    });

    it('honest empty: [] when nothing completed in scope', async () => {
      const rows = await TaskService.getCompletedByActor(projectsScope([pEmpty]), null);
      expect(rows).toEqual([]);
    });
  });
});
