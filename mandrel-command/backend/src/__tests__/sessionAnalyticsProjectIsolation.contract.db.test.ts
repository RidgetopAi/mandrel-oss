/**
 * Contract test: per-session / per-project context counts are ISOLATED.
 *
 * Schematic fuse for the cross-project misattribution bug reported by a real
 * customer: the dashboard Session Analytics showed contexts belonging to
 * project B under a session whose project_id was A ("Personal Project").
 *
 * Root: every per-session context count joined `contexts ON session_id` WITHOUT
 * scoping to the session's project_id. When a session's project_id diverges from
 * its contexts' project_id (the deep session->project association bug),
 * one project's contexts showed up under another project's session.
 *
 * This test builds exactly that divergent shape — a session bound to Project A
 * whose contexts actually belong to Project B — and asserts the Session
 * Analytics list never attributes B's contexts to A's session.
 *
 * Requires a reachable Postgres (same one the service uses). When the DB is not
 * available the suite skips rather than failing CI.
 */
import { Pool } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import { SessionAnalyticsService } from '../services/sessionAnalytics';
import { contractDbConfig, describeContract, assertDbReachable } from './helpers/dbContractGate';
import { projectsScope } from '../services/projectListScope';

describeContract('SessionAnalytics project isolation (contract)', () => {
  let pool: Pool;

  // Fixture ids
  const projectA = uuidv4(); // "Personal Project"-like: session lives here
  const projectB = uuidv4(); // real work project: contexts actually belong here
  const sessionInA = uuidv4(); // session whose project_id = A
  const contextIds = [uuidv4(), uuidv4(), uuidv4()]; // 3 contexts, all in B, on sessionInA

  beforeAll(async () => {
    pool = new Pool(contractDbConfig);
    await assertDbReachable(pool);
    const client = await pool.connect();
    try {
      // Two projects
      await client.query(
        `INSERT INTO projects (id, name, description, created_at)
           VALUES ($1, $2, $3, NOW()), ($4, $5, $6, NOW())`,
        [
          projectA, `iso-test-A-${projectA.slice(0, 8)}`, 'isolation test project A (session home)',
          projectB, `iso-test-B-${projectB.slice(0, 8)}`, 'isolation test project B (contexts home)',
        ]
      );

      // One session bound to project A (display_id is trigger-generated)
      await client.query(
        `INSERT INTO sessions (id, project_id, agent_type, started_at)
           VALUES ($1, $2, 'mcp-server', NOW())`,
        [sessionInA, projectA]
      );

      // 3 contexts attached to that session, but whose project_id is B.
      // This is the exact divergent shape the user hit.
      for (const cid of contextIds) {
        await client.query(
          `INSERT INTO contexts (id, project_id, session_id, context_type, content, created_at)
             VALUES ($1, $2, $3, 'completion', 'isolation-test-context', NOW())`,
          [cid, projectB, sessionInA]
        );
      }
    } finally {
      client.release();
    }
  });

  afterAll(async () => {
    if (!pool) return;
    try {
      const client = await pool.connect();
      try {
        await client.query(`DELETE FROM contexts WHERE id = ANY($1)`, [contextIds]);
        await client.query(`DELETE FROM sessions WHERE id = $1`, [sessionInA]);
        await client.query(`DELETE FROM projects WHERE id = ANY($1)`, [[projectA, projectB]]);
      } finally {
        client.release();
      }
    } catch {
      /* best-effort cleanup — DB may be unreachable (a required suite already failed loudly) */
    } finally {
      await pool.end();
    }
  });

  test('Project A session does NOT count Project B contexts (no cross-project leak)', async () => {
    // Project A view: the session lives here but its contexts belong to B.
    const aView = await SessionAnalyticsService.getSessionsList({ scope: projectsScope([projectA])});
    const aSession = aView.sessions.find((s: any) => s.id === sessionInA);
    expect(aSession).toBeDefined();
    // THE FUSE: A's session must show 0 contexts — B's 3 contexts must not leak in.
    expect(aSession.context_count).toBe(0);
    expect(aSession.contextsCount).toBe(0);
  });

  test('Project B view does not surface the A-bound session at all', async () => {
    const bView = await SessionAnalyticsService.getSessionsList({ scope: projectsScope([projectB])});
    // The session belongs to A by project_id, so B's session list excludes it.
    const leaked = bView.sessions.find((s: any) => s.id === sessionInA);
    expect(leaked).toBeUndefined();
  });
});
