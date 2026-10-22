/**
 * Contract test: the Activity Score is UNIFIED across surfaces.
 *
 * The bug (SR-4 / bug-6 ee8ac4e0): getSessionDetail computed the score from LIVE
 * counts (contexts/decisions/tasks via session_id) while getSessionSummaries
 * (list / analytics) computed from denormalized counter columns — and
 * `decisions_created` is 0 on every prod row — so the SAME session showed a higher
 * score in detail than in the list (e.g. 70.0 vs 37.0 on a real prod session).
 *
 * This test inserts ONE real session with contexts + decisions + a completed task
 * linked by session_id, then asserts:
 *   getSessionSummaries(session).productivity_score === getSessionDetail(session).productivity_score
 * i.e. both surfaces route through the shared calculateActivityScore() on the same
 * live inputs. If anyone reintroduces a divergent score path, this fails.
 *
 * Requires a reachable Postgres (the CI disposable migrated DB). When the DB is not
 * available the suite skips rather than failing CI.
 */
import { Pool } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import { SessionDetailService } from '../services/sessionDetail';
import { calculateActivityScore } from '../services/sessionScore';
import { contractDbConfig, describeContract, assertDbReachable } from './helpers/dbContractGate';
import { projectsScope } from '../services/projectListScope';

describeContract('Activity Score is unified across list and detail (contract)', () => {
  let pool: Pool;

  const projectId = uuidv4();
  const sessionId = uuidv4();
  const ctxIds = [uuidv4(), uuidv4(), uuidv4()]; // 3 contexts
  const decisionId = uuidv4();
  const taskId = uuidv4();

  beforeAll(async () => {
    pool = new Pool(contractDbConfig);
    await assertDbReachable(pool);
    const client = await pool.connect();
    try {
      await client.query(
        `INSERT INTO projects (id, name, description, created_at)
           VALUES ($1, $2, $3, NOW())`,
        [projectId, `score-unify-${projectId.slice(0, 8)}`, 'unified score contract test']
      );

      // A real, ENDED session (deterministic duration: exactly 60 minutes).
      // Note the denormalized counters are DELIBERATELY left at the stale/wrong
      // values that prod had (decisions_created = 0) — the whole point is that the
      // unified score ignores them and counts live.
      await client.query(
        `INSERT INTO sessions
             (id, project_id, agent_type, started_at, ended_at,
              total_tokens, contexts_created, decisions_created, tasks_created, tasks_completed)
           VALUES ($1, $2, 'claude-code',
                   NOW() - INTERVAL '60 minutes', NOW(),
                   2000, 0, 0, 0, 0)`,
        [sessionId, projectId]
      );

      // 3 contexts linked by session_id.
      for (const id of ctxIds) {
        await client.query(
          `INSERT INTO contexts (id, project_id, session_id, context_type, content, created_at)
             VALUES ($1, $2, $3, 'code', 'unified score test context', NOW())`,
          [id, projectId, sessionId]
        );
      }

      // 1 decision linked by session_id (this is what the list path lost on prod).
      await client.query(
        `INSERT INTO technical_decisions
             (id, project_id, session_id, decision_type, title, description, rationale,
              impact_level, status, decision_date)
           VALUES ($1, $2, $3, 'architecture', 'unified score test decision',
                   'desc', 'rationale', 'medium', 'active', NOW())`,
        [decisionId, projectId, sessionId]
      );

      // 1 COMPLETED task linked by session_id.
      await client.query(
        `INSERT INTO tasks
             (id, project_id, session_id, title, type, status, priority, created_at, completed_at)
           VALUES ($1, $2, $3, 'unified score test task', 'feature', 'completed', 'medium',
                   NOW() - INTERVAL '30 minutes', NOW())`,
        [taskId, projectId, sessionId]
      );
    } finally {
      client.release();
    }
  });

  afterAll(async () => {
    if (!pool) return;
    try {
      const client = await pool.connect();
      try {
        await client.query(`DELETE FROM contexts WHERE session_id = $1`, [sessionId]);
        await client.query(`DELETE FROM technical_decisions WHERE session_id = $1`, [sessionId]);
        await client.query(`DELETE FROM tasks WHERE session_id = $1`, [sessionId]);
        await client.query(`DELETE FROM sessions WHERE id = $1`, [sessionId]);
        await client.query(`DELETE FROM projects WHERE id = $1`, [projectId]);
      } finally {
        client.release();
      }
    } catch {
      /* best-effort cleanup — DB may be unreachable (a required suite already failed loudly) */
    } finally {
      await pool.end();
    }
  });

  test('list (getSessionSummaries) and detail (getSessionDetail) report the SAME score', async () => {
    const detail = await SessionDetailService.getSessionDetail(sessionId);
    const summaries = await SessionDetailService.getSessionSummaries(projectsScope([projectId]), 50, 0);
    const summary = summaries.find((s) => s.id === sessionId);

    expect(detail).not.toBeNull();
    expect(summary).toBeDefined();

    // The two surfaces must agree exactly.
    expect(summary!.productivity_score).toBe(detail!.productivity_score);

    // And both must equal the shared calculator on the LIVE inputs:
    // 3 contexts, 1 decision, 1 completed task, 60 min, 2000 tokens
    // = 3*2 + 1*3 + 1*4 + min(1,8)*1.5 + min(2,10)*0.5 = 6+3+4+1.5+1 = 15.5
    const expected = calculateActivityScore({
      contexts: 3,
      decisions: 1,
      tasksCompleted: 1,
      durationMinutes: 60,
      totalTokens: 2000,
    });
    expect(expected).toBe(15.5);
    expect(detail!.productivity_score).toBe(expected);
    expect(summary!.productivity_score).toBe(expected);
  });

  test('the list score counts decisions live (NOT the stale decisions_created column)', async () => {
    const summaries = await SessionDetailService.getSessionSummaries(projectsScope([projectId]), 50, 0);
    const summary = summaries.find((s) => s.id === sessionId);
    expect(summary).toBeDefined();
    // decisions_created column is 0 on the row, but the live decision count is 1.
    expect(summary!.decisions_created).toBe(1);
  });
});
