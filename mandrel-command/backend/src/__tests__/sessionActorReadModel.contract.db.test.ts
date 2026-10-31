/**
 * Contract test: the session read models SERIALIZE `actor` and SLICE by it.
 *
 * an earlier Task — expose the "who" dimension.
 * The Sessions Foundation (migration 062) stamps `sessions.actor`
 * on write; before this task the Command read models DROPPED it on read. This suite
 * proves, against the REAL migrated schema:
 *   1. GET /sessions list serializes `actor` (and null when unstamped);
 *   2. GET /sessions/:id detail serializes `actor`;
 *   3. the `?actor=` filter narrows the list, analytics, and trends;
 *   4. the field is ADDITIVE — existing fields on a session row are unchanged.
 *
 * Requires a reachable migrated Postgres (CI provisions one). See dbContractGate.
 */
import { Pool } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import { SessionAnalyticsService } from '../services/sessionAnalytics';
import { SessionDetailService } from '../services/sessionDetail';
import { contractDbConfig, describeContract, assertDbReachable } from './helpers/dbContractGate';
import { projectsScope } from '../services/projectListScope';

describeContract('session read models expose + slice by actor (contract)', () => {
  let pool: Pool;

  const projectId = uuidv4();
  // Two sessions owned by 'coordinator', one by 'tick', one with NO actor (NULL).
  const coordinatorSessionA = uuidv4();
  const coordinatorSessionB = uuidv4();
  const tickSession = uuidv4();
  const nullActorSession = uuidv4();

  // ── The ACTOR-SLICE fixture for the record-anchored trends CTE (nit N4) ──────────────
  // getSessionTrends counts contexts/tasks by the RECORD's own project, and correlates to
  // a session ONLY to resolve the actor. Both halves of that sentence need a fixture that
  // can tell them apart, so:
  const otherProjectId = uuidv4(); // a SECOND project, to prove the project half
  const ctxCoordinatorA1 = uuidv4();
  const ctxCoordinatorA2 = uuidv4(); // 2 contexts by 'coordinator', in projectId
  const ctxTick = uuidv4(); //     1 by 'tick'
  const ctxNullActor = uuidv4(); //  1 by the session with a NULL actor
  const ctxNoSession = uuidv4(); //  1 with NO session at all — the value that slips through
  const ctxOtherProject = uuidv4(); // written by a 'coordinator' session but owned by ANOTHER project
  const taskCoordinatorA = uuidv4();

  beforeAll(async () => {
    pool = new Pool(contractDbConfig);
    await assertDbReachable(pool);
    const client = await pool.connect();
    try {
      await client.query(
        `INSERT INTO projects (id, name, description, created_at)
           VALUES ($1, $2, $3, NOW()), ($4, $5, $6, NOW())`,
        [
          projectId, `actor-test-${projectId.slice(0, 8)}`, 'actor read-model contract test project',
          otherProjectId, `actor-test-other-${otherProjectId.slice(0, 8)}`, 'second project: the cross-project leg',
        ]
      );

      // started_at = NOW() so the rows land inside the trends window.
      const insert = async (id: string, actor: string | null, tokens: number) =>
        client.query(
          `INSERT INTO sessions
               (id, project_id, agent_type, actor, started_at, ended_at,
                total_tokens, contexts_created, decisions_created, tasks_created)
             VALUES ($1, $2, 'claude-code', $3, NOW() - INTERVAL '20 minutes', NOW(),
                     $4, 0, 0, 0)`,
          [id, projectId, actor, tokens]
        );

      await insert(coordinatorSessionA, 'coordinator', 100);
      await insert(coordinatorSessionB, 'coordinator', 200);
      await insert(tickSession, 'tick', 50);
      await insert(nullActorSession, null, 10);

      // Contexts for the actor-slice guard (N4). created_at = NOW() so they land in the
      // trends window on the same day the sessions started.
      const ctx = async (id: string, project: string, sessionId: string | null) =>
        client.query(
          `INSERT INTO contexts (id, project_id, session_id, context_type, content, created_at)
             VALUES ($1, $2, $3, 'completion', 'actor-slice fixture', NOW())`,
          [id, project, sessionId]
        );
      await ctx(ctxCoordinatorA1, projectId, coordinatorSessionA);
      await ctx(ctxCoordinatorA2, projectId, coordinatorSessionA);
      await ctx(ctxTick, projectId, tickSession);
      await ctx(ctxNullActor, projectId, nullActorSession);
      await ctx(ctxNoSession, projectId, null);
      await ctx(ctxOtherProject, otherProjectId, coordinatorSessionA);

      await client.query(
        `INSERT INTO tasks (id, project_id, session_id, title, type, status, priority, created_at)
           VALUES ($1, $2, $3, 'actor-slice fixture task', 'general', 'todo', 'medium', NOW())`,
        [taskCoordinatorA, projectId, coordinatorSessionA]
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
        const ids = [projectId, otherProjectId];
        await client.query(`DELETE FROM tasks WHERE project_id = ANY($1)`, [ids]);
        await client.query(`DELETE FROM contexts WHERE project_id = ANY($1)`, [ids]);
        await client.query(`DELETE FROM sessions WHERE project_id = ANY($1)`, [ids]);
        await client.query(`DELETE FROM projects WHERE id = ANY($1)`, [ids]);
      } finally {
        client.release();
      }
    } catch {
      /* best-effort cleanup */
    } finally {
      await pool.end();
    }
  });

  test('LIST serializes actor for every session (including null when unstamped)', async () => {
    const { sessions } = await SessionAnalyticsService.getSessionsList({ scope: projectsScope([projectId]) });
    const byId = new Map(sessions.map((s) => [s.id, s]));

    expect(byId.get(coordinatorSessionA)?.actor).toBe('coordinator');
    expect(byId.get(coordinatorSessionB)?.actor).toBe('coordinator');
    expect(byId.get(tickSession)?.actor).toBe('tick');
    // Unstamped row → serialized as null (the field is always present, never omitted).
    expect(byId.get(nullActorSession)).toHaveProperty('actor');
    expect(byId.get(nullActorSession)?.actor).toBeNull();
  });

  test('LIST is ADDITIVE — existing fields on a row are unchanged', async () => {
    const { sessions } = await SessionAnalyticsService.getSessionsList({ scope: projectsScope([projectId]) });
    const row = sessions.find((s) => s.id === coordinatorSessionA)!;
    // Spot-check the pre-existing contract still holds alongside the new field.
    expect(row.id).toBe(coordinatorSessionA);
    expect(row.project_id).toBe(projectId);
    expect(row.total_tokens).toBe('100');
    expect(row.status).toBeDefined();
    expect(row.session_type).toBe('claude-code');
  });

  test('LIST slices by actor', async () => {
    const coordinatorOnly = await SessionAnalyticsService.getSessionsList({ scope: projectsScope([projectId]), actor: 'coordinator' });
    const ids = coordinatorOnly.sessions.map((s) => s.id).sort();
    expect(ids).toEqual([coordinatorSessionA, coordinatorSessionB].sort());
    expect(coordinatorOnly.total).toBe(2);
    for (const s of coordinatorOnly.sessions) expect(s.actor).toBe('coordinator');

    const tickOnly = await SessionAnalyticsService.getSessionsList({ scope: projectsScope([projectId]), actor: 'tick' });
    expect(tickOnly.sessions.map((s) => s.id)).toEqual([tickSession]);
    expect(tickOnly.total).toBe(1);
  });

  test('DETAIL serializes actor', async () => {
    const coordinator = await SessionDetailService.getSessionDetail(coordinatorSessionA);
    expect(coordinator?.actor).toBe('coordinator');

    const nullActor = await SessionDetailService.getSessionDetail(nullActorSession);
    expect(nullActor).toHaveProperty('actor');
    expect(nullActor?.actor).toBeNull();
  });

  test('ANALYTICS slices by actor', async () => {
    const all = await SessionAnalyticsService.getSessionAnalytics(projectsScope([projectId]));
    expect(all.total_sessions).toBe(4);

    const coordinator = await SessionAnalyticsService.getSessionAnalytics(projectsScope([projectId]), 'coordinator');
    expect(coordinator.total_sessions).toBe(2);
    // coordinator sessions carry 100 + 200 tokens.
    expect(coordinator.total_tokens_used).toBe(300);

    const tick = await SessionAnalyticsService.getSessionAnalytics(projectsScope([projectId]), 'tick');
    expect(tick.total_sessions).toBe(1);
  });

  test('TRENDS slices by actor', async () => {
    const all = await SessionAnalyticsService.getSessionTrends(projectsScope([projectId]), 30);
    const allTotal = all.reduce((n, d) => n + d.session_count, 0);
    expect(allTotal).toBe(4);

    const coordinator = await SessionAnalyticsService.getSessionTrends(projectsScope([projectId]), 30, 'coordinator');
    const coordinatorTotal = coordinator.reduce((n, d) => n + d.session_count, 0);
    expect(coordinatorTotal).toBe(2);
    const coordinatorTokens = coordinator.reduce((n, d) => n + d.total_tokens_used, 0);
    expect(coordinatorTokens).toBe(300);

    const tick = await SessionAnalyticsService.getSessionTrends(projectsScope([projectId]), 30, 'tick');
    const tickTotal = tick.reduce((n, d) => n + d.session_count, 0);
    expect(tickTotal).toBe(1);
  });

  /**
   * TRENDS: the actor slice of the RECORD-ANCHORED context/task CTEs (N4).
   *
   * The tests above exercise this branch but assert only `session_count` and
   * `total_tokens_used`, which are session-owned and would be identical however the
   * context series were built. So the sentence the implementation's own header makes —
   * "when an actor is named the record-anchored CTEs keep the session correlation for the
   * ACTOR only, never for the project" — was unguarded. It has two halves and this
   * fixture separates them:
   *
   *   THE ACTOR HALF   a context is attributed to an actor through its OWNING SESSION,
   *                    so `ctxNoSession` (no session at all) must count when no actor is
   *                    named and must vanish under EVERY actor filter. That is the
   *                    absent-population value, and it is the one that slips through: a
   *                    naive `INNER JOIN sessions` would drop it from the unfiltered
   *                    total too.
   *   THE PROJECT HALF `ctxOtherProject` is written BY a 'coordinator' session but OWNED by
   *                    another project. It must never appear in projectId's series —
   *                    if the actor correlation leaked into the project filter, or if the
   *                    series went back to counting by the session's project, it would.
   */
  const contextsIn = (rows: Awaited<ReturnType<typeof SessionAnalyticsService.getSessionTrends>>) =>
    rows.reduce((n, d) => n + d.total_contexts, 0);
  const tasksIn = (rows: Awaited<ReturnType<typeof SessionAnalyticsService.getSessionTrends>>) =>
    rows.reduce((n, d) => n + d.total_tasks_created, 0);

  test('TRENDS slices the RECORD-ANCHORED context series by actor', async () => {
    // No actor: all 5 contexts this project OWNS, including the one with NO session.
    const all = await SessionAnalyticsService.getSessionTrends(projectsScope([projectId]), 30);
    expect(contextsIn(all)).toBe(5);

    // 'coordinator' wrote 2 of them in THIS project. The third context on a coordinator session
    // (ctxOtherProject) belongs to another project and must not be counted here.
    const coordinator = await SessionAnalyticsService.getSessionTrends(projectsScope([projectId]), 30, 'coordinator');
    expect(contextsIn(coordinator)).toBe(2);

    const tick = await SessionAnalyticsService.getSessionTrends(projectsScope([projectId]), 30, 'tick');
    expect(contextsIn(tick)).toBe(1);

    // An actor nobody used: an EMPTY slice, not a fallback to everything.
    const nobody = await SessionAnalyticsService.getSessionTrends(projectsScope([projectId]), 30, 'nobody');
    expect(contextsIn(nobody)).toBe(0);

    // The sessionless context is in the unfiltered total and in NO actor's slice.
    expect(contextsIn(all) - contextsIn(coordinator) - contextsIn(tick)).toBe(2); // ctxNullActor + ctxNoSession
  });

  test('TRENDS slices the RECORD-ANCHORED task series by actor the same way', async () => {
    const all = await SessionAnalyticsService.getSessionTrends(projectsScope([projectId]), 30);
    expect(tasksIn(all)).toBe(1);

    const coordinator = await SessionAnalyticsService.getSessionTrends(projectsScope([projectId]), 30, 'coordinator');
    expect(tasksIn(coordinator)).toBe(1);

    const tick = await SessionAnalyticsService.getSessionTrends(projectsScope([projectId]), 30, 'tick');
    expect(tasksIn(tick)).toBe(0);
  });

  test('TRENDS never attributes another project\'s record to this one, under any actor', async () => {
    // The cross-project context is real and IS reachable — from its own project, under
    // the actor of the session that wrote it. Asserting it exists somewhere is what makes
    // the absence above evidence of scoping rather than of a broken fixture.
    const other = await SessionAnalyticsService.getSessionTrends(
      projectsScope([otherProjectId]), 30, 'coordinator',
    );
    expect(contextsIn(other)).toBe(1);

    // ...and it is nowhere in projectId's series, with or without the actor filter.
    for (const actor of [undefined, 'coordinator', 'tick']) {
      const rows = await SessionAnalyticsService.getSessionTrends(
        projectsScope([projectId]), 30, actor,
      );
      expect(contextsIn(rows)).toBeLessThanOrEqual(5);
    }
    const coordinatorHere = await SessionAnalyticsService.getSessionTrends(
      projectsScope([projectId]), 30, 'coordinator',
    );
    expect(contextsIn(coordinatorHere)).toBe(2); // NOT 3
  });
});
