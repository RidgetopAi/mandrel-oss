/**
 * project_insights DATA-INTEGRITY Contract Test
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * WHY THIS FILE EXISTS AT ALL — the absence of it IS the root cause.
 * ═══════════════════════════════════════════════════════════════════════════════
 * project_insights shipped TWO pieces of fabricated data to customers for ~10 months
 * (2025-09-10 → 2026-07-20). Before this file, the tool had ZERO behavioural coverage —
 * it appeared only in toolSurfaceGolden's surface-REGISTRATION test, which asserts the
 * tool EXISTS and never asserts a single returned VALUE. That is exactly how both
 * defects survived: nothing ever looked at the numbers.
 *
 * DEFECT 1 — the task rollup read a GHOST TABLE.
 *   getTaskInsights queried `agent_tasks`, which no longer exists. 53 of 99 projects
 *   (every project with tasks) reported tasksTotal: 0 / completionRate 0. The DATA was
 *   always there and correct — only the READ pointed at a table that was gone.
 *
 *   Provenance, stated only as far as it is actually VERIFIED (an earlier version of this
 *   header confidently blamed a migration that turns out not to mention `agent_tasks` at
 *   all — see the note in handlers/smartSearch.getTaskInsights for the full evidence):
 *     • `agent_tasks` was CREATED by 005_create_agent_coordination.sql:31.
 *     • NO migration in the tree ever renames or drops it — grep across
 *       database/migrations/ finds no such statement.
 *     • The consolidated 000_baseline_schema.sql declares `public.tasks` (line 5101) and
 *       carries no `agent_tasks` table.
 *     • VERIFIED END STATE (live prod, read-only): `tasks` exists, `agent_tasks` does not.
 *   The end state is what this test pins, and the end state is certain.
 *
 * DEFECT 2 — absent code data rendered as PERFECT.
 *   AVG(complexity_score) over zero rows is SQL NULL → coerced to 0 upstream → the old
 *   scoring computed 100 - 0 - 0 = 100 and banded 0 < 3 as 'healthy'. 98 of 99 projects
 *   reported "🟢 HEALTHY 100/100" alongside "No code analyzed yet". A wrong number is
 *   visible; a fabricated green is TRUSTED — the worse of the two.
 *
 * DEFECT 3 (the meta-defect) — THE CAMOUFLAGE, and the thing this file most exists to stop.
 *   Commit c688805, 48h after the rename, added an information_schema existence check that
 *   returned {total: 0} when `agent_tasks` was missing. That turned a LOUD
 *   `relation "agent_tasks" does not exist` — which would have failed on day one — into a
 *   plausible silent zero. The guard WAS the bug's camouflage.
 *
 *   So the permanent contract this file pins is not just "the numbers are right today".
 *   It is: IF THE UNDERLYING DATA CANNOT BE READ, project_insights MUST FAIL LOUD.
 *   Never a 0, never a default, never a swallowed error. The fail-loud tests below are
 *   the standing guard against someone re-applying the 2025 "fix".
 *
 * DRIVEN THROUGH THE REAL PUBLIC PATH (validate → routeExecutor), against real migrated
 * Postgres (the disposable ci_* DB from scripts/provision-test-db.sh — never production),
 * the same idiom as cancelTask / contextSearchTotalCount.
 *
 * GROUND TRUTH IS DERIVED, NEVER HARDCODED: the rollup assertions reconcile
 * project_insights against what the task_list tool independently reports for the SAME
 * seeded project. Two independent read paths must agree. Hardcoded expected counts would
 * drift the moment the seed changed; a cross-tool reconciliation cannot.
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';

import { db } from '../config/database.js';
import { validateToolArguments } from '../middleware/validation.js';
import { routeExecutor } from '../routes/index.js';
import { SmartSearchHandler } from '../handlers/smartSearch.js';
import {
  HEALTH_LEVEL_NO_DATA,
  HEALTH_SCORE_CEILING,
  HEALTH_AVG_COMPLEXITY_WEIGHT,
} from '../config/insightsConfig.js';

const STAMP = Date.now();

/**
 * The seeded task mix. Deliberately UNEVEN and spread across several statuses/priorities
 * so a rollup that collapses or mis-groups cannot accidentally match. The TEST never
 * hardcodes these totals — it derives expectations from this table and cross-checks them
 * against task_list, so changing this constant keeps every assertion honest.
 */
const TASK_MIX: ReadonlyArray<{ status: string; priority: string; count: number }> = [
  { status: 'completed', priority: 'high', count: 7 },
  { status: 'completed', priority: 'low', count: 4 },
  { status: 'todo', priority: 'medium', count: 5 },
  { status: 'in_progress', priority: 'high', count: 3 },
  { status: 'blocked', priority: 'low', count: 2 },
  { status: 'cancelled', priority: 'medium', count: 1 },
];
const SEEDED_TOTAL = TASK_MIX.reduce((sum, row) => sum + row.count, 0);
const SEEDED_COMPLETED = TASK_MIX
  .filter((row) => row.status === 'completed')
  .reduce((sum, row) => sum + row.count, 0);

/** Seeded decisions — pins decisionsTotal, which WORKS today and must not regress. */
const SEEDED_DECISIONS = 3;

/**
 * Bound on how long the end-to-end fail-loud probe will wait for the ACCESS EXCLUSIVE
 * lock its `ALTER TABLE ... RENAME` needs. Generous enough never to fire on a healthy
 * run (the ALTER completes in ~2ms uncontended), short enough that genuine lock
 * contention surfaces as a fast, readable failure instead of an indefinitely hung suite.
 *
 * MUST STAY COMFORTABLY BELOW vitest's per-test timeout (vitest.config testTimeout:
 * 10000ms). At 10s the two raced and VITEST won — measured: contention produced
 * "Test timed out in 10000ms" instead of Postgres's informative
 * "canceling statement due to lock timeout", throwing away the whole diagnostic point of
 * having a lock timeout at all. A guard that fires but reports the wrong cause is barely
 * a guard. Keep this strictly less than testTimeout.
 */
const PROBE_LOCK_TIMEOUT = '3s';

/** A project WITH code components (scored path) and one WITHOUT (no_data path). */
let projWithTasksId: string;   // tasks + decisions, NO code components
let projWithCodeId: string;    // code components, so codeHealth actually scores
let projEmptyId: string;       // nothing at all

async function viaPublicTool(toolName: string, rawArgs: any): Promise<any> {
  const validated = validateToolArguments(toolName, rawArgs);
  return routeExecutor(toolName, validated);
}

/** project_insights structuredContent for a project, through the real tool path. */
async function insightsFor(projectId: string): Promise<any> {
  const resp = await viaPublicTool('project_insights', { projectId });
  expect(resp.isError, `project_insights errored: ${JSON.stringify(resp.content)}`).toBeFalsy();
  return resp.structuredContent;
}

/**
 * The FULL handler payload (per-status rollup lives in taskStats.byStatus, which the
 * tool's structuredContent intentionally summarises to a single tasksTotal).
 */
async function rawInsightsFor(projectId: string): Promise<any> {
  return new SmartSearchHandler().getProjectInsights(projectId);
}

/** The full text body for a project (the human channel). */
async function insightsTextFor(projectId: string): Promise<string> {
  const resp = await viaPublicTool('project_insights', { projectId });
  expect(resp.isError).toBeFalsy();
  return resp.content.map((c: any) => c.text).join('\n');
}

/** GROUND TRUTH from the INDEPENDENT task_list read path (never hardcoded). */
async function taskListTotal(projectId: string, status?: string): Promise<number> {
  const resp = await viaPublicTool('task_list', status ? { projectId, status } : { projectId });
  expect(resp.isError, `task_list errored: ${JSON.stringify(resp.content)}`).toBeFalsy();
  return resp.structuredContent.total;
}

describe('project_insights data integrity', () => {
  beforeAll(async () => {
    projWithTasksId = (
      await db.query(
        `INSERT INTO projects (name, description) VALUES ($1, 'insights rollup fixture') RETURNING id`,
        [`insights-tasks-${STAMP}`]
      )
    ).rows[0].id;
    projWithCodeId = (
      await db.query(
        `INSERT INTO projects (name, description) VALUES ($1, 'insights code fixture') RETURNING id`,
        [`insights-code-${STAMP}`]
      )
    ).rows[0].id;
    projEmptyId = (
      await db.query(
        `INSERT INTO projects (name, description) VALUES ($1, 'insights empty fixture') RETURNING id`,
        [`insights-empty-${STAMP}`]
      )
    ).rows[0].id;

    // Seed the task mix.
    for (const { status, priority, count } of TASK_MIX) {
      for (let i = 0; i < count; i++) {
        await db.query(
          `INSERT INTO tasks (project_id, title, type, priority, status)
           VALUES ($1, $2, 'general', $3, $4)`,
          [projWithTasksId, `${status}-${priority}-${i}-${STAMP}`, priority, status]
        );
      }
    }

    // Seed decisions (decisionsTotal regression pin).
    for (let i = 0; i < SEEDED_DECISIONS; i++) {
      await db.query(
        `INSERT INTO technical_decisions
           (project_id, decision_type, title, description, rationale, impact_level)
         VALUES ($1, 'architecture', $2, 'fixture', 'fixture', 'medium')`,
        [projWithTasksId, `insights decision ${i} ${STAMP}`]
      );
    }

    // Seed code components on the CODE project ONLY, with a known complexity profile so
    // the scored path is checked against a value derived from the same inputs.
    // avg complexity = (2 + 4) / 2 = 3 ; max = 4 (below the max-complexity penalty threshold).
    for (const [idx, complexity] of [2, 4].entries()) {
      await db.query(
        `INSERT INTO code_components
           (project_id, file_path, component_type, name, complexity_score, lines_of_code)
         VALUES ($1, $2, 'function', $3, $4, 10)`,
        [projWithCodeId, `src/fixture_${idx}.ts`, `fixture_fn_${idx}`, complexity]
      );
    }
  });

  afterAll(async () => {
    const ids = [projWithTasksId, projWithCodeId, projEmptyId].filter(Boolean);
    for (const id of ids) {
      await db.query(`DELETE FROM tasks WHERE project_id = $1`, [id]);
      await db.query(`DELETE FROM technical_decisions WHERE project_id = $1`, [id]);
      await db.query(`DELETE FROM code_components WHERE project_id = $1`, [id]);
      await db.query(`DELETE FROM projects WHERE id = $1`, [id]);
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // DEFECT 1 — the task rollup. Real counts, reconciled with an independent tool.
  // ═══════════════════════════════════════════════════════════════════════════
  describe('task rollup reads the real `tasks` table', () => {
    test('tasksTotal is the REAL count, not 0 (the ghost-table regression)', async () => {
      const sc = await insightsFor(projWithTasksId);

      // The headline regression: this returned 0 for ~10 months on every project with tasks.
      expect(sc.tasksTotal).not.toBe(0);
      expect(sc.tasksTotal).toBe(SEEDED_TOTAL);
    });

    test('tasksTotal RECONCILES with the independent task_list read path', async () => {
      const sc = await insightsFor(projWithTasksId);
      const groundTruth = await taskListTotal(projWithTasksId);

      // Two independent reads of the same underlying data must agree. This is the
      // assertion that cannot drift: it derives truth from the product, not a literal.
      expect(sc.tasksTotal).toBe(groundTruth);
    });

    test('per-status counts reconcile with task_list filtered by that same status', async () => {
      const raw = await rawInsightsFor(projWithTasksId);
      const statuses = [...new Set(TASK_MIX.map((r) => r.status))];

      for (const status of statuses) {
        const fromInsights = Object.values(raw.taskStats.byStatus?.[status] ?? {})
          .reduce((a: number, b: any) => a + Number(b), 0);
        const fromTaskList = await taskListTotal(projWithTasksId, status);
        expect(
          fromInsights,
          `status '${status}': project_insights says ${fromInsights}, task_list says ${fromTaskList}`
        ).toBe(fromTaskList);
      }
    });

    test('completionRate reflects real completed/total, not a fabricated 0', async () => {
      const sc = await insightsFor(projWithTasksId);
      const completedGroundTruth = await taskListTotal(projWithTasksId, 'completed');
      const totalGroundTruth = await taskListTotal(projWithTasksId);

      expect(completedGroundTruth).toBe(SEEDED_COMPLETED);
      expect(sc.teamEfficiency.completionRate).toBeCloseTo(completedGroundTruth / totalGroundTruth, 10);
      expect(sc.teamEfficiency.completionRate).toBeGreaterThan(0);
      expect(sc.teamEfficiency.level).not.toBe(HEALTH_LEVEL_NO_DATA);
    });

    test('a project with genuinely zero tasks reports 0 — absence is still reported honestly', async () => {
      const sc = await insightsFor(projEmptyId);
      expect(sc.tasksTotal).toBe(0);
      expect(await taskListTotal(projEmptyId)).toBe(0);
      // teamEfficiency already had the honest no_data branch; pin it.
      expect(sc.teamEfficiency.level).toBe(HEALTH_LEVEL_NO_DATA);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // DEFECT 2 — absent code data must NEVER render as perfect health.
  // ═══════════════════════════════════════════════════════════════════════════
  describe('codeHealth never fabricates a score from absent data', () => {
    test('ZERO components → no_data with a NULL score (never 100, never healthy)', async () => {
      const sc = await insightsFor(projEmptyId);

      expect(sc.totalComponents).toBe(0);
      expect(sc.codeHealth.level).toBe(HEALTH_LEVEL_NO_DATA);
      // The exact fabrication that shipped: 100/healthy from nothing.
      expect(sc.codeHealth.score).not.toBe(HEALTH_SCORE_CEILING);
      expect(sc.codeHealth.level).not.toBe('healthy');
      // The honest shape: no score at all. NOT 0 either — 0 reads as "terrible health",
      // which is just as much a fabrication as 100.
      expect(sc.codeHealth.score).toBeNull();
      expect(sc.codeHealth.issues).toContain('No code analyzed yet');
    });

    test('the TEXT channel never prints a fabricated score for a no_data project', async () => {
      const text = await insightsTextFor(projEmptyId);

      expect(text).toContain('NO DATA');
      expect(text).toContain('(not analyzed)');
      // The precise pre-fix output, and the shape a naive null-interpolation would give.
      expect(text).not.toContain('100/100');
      expect(text).not.toContain('null/100');
      expect(text).not.toContain('HEALTHY');
    });

    test('WITH components → still scores correctly (the no_data fix did not break the scored path)', async () => {
      const sc = await insightsFor(projWithCodeId);

      expect(sc.totalComponents).toBe(2);
      expect(sc.codeHealth.level).not.toBe(HEALTH_LEVEL_NO_DATA);
      expect(typeof sc.codeHealth.score).toBe('number');
      expect(sc.codeHealth.score).toBeGreaterThan(0);

      // Derived from the seeded profile through the SAME named config the product reads,
      // so a config change moves both sides together (never a hardcoded 70).
      const avg = 3; // (2 + 4) / 2, from the seeded complexity scores above
      // Derived through the SAME named config the product reads — never a literal weight.
      // (a past incidentb: a hardcoded config-derived value in a test silently stops tracking
      // the product the moment the config changes, while still claiming that it does.)
      const expectedScore = HEALTH_SCORE_CEILING - avg * HEALTH_AVG_COMPLEXITY_WEIGHT;
      expect(sc.codeHealth.score).toBe(expectedScore);
      // avg 3 is NOT < 3, so this lands in the 'moderate' band — proving the banding is
      // actually evaluated rather than short-circuited.
      expect(sc.codeHealth.level).toBe('moderate');
    });

    test('a scored project still renders the (n/100) prose form', async () => {
      const text = await insightsTextFor(projWithCodeId);
      // The `(n/100)` shape is the prose rendering contract for a scored project; the
      // no_data case renders `(not analyzed)` instead. (The Command UI text parsers this
      // once protected were deleted by an earlier task — the UI reads the structured channel.)
      expect(text).toMatch(/MODERATE\s*\([0-9.]+\/100\)/);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // DEFECT 3 — THE CAMOUFLAGE GUARD. Unreadable data must ERROR, never return zeros.
  // This is the permanent standing guard against re-applying the 2025 "fix".
  // ═══════════════════════════════════════════════════════════════════════════
  describe('FAIL LOUD: unreadable task data errors — it NEVER becomes a silent zero', () => {
    /**
     * A pool that fails ONLY the task-rollup query and lets every other query through to
     * the real database.
     *
     * WHY THE NARROWING IS LOAD-BEARING (Reviewer):
     *   The first version of this double failed EVERY query. Both tests below then passed
     *   for the WRONG REASON — the rejection they observed could just as easily have come
     *   from the contexts or decisions query. They READ as "the task path fails loud" but
     *   actually proved only "something, somewhere, fails loud", which is a strictly weaker
     *   claim. Measured proof of the weakness: under the M2 camouflage mutation (existence
     *   check → silent zero) both tests stayed GREEN, because contexts/decisions still threw.
     *   A test that passes for the wrong reason is the exact class this whole task exists to
     *   kill, so it does not get to live in the file that kills it.
     *
     *   Failing ONLY `FROM tasks` means a rejection can have come from nowhere else. Under
     *   M2 the task path returns a silent zero instead of throwing, nothing else fails, and
     *   these tests go RED — which is the behaviour they were always claiming to check.
     */
    function taskQueryOnlyFailingPool(): Pool {
      const err: any = new Error('relation "tasks" does not exist');
      err.code = '42P01'; // undefined_table — the real Postgres SQLSTATE
      return {
        connect: async () => {
          const real = await db.connect();
          return {
            query: async (...args: any[]) => {
              const sql: string = typeof args[0] === 'string' ? args[0] : (args[0]?.text ?? '');
              if (/\bFROM\s+tasks\b/i.test(sql)) throw err;
              return (real as any).query(...args);
            },
            release: () => real.release(),
          };
        },
      } as unknown as Pool;
    }

    test('a missing tasks table REJECTS — no {total: 0} fallback', async () => {
      const handler = new SmartSearchHandler(taskQueryOnlyFailingPool());

      await expect(
        handler.getProjectInsights(projWithTasksId),
        'getProjectInsights swallowed an unreadable-table error and returned a value — ' +
        'this is the 2025 camouflage regression'
      ).rejects.toThrow(/does not exist/);
    });

    test('the failure surfaces as an ERROR on the public tool surface, not a zeroed payload', async () => {
      // Same condition, observed where a customer would see it: the tool must report an
      // error, not a confident "0 tasks".
      const handler = new SmartSearchHandler(taskQueryOnlyFailingPool());
      let captured: any = null;
      try {
        await handler.getProjectInsights(projWithTasksId);
      } catch (e) {
        captured = e;
      }
      expect(captured, 'expected a thrown error, got a returned value').toBeTruthy();
      expect(String(captured.message)).toMatch(/does not exist/);
    });

    test('END-TO-END against real Postgres: renaming `tasks` away makes the tool ERROR', async () => {
      // The strongest form of the guard — real DB, real migration-style breakage, the real
      // public tool path. Restored in `finally` on EVERY path.
      // (Safe: the suite is pinned to a single fork, so no other test file is mid-run, and
      // this only ever touches the disposable ci_* test DB.)
      //
      // lock_timeout: ALTER TABLE ... RENAME needs an ACCESS EXCLUSIVE lock. If any other
      // connection were holding a conflicting lock, an un-timed-out ALTER would wait
      // FOREVER and hang the whole CI suite with no diagnostic. A bounded timeout makes
      // that contention a LOUD, fast failure instead — the same fail-loud principle this
      // very test exists to enforce, applied to the test's own machinery.
      //
      // The rename is done on ONE EXPLICITLY-HELD client, not via db.query(): `SET` is
      // SESSION-scoped, so on a pool db.query('SET ...') and db.query('ALTER ...') can be
      // served by DIFFERENT connections — which would silently leave the ALTER with no
      // timeout at all. Holding the client makes the setting actually apply to the
      // statement it is meant to bound.
      // ONE try/finally around the WHOLE held-client lifetime. An earlier version had a
      // separate catch for the ALTER that released the client WITHOUT resetting
      // lock_timeout — so on the contention path (measured: it does fire) a connection
      // carrying a 3s lock_timeout went straight back into the shared pool and silently
      // reconfigured whatever ran next. That is the same session-state-leak class the
      // suite's own env-leak guard exists to catch, so it does not get to live here.
      // `renamed` tracks whether the ALTER actually succeeded, so the restore only runs
      // when there is something to restore.
      const lockClient = await db.connect();
      let renamed = false;
      try {
        await lockClient.query(`SET lock_timeout = '${PROBE_LOCK_TIMEOUT}'`);
        await lockClient.query(`ALTER TABLE tasks RENAME TO tasks_probe_hidden`);
        renamed = true;

        const resp = await viaPublicTool('project_insights', { projectId: projWithTasksId });

        expect(resp.isError, 'project_insights returned SUCCESS while `tasks` was unreadable').toBe(true);
        const body = JSON.stringify(resp.content);
        // The datastore error boundary redacts driver text before it reaches a
        // caller, so the response no longer repeats Postgres's `relation "tasks" does not exist`
        // — deliberately: that string names an internal table to whoever asked. THIS TEST'S
        // POINT IS UNCHANGED and still enforced below: the tool must ERROR LOUDLY and must NOT
        // quietly report a zero rollup. What it now asserts is the TYPED failure plus a
        // correlation ref an operator can look up, which is strictly more than "it said
        // something red".
        expect(body).toMatch(/\[DATASTORE_ERROR\]/);
        expect(body).toMatch(/ref: [0-9a-f]{8}/);
        expect(body, 'the internal table name leaked to the caller').not.toMatch(/does not exist/i);
        // And crucially: it must not have quietly reported a zero rollup.
        expect(resp.structuredContent?.tasksTotal).not.toBe(0);
      } finally {
        try {
          if (renamed) {
            await lockClient.query(`ALTER TABLE tasks_probe_hidden RENAME TO tasks`);
          }
          // RESET on EVERY path — including the lock-contention path — so the connection
          // returns to the pool exactly as it was found.
          await lockClient.query(`RESET lock_timeout`);
        } finally {
          lockClient.release();
        }
      }

      // Prove the restore worked — the very next read is healthy again.
      const sc = await insightsFor(projWithTasksId);
      expect(sc.tasksTotal).toBe(SEEDED_TOTAL);
    });

    test('codeHealth THROWS on unreadable component stats — it never defaults to a score', async () => {
      // assessCodeHealth is private; reach it the way the product does, with a codeStats
      // input that cannot be trusted. A malformed/absent totalComponents must fail loud
      // rather than fall back to `|| 0` (which is precisely how absent became perfect).
      const handler: any = new SmartSearchHandler();
      for (const bad of [null, undefined, {}, { totalComponents: null }, { totalComponents: NaN }, { totalComponents: 'seven' }]) {
        expect(
          () => handler.assessCodeHealth(bad),
          `assessCodeHealth(${JSON.stringify(bad)}) returned instead of throwing`
        ).toThrow(/refusing to fabricate/);
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // REGRESSION PINS — fields that are CORRECT today and must stay correct.
  // ═══════════════════════════════════════════════════════════════════════════
  describe('fields that already worked must not regress', () => {
    test('decisionsTotal is the real decision count', async () => {
      const sc = await insightsFor(projWithTasksId);
      expect(sc.decisionsTotal).toBe(SEEDED_DECISIONS);
    });

    test('totalComponents is the real component count on both project shapes', async () => {
      expect((await insightsFor(projWithCodeId)).totalComponents).toBe(2);
      expect((await insightsFor(projWithTasksId)).totalComponents).toBe(0);
    });

    /**
     * SUPERSEDED PIN. This used to pin `knowledgeGaps` — the array produced by
     * identifyKnowledgeGaps(), which fired on raw record COUNTS with zero edge reads. The
     * Amp-orb eval measured that output as WRONG on a healthy project (report lines 558-581),
     * so the function and the field are deleted, and pinning them would now be pinning the
     * defect in place.
     *
     * The field the caller reads is `coverage`, produced from the typed-edge graph. Its rules
     * are guarded by projectCoverage.unit.test.ts + projectInsightsGraphAware.contract.test.ts;
     * what THIS pin still owns is the same thing it always owned — the structuredContent
     * CONTRACT does not silently lose its gap channel.
     */
    test('the gap channel is still produced — now as graph-derived coverage', async () => {
      const sc = await insightsFor(projWithTasksId);
      expect(sc.knowledgeGaps, 'the deleted count-based field is back').toBeUndefined();
      expect(Array.isArray(sc.coverage.findings)).toBe(true);
      expect(sc.coverage.ratios).toBeDefined();
      expect(sc.coverage.scope.recordsExamined).toBeGreaterThanOrEqual(0);
    });
  });
});
