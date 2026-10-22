/**
 * taskAnalyticsArchivedPopulation.db.test.ts — every task-analytics read answers about
 * the SAME population: live (non-archived) tasks.
 *
 * THE DEFECT THIS GUARDS
 *   `getTaskStats` filtered `archived_at IS NULL`; `getLeadTimeDistribution` did not.
 *   The Analytics "Work mix" panel draws both — Created/day and Open now from the
 *   archive-aware read, Completed/day and Median time to done from the other — so the
 *   two halves of one panel were cut on two populations. Nothing fails; the numbers
 *   just stop meaning the same thing the moment anyone archives a completed task.
 *
 *   The d21ec7bd sweep (`grep -n "FROM tasks" src/services/*.ts src/controllers/*.ts`)
 *   found the omission in THREE reads, not one: `getLeadTimeDistribution`,
 *   `getThroughputSeries` (all three of its CTEs) and `getCompletedByActor`. All three
 *   are asserted here, because fixing one instance and missing a sibling is the shape
 *   this class keeps taking.
 *
 * WHY THESE TESTS HAVE TEETH (C3)
 *   The fixture CONTAINS an archived completed task, and every assertion is preceded by
 *   a POSITIVE CONTROL that reads that row back with raw SQL — proving the row exists,
 *   is `status='completed'`, carries a non-null `archived_at`, and would be selected by
 *   the pre-fix predicate. Without that control the suite would pass against an empty
 *   fixture, which is exactly the hole found on `fb10aa52` (Reviewer probe 1b).
 *
 *   The archived row's numbers are chosen to be LOUD: its lead time (22d) is an order
 *   of magnitude off the live row's (2d), its actor name appears nowhere else, and its
 *   created_at is 20 days older than any live row so it also moves the throughput
 *   chart's left edge. Fixed and broken diverge on the smallest possible fixture: ONE
 *   live completed task and ONE archived completed task.
 *
 * RUN (throwaway DB — provision FIRST; --runInBand, the backend suites cross-contaminate
 * under parallel run):
 *   bash scripts/provision-test-db.sh ci_b1_dataloss
 *   eval "$(bash scripts/provision-test-db.sh ci_b1_dataloss --print-env)"
 *   npx jest taskAnalyticsArchivedPopulation --runInBand --forceExit
 *   bash scripts/provision-test-db.sh ci_b1_dataloss --drop
 */

import { v4 as uuidv4 } from 'uuid';

import { db } from '../database/connection';
import { TaskService } from '../services/task';
import { describeDb } from './helpers/dbContractGate';
import { projectsScope } from '../services/projectListScope';

describeDb('Task analytics reads share ONE population: live tasks', () => {
  let projectId: string;
  const createdTaskIds: string[] = [];

  /** The live completed task: created 10d ago, completed 8d ago → lead time 2 days. */
  const LIVE_ACTOR = 'alpha-live-d21ec7bd';
  /** The archived completed task: created 30d ago, completed 8d ago → lead time 22 days. */
  const ARCHIVED_ACTOR = 'beta-archived-d21ec7bd';

  const LIVE_LEAD_DAYS = 2;
  const ARCHIVED_LEAD_DAYS = 22;

  /**
   * Seed ONE task with raw SQL — not through the service — so the fixture cannot inherit
   * a bug from the code under test. `createdDaysAgo` / `completedDaysAgo` are resolved by
   * Postgres, so the fixture and the queries share one clock.
   */
  async function seedCompletedTask(opts: {
    archived: boolean;
    createdDaysAgo: number;
    completedDaysAgo: number;
    assignedTo: string;
  }): Promise<string> {
    const id = uuidv4();
    createdTaskIds.push(id);
    await db.query(
      `INSERT INTO tasks
         (id, project_id, title, description, type, status, priority, assigned_to,
          created_at, completed_at, archived_at)
       VALUES ($1, $2, $3, 'seeded by taskAnalyticsArchivedPopulation.db.test', 'general',
               'completed', 'medium', $4,
               now() - make_interval(days => $5::int),
               now() - make_interval(days => $6::int),
               CASE WHEN $7::boolean THEN now() ELSE NULL END)`,
      [
        id,
        projectId,
        `d21ec7bd probe ${id.slice(0, 8)}`,
        opts.assignedTo,
        opts.createdDaysAgo,
        opts.completedDaysAgo,
        opts.archived,
      ],
    );
    return id;
  }

  let liveTaskId: string;
  let archivedTaskId: string;
  const scope = () => projectsScope([projectId]);

  /**
   * POSITIVE CONTROL, shared by every case below.
   *
   * Asserts the archived row is REALLY in the fixture and REALLY reachable by the
   * predicate the pre-fix code used. If this ever stops holding, every "the archived row
   * is excluded" assertion below becomes a no-op against an empty set — the failure mode
   * this control exists to make impossible.
   */
  async function assertFixtureWouldFeedThePreFixQuery(): Promise<void> {
    const res = await db.query(
      `SELECT id, status, archived_at,
              EXTRACT(EPOCH FROM (completed_at - created_at)) / 86400 AS lead_time_days
         FROM tasks
        WHERE project_id = $1
          AND status = 'completed'
          AND completed_at IS NOT NULL
          AND created_at IS NOT NULL
        ORDER BY lead_time_days`,
      [projectId],
    );
    // The pre-fix predicate selects BOTH rows. That is the bug, stated as a measurement.
    expect(res.rows.map((r: any) => r.id)).toEqual([liveTaskId, archivedTaskId]);
    expect(res.rows[0].archived_at).toBeNull();
    expect(res.rows[1].archived_at).not.toBeNull();
    expect(Math.round(parseFloat(res.rows[0].lead_time_days))).toBe(LIVE_LEAD_DAYS);
    expect(Math.round(parseFloat(res.rows[1].lead_time_days))).toBe(ARCHIVED_LEAD_DAYS);
  }

  beforeAll(async () => {
    projectId = uuidv4();
    await db.query(
      `INSERT INTO projects (id, name, description, status, created_at)
       VALUES ($1, $2, 'taskAnalyticsArchivedPopulation fixture', 'active', NOW())`,
      [projectId, `d21ec7bd-${projectId.slice(0, 8)}`],
    );

    liveTaskId = await seedCompletedTask({
      archived: false,
      createdDaysAgo: 10,
      completedDaysAgo: 8,
      assignedTo: LIVE_ACTOR,
    });
    archivedTaskId = await seedCompletedTask({
      archived: true,
      createdDaysAgo: 30,
      completedDaysAgo: 8,
      assignedTo: ARCHIVED_ACTOR,
    });
  });

  afterAll(async () => {
    if (createdTaskIds.length) {
      await db.query('DELETE FROM tasks WHERE id = ANY($1::uuid[])', [createdTaskIds]);
    }
    await db.query('DELETE FROM projects WHERE id = $1', [projectId]);
    await db.end();
  });

  // ──────────────────────────────────────────────────────────────────────────────
  // THE NAMED DEFECT
  // ──────────────────────────────────────────────────────────────────────────────

  it('getLeadTimeDistribution excludes the archived completed task', async () => {
    await assertFixtureWouldFeedThePreFixQuery();

    const result = await TaskService.getLeadTimeDistribution(scope(), null);

    // One task, not two — and the reported lead time is the LIVE row's. Pre-fix these
    // read totalTasks: 2 and medianLeadTime: 22 (leadTimes is ORDER BY lead_time_days,
    // so the archived 22d row lands on the median index for n=2).
    expect(result.stats.totalTasks).toBe(1);
    expect(Math.round(result.stats.medianLeadTime)).toBe(LIVE_LEAD_DAYS);
    expect(Math.round(result.stats.averageLeadTime)).toBe(LIVE_LEAD_DAYS);

    // `distribution` is always the same five fixed buckets, so the observable is the
    // COUNTS, not the bucket list. The archived row's 22 days lands in "2+ weeks"; that
    // bucket must be empty, and the counts must sum to exactly the one live task.
    const twoPlusWeeks = result.distribution.find((d) => d.leadTimeDays === ARCHIVED_LEAD_DAYS - 1);
    expect(twoPlusWeeks).toBeDefined(); // the bucket exists — we are reading the right one
    expect(twoPlusWeeks!.count).toBe(0);
    expect(result.distribution.reduce((n, d) => n + d.count, 0)).toBe(1);
  });

  it('getLeadTimeDistribution and getTaskStats can state the SAME population', async () => {
    await assertFixtureWouldFeedThePreFixQuery();

    // This is the panel-level claim from the task: the two halves of Work Mix agree.
    const stats = await TaskService.getTaskStats(scope(), null);
    const lead = await TaskService.getLeadTimeDistribution(scope(), null);

    expect(stats.by_status.completed ?? 0).toBe(1);
    expect(lead.stats.totalTasks).toBe(stats.by_status.completed ?? 0);
    // And the archived row is accounted for — separately, never folded into the total.
    expect(stats.archived).toBe(1);
    expect(stats.total).toBe(1);
  });

  // ──────────────────────────────────────────────────────────────────────────────
  // THE SIBLINGS THE SWEEP FOUND — same omission, same panel family
  // ──────────────────────────────────────────────────────────────────────────────

  it('getThroughputSeries counts only the live completion, and starts at the live row', async () => {
    await assertFixtureWouldFeedThePreFixQuery();

    const series = await TaskService.getThroughputSeries(scope(), null, 'UTC');

    // `comp` CTE: one completion, not two — both rows completed on the SAME day, so a
    // missing filter shows up as a 2 in a single bucket.
    const totalCompleted = series.reduce((n, row) => n + row.completed, 0);
    expect(totalCompleted).toBe(1);

    // `crea` CTE: one creation.
    const totalCreated = series.reduce((n, row) => n + row.created, 0);
    expect(totalCreated).toBe(1);

    // `b` CTE (the chart's left edge): derived from the LIVE row's created_at (10d ago),
    // not the archived row's (30d ago). Expected value is read from the same clock the
    // query uses, never from the test process's clock.
    const expected = await db.query(
      `SELECT to_char(((now() AT TIME ZONE 'UTC') - make_interval(days => 10))::date, 'YYYY-MM-DD') AS d,
              to_char((now() AT TIME ZONE 'UTC')::date, 'YYYY-MM-DD') AS today`,
    );
    expect(series[0].day).toBe(expected.rows[0].d);
    expect(series[series.length - 1].day).toBe(expected.rows[0].today);
    expect(series.length).toBe(11); // inclusive: 10 days ago .. today
  });

  it('getCompletedByActor omits the archived task’s assignee entirely', async () => {
    await assertFixtureWouldFeedThePreFixQuery();

    const rows = await TaskService.getCompletedByActor(scope(), null);

    // POSITIVE CONTROL on the read itself: it DID see the live row. Otherwise "the
    // archived actor is absent" could just be an empty result.
    expect(rows.find((r) => r.actor === LIVE_ACTOR)?.count).toBe(1);
    expect(rows.map((r) => r.actor)).not.toContain(ARCHIVED_ACTOR);
  });
});
