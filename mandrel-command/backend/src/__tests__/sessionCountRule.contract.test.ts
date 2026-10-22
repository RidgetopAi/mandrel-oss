/**
 * SESSION COUNT RULE — THE THREE COPIES MUST AGREE (Reviewer F1/F7).
 *
 * ── WHAT THIS FILE IS FOR ───────────────────────────────────────────────────────────────
 * "How many contexts / tasks / decisions does this session have" is written in THREE
 * places, in two packages and one SQL file. They cannot be collapsed into one accessor
 * (a Postgres view cannot import TypeScript; mcp-server does not import backend code), so
 * the rule is duplicated by necessity — which means the ONLY thing that can keep them
 * honest is a pair of tests (one per package, each building an EQUIVALENT cross-project
 * fixture: same shape, same expected literals) that EXECUTE their copies and compare:
 *
 *   COPY 1  mcp-server/database/migrations/070_session_summaries_derive_counts.sql
 *           → the `v_session_summaries` VIEW. Asserted HERE (the backend reads this view
 *             for /api/v2/sessions detail + compare) and in the mcp-server half.
 *   COPY 2  mcp-server SessionRepo.IDENTITY_SELECT (+ getFinalCounts)
 *           → asserted in mcp-server/src/tests/sessionCountRule.contract.test.ts.
 *   COPY 3  mandrel-command/backend/src/services/sessionCounts.ts
 *           → asserted HERE, both as raw SQL and through the real list endpoint.
 *
 * The two halves are anchored to the SAME literal expected numbers AND both pin COPY 1
 * (the view) as their shared link, so "all three agree" is asserted, not assumed. Each
 * copy is exercised by the interpreter that actually runs it — Postgres runs the view and
 * the built SQL; nothing here shape-matches source text (a text search never
 * stands in for a behavioural claim).
 *
 * ── THE FIXTURE IS CROSS-PROJECT, AND THAT IS THE ENTIRE POINT ──────────────────────────
 * The bug being guarded is the third, wrong rule that was actually in the code:
 * `c.project_id = s.project_id` — a correlation to the SESSION's project, which is neither
 * RULE 1 nor RULE 2 and drops 1715 of 7271 session-linked contexts on prod (24%).
 *
 * A single-project fixture CANNOT see that bug: if every context's project equals the
 * session's project, the wrong predicate is trivially true and a drifted copy passes
 * GREEN. (This is exactly why sessionCountersSurviveFinalize.contract.test.ts, which
 * drives one project, is not a guard for this.) So the session below lives in project A
 * and carries child rows in BOTH A and B, and the first test asserts that spread directly
 * — if someone ever "simplifies" the fixture to one project, that test goes RED before any
 * of the count assertions can quietly stop discriminating (mutation-probe the probe).
 *
 * ── MUTATION PROOF (redo this if you touch any copy) ─────────────────────────────────────
 * Re-add `AND c.project_id = s.project_id` to a copy and this suite must go RED:
 *   COPY 1 → edit migration 070, re-apply it, re-run → the view test fails 4 !== 7.
 *   COPY 3 → edit sessionCounts.contextCountSql → the raw-SQL AND list-endpoint tests fail.
 *   COPY 2 → covered by the mcp-server half (same drill on IDENTITY_SELECT).
 * All three runs were recorded in the an earlier task remediation report.
 *
 * ── SECOND CONTRACT IN THIS FILE: THE ARCHIVED RULE, PER READ PATH ──────
 * The three-copies contract above is about the PROJECT rule. The block at the bottom of the
 * file is about the ARCHIVED rule, and it exists because that one had been written as a
 * PROSE LIST in a comment and was wrong three rewrites running. It asserts, by invoking each
 * one, what every read path currently answers for a session carrying both live and archived
 * contexts — plus a CENSUS that fails when a hand-written session-scoped contexts query
 * appears in the source without being claimed. Read the header on that block before adding
 * or changing a reader; its limits are stated there rather than implied.
 *
 * Requires a reachable Postgres (the CI disposable migrated DB) — see helpers/dbContractGate.
 */
import { Pool } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import { SessionAnalyticsService } from '../services/sessionAnalytics';
import {
  contextCountSql,
  taskCountSql,
  completedTaskCountSql,
  decisionCountSql,
  taskCompletionRateSql,
} from '../services/sessionCounts';
import { contractDbConfig, describeContract, assertDbReachable } from './helpers/dbContractGate';
import { allProjects, projectsScope } from '../services/projectListScope';
import { ProjectService } from '../services/project';
import { SessionDetailService } from '../services/sessionDetail';
import { DaySummaryService } from '../services/daySummary';
import { queryDailySeries } from '../services/dailySeries';

describeContract('session count rule: the three copies agree', () => {
  let pool: Pool;

  const projectA = uuidv4(); // the session's OWN project
  const projectB = uuidv4(); // a project the session switched into mid-flight
  const sessionInA = uuidv4();
  // A unique actor so the list-endpoint assertions can select THIS session without a
  // project filter — filtering by project would switch the query to RULE 2 and stop
  // testing RULE 1, which is the surface Operator reported the bug on.
  const ACTOR = `count-rule-probe-${sessionInA.slice(0, 8)}`;

  // A SECOND session, in project A, whose contexts ALL live in project B. Under the old
  // `c.project_id = s.project_id` predicate its context count was 0, which put it below
  // getProductiveSessions' `> 0` filter and made it DISAPPEAR from that endpoint — not
  // merely under-counted. It exists so the "still present" assertion is discriminating
  // rather than decorative (the main fixture has 4 same-project contexts and would have
  // survived the old predicate regardless).
  const sessionAllCross = uuidv4();
  const ACTOR_CROSS = `count-rule-cross-${sessionAllCross.slice(0, 8)}`;
  const CTX_ALL_CROSS = 2;

  // ── EXPECTED VALUES ──────────────────────────────────────────────────────────────────
  // Deliberately distinct from one another so a transposed field cannot coincidentally
  // satisfy an assertion, and chosen so the RIGHT answer and the WRONG (project-guarded)
  // answer differ for every count.
  const CTX_IN_A = 4;
  const CTX_IN_B = 3;
  const CTX_RULE1 = CTX_IN_A + CTX_IN_B; // 7  — session linkage only
  const TASKS_IN_A = 3; // 2 of them completed
  const TASKS_IN_B = 2; // 1 of them completed
  const TASKS_RULE1 = TASKS_IN_A + TASKS_IN_B; // 5
  const TASKS_DONE_IN_A = 2;
  const TASKS_DONE_IN_B = 1;
  const TASKS_DONE_RULE1 = TASKS_DONE_IN_A + TASKS_DONE_IN_B; // 3
  const DEC_IN_A = 2;
  const DEC_IN_B = 1;
  const DEC_RULE1 = DEC_IN_A + DEC_IN_B; // 3

  // ── ARCHIVED DECOYS ─────────────────────────────────────────────────
  // Soft-deleted child rows on the SAME session. Excluded from every count, so the RULE1
  // numbers above are unchanged — which is the point: a builder that forgets
  // `AND <alias>.archived_at IS NULL` counts these and the existing assertions go RED.
  // This fixture previously archived NOTHING, so all three copies of the rule could be
  // wrong the same way and still agree with each other. Mirrors the mcp-server twin's
  // constants exactly, so the two halves stay comparable.
  // The archived contexts are split across the two projects EXPLICITLY (they used to be
  // dealt out by `i % 2`, which produced the same 3/2 split but as an accident of the loop
  // rather than a number any assertion could name). The per-read-path archived contract
  // below asserts PROJECT-scoped totals, which need that split as a constant.
  const ARCH_CTX_IN_A = 3;
  const ARCH_CTX_IN_B = 2;
  const ARCH_CTX = ARCH_CTX_IN_A + ARCH_CTX_IN_B; // 5 — unchanged; the mcp-server twin pins the same total
  const ARCH_TASKS = 4;
  const ARCH_TASKS_DONE = 2;
  const ARCH_DEC = 6;

  beforeAll(async () => {
    pool = new Pool(contractDbConfig);
    await assertDbReachable(pool);
    const client = await pool.connect();
    try {
      await client.query(
        `INSERT INTO projects (id, name, description, created_at)
           VALUES ($1, $2, $3, NOW()), ($4, $5, $6, NOW())`,
        [
          projectA, `count-rule-A-${projectA.slice(0, 8)}`, 'count rule: session home project',
          projectB, `count-rule-B-${projectB.slice(0, 8)}`, 'count rule: mid-session switch target',
        ]
      );

      // An ENDED session — the state whose counters the old finish() destroyed, and the
      // state the "Earlier" bucket in the UI renders.
      await client.query(
        `INSERT INTO sessions (id, project_id, agent_type, actor, status, started_at, ended_at)
           VALUES ($1, $2, 'mcp-server', $3, 'ended', NOW() - INTERVAL '30 minutes', NOW())`,
        [sessionInA, projectA, ACTOR]
      );

      // Contexts: some in the session's own project, some in the project it switched to.
      // ALL linked to the session by session_id — that linkage is what RULE 1 counts.
      for (let i = 0; i < CTX_IN_A; i++) {
        await client.query(
          `INSERT INTO contexts (id, project_id, session_id, context_type, content, created_at)
             VALUES ($1, $2, $3, 'completion', 'count-rule ctx in A', NOW())`,
          [uuidv4(), projectA, sessionInA]
        );
      }
      for (let i = 0; i < CTX_IN_B; i++) {
        await client.query(
          `INSERT INTO contexts (id, project_id, session_id, context_type, content, created_at)
             VALUES ($1, $2, $3, 'completion', 'count-rule ctx in B (mid-switch)', NOW())`,
          [uuidv4(), projectB, sessionInA]
        );
      }

      // The all-cross-project session (see the declaration above).
      await client.query(
        `INSERT INTO sessions (id, project_id, agent_type, actor, status, started_at, ended_at)
           VALUES ($1, $2, 'mcp-server', $3, 'ended', NOW() - INTERVAL '20 minutes', NOW())`,
        [sessionAllCross, projectA, ACTOR_CROSS]
      );
      for (let i = 0; i < CTX_ALL_CROSS; i++) {
        await client.query(
          `INSERT INTO contexts (id, project_id, session_id, context_type, content, created_at)
             VALUES ($1, $2, $3, 'completion', 'count-rule ctx: ALL cross-project', NOW())`,
          [uuidv4(), projectB, sessionAllCross]
        );
      }

      const insTask = async (project: string, done: boolean) =>
        client.query(
          `INSERT INTO tasks (id, project_id, session_id, title, type, status, priority, tags)
             VALUES ($1, $2, $3, $4, 'general', $5, 'medium', '{}')`,
          [uuidv4(), project, sessionInA, `count-rule task ${done ? 'done' : 'todo'}`,
           done ? 'completed' : 'todo']
        );
      for (let i = 0; i < TASKS_IN_A; i++) await insTask(projectA, i < TASKS_DONE_IN_A);
      for (let i = 0; i < TASKS_IN_B; i++) await insTask(projectB, i < TASKS_DONE_IN_B);

      const insDecision = async (project: string) =>
        client.query(
          `INSERT INTO technical_decisions
             (id, project_id, session_id, decision_type, title, description, rationale, decision_date)
           VALUES ($1, $2, $3, 'architecture', 'count-rule decision', 'd', 'r', NOW())`,
          [uuidv4(), project, sessionInA]
        );
      for (let i = 0; i < DEC_IN_A; i++) await insDecision(projectA);
      for (let i = 0; i < DEC_IN_B; i++) await insDecision(projectB);

      // ARCHIVED DECOYS — see the constants block. Split across both
      // projects so an archived row cannot be excluded by the project rule instead.
      const insArchivedCtx = async (project: string) =>
        client.query(
          `INSERT INTO contexts (id, project_id, session_id, context_type, content, created_at, archived_at)
             VALUES ($1, $2, $3, 'completion', 'count-rule ARCHIVED ctx', NOW(), NOW())`,
          [uuidv4(), project, sessionInA]
        );
      for (let i = 0; i < ARCH_CTX_IN_A; i++) await insArchivedCtx(projectA);
      for (let i = 0; i < ARCH_CTX_IN_B; i++) await insArchivedCtx(projectB);
      for (let i = 0; i < ARCH_TASKS; i++) {
        await client.query(
          `INSERT INTO tasks (id, project_id, session_id, title, type, status, priority, tags, archived_at)
             VALUES ($1, $2, $3, 'count-rule ARCHIVED task', 'general', $4, 'medium', '{}', NOW())`,
          [uuidv4(), i % 2 === 0 ? projectA : projectB, sessionInA,
           i < ARCH_TASKS_DONE ? 'completed' : 'todo']
        );
      }
      for (let i = 0; i < ARCH_DEC; i++) {
        await client.query(
          `INSERT INTO technical_decisions
             (id, project_id, session_id, decision_type, title, description, rationale, decision_date, archived_at)
           VALUES ($1, $2, $3, 'architecture', 'count-rule ARCHIVED decision', 'd', 'r', NOW(), NOW())`,
          [uuidv4(), i % 2 === 0 ? projectA : projectB, sessionInA]
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
        const ids = [sessionInA, sessionAllCross];
        await client.query(`DELETE FROM contexts WHERE session_id = ANY($1)`, [ids]);
        await client.query(`DELETE FROM tasks WHERE session_id = ANY($1)`, [ids]);
        await client.query(`DELETE FROM technical_decisions WHERE session_id = ANY($1)`, [ids]);
        await client.query(`DELETE FROM sessions WHERE id = ANY($1)`, [ids]);
        await client.query(`DELETE FROM projects WHERE id = ANY($1)`, [[projectA, projectB]]);
      } finally {
        client.release();
      }
    } catch {
      /* best-effort cleanup — an unreachable DB already failed the suite loudly */
    } finally {
      await pool.end();
    }
  });

  // ──────────────────────────────────────────────────────────────────────────────────────
  // PRECONDITION — the fixture must actually span two projects.
  // Every assertion below is only discriminating because some child rows belong to a
  // DIFFERENT project than the session. If that stops being true, the whole suite silently
  // degrades into "any rule passes". This test is the fuse on the fixture itself.
  // ──────────────────────────────────────────────────────────────────────────────────────
  it('PRECONDITION: the session carries child rows OUTSIDE its own project', async () => {
    const r = await pool.query(
      `SELECT
         COUNT(*)::int                                              AS total,
         COUNT(*) FILTER (WHERE c.project_id <> s.project_id)::int  AS cross_project
       FROM contexts c JOIN sessions s ON s.id = c.session_id
       -- LIVE rows only: the fixture now also seeds ARCHIVED decoys on this session
       --, which every copy of the rule excludes.
       WHERE c.session_id = $1 AND c.archived_at IS NULL`,
      [sessionInA]
    );
    expect(r.rows[0].total).toBe(CTX_RULE1);
    // The load-bearing number. Zero here = every project-guarded predicate passes = the
    // guard is hollow.
    expect(r.rows[0].cross_project).toBe(CTX_IN_B);
    expect(r.rows[0].cross_project).toBeGreaterThan(0);

    // ARCHIVED DECOYS must exist, or every archived assertion this fixture
    // arms is vacuous — the copies would agree on un-decoyed numbers and pass while
    // guarding nothing.
    const a = await pool.query(
      `SELECT (SELECT COUNT(*)::int FROM contexts            WHERE session_id = $1 AND archived_at IS NOT NULL) AS ctx,
              (SELECT COUNT(*)::int FROM tasks               WHERE session_id = $1 AND archived_at IS NOT NULL) AS tasks,
              (SELECT COUNT(*)::int FROM tasks               WHERE session_id = $1 AND archived_at IS NOT NULL
                                                               AND status = 'completed')                        AS tasks_done,
              (SELECT COUNT(*)::int FROM technical_decisions WHERE session_id = $1 AND archived_at IS NOT NULL) AS dec`,
      [sessionInA]
    );
    expect(a.rows[0].ctx).toBe(ARCH_CTX);
    // …and the PROJECT split of the archived contexts, which the per-read-path archived
    // contract below turns into project-scoped expected numbers. If the split drifts, those
    // numbers stop meaning what their names say, so it is pinned here at the fixture.
    const as = await pool.query(
      `SELECT COUNT(*) FILTER (WHERE project_id = $2)::int AS in_a,
              COUNT(*) FILTER (WHERE project_id = $3)::int AS in_b
         FROM contexts WHERE session_id = $1 AND archived_at IS NOT NULL`,
      [sessionInA, projectA, projectB]
    );
    expect(as.rows[0].in_a).toBe(ARCH_CTX_IN_A);
    expect(as.rows[0].in_b).toBe(ARCH_CTX_IN_B);
    expect(a.rows[0].tasks).toBe(ARCH_TASKS);
    expect(a.rows[0].tasks_done).toBe(ARCH_TASKS_DONE);
    expect(a.rows[0].dec).toBe(ARCH_DEC);
    for (const v of Object.values(a.rows[0])) expect(Number(v)).toBeGreaterThan(0);

    // The SECOND fixture needs its own fuse (Reviewer N3). `sessionAllCross` is the only
    // thing that makes the "getProductiveSessions does not DROP" test discriminating: it
    // is discriminating because ALL of its contexts are cross-project, so the old guarded
    // count answered 0 and `HAVING COUNT(c.id) > 0` deleted the row. Move those contexts
    // into projectA and that test keeps passing while guarding nothing — the exact
    // fixture-drift hole this PRECONDITION exists to close, one fixture over.
    const rc = await pool.query(
      `SELECT
         COUNT(*)::int                                              AS total,
         COUNT(*) FILTER (WHERE c.project_id <> s.project_id)::int  AS cross_project
       FROM contexts c JOIN sessions s ON s.id = c.session_id
       WHERE c.session_id = $1`,
      [sessionAllCross]
    );
    expect(rc.rows[0].total).toBe(CTX_ALL_CROSS);
    // ALL of them, not merely some: a single same-project context would put the session
    // back above the `> 0` filter and de-fang the drop test.
    expect(rc.rows[0].cross_project).toBe(CTX_ALL_CROSS);
    expect(rc.rows[0].cross_project).toBeGreaterThan(0);
  });

  // ──────────────────────────────────────────────────────────────────────────────────────
  // COPY 3 — the backend SQL builders, executed by Postgres.
  // ──────────────────────────────────────────────────────────────────────────────────────
  it('COPY 3 (sessionCounts.ts) applies RULE 1: session linkage only, no project guard', async () => {
    const r = await pool.query(
      `SELECT ${contextCountSql('s')}         AS contexts,
              ${taskCountSql('s')}            AS tasks,
              ${completedTaskCountSql('s')}   AS tasks_done,
              ${decisionCountSql('s')}        AS decisions,
              ${taskCompletionRateSql('s')}   AS rate
         FROM sessions s WHERE s.id = $1`,
      [sessionInA]
    );
    const row = r.rows[0];
    expect(Number(row.contexts)).toBe(CTX_RULE1);
    expect(Number(row.tasks)).toBe(TASKS_RULE1);
    expect(Number(row.tasks_done)).toBe(TASKS_DONE_RULE1);
    expect(Number(row.decisions)).toBe(DEC_RULE1);
    expect(Number(row.rate)).toBe(60); // 3 of 5
  });

  it('COPY 3 applies RULE 2 on the CHILD\'s own project, never the session\'s', async () => {
    const forProject = async (project: string) => {
      const r = await pool.query(
        `SELECT ${contextCountSql('s', '$2')}       AS contexts,
                ${taskCountSql('s', '$2')}          AS tasks,
                ${completedTaskCountSql('s', '$2')} AS tasks_done,
                ${decisionCountSql('s', '$2')}      AS decisions
           FROM sessions s WHERE s.id = $1`,
        [sessionInA, project]
      );
      return r.rows[0];
    };

    const a = await forProject(projectA);
    expect(Number(a.contexts)).toBe(CTX_IN_A);
    expect(Number(a.tasks)).toBe(TASKS_IN_A);
    expect(Number(a.tasks_done)).toBe(TASKS_DONE_IN_A);
    expect(Number(a.decisions)).toBe(DEC_IN_A);

    // The discriminating half: project B is NOT the session's project. A copy that
    // correlated to `s.project_id` would answer 0 here for every count.
    const b = await forProject(projectB);
    expect(Number(b.contexts)).toBe(CTX_IN_B);
    expect(Number(b.tasks)).toBe(TASKS_IN_B);
    expect(Number(b.tasks_done)).toBe(TASKS_DONE_IN_B);
    expect(Number(b.decisions)).toBe(DEC_IN_B);
  });

  // ──────────────────────────────────────────────────────────────────────────────────────
  // COPY 1 — migration 070's view, executed by Postgres, and pinned to COPY 3.
  // ──────────────────────────────────────────────────────────────────────────────────────
  it('COPY 1 (v_session_summaries) reports the same RULE 1 numbers as COPY 3', async () => {
    const view = await pool.query(
      `SELECT contexts_created::int  AS contexts,
              tasks_created::int     AS tasks,
              tasks_completed::int   AS tasks_done,
              decisions_created::int AS decisions,
              task_completion_rate   AS rate
         FROM v_session_summaries WHERE id = $1`,
      [sessionInA]
    );
    expect(view.rows).toHaveLength(1);
    const v = view.rows[0];

    // Against the literals…
    expect(v.contexts).toBe(CTX_RULE1);
    expect(v.tasks).toBe(TASKS_RULE1);
    expect(v.tasks_done).toBe(TASKS_DONE_RULE1);
    expect(v.decisions).toBe(DEC_RULE1);
    expect(Number(v.rate)).toBe(60);

    // …and directly against COPY 3, so "the copies agree" is measured, not inferred.
    const built = await pool.query(
      `SELECT ${contextCountSql('s')}       AS contexts,
              ${taskCountSql('s')}          AS tasks,
              ${completedTaskCountSql('s')} AS tasks_done,
              ${decisionCountSql('s')}      AS decisions
         FROM sessions s WHERE s.id = $1`,
      [sessionInA]
    );
    const b = built.rows[0];
    expect(v.contexts).toBe(Number(b.contexts));
    expect(v.tasks).toBe(Number(b.tasks));
    expect(v.tasks_done).toBe(Number(b.tasks_done));
    expect(v.decisions).toBe(Number(b.decisions));
  });

  // ──────────────────────────────────────────────────────────────────────────────────────
  // F7 — THE LIST ENDPOINT, UNFILTERED. This is the surface the bug was reported on
  // ("24% recovered"): /api/v2/sessions with no project filter → RULE 1. The rule being
  // right inside sessionCounts.ts proves nothing if the caller passes the wrong argument,
  // so this exercises SessionAnalyticsService.getSessionsList itself.
  // ──────────────────────────────────────────────────────────────────────────────────────
  it('F7: getSessionsList UNFILTERED counts every session-linked child row (RULE 1)', async () => {
    const { sessions } = await SessionAnalyticsService.getSessionsList({ scope: allProjects, actor: ACTOR });
    // The actor filter narrows to our fixture WITHOUT introducing a project filter — the
    // query is still in its RULE 1 shape (projParamRef is set by projectId alone).
    expect(sessions).toHaveLength(1);
    const s = sessions[0];
    expect(s.id).toBe(sessionInA);

    // Both field names, because the API serves the same derived number under each and a
    // consumer writing `contexts_created ?? context_count` must not be handed a poisoned 0.
    expect(s.contexts_created).toBe(CTX_RULE1);
    expect(s.context_count).toBe(CTX_RULE1);
    expect(s.tasks_created).toBe(TASKS_RULE1);
    expect(s.task_count).toBe(TASKS_RULE1);
    expect(s.tasks_completed).toBe(TASKS_DONE_RULE1);
    expect(s.decisions_created).toBe(DEC_RULE1);
    expect(s.decision_count).toBe(DEC_RULE1);
    expect(s.contextsCount).toBe(CTX_RULE1); // legacy alias, same source
    expect(s.tasksCount).toBe(TASKS_RULE1);
    expect(Number(s.task_completion_rate)).toBe(60);
  });

  it('F7: getSessionsList PROJECT-FILTERED counts by the child\'s own project (RULE 2)', async () => {
    const inA = await SessionAnalyticsService.getSessionsList({ scope: projectsScope([projectA])});
    const rowA = inA.sessions.find((s: any) => s.id === sessionInA);
    expect(rowA).toBeDefined();
    expect(rowA.contexts_created).toBe(CTX_IN_A);
    expect(rowA.tasks_created).toBe(TASKS_IN_A);
    expect(rowA.decisions_created).toBe(DEC_IN_A);

    // (see also the getProductiveSessions test below — the reader this remediation found
    // still carrying the bug predicate.)

    // And the row-level filter is unchanged: the list is filtered on the SESSION's
    // project, so a project-B list does not contain this session at all. Asserted
    // unconditionally — an `if (row)` guard here would pass silently the day the count
    // rule broke and the row vanished for the wrong reason.
    const inB = await SessionAnalyticsService.getSessionsList({ scope: projectsScope([projectB])});
    expect(inB.sessions.find((s: any) => s.id === sessionInA)).toBeUndefined();
  });

  // ──────────────────────────────────────────────────────────────────────────────────────
  // getProductiveSessions — a reader this remediation FOUND still carrying the bug
  // predicate (`LEFT JOIN contexts c ON … AND c.project_id = s.project_id`), live at
  // GET /api/v2/sessions/productive and absent from the original task's reader list.
  // Worse than an under-count: the `HAVING COUNT(c.id) > 0` filter used the same guarded
  // count, so a session whose contexts all live in a switched-into project scored zero and
  // was DROPPED from the ranking entirely.
  // ──────────────────────────────────────────────────────────────────────────────────────
  // Two separate claims, two separate tests: the old code failed BOTH ways (an under-count
  // on one session, a vanished row on the other), and a single test would only ever show
  // whichever assertion it reached first.
  it('getProductiveSessions counts by session linkage (RULE 1), not the session\'s project', async () => {
    const rows = await SessionAnalyticsService.getProductiveSessions(allProjects, 1000);
    const mine = rows.find((r) => r.id === sessionInA);
    expect(mine).toBeDefined();
    expect(mine!.context_count).toBe(CTX_RULE1);

    // Project-filtered → RULE 2, on the CHILD's own project.
    const inA = await SessionAnalyticsService.getProductiveSessions(projectsScope([projectA]), 1000);
    const mineA = inA.find((r) => r.id === sessionInA);
    expect(mineA).toBeDefined();
    expect(mineA!.context_count).toBe(CTX_IN_A);
  });

  it('getProductiveSessions does not DROP a session whose contexts are all cross-project', async () => {
    // This session's contexts all live in a project it switched into, so the old guarded
    // count answered 0 and the `HAVING COUNT(c.id) > 0` filter deleted it from the ranking
    // outright — it did not rank low, it disappeared.
    const rows = await SessionAnalyticsService.getProductiveSessions(allProjects, 1000);
    const cross = rows.find((r) => r.id === sessionAllCross);
    expect(cross).toBeDefined();
    expect(cross!.context_count).toBe(CTX_ALL_CROSS);
  });

  // ══════════════════════════════════════════════════════════════════════════════════════
  // THE ARCHIVED-CONTEXTS RULE, ASSERTED PER READ PATH
  //
  // ── WHY THIS EXISTS ───────────────────────────────────────────────────────────────────
  // `services/sessionCounts.ts` excludes archived child rows (`archived_at IS NULL`), and
  // so does `getSessionTrends`. Several read paths still hand-write their own per-session
  // child count and never touch the builder, so they still COUNT archived rows. Which paths
  // those are was, for three rewrites, a PROSE LIST in a comment in sessionAnalytics.ts.
  // Every rewrite fixed its predecessor's false statement and introduced a new one — a
  // function that had never existed in the repo, then a line number pointing into a
  // different function, then a population that was still narrow, then a claim about the
  // merge-base that was false. The clean gate was GREEN through all of it, because a gate
  // cannot measure a sentence.
  //
  // So the list is deleted and the behaviour is EXECUTED instead. Each entry below calls the
  // real service function against the fixture — which carries ARCH_CTX archived contexts and
  // CTX_RULE1 live ones on ONE session — and asserts the number it actually returns. A path
  // cannot be described wrongly here: it is invoked, or it is not in the file.
  //
  // ── OPEN IS NOT A BUG BEING SMUGGLED THROUGH ──────────────────────────────────────────
  // `rule: 'OPEN'` records what a path answers TODAY, not what it ought to answer. Whether
  // these paths should adopt the builder is a separate decision (they are user-visible
  // numbers on the Dashboard, Projects and Session Detail surfaces). The contract's job is
  // that the divergence is a number under test rather than a sentence nobody can check: fix
  // one of them and its assertion goes RED, which is the prompt to update it deliberately.
  //
  // ── HOW A *NEW* PATH IS CAUGHT: the CENSUS at the bottom of this file ─────────────────
  // A per-path table alone is still a list — it passes while a path it never heard of is
  // added. The census closes that: it enumerates every hand-written SQL literal in the
  // backend source that touches the `contexts` table AND mentions `session_id`, and requires
  // each one to be claimed by a registry entry that either names a READ_PATH executed above
  // or carries a written out-of-scope reason. Add a new hand-written per-session context
  // query and the census finds an unclaimed site and goes RED. Its LIMITS are stated there —
  // read them before trusting it.
  // ══════════════════════════════════════════════════════════════════════════════════════

  // What each read path answers about a session carrying BOTH live and archived contexts.
  // Both fixture sessions together, over both fixture projects.
  const LIVE_CTX_IN_AB = CTX_RULE1 + CTX_ALL_CROSS;         // 9
  const CTX_IN_B_LIVE_BOTH_SESSIONS = CTX_IN_B + CTX_ALL_CROSS;    // 5 — live only

  // Resolved from the DB in beforeAll so the day bucket comes from the same clock that
  // stamped the fixture rows, never from the test process's own idea of "today".
  let todayUtc = '';
  beforeAll(async () => {
    const r = await pool.query(`SELECT (now() AT TIME ZONE 'UTC')::date::text AS d`);
    todayUtc = r.rows[0].d;
  });

  /**
   * Several service return types declare their count fields OPTIONAL (`context_count?:
   * number`). An absent field must FAIL, not quietly compare as `undefined === undefined`,
   * so it is coerced here and a non-number throws where the path ran rather than surfacing
   * as an unrelated shape mismatch.
   */
  const num = (v: unknown, field: string): number => {
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      throw new Error(`expected a finite number for "${field}", got ${JSON.stringify(v)}`);
    }
    return v;
  };

  interface ReadPath {
    /** Stable id; the census registry claims sites by this name. */
    id: string;
    /** What the path answers about archived contexts TODAY. Not a judgement. */
    rule: 'OPEN' | 'COMPLIANT';
    run: () => Promise<Record<string, number>>;
    expected: Record<string, number>;
  }

  const READ_PATHS: ReadPath[] = [
    // ── OPEN: hand-written, no archived predicate ──────────────────────────────────────
    {
      id: 'sessionAnalytics.getSessionAnalytics',
      rule: 'COMPLIANT',
      run: async () => {
        const unscoped = await SessionAnalyticsService.getSessionAnalytics(allProjects, ACTOR, 'UTC');
        const inA = await SessionAnalyticsService.getSessionAnalytics(
          projectsScope([projectA]), ACTOR, 'UTC'
        );
        return {
          total_contexts_unscoped: unscoped.total_contexts,
          average_contexts_unscoped: unscoped.average_contexts_per_session,
          total_contexts_in_A: inA.total_contexts,
        };
      },
      expected: {
        // RULE 1 branch (no project filter): every LIVE context linked by session_id.
        // This used to INCLUDE archived rows and was the number that disagreed with
        // getSessionTrends below; an earlier task made the two agree.
        total_contexts_unscoped: CTX_RULE1,
        average_contexts_unscoped: CTX_RULE1, // one session for this actor
        // RULE 2 branch: the project JOIN narrows to project A, archived excluded.
        total_contexts_in_A: CTX_IN_A,
      },
    },
    {
      id: 'project.getProjectSessions',
      rule: 'COMPLIANT',
      run: async () => {
        const rows = await ProjectService.getProjectSessions(projectA);
        const mine = rows.find((r) => r.id === sessionInA);
        expect(mine).toBeDefined();
        const inB = await ProjectService.getProjectSessions(projectB);
        const mineB = inB.find((r) => r.id === sessionInA);
        expect(mineB).toBeDefined();
        return {
          context_count_in_A: num(mine!.context_count, 'context_count_in_A'),
          context_count_in_B: num(mineB!.context_count, 'context_count_in_B'),
        };
      },
      // LIVE only since a soft-deleted context must leave the session's
      // context_count, or Delete looks like it did nothing.
      expected: { context_count_in_A: CTX_IN_A, context_count_in_B: CTX_IN_B },
    },
    {
      id: 'sessionDetail.getSessionSummaries',
      rule: 'COMPLIANT',
      run: async () => {
        const rows = await SessionDetailService.getSessionSummaries(projectsScope([projectA]), 1000, 0);
        const mine = rows.find((r) => r.id === sessionInA);
        expect(mine).toBeDefined();
        return {
          contexts_created: mine!.contexts_created,
          tasks_created: mine!.tasks_created,
          tasks_completed: mine!.tasks_completed,
          decisions_created: mine!.decisions_created,
        };
      },
      // All FOUR counters, because all four are hand-written in the same query and a fix
      // that reached only the contexts one would otherwise pass.
      // THE ASYMMETRY IS CLOSED. Contexts and decisions went live-only in
      // which deliberately PINNED the task counters at their archived-
      // inclusive values so that a later tasks fix would land here as a RED. It did: the
      // two task subqueries were the last hand-written ones in this query and now call
      // taskCountSql / completedTaskCountSql, so all four counters answer live-only.
      expected: {
        contexts_created: CTX_RULE1,
        tasks_created: TASKS_RULE1,
        tasks_completed: TASKS_DONE_RULE1,
        decisions_created: DEC_RULE1,
      },
    },
    {
      id: 'sessionDetail.getSessionDetail',
      rule: 'COMPLIANT',
      run: async () => {
        const d = await SessionDetailService.getSessionDetail(sessionInA);
        expect(d).not.toBeNull();
        return {
          contexts_created: d!.contexts_created,
          context_count: d!.context_count,
          // This path does not merely COUNT archived rows — it RETURNED them, so the card
          // rendered soft-deleted contexts as the session's work. Closed by           // asserted here so a regression is a number, not a sentence.
          contexts_returned: d!.contexts.length,
          decisions_created: d!.decisions_created,
          tasks_created: d!.tasks_created,
          tasks_completed: d!.tasks_completed,
          tasks_returned: d!.tasks.length,
        };
      },
      expected: {
        contexts_created: CTX_RULE1,
        context_count: CTX_RULE1,
        contexts_returned: CTX_RULE1,
        decisions_created: DEC_RULE1,
        // Live-only since an earlier task — see getSessionSummaries above. This path did not
        // merely count archived tasks, it RETURNED them in `tasks`, exactly as it once did
        // with contexts; `tasks_returned` below is that half, asserted as a number.
        tasks_created: TASKS_RULE1,
        tasks_completed: TASKS_DONE_RULE1,
        tasks_returned: TASKS_RULE1,
      },
    },
    {
      id: 'project.getAllProjects',
      rule: 'COMPLIANT',
      run: async () => {
        const rows = await ProjectService.getAllProjects(projectsScope([projectA, projectB]));
        const a = rows.find((r) => r.id === projectA);
        const b = rows.find((r) => r.id === projectB);
        expect(a).toBeDefined();
        expect(b).toBeDefined();
        return {
          context_count_A: num(a!.context_count, 'context_count_A'),
          context_count_B: num(b!.context_count, 'context_count_B'),
        };
      },
      // A per-PROJECT count, not a per-session one — included because it is the same
      // archived question on the same table and it was never in any prose list.
      expected: { context_count_A: CTX_IN_A, context_count_B: CTX_IN_B_LIVE_BOTH_SESSIONS },
    },
    {
      id: 'project.getProjectById',
      rule: 'COMPLIANT',
      run: async () => {
        const p = await ProjectService.getProjectById(projectA);
        expect(p).not.toBeNull();
        return { context_count: num(p!.context_count, 'context_count') };
      },
      expected: { context_count: CTX_IN_A },
    },
    {
      id: 'project.getProjectStats',
      rule: 'COMPLIANT',
      run: async () => {
        const s = await ProjectService.getProjectStats(projectsScope([projectA, projectB]));
        return {
          total_contexts: s.total_contexts,
          contexts_last_week: s.recent_activity.contexts_last_week,
          sessions_last_week: s.recent_activity.sessions_last_week,
        };
      },
      expected: {
        total_contexts: LIVE_CTX_IN_AB,
        contexts_last_week: LIVE_CTX_IN_AB,
        sessions_last_week: 2, // both fixture sessions, via DISTINCT session_id on contexts
      },
    },

    // ── COMPLIANT: archived rows excluded ──────────────────────────────────────────────
    // Asserted for the same reason as the OPEN ones: so compliance is PINNED. A path that
    // quietly stops applying the rule moves from 7 to 12 and goes RED here.
    {
      id: 'sessionCounts.contextCountSql',
      rule: 'COMPLIANT',
      run: async () => {
        const r = await pool.query(
          `SELECT ${contextCountSql('s')} AS rule1, ${contextCountSql('s', '$2')} AS rule2
             FROM sessions s WHERE s.id = $1`,
          [sessionInA, projectA]
        );
        return { rule1: Number(r.rows[0].rule1), rule2: Number(r.rows[0].rule2) };
      },
      expected: { rule1: CTX_RULE1, rule2: CTX_IN_A },
    },
    {
      id: 'sessionAnalytics.getSessionTrends',
      rule: 'COMPLIANT',
      run: async () => {
        // Summed over the series, not read off one day: the fixture's sessions started
        // minutes ago and a run that straddles UTC midnight would otherwise bucket them
        // on the previous day and fail for a reason that is not the archived rule.
        const unscoped = await SessionAnalyticsService.getSessionTrends(allProjects, 30, ACTOR, 'UTC');
        const inA = await SessionAnalyticsService.getSessionTrends(
          projectsScope([projectA]), 30, ACTOR, 'UTC'
        );
        const sum = (rows: Array<{ total_contexts: number }>) =>
          rows.reduce((n, r) => n + r.total_contexts, 0);
        return { unscoped_contexts: sum(unscoped), in_A_contexts: sum(inA) };
      },
      // The two branches of this one endpoint now agree about archived rows — which is the
      // change this branch made, and the reason it now disagrees with the OPEN paths above.
      expected: { unscoped_contexts: CTX_RULE1, in_A_contexts: CTX_IN_A },
    },
    {
      id: 'sessionAnalytics.getContextsByActor',
      rule: 'COMPLIANT',
      // The by-actor GROUP BY. It reaches `contexts` from the OTHER
      // direction — contexts LEFT JOIN sessions rather than a per-session subquery — so
      // it is a hand-written site the census correctly refuses to let through unclaimed.
      run: async () => {
        // Read the ACTOR's own row rather than a total: this DB is shared with other
        // suites, and only this fixture's session carries this actor slug.
        const unscoped = await SessionAnalyticsService.getContextsByActor(allProjects, 30, 'UTC');
        const inA = await SessionAnalyticsService.getContextsByActor(
          projectsScope([projectA]), 30, 'UTC'
        );
        const mine = (r: { actors: Array<{ actor: string; context_count: number }> }) =>
          r.actors.find((a) => a.actor === ACTOR)?.context_count ?? 0;
        return { unscoped_contexts: mine(unscoped), in_A_contexts: mine(inA) };
      },
      // Archived contexts are excluded on BOTH branches (it calls no builder, but it
      // states `archived_at IS NULL` itself), and the project branch filters on the
      // CONTEXT's own project — so it answers the same numbers as getSessionTrends.
      expected: { unscoped_contexts: CTX_RULE1, in_A_contexts: CTX_IN_A },
    },
    {
      id: 'sessionAnalytics.getSessionsList',
      rule: 'COMPLIANT',
      run: async () => {
        const { sessions } = await SessionAnalyticsService.getSessionsList({
          scope: allProjects, actor: ACTOR,
        });
        expect(sessions).toHaveLength(1);
        return {
          contexts_created: sessions[0].contexts_created,
          context_count: sessions[0].context_count,
        };
      },
      expected: { contexts_created: CTX_RULE1, context_count: CTX_RULE1 },
    },
    {
      id: 'sessionAnalytics.getProductiveSessions',
      rule: 'COMPLIANT',
      run: async () => {
        const rows = await SessionAnalyticsService.getProductiveSessions(allProjects, 1000);
        const mine = rows.find((r) => r.id === sessionInA);
        expect(mine).toBeDefined();
        return { context_count: mine!.context_count };
      },
      expected: { context_count: CTX_RULE1 },
    },
    {
      id: 'project.getAllSessions',
      rule: 'COMPLIANT',
      run: async () => {
        const rows = await ProjectService.getAllSessions({
          scope: projectsScope([projectA, projectB]), limit: 1000,
        });
        const mine = rows.find((r) => r.id === sessionInA);
        expect(mine).toBeDefined();
        return { context_count: num(mine!.context_count, 'context_count') };
      },
      // RULE 2 over {A,B} = every live context on the session; archived excluded.
      expected: { context_count: CTX_RULE1 },
    },
    {
      id: 'dailySeries.queryDailySeries',
      rule: 'COMPLIANT',
      run: async () => {
        const rows = await queryDailySeries(todayUtc, 'UTC', 30, projectsScope([projectA, projectB]));
        return { contexts: rows.reduce((n, r) => n + r.contexts, 0) };
      },
      expected: { contexts: LIVE_CTX_IN_AB },
    },
    {
      id: 'daySummary.getDaySummary',
      rule: 'COMPLIANT',
      run: async () => {
        const s = await DaySummaryService.getDaySummary(todayUtc, 'UTC', projectsScope([projectA, projectB]));
        const mine = s.byActor.find((a) => a.actor === ACTOR);
        expect(mine).toBeDefined();
        return { by_actor_count: mine!.count, kpi_contexts: s.kpis.contexts.value };
      },
      // byActor unions contexts + decisions + COMPLETED tasks, live only.
      //
      // MOVED BY MIGRATION 094, and moved in the right direction. This used
      // to read `CTX_RULE1 + DEC_RULE1` with the note "the fixture's completed tasks carry
      // no completed_at, so they are outside that CTE's window by construction" — which was
      // true, and meant the TASKS arm of the union was silently untested here. 094 stamps a
      // task inserted as `status='completed'`, so the fixture's 3 live completed tasks now
      // land on today and are counted, and the archived completed decoys are excluded by
      // the archived rule this case exists to check rather than by a missing timestamp.
      expected: {
        by_actor_count: CTX_RULE1 + DEC_RULE1 + TASKS_DONE_RULE1,
        kpi_contexts: LIVE_CTX_IN_AB,
      },
    },
  ];

  for (const p of READ_PATHS) {
    it(`archived rule [${p.rule}] — ${p.id}`, async () => {
      await expect(p.run()).resolves.toEqual(p.expected);
    });
  }

  // ──────────────────────────────────────────────────────────────────────────────────────
  // THE CENSUS — the fuse that makes the table above more than a list.
  //
  // POPULATION (state it, or the guard is scoped to whatever the author had in mind):
  //   every TEMPLATE LITERAL in mandrel-command/backend/src (excluding __tests__ and
  //   comments) that BOTH names the `contexts` table in a FROM/JOIN/UPDATE/INTO position —
  //   or interpolates the table name there — AND mentions `session_id`.
  // That is the choke point every HAND-WRITTEN session-scoped context query must pass
  // through, and it is a BYTES question about source text, which is why a text scan is the
  // right instrument for it (the STRUCTURAL question — "does this query apply the rule?" —
  // is never answered here; it is answered by executing the path above).
  //
  // WHAT IT CANNOT SEE — the two limits that are true BY CONSTRUCTION:
  //   * a reader outside mandrel-command/backend/src — the mcp-server package has its own
  //     twin suite, and the `v_session_summaries` view is COPY 1, asserted separately;
  //   * a path that interpolates the shared builder: those carry no literal `contexts`, so
  //     they are represented by the ONE builder site (sessionCounts.ts) instead. That is
  //     sound — the builder is where their rule lives — but it means a compliant path can
  //     be ADDED without appearing here.
  //
  // This block states what the scan MATCHES. It deliberately does NOT claim what evasion
  // cannot do. It used to: it asserted a non-compliant path "cannot" be added without
  // appearing, and that a quoted-literal reader was a blind spot with "none today". The
  // first was an unprovable universal and was falsified by two planted probes
  // (`FROM "contexts"`, `FROM public.contexts` — both passed GREEN); the second was a
  // snapshot that had already rotted, because the scan had been widened to read quoted
  // literals and this block was not updated. A limits block may say what is matched. A
  // modal claim about what an evader cannot do is not checkable, and an inventory of
  // "how things are today" rots the moment someone types.
  // ──────────────────────────────────────────────────────────────────────────────────────
  interface CensusEntry {
    /** A whitespace-normalized substring that identifies exactly ONE site in `file`. */
    key: string;
    /** Either the READ_PATHS ids that execute this site, or [] with a written reason. */
    pathIds: string[];
    /** Required when pathIds is empty: why this site is not in the archived contract. */
    outOfScope?: string;
  }

  const CENSUS: Record<string, CensusEntry[]> = {
    'services/sessionCounts.ts': [
      { key: 'FROM contexts c WHERE c.session_id =', pathIds: ['sessionCounts.contextCountSql',
        'sessionAnalytics.getSessionTrends', 'sessionAnalytics.getSessionsList',
        'sessionAnalytics.getProductiveSessions', 'project.getAllSessions'] },
    ],
    'services/sessionAnalytics.ts': [
      { key: 'WITH session_stats AS (', pathIds: ['sessionAnalytics.getSessionAnalytics'] },
      { key: 'LEFT JOIN sessions s ON s.id = c.session_id',
        pathIds: ['sessionAnalytics.getContextsByActor'] },
    ],
    'services/sessionDetail.ts': [
      { key: 'relevance_score FROM contexts', pathIds: ['sessionDetail.getSessionDetail'] },
      { key: ') as contexts_created,', pathIds: ['sessionDetail.getSessionSummaries'] },
    ],
    'services/project.ts': [
      { key: 'ORDER BY p.updated_at DESC', pathIds: ['project.getAllProjects'] },
      { key: 'LEFT JOIN contexts c ON p.id = c.project_id AND c.archived_at IS NULL WHERE p.id = $1',
        pathIds: ['project.getProjectById'] },
      { key: 'COALESCE(c.session_id, gen_random_uuid()) as id',
        pathIds: ['project.getProjectSessions'] },
      { key: 'as contexts_last_week', pathIds: ['project.getProjectStats'] },
      { key: 'as sessions_last_week', pathIds: ['project.getProjectStats'] },
    ],
    'services/dailySeries.ts': [
      { key: "COUNT(*) FILTER (WHERE c.context_type = 'milestone')",
        pathIds: ['dailySeries.queryDailySeries'] },
    ],
    'services/daySummary.ts': [
      { key: 'WITH recs AS (', pathIds: ['daySummary.getDaySummary'] },
    ],
    'services/context.ts': [
      { key: 'COUNT(*) OVER() as total_count', pathIds: [],
        outOfScope: 'searchContexts — the context BROWSE query, not a per-session count. It ' +
          'already excludes archived rows by default and is guarded by ' +
          'browseArchivedExcluded.db.test.ts.' },
      { key: 'FROM contexts c LEFT JOIN projects p ON c.project_id = p.id WHERE c.id = $1',
        pathIds: [], outOfScope: 'getContextById — one row by primary key. No count, no ' +
          'session correlation; session_id is only in the projection.' },
      { key: 'UPDATE contexts', pathIds: [],
        outOfScope: 'updateContext — a WRITE. session_id is only in the RETURNING list.' },
      { key: 'JOIN contexts c2 ON c1.id != c2.id', pathIds: [],
        outOfScope: 'getRelatedContexts — vector-similarity neighbours of one context. No ' +
          'count and no session correlation; session_id is only in the projection.' },
    ],
  };

  it('CENSUS: every hand-written session-scoped contexts query is claimed by this contract', () => {
    /* eslint-disable @typescript-eslint/no-var-requires */
    const fs = require('fs') as typeof import('fs');
    const path = require('path') as typeof import('path');
    /* eslint-enable @typescript-eslint/no-var-requires */
    const SRC = path.resolve(__dirname, '..');

    const walk = (dir: string, out: string[] = []): string[] => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (e.name === '__tests__' || e.name === 'node_modules') continue;
          walk(p, out);
        } else if (e.name.endsWith('.ts')) out.push(p);
      }
      return out;
    };

    // Blank out comments (keeping offsets) so a SQL fragment quoted in prose is not counted
    // as a read path — one of the earlier prose lists was built from a comment.
    const stripComments = (s: string): string =>
      s
        .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
        .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1: string) => p1 + ' '.repeat(m.length - p1.length));

    const norm = (s: string): string => s.replace(/\s+/g, ' ').trim();

    // `re.exec(s) !== null`, never `re.test(s)`: dbTestGateCoverage.test.ts forbids any
    // REFERENCE to the identifier `test` outside a gate call, because a reference can be
    // aliased or branched on and that is how a suite goes dark. A regex method that happens
    // to share the name is indistinguishable to that scanner — and it is right to be strict.
    const has = (re: RegExp, s: string): boolean => re.exec(s) !== null;

    const discovered: Array<{ file: string; text: string }> = [];
    for (const file of walk(SRC)) {
      const src = stripComments(fs.readFileSync(file, 'utf8'));
      // Template literals AND ordinary quoted strings. The `'…'` shape was a MEASURED hole:
      // the first version of this scan read template literals only, and a probe that rewrote
      // a new non-compliant reader as a single-quoted one-liner passed GREEN. Closing it is
      // four characters of regex, which beats writing the hole down as a known limitation.
      const literals = [
        ...(src.match(/`[^`]*`/g) ?? []),
        ...(src.match(/'(?:[^'\\\n]|\\.)*'/g) ?? []),
        ...(src.match(/"(?:[^"\\\n]|\\.)*"/g) ?? []),
      ];
      for (const lit of literals) {
        if (!has(/\bsession_id\b/, lit)) continue;
        // `(?!\s*\.)` excludes a DOTTED reference — `contexts.session_id`. Widening the scan
        // to ordinary quoted strings made English prose reachable, and an OpenAPI schema
        // description reading "Derived from contexts.session_id" was flagged as a read path.
        // A guard that flags correct work gets deleted the first time it is inconvenient.
        // `(?:public\.)?"?contexts"?` — both spellings Reviewer planted and this scan
        // missed: `FROM "contexts"` (quoted identifier) and `FROM public.contexts`
        // (schema-qualified). Both hand-write the table, both bypass the builder, both
        // counted archived rows, and both passed GREEN before this line changed.
        const namesTable = has(
          /\b(FROM|JOIN|UPDATE|INTO)\s+(?:public\.)?"?contexts"?\b(?!\s*\.)/i,
          lit,
        );
        const interpolatesTable = has(/\b(FROM|JOIN|UPDATE|INTO)\s+\$\{/, lit);
        if (namesTable || interpolatesTable) {
          discovered.push({ file: path.relative(SRC, file), text: norm(lit) });
        }
      }
    }

    // The scan must find something, or an extraction change turns this guard into a
    // vacuous pass (the empty population — C3).
    expect(discovered.length).toBeGreaterThan(0);

    const registered = Object.values(CENSUS).reduce((n, e) => n + e.length, 0);
    const claimed = new Set<number>();
    const problems: string[] = [];

    for (const [file, entries] of Object.entries(CENSUS)) {
      for (const entry of entries) {
        const hits = discovered
          .map((d, i) => ({ d, i }))
          .filter(({ d }) => d.file === file && d.text.includes(norm(entry.key)));
        if (hits.length !== 1) {
          problems.push(
            `registry key ${file} :: "${entry.key}" matched ${hits.length} sites (want exactly 1)`
          );
          continue;
        }
        claimed.add(hits[0].i);
      }
    }

    const unclaimed = discovered.filter((_, i) => !claimed.has(i));
    for (const u of unclaimed) {
      problems.push(
        `UNCLAIMED session-scoped contexts query in ${u.file}: ${u.text.slice(0, 160)}… — ` +
          'add a CENSUS entry that either names a READ_PATHS id (and assert the number it ' +
          'returns for an archived context) or carries a written outOfScope reason.'
      );
    }

    expect(problems).toEqual([]);
    // Bijection: as many sites as registry entries, each matched once. A duplicate entry
    // for one site would otherwise let a second site hide inside the total.
    expect(discovered.length).toBe(registered);
  });

  it('CENSUS: every registry entry is either EXECUTED above or given a written reason', () => {
    const executed = new Set(READ_PATHS.map((p) => p.id));
    const referenced = new Set<string>();
    const problems: string[] = [];

    for (const [file, entries] of Object.entries(CENSUS)) {
      for (const entry of entries) {
        if (entry.pathIds.length === 0) {
          if (!entry.outOfScope || entry.outOfScope.trim().length < 20) {
            problems.push(`${file} :: "${entry.key}" claims no read path and gives no reason`);
          }
          continue;
        }
        for (const id of entry.pathIds) {
          referenced.add(id);
          if (!executed.has(id)) {
            problems.push(`${file} :: "${entry.key}" names read path "${id}", which READ_PATHS does not execute`);
          }
        }
      }
    }

    // …and the other direction: a READ_PATH that no census site points at is a path this
    // contract believes in but the source no longer contains.
    for (const id of executed) {
      if (!referenced.has(id)) problems.push(`READ_PATHS "${id}" is claimed by no CENSUS site`);
    }

    expect(problems).toEqual([]);
    expect(executed.size).toBe(READ_PATHS.length); // no duplicate ids
  });
});
