/**
 * Contract test: SessionDetailService.getSessionSummaries works against the
 * REAL migrated schema.
 *
 * Schematic fuse for the customer-reported, fleet-wide bug:
 *   "Error loading sessions / Failed to load session summaries"
 * Root cause: getSessionSummaries queried `FROM user_sessions`, a relation that
 * does not exist in any tenant DB (the legacy web-sessions table was consolidated
 * into the single `sessions` table). Every call threw
 *   'relation "user_sessions" does not exist'.
 *
 * This test inserts a real session into the `sessions` table and asserts the
 * service returns it WITHOUT throwing — i.e. the query targets a table that
 * actually exists in the migrated schema. If anyone reintroduces `user_sessions`
 * (or another non-existent relation) this test fails with that exact Postgres
 * error rather than shipping a dead dashboard panel.
 *
 * Requires a reachable Postgres (the CI disposable migrated DB). CI provisions one,
 * so this suite RUNS and ASSERTS for real; if the DB is unreachable it FAILS LOUDLY
 * (never a silent green). A local dev run with no DB can VISIBLY skip via
 * MANDREL_DB_CONTRACTS_OPTIONAL=true. See __tests__/helpers/dbContractGate.ts.
 */
import { Pool } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import { SessionDetailService } from '../services/sessionDetail';
import { contractDbConfig, describeContract, assertDbReachable } from './helpers/dbContractGate';
import { allProjects, projectsScope } from '../services/projectListScope';

describeContract('getSessionSummaries against real migrated schema (contract)', () => {
  let pool: Pool;

  const projectId = uuidv4();
  const sessionId = uuidv4();

  beforeAll(async () => {
    pool = new Pool(contractDbConfig);
    await assertDbReachable(pool);
    const client = await pool.connect();
    try {
      await client.query(
        `INSERT INTO projects (id, name, description, created_at)
           VALUES ($1, $2, $3, NOW())`,
        [projectId, `sum-test-${projectId.slice(0, 8)}`, 'session summaries contract test project']
      );

      // A real session row in the (single, consolidated) sessions table.
      // NOTE: getSessionSummaries now counts LIVE (off session_id), NOT the
      // denormalized counter columns (which are stale/0 on prod — decisions_created
      // was 0 on every prod row, which under-scored the list vs the detail view).
      // So we insert the denormalized counters DELIBERATELY WRONG (all 0) and then
      // insert the REAL linked rows below; the summary must report the live counts,
      // proving it no longer trusts the stale columns.
      await client.query(
        `INSERT INTO sessions
             (id, project_id, agent_type, started_at, ended_at,
              total_tokens, contexts_created, decisions_created, tasks_created)
           VALUES ($1, $2, 'claude-code', NOW() - INTERVAL '30 minutes', NOW(),
                   1234, 0, 0, 0)`,
        [sessionId, projectId]
      );

      // 3 real contexts, 2 real decisions, 1 real task — all linked by session_id.
      for (let i = 0; i < 3; i++) {
        await client.query(
          `INSERT INTO contexts (id, project_id, session_id, context_type, content, created_at)
             VALUES ($1, $2, $3, 'code', 'summaries contract context', NOW())`,
          [uuidv4(), projectId, sessionId]
        );
      }
      for (let i = 0; i < 2; i++) {
        await client.query(
          `INSERT INTO technical_decisions
               (id, project_id, session_id, decision_type, title, description, rationale,
                impact_level, status, decision_date)
             VALUES ($1, $2, $3, 'architecture', 'summaries contract decision',
                     'desc', 'rationale', 'medium', 'active', NOW())`,
          [uuidv4(), projectId, sessionId]
        );
      }
      await client.query(
        `INSERT INTO tasks
             (id, project_id, session_id, title, type, status, priority, created_at, completed_at)
           VALUES ($1, $2, $3, 'summaries contract task', 'feature', 'completed', 'medium',
                   NOW() - INTERVAL '10 minutes', NOW())`,
        [uuidv4(), projectId, sessionId]
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

  test('returns summaries for a project WITHOUT throwing (no user_sessions relation)', async () => {
    // The fuse: before the fix this rejected with
    // 'relation "user_sessions" does not exist'. It must now resolve.
    const summaries = await SessionDetailService.getSessionSummaries(projectsScope([projectId]), 20, 0);

    expect(Array.isArray(summaries)).toBe(true);
    const ours = summaries.find((s) => s.id === sessionId);
    expect(ours).toBeDefined();
    // Tokens come straight off the sessions row.
    expect(ours!.total_tokens).toBe(1234);
    // Counts are now LIVE (off session_id), NOT the denormalized columns (which we
    // set to 0 on the row above). This proves the list path counts real activity.
    expect(ours!.contexts_created).toBe(3);
    expect(ours!.decisions_created).toBe(2); // live decisions — the prod bug was 0 here
    expect(ours!.tasks_completed).toBe(1);   // live completed task via session_id
    expect(ours!.session_type).toBe('claude-code');
  });

  test('also returns WITHOUT throwing when no projectId filter is given', async () => {
    // Exercises the no-WHERE-clause branch of the same query.
    const summaries = await SessionDetailService.getSessionSummaries(allProjects, 5, 0);
    expect(Array.isArray(summaries)).toBe(true);
  });
});
