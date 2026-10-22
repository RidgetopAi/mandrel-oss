/**
 * Contract test: getContextsByActor — the by-actor GROUP BY behind the Analytics
 * "Activity by actor" panel.
 *
 * WHAT THIS SUITE IS FOR. The panel prints two things that must agree: a set of bars
 * ("coordinator: 3") and a coverage line ("4 of 6 contexts attributed"). The bug class it
 * guards is not "the query returns nothing" — it is the query returning a plausible
 * number computed over a DIFFERENT population than the sentence next to it claims.
 * So every assertion below is a literal count against one fixture that deliberately
 * contains every population the aggregation can mis-handle:
 *
 *   - a context whose owning session has an actor            -> a bar
 *   - a context whose owning session's actor IS NULL         -> unattributed, NOT a bar
 *   - a context whose owning session's actor is BLANK ('  ') -> unattributed, NOT a bar
 *     (an empty-string actor rendering as an unlabelled bar is the exact silent-empty
 *      case CLASSES.md C3 says to probe)
 *   - a context with NO session at all                       -> unattributed, NOT a bar
 *     (1557 of 9860 live contexts on prod carried no session_id, measured 2026-08-10)
 *   - an ARCHIVED context                                    -> in no total at all
 *   - a context OUTSIDE the day window                       -> in no total at all
 *   - a context in project B written by a session that lives in project A
 *     -> counts for B (RULE 2, the CONTEXT's own project), never for A
 *   - a project whose contexts are ALL unattributed          -> zero bars, non-zero total
 *     (the new-customer onboarding case the panel's empty state exists for)
 *
 * The unit invariant is asserted directly: `attributed_contexts` must be the SUM of the
 * returned bars, and `total_contexts` must be attributed + unattributed. A coverage line
 * whose numerator came from a different query than its bars is the dishonesty this
 * endpoint was built to remove, and one read is what makes it structurally impossible.
 *
 * Requires a reachable Postgres (the CI disposable migrated DB) — see
 * __tests__/helpers/dbContractGate.ts. Never a silent green.
 */
import { Pool } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import { SessionAnalyticsService } from '../services/sessionAnalytics';
import { contractDbConfig, describeContract, assertDbReachable } from './helpers/dbContractGate';
import { allProjects, projectsScope } from '../services/projectListScope';

describeContract('getContextsByActor: attribution, coverage, scope (contract)', () => {
  let pool: Pool;

  /** The project the panel is looking at. */
  const projectA = uuidv4();
  /** A second project, to prove the scope predicate filters on the CONTEXT's project. */
  const projectB = uuidv4();
  /** A project with data but ZERO attribution — the new-customer onboarding case. */
  const projectC = uuidv4();

  const sessionCoordinator = uuidv4(); // actor 'coordinator', lives in project A
  const sessionTick = uuidv4(); // actor 'tick',  lives in project A
  const sessionNullActor = uuidv4(); // actor NULL, lives in project A
  const sessionBlankActor = uuidv4(); // actor '   ', lives in project A

  /** A day count comfortably inside the fixture's window. */
  const WINDOW_DAYS = 30;
  /** Where the out-of-window row sits — well past WINDOW_DAYS, inside the max clamp. */
  const OUTSIDE_DAYS_AGO = 120;

  beforeAll(async () => {
    pool = new Pool(contractDbConfig);
    await assertDbReachable(pool);
    const client = await pool.connect();
    try {
      await client.query(
        `INSERT INTO projects (id, name, description, created_at)
           VALUES ($1, $2, 'by-actor A', NOW()), ($3, $4, 'by-actor B', NOW()), ($5, $6, 'by-actor C', NOW())`,
        [
          projectA, `actor-test-A-${projectA.slice(0, 8)}`,
          projectB, `actor-test-B-${projectB.slice(0, 8)}`,
          projectC, `actor-test-C-${projectC.slice(0, 8)}`,
        ]
      );

      const session = async (id: string, actor: string | null) =>
        client.query(
          `INSERT INTO sessions (id, project_id, agent_type, actor, started_at, ended_at)
             VALUES ($1, $2, 'mcp-server', $3, NOW() - INTERVAL '2 hours', NOW())`,
          [id, projectA, actor]
        );
      await session(sessionCoordinator, 'coordinator');
      await session(sessionTick, 'tick');
      await session(sessionNullActor, null);
      await session(sessionBlankActor, '   ');

      const ctx = async (opts: {
        project: string;
        session: string | null;
        agoHours?: number;
        agoDays?: number;
        archived?: boolean;
      }) =>
        client.query(
          `INSERT INTO contexts (id, project_id, session_id, context_type, content, created_at, archived_at)
             VALUES ($1, $2, $3, 'code', 'by-actor fixture', NOW() - make_interval(days => $4, hours => $5), $6)`,
          [
            uuidv4(),
            opts.project,
            opts.session,
            opts.agoDays ?? 0,
            opts.agoHours ?? 1,
            opts.archived ? new Date() : null,
          ]
        );

      // --- project A, IN WINDOW -------------------------------------------------------
      await ctx({ project: projectA, session: sessionCoordinator }); // coordinator 1
      await ctx({ project: projectA, session: sessionCoordinator }); // coordinator 2
      await ctx({ project: projectA, session: sessionCoordinator }); // coordinator 3
      await ctx({ project: projectA, session: sessionTick }); //  tick  1
      await ctx({ project: projectA, session: sessionNullActor }); // unattributed 1
      await ctx({ project: projectA, session: sessionBlankActor }); // unattributed 2 (blank)
      await ctx({ project: projectA, session: null }); //             unattributed 3 (no session)

      // --- project A, EXCLUDED ---------------------------------------------------------
      await ctx({ project: projectA, session: sessionCoordinator, archived: true }); // archived
      await ctx({ project: projectA, session: sessionCoordinator, agoDays: OUTSIDE_DAYS_AGO }); // old

      // --- project B: written by a project-A session (the mid-switch shape) ------------
      await ctx({ project: projectB, session: sessionCoordinator });

      // --- project C: data, but nothing attributed ------------------------------------
      await ctx({ project: projectC, session: sessionNullActor });
      await ctx({ project: projectC, session: null });
    } finally {
      client.release();
    }
  });

  afterAll(async () => {
    if (!pool) return;
    try {
      const client = await pool.connect();
      try {
        await client.query('DELETE FROM contexts WHERE project_id = ANY($1::uuid[])', [
          [projectA, projectB, projectC],
        ]);
        await client.query('DELETE FROM sessions WHERE project_id = ANY($1::uuid[])', [
          [projectA, projectB, projectC],
        ]);
        await client.query('DELETE FROM projects WHERE id = ANY($1::uuid[])', [
          [projectA, projectB, projectC],
        ]);
      } finally {
        client.release();
      }
    } finally {
      await pool.end();
    }
  });

  it('groups by the owning session actor, count DESC', async () => {
    const res = await SessionAnalyticsService.getContextsByActor(
      projectsScope([projectA]),
      WINDOW_DAYS
    );
    expect(res.actors).toEqual([
      { actor: 'coordinator', context_count: 3, kind: 'agent' },
      { actor: 'tick', context_count: 1, kind: 'automation' },
    ]);
  });

  it('counts NULL-actor, BLANK-actor and session-less contexts as UNATTRIBUTED, never as a bar', async () => {
    const res = await SessionAnalyticsService.getContextsByActor(
      projectsScope([projectA]),
      WINDOW_DAYS
    );
    expect(res.actors.map((a) => a.actor)).not.toContain('');
    expect(res.actors.map((a) => a.actor)).not.toContain('   ');
    expect(res.unattributed_contexts).toBe(3);
  });

  it('the coverage totals are derived from the SAME rows as the bars (one unit, one read)', async () => {
    const res = await SessionAnalyticsService.getContextsByActor(
      projectsScope([projectA]),
      WINDOW_DAYS
    );
    const sumOfBars = res.actors.reduce((s, a) => s + a.context_count, 0);
    expect(res.attributed_contexts).toBe(sumOfBars);
    expect(res.attributed_contexts).toBe(4);
    expect(res.total_contexts).toBe(res.attributed_contexts + res.unattributed_contexts);
    expect(res.total_contexts).toBe(7);
  });

  it('excludes archived contexts and contexts outside the day window', async () => {
    const res = await SessionAnalyticsService.getContextsByActor(
      projectsScope([projectA]),
      WINDOW_DAYS
    );
    // coordinator wrote 5 contexts in project A; one is archived and one is older than the
    // window. Both are absent from the BAR and from the TOTAL — a row that is excluded
    // from the numerator but not the denominator would understate coverage silently.
    expect(res.actors.find((a) => a.actor === 'coordinator')?.context_count).toBe(3);
    expect(res.total_contexts).toBe(7);
  });

  it('widening the window pulls the older context back in', async () => {
    const res = await SessionAnalyticsService.getContextsByActor(
      projectsScope([projectA]),
      OUTSIDE_DAYS_AGO + 1
    );
    expect(res.actors.find((a) => a.actor === 'coordinator')?.context_count).toBe(4);
    expect(res.total_contexts).toBe(8);
  });

  it('scopes on the CONTEXT own project, not the owning session project (RULE 2)', async () => {
    // The project-B context was written by a session that lives in project A. It must
    // count for B, and must NOT leak into A's totals.
    const b = await SessionAnalyticsService.getContextsByActor(
      projectsScope([projectB]),
      WINDOW_DAYS
    );
    expect(b.actors).toEqual([{ actor: 'coordinator', context_count: 1, kind: 'agent' }]);
    expect(b.total_contexts).toBe(1);

    const a = await SessionAnalyticsService.getContextsByActor(
      projectsScope([projectA]),
      WINDOW_DAYS
    );
    expect(a.actors.find((x) => x.actor === 'coordinator')?.context_count).toBe(3);
  });

  it('a multi-project scope sums both projects', async () => {
    const res = await SessionAnalyticsService.getContextsByActor(
      projectsScope([projectA, projectB]),
      WINDOW_DAYS
    );
    expect(res.actors.find((a) => a.actor === 'coordinator')?.context_count).toBe(4);
    expect(res.total_contexts).toBe(8);
  });

  it('an EMPTY scope (a caller with zero grants) returns nothing, not everything', async () => {
    const res = await SessionAnalyticsService.getContextsByActor(projectsScope([]), WINDOW_DAYS);
    expect(res.actors).toEqual([]);
    expect(res.attributed_contexts).toBe(0);
    expect(res.unattributed_contexts).toBe(0);
    expect(res.total_contexts).toBe(0);
  });

  it('ZERO ATTRIBUTED: a project with contexts but no actor gives no bars and a real total', async () => {
    const res = await SessionAnalyticsService.getContextsByActor(
      projectsScope([projectC]),
      WINDOW_DAYS
    );
    expect(res.actors).toEqual([]);
    expect(res.attributed_contexts).toBe(0);
    // The distinction the panel's onboarding state depends on: no ACTOR is not no DATA.
    expect(res.unattributed_contexts).toBe(2);
    expect(res.total_contexts).toBe(2);
  });

  it('ALL_PROJECTS sees every fixture project at once', async () => {
    const res = await SessionAnalyticsService.getContextsByActor(allProjects, WINDOW_DAYS);
    const coordinator = res.actors.find((a) => a.actor === 'coordinator')?.context_count ?? 0;
    // 3 in A + 1 in B. Other suites' rows may also be present in this shared DB, so this
    // asserts a LOWER bound on the shared population and an exact count on ours.
    expect(coordinator).toBeGreaterThanOrEqual(4);
    expect(res.total_contexts).toBeGreaterThanOrEqual(9);
    expect(res.attributed_contexts + res.unattributed_contexts).toBe(res.total_contexts);
  });

  it('echoes the window it actually used, so the caller can label it honestly', async () => {
    const res = await SessionAnalyticsService.getContextsByActor(
      projectsScope([projectA]),
      WINDOW_DAYS
    );
    expect(res.days).toBe(WINDOW_DAYS);
  });
});
