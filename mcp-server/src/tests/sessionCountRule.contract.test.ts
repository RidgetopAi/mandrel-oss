/**
 * SESSION COUNT RULE — THE mcp-server HALF (Reviewer F1).
 *
 * Companion to mandrel-command/backend/src/__tests__/sessionCountRule.contract.test.ts.
 * Read that file's header for the full rationale; the short version:
 *
 *   "How many contexts / tasks / decisions does this session have" exists in THREE copies
 *   that cannot be collapsed into one accessor (a Postgres view cannot import TypeScript,
 *   and mcp-server does not import backend code):
 *     COPY 1  migration 070 → the `v_session_summaries` VIEW
 *     COPY 2  SessionRepo.IDENTITY_SELECT and SessionRepo.getFinalCounts   ← THIS FILE
 *     COPY 3  mandrel-command backend services/sessionCounts.ts            ← the other file
 *
 *   Both halves use the SAME literal expected numbers and both pin COPY 1 (the view), so
 *   the view is the shared link and "all three agree" is measured end to end.
 *
 * ── WHY THE FIXTURE IS CROSS-PROJECT ────────────────────────────────────────────────────
 * The failure being guarded is `AND c.project_id = s.project_id` — a correlation to the
 * SESSION's project (neither RULE 1 nor RULE 2), which drops 24% of session-linked
 * contexts on prod. With a SINGLE-project fixture that predicate is trivially true and a
 * drifted copy passes GREEN — which is precisely why the existing
 * sessionCountersSurviveFinalize.contract.test.ts (one project, one actor per test) is not
 * a guard for this rule. The session below lives in project A and owns child rows in both
 * A and B, and the first test asserts that spread so the fixture cannot be quietly
 * de-fanged (mutation-probe the probe).
 *
 * ── ALSO GUARDED HERE ───────────────────────────────────────────────────────────────────
 * `endSession` consumes the in-memory delta before it can persist it (get-and-delete).
 * F6 / F6b prove the RESCUE: if the persisting write fails, the delta is handed BACK to
 * the store and survives to the next flush instead of dying in a local variable. Tokens
 * are the reason that matters — they have no child table, so a dropped token delta is
 * unrecoverable.
 *
 * F8 (the last test) guards this file's own FIXTURE: every session timestamp it writes must
 * come from ONE clock — the process's, the way production does it — never from SQL `NOW()`.
 * See the block comment above `newVictim`; a `NOW()` fixture made F6c/F7d pass here and fail
 * on the gate box purely on clock skew.
 *
 * DB target: the disposable migrated Postgres that the CI gate provisions (Stage 0b) and
 * runs the vitest suite against (Stage 1). NEVER the production `mandrel` DB.
 */

import { describe, test, expect, beforeAll, afterAll, vi } from 'vitest';

// Real UUIDs (the global vitest.setup.ts mocks randomUUID with a counter).
vi.unmock('crypto');
vi.unmock('node:crypto');

import { db } from '../config/database.js';
import { SessionRepo } from '../services/session/infra/db/SessionRepo.js';
import { SessionTracker } from '../services/session/SessionTracker.js';
import { OperationTracker } from '../services/session/domain/tracking/OperationTracker.js';
import { TokenTracker } from '../services/session/domain/tracking/TokenTracker.js';
import { SessionLifecycleService } from '../services/session/domain/lifecycle/SessionLifecycleService.js';

const STAMP = Date.now();

// ── EXPECTED VALUES ────────────────────────────────────────────────────────────────────
// Identical to the backend half on purpose: the two files are one guard. Distinct from one
// another so a transposed field cannot coincidentally satisfy an assertion, and chosen so
// the RIGHT answer differs from the WRONG (project-guarded) answer for every count.
const CTX_IN_A = 4;
const CTX_IN_B = 3;
const CTX_RULE1 = CTX_IN_A + CTX_IN_B; // 7
const TASKS_IN_A = 3;
const TASKS_IN_B = 2;
const TASKS_RULE1 = TASKS_IN_A + TASKS_IN_B; // 5
const TASKS_DONE_IN_A = 2;
const TASKS_DONE_IN_B = 1;
const TASKS_DONE_RULE1 = TASKS_DONE_IN_A + TASKS_DONE_IN_B; // 3
const DEC_IN_A = 2;
const DEC_IN_B = 1;
const DEC_RULE1 = DEC_IN_A + DEC_IN_B; // 3

// ── ARCHIVED DECOYS ───────────────────────────────────────────────────
// Soft-deleted child rows on the SAME session. They are EXCLUDED from every count, so the
// RULE1 expectations above are unchanged — which is exactly the point: any copy that forgets
// `AND <alias>.archived_at IS NULL` counts these instead and the existing assertions go RED,
// naming the copy.
//
// THIS FIXTURE PREVIOUSLY ARCHIVED NOTHING, so the three-copy guard was blind to the whole
// archived axis: all three copies counted archived rows, agreed with each other, and passed.
// Measured on live prod 2026-07-30 that meant 18 archived contexts / 429 decisions / 23 tasks
// inflating session_status, session_get and session_list. A guard that only compares copies
// to EACH OTHER cannot see a rule they are all wrong about the same way — it needs a value
// the rule says to exclude.
//
// Deliberately DIFFERENT per table so a copy that filters the wrong child table is visible
// rather than accidentally arithmetically correct.
const ARCH_CTX = 5;
const ARCH_TASKS = 4;
const ARCH_TASKS_DONE = 2; // of ARCH_TASKS — pins tasks_completed's predicate independently
const ARCH_DEC = 6;

let projectA: string;
let projectB: string;
let sessionId: string;

// ── THE FIXTURE CLOCK: ONE clock, the same one production uses ─────────────────────────
// EVERY session timestamp a fixture in this file hands the database comes from THIS
// process's clock, bound as a parameter. NEVER from SQL `NOW()` / `CURRENT_TIMESTAMP`.
//
// WHY (this fail-closed-aborted a prod deploy on 2026-07-26). `sessions` carries
//     CONSTRAINT reasonable_session_duration CHECK (ended_at IS NULL OR ended_at >= started_at)
// and the two sides of that comparison are written by DIFFERENT code:
//     started_at  ← the fixture below
//     ended_at    ← SessionLifecycleService.endSession, from `new Date()` — the NODE clock
// PRODUCTION never mixes clocks: SessionRepo.create/createForActorLocked bind
// `params.startTime` (a JS Date from `new Date()`) and endSession stamps `new Date()`, so
// both ends of the constraint come from the app. A fixture that seeds `started_at` with SQL
// `NOW()` borrows the POSTGRES clock instead — and because a victim here is created and
// ended within MILLISECONDS, the constraint is then decided by whether two machines' clocks
// agree to within that window. Measured on this file: a node-vs-Postgres offset of just
// 2 ms is enough to make F6c and F7d fail. That is exactly what happened — GREEN on the dev
// box, RED on the clean gate box, on tests the branch that broke had never touched.
// (Second, quieter symptom of the same mix — and the one that does NOT announce itself:
// `durationMs` in endSession is `endTime(node) - started_at(read back from the DB)`
// (SessionLifecycleService.ts:427). When the node clock runs BEHIND, that is negative and
// the constraint rejects the write, so you find out. When it runs AHEAD, the constraint is
// satisfied and an inflated `duration_ms` persists into the session metadata with nothing
// failing at all — measured at 3,599,991 ms for a session that should have been 30 minutes.)
//
// The BACKDATE is the second half of the fix, not decoration. Real sessions live minutes to
// hours; a fixture whose entire lifetime is one millisecond has no margin for any clock
// disagreement at all. Starting it in the past makes the fixture both faithful to production
// and robust from either direction.
//
// The guard for all of the above is F8, the last test in this file: it drives
// newVictim -> endSession with this process's clock deliberately skewed off Postgres.
const FIXTURE_SESSION_AGE_MS = 30 * 60_000;
const appClockStartedAt = () => new Date(Date.now() - FIXTURE_SESSION_AGE_MS);

/**
 * The ONE way this file creates a session row. Every test that ends a session goes through
 * here, so the clock rule above has a single place to live rather than N insert sites that
 * agree today.
 */
const newVictim = async (label: string) =>
  (
    await db.query(
      `INSERT INTO sessions (project_id, agent_type, actor, status, started_at)
         VALUES ($1, 'mcp-server', $2, 'active', $3) RETURNING id`,
      [projectA, `count-rule-${label}-${STAMP}`, appClockStartedAt()]
    )
  ).rows[0].id;

describe('session count rule: mcp-server copies', () => {
  beforeAll(async () => {
    projectA = (
      await db.query(
        `INSERT INTO projects (name, description) VALUES ($1, 'count rule: session home') RETURNING id`,
        [`count-rule-mcp-A-${STAMP}`]
      )
    ).rows[0].id;
    projectB = (
      await db.query(
        `INSERT INTO projects (name, description) VALUES ($1, 'count rule: mid-switch target') RETURNING id`,
        [`count-rule-mcp-B-${STAMP}`]
      )
    ).rows[0].id;

    sessionId = (
      await db.query(
        `INSERT INTO sessions (project_id, agent_type, actor, status, started_at, ended_at)
           VALUES ($1, 'mcp-server', $2, 'ended', $3, $4)
         RETURNING id`,
        [projectA, `count-rule-mcp-${STAMP}`, appClockStartedAt(), new Date()]
      )
    ).rows[0].id;

    for (let i = 0; i < CTX_IN_A; i++) {
      await db.query(
        `INSERT INTO contexts (project_id, session_id, context_type, content)
           VALUES ($1, $2, 'completion', 'count-rule ctx in A')`,
        [projectA, sessionId]
      );
    }
    for (let i = 0; i < CTX_IN_B; i++) {
      await db.query(
        `INSERT INTO contexts (project_id, session_id, context_type, content)
           VALUES ($1, $2, 'completion', 'count-rule ctx in B (mid-switch)')`,
        [projectB, sessionId]
      );
    }

    const insTask = (project: string, done: boolean) =>
      db.query(
        `INSERT INTO tasks (project_id, session_id, title, type, status, priority, tags)
           VALUES ($1, $2, $3, 'general', $4, 'medium', '{}')`,
        [project, sessionId, `count-rule task ${done ? 'done' : 'todo'}`, done ? 'completed' : 'todo']
      );
    for (let i = 0; i < TASKS_IN_A; i++) await insTask(projectA, i < TASKS_DONE_IN_A);
    for (let i = 0; i < TASKS_IN_B; i++) await insTask(projectB, i < TASKS_DONE_IN_B);

    const insDecision = (project: string) =>
      db.query(
        `INSERT INTO technical_decisions
           (project_id, session_id, decision_type, title, description, rationale, decision_date)
         VALUES ($1, $2, 'architecture', 'count-rule decision', 'd', 'r', NOW())`,
        [project, sessionId]
      );
    for (let i = 0; i < DEC_IN_A; i++) await insDecision(projectA);
    for (let i = 0; i < DEC_IN_B; i++) await insDecision(projectB);

    // ARCHIVED DECOYS — see the constants block. Same session, archived_at
    // set, therefore invisible to every count. Split across both projects so an archived row
    // cannot be excluded by the project rule instead of the archived rule.
    for (let i = 0; i < ARCH_CTX; i++) {
      await db.query(
        `INSERT INTO contexts (project_id, session_id, context_type, content, archived_at)
           VALUES ($1, $2, 'completion', 'count-rule ARCHIVED ctx', now())`,
        [i % 2 === 0 ? projectA : projectB, sessionId]
      );
    }
    for (let i = 0; i < ARCH_TASKS; i++) {
      await db.query(
        `INSERT INTO tasks (project_id, session_id, title, type, status, priority, tags, archived_at)
           VALUES ($1, $2, 'count-rule ARCHIVED task', 'general', $3, 'medium', '{}', now())`,
        [i % 2 === 0 ? projectA : projectB, sessionId, i < ARCH_TASKS_DONE ? 'completed' : 'todo']
      );
    }
    for (let i = 0; i < ARCH_DEC; i++) {
      await db.query(
        `INSERT INTO technical_decisions
           (project_id, session_id, decision_type, title, description, rationale, decision_date, archived_at)
         VALUES ($1, $2, 'architecture', 'count-rule ARCHIVED decision', 'd', 'r', NOW(), now())`,
        [i % 2 === 0 ? projectA : projectB, sessionId]
      );
    }
  });

  afterAll(async () => {
    try {
      await db.query('DELETE FROM contexts WHERE session_id = $1', [sessionId]);
      await db.query('DELETE FROM tasks WHERE session_id = $1', [sessionId]);
      await db.query('DELETE FROM technical_decisions WHERE session_id = $1', [sessionId]);
      await db.query('DELETE FROM sessions WHERE project_id = ANY($1)', [[projectA, projectB]]);
      await db.query('DELETE FROM projects WHERE id = ANY($1)', [[projectA, projectB]]);
    } catch {
      /* ignore */
    }
    await db.end();
  });

  // ────────────────────────────────────────────────────────────────────────────────────
  // PRECONDITION — the fixture must span two projects, or every assertion below stops
  // discriminating and a project-guarded copy sails through green.
  // ────────────────────────────────────────────────────────────────────────────────────
  test('PRECONDITION: the session carries child rows OUTSIDE its own project', async () => {
    const r = await db.query(
      // LIVE rows only: the fixture now also seeds ARCHIVED decoys on this session
      //, which every copy of the rule excludes. Counting them here would
      // make this precondition disagree with the very copies it exists to arm.
      `SELECT COUNT(*)::int                                             AS total,
              COUNT(*) FILTER (WHERE c.project_id <> s.project_id)::int AS cross_project
         FROM contexts c JOIN sessions s ON s.id = c.session_id
        WHERE c.session_id = $1 AND c.archived_at IS NULL`,
      [sessionId]
    );
    expect(r.rows[0].total).toBe(CTX_RULE1);
    expect(r.rows[0].cross_project).toBe(CTX_IN_B);
    expect(r.rows[0].cross_project).toBeGreaterThan(0);
  });

  // ────────────────────────────────────────────────────────────────────────────────────
  // PRECONDITION — the ARCHIVED decoys must actually exist. Without this,
  // an insert that silently failed would leave every archived assertion below vacuous: the
  // copies would agree on the un-decoyed numbers and the suite would pass while guarding
  // nothing. This is the same empty-population trap the archived axis was hiding in.
  // ────────────────────────────────────────────────────────────────────────────────────
  test('PRECONDITION: the session carries ARCHIVED child rows on all three tables', async () => {
    const r = await db.query(
      `SELECT (SELECT COUNT(*)::int FROM contexts            WHERE session_id = $1 AND archived_at IS NOT NULL) AS ctx,
              (SELECT COUNT(*)::int FROM tasks               WHERE session_id = $1 AND archived_at IS NOT NULL) AS tasks,
              (SELECT COUNT(*)::int FROM tasks               WHERE session_id = $1 AND archived_at IS NOT NULL
                                                               AND status = 'completed')                        AS tasks_done,
              (SELECT COUNT(*)::int FROM technical_decisions WHERE session_id = $1 AND archived_at IS NOT NULL) AS dec`,
      [sessionId]
    );
    expect(r.rows[0].ctx).toBe(ARCH_CTX);
    expect(r.rows[0].tasks).toBe(ARCH_TASKS);
    expect(r.rows[0].tasks_done).toBe(ARCH_TASKS_DONE);
    expect(r.rows[0].dec).toBe(ARCH_DEC);
    // Every decoy count must be non-zero, or the assertions it arms prove nothing.
    for (const v of Object.values(r.rows[0])) expect(Number(v)).toBeGreaterThan(0);
  });

  // ────────────────────────────────────────────────────────────────────────────────────
  // COPY 2a — SessionRepo.IDENTITY_SELECT (session_get / session_status / session_list).
  // The product's own SQL constant, executed by Postgres.
  // ────────────────────────────────────────────────────────────────────────────────────
  test('COPY 2 (IDENTITY_SELECT) applies RULE 1: session linkage only', async () => {
    const row = await SessionRepo.getIdentityRow(sessionId);
    expect(row).not.toBeNull();
    expect(Number(row!.context_count)).toBe(CTX_RULE1);
    expect(Number(row!.task_count)).toBe(TASKS_RULE1);
    expect(Number(row!.decision_count)).toBe(DEC_RULE1);

    // The LIST surface shares the same constant — assert it too, so a future divergence
    // between get and list cannot hide behind one of them being tested.
    const listed = await SessionRepo.listIdentityRows({
      projectId: projectA,
      limit: 50,
      offset: 0,
    });
    const mine = listed.rows.find((r) => r.id === sessionId);
    expect(mine).toBeDefined();
    expect(Number(mine!.context_count)).toBe(CTX_RULE1);
    expect(Number(mine!.task_count)).toBe(TASKS_RULE1);
    expect(Number(mine!.decision_count)).toBe(DEC_RULE1);
  });

  // ────────────────────────────────────────────────────────────────────────────────────
  // COPY 2b — SessionRepo.getFinalCounts, the numbers endSession writes into the session
  // summary text, the productivity score and the session_end analytics event.
  // ────────────────────────────────────────────────────────────────────────────────────
  test('COPY 2 (getFinalCounts) applies RULE 1 and agrees with IDENTITY_SELECT', async () => {
    const counts = await SessionRepo.getFinalCounts(sessionId);
    expect(counts.contexts_created).toBe(CTX_RULE1);
    expect(counts.tasks_created).toBe(TASKS_RULE1);
    expect(counts.tasks_completed).toBe(TASKS_DONE_RULE1);
    expect(counts.decisions_created).toBe(DEC_RULE1);

    const identity = await SessionRepo.getIdentityRow(sessionId);
    expect(counts.contexts_created).toBe(Number(identity!.context_count));
    expect(counts.tasks_created).toBe(Number(identity!.task_count));
    expect(counts.decisions_created).toBe(Number(identity!.decision_count));
  });

  // ────────────────────────────────────────────────────────────────────────────────────
  // COPY 1 — migration 070's view, pinned to COPY 2. The backend half pins the same view
  // to COPY 3, so the three copies are transitively locked to one set of numbers.
  // ────────────────────────────────────────────────────────────────────────────────────
  test('COPY 1 (v_session_summaries) reports the same RULE 1 numbers as COPY 2', async () => {
    const view = await db.query(
      `SELECT contexts_created::int  AS contexts,
              tasks_created::int     AS tasks,
              tasks_completed::int   AS tasks_done,
              decisions_created::int AS decisions,
              task_completion_rate   AS rate
         FROM v_session_summaries WHERE id = $1`,
      [sessionId]
    );
    expect(view.rows).toHaveLength(1);
    const v = view.rows[0];

    expect(v.contexts).toBe(CTX_RULE1);
    expect(v.tasks).toBe(TASKS_RULE1);
    expect(v.tasks_done).toBe(TASKS_DONE_RULE1);
    expect(v.decisions).toBe(DEC_RULE1);
    expect(Number(v.rate)).toBe(60); // 3 of 5

    const counts = await SessionRepo.getFinalCounts(sessionId);
    expect(v.contexts).toBe(counts.contexts_created);
    expect(v.tasks).toBe(counts.tasks_created);
    expect(v.tasks_done).toBe(counts.tasks_completed);
    expect(v.decisions).toBe(counts.decisions_created);
  });

  // ────────────────────────────────────────────────────────────────────────────────────
  // getFinalCounts MUST NOT FAIL SAFE TO ZEROS (Reviewer F5).
  // It used to swallow a DB error and return the all-zero object, which endSession then
  // wrote into `context_summary` ("0 tasks and 0 contexts") and the productivity score —
  // the same confident-zero lie this task exists to delete, one layer up.
  // ────────────────────────────────────────────────────────────────────────────────────
  test('F5: getFinalCounts THROWS on a read failure instead of returning zeros', async () => {
    const spy = vi.spyOn(db, 'query').mockRejectedValueOnce(new Error('simulated DB failure'));
    try {
      await expect(SessionRepo.getFinalCounts(sessionId)).rejects.toThrow('simulated DB failure');
    } finally {
      spy.mockRestore();
    }
    // Still honest afterwards.
    const counts = await SessionRepo.getFinalCounts(sessionId);
    expect(counts.contexts_created).toBe(CTX_RULE1);
  });

  test('F5: getFinalCounts THROWS for a session that does not exist', async () => {
    await expect(
      SessionRepo.getFinalCounts('00000000-0000-4000-8000-000000000000')
    ).rejects.toThrow(/not found/);
  });

  // ────────────────────────────────────────────────────────────────────────────────────
  // A CONSUMED DELTA IS NEVER DROPPED (Reviewer F6).
  // `endSession` consumes the in-memory delta with a get-and-DELETE, so between that call
  // and the write that persists it, the delta lives ONLY in a local variable. If the write
  // fails it must be handed BACK, not lost — contexts/tasks would be re-derived from the
  // child tables, but TOKENS HAVE NO CHILD TABLE and would be gone for good.
  //
  // The observable is a SIDE EFFECT, not a return value: after the failed end we run the
  // real flush and check the COLUMN. A peek at the in-memory store could be right by luck;
  // this proves the delta actually survived all the way to disk.
  // ────────────────────────────────────────────────────────────────────────────────────
  test('F6: a delta consumed by endSession survives a failed persist and flushes later', async () => {
    // Same actor label as before (`count-rule-rescue-<STAMP>`), now through the one fixture
    // helper. This victim's end is mocked to fail BEFORE `finish`, so it never wrote an
    // `ended_at` and never tripped the constraint — it was the same latent defect as F6c/F7d,
    // hidden only by where the mock throws.
    const victim = await newVictim('rescue');

    // An un-flushed delta, recorded through the real trackers.
    const TOK_IN = 613;
    const TOK_OUT = 409;
    TokenTracker.record(victim, TOK_IN, TOK_OUT);
    OperationTracker.recordTaskCreated(victim);
    OperationTracker.recordContextCreated(victim);
    OperationTracker.recordContextCreated(victim);

    // Break the write that persists it. endSession must fail LOUDLY…
    // (`applyCounterDelta` is the single statement endSession pushes the whole delta
    // through — see the B1 note in SessionRepo. It was two calls, `applyActivityCounts`
    // then `addTokens`; F6b below is the test that proves it is now one.)
    const spy = vi
      .spyOn(SessionRepo, 'applyCounterDelta')
      .mockRejectedValueOnce(new Error('simulated persist failure'));
    await expect(SessionLifecycleService.endSession(victim)).rejects.toThrow(
      'simulated persist failure'
    );
    spy.mockRestore();

    // …and the columns must still be untouched (the write never landed).
    const mid = await db.query(
      `SELECT COALESCE(total_tokens,0)::int AS total_tokens,
              COALESCE(contexts_created,0)::int AS contexts_created
         FROM sessions WHERE id = $1`,
      [victim]
    );
    expect(mid.rows[0].total_tokens).toBe(0);
    expect(mid.rows[0].contexts_created).toBe(0);

    // THE RESCUE: the delta is back in the stores, so the ordinary flush persists it.
    await SessionTracker.flushActivityToDatabase();
    await SessionTracker.flushTokensToDatabase();

    const after = await db.query(
      `SELECT COALESCE(total_tokens,0)::int     AS total_tokens,
              COALESCE(input_tokens,0)::int     AS input_tokens,
              COALESCE(output_tokens,0)::int    AS output_tokens,
              COALESCE(contexts_created,0)::int AS contexts_created,
              COALESCE(tasks_created,0)::int    AS tasks_created
         FROM sessions WHERE id = $1`,
      [victim]
    );
    // Exact values, never `> 0`: a partial rescue is the failure mode worth catching.
    expect(after.rows[0].total_tokens).toBe(TOK_IN + TOK_OUT);
    expect(after.rows[0].input_tokens).toBe(TOK_IN);
    expect(after.rows[0].output_tokens).toBe(TOK_OUT);
    expect(after.rows[0].contexts_created).toBe(2);
    expect(after.rows[0].tasks_created).toBe(1);

    await db.query('DELETE FROM sessions WHERE id = $1', [victim]);
  });

  // ────────────────────────────────────────────────────────────────────────────────────
  // F6b / F6c — A CONSUMED DELTA IS NEVER DOUBLE-COUNTED EITHER (Reviewer B1).
  //
  // F6 above proves the delta is not DROPPED. These two prove its mirror image: it is not
  // applied TWICE. `endSession` restores the WHOLE delta when the persist fails, so that
  // restore is only honest if NOTHING can have landed. The shape that broke it was two
  // sequential writes (activity, then tokens) inside one try with a restore-both catch:
  // when the second failed the first had already COMMITTED, and the next flush added it
  // again — a delta of 2 contexts / 1 task created / 1 task updated / 150 tokens came back
  // as 4 / 2 / 2 / 150. `tasks_updated` has no child table, so nothing re-derives it: the
  // over-count is what `getFinalCounts` returns, what the productivity score is computed
  // from, and what the session surfaces show.
  //
  // TWO tests, not one, and deliberately so: each is a separate verdict, so neither can be
  // left unexercised by the other one failing first (this file's own first draft had them
  // in one test, and the mutation probe never reached the second half).
  //   F6b  BEHAVIOUR — force the counter write to fail the way production fails it (a
  //        transient error from the pool, not a stubbed repo method) and assert the EXACT
  //        numbers on disk after the recovery flush. Not `> 0`: doubling is the failure
  //        mode, and `> 0` is green while doubled.
  //   F6c  MECHANISM — during an ORDINARY end, count the statements that write a counter
  //        column. Exactly ONE. "Restore both" is unconditionally correct only because
  //        there is one atomic write; two writes re-open the class however the catch is
  //        written. Fails closed: 0 (regex matched nothing) is RED too, not a silent pass.
  // ────────────────────────────────────────────────────────────────────────────────────

  // Any UPDATE that changes a counter column must NAME that column — the column name is
  // the choke-point token every such write passes through, not a spelling this test
  // guessed at. Anchoring on UPDATE excludes the readers, so `getFinalCounts` (which
  // names every one of these columns) is not miscounted as a write.
  const COUNTER_WRITE =
    /UPDATE\s+sessions[\s\S]*?\b(tasks_created|tasks_updated|tasks_completed|contexts_created|total_tokens|input_tokens|output_tokens|tokens_used)\s*=/i;

  // Reviewer's measured delta, both halves non-zero — the ORDINARY case, not an exotic
  // one: `recordTokenUsage` fires on every tool call, so a session that ends after any
  // work has activity AND tokens pending at once.
  const CTX = 2;
  const TASK_NEW = 1;
  const TASK_UPD = 1;
  const TOK_IN = 100;
  const TOK_OUT = 50;

  const seedDelta = (id: string) => {
    TokenTracker.record(id, TOK_IN, TOK_OUT);
    OperationTracker.recordTaskCreated(id);
    OperationTracker.recordTaskUpdated(id);
    OperationTracker.recordContextCreated(id);
    OperationTracker.recordContextCreated(id);
  };
  const readCounters = async (id: string) => {
    const r = await db.query(
      `SELECT COALESCE(contexts_created,0)::int AS c,
              COALESCE(tasks_created,0)::int    AS t,
              COALESCE(tasks_updated,0)::int    AS tu,
              COALESCE(total_tokens,0)::int     AS tok,
              COALESCE(input_tokens,0)::int     AS ti,
              COALESCE(output_tokens,0)::int    AS to_
         FROM sessions WHERE id = $1`,
      [id]
    );
    return r.rows[0];
  };
  // `newVictim` lives at module scope, next to the fixture-clock rule it implements.

  test('F6b: a failed end restores the consumed delta EXACTLY ONCE — the recovery flush lands the delta, not double it', async () => {
    const realQuery = db.query.bind(db);
    const victim = await newVictim('b1-restore');
    seedDelta(victim);

    // Fail the counter write itself, at the pool — the way a transient error actually
    // arrives. (F6 stubs the repo method; this one does not, so it also covers the case
    // where the repo swallows instead of propagating.)
    const failSpy = vi.spyOn(db, 'query').mockImplementation(((sql: any, params: any) => {
      if (typeof sql === 'string' && COUNTER_WRITE.test(sql)) {
        return Promise.reject(new Error('simulated transient persist failure'));
      }
      return realQuery(sql, params);
    }) as any);
    await expect(SessionLifecycleService.endSession(victim)).rejects.toThrow(
      'simulated transient persist failure'
    );
    failSpy.mockRestore();

    // NO HALF of the delta is on disk. This is the assertion the old two-write shape
    // failed: the activity half had already committed here (2 / 1 / 1), which is what
    // made the restore below a double-count.
    expect(await readCounters(victim)).toMatchObject({ c: 0, t: 0, tu: 0, tok: 0 });

    // The ordinary flush persists the restored delta — exactly the delta.
    await SessionTracker.flushActivityToDatabase();
    await SessionTracker.flushTokensToDatabase();
    expect(await readCounters(victim)).toMatchObject({
      c: CTX,
      t: TASK_NEW,
      tu: TASK_UPD,
      tok: TOK_IN + TOK_OUT,
      ti: TOK_IN,
      to_: TOK_OUT
    });

    await db.query('DELETE FROM sessions WHERE id = $1', [victim]);
  });

  test('F6c: an ordinary end writes the counter columns with ONE statement (both halves in it)', async () => {
    const realQuery = db.query.bind(db);
    const clean = await newVictim('b1-atomic');
    seedDelta(clean);

    const counterWrites: string[] = [];
    const countSpy = vi.spyOn(db, 'query').mockImplementation(((sql: any, params: any) => {
      if (typeof sql === 'string' && COUNTER_WRITE.test(sql)) counterWrites.push(sql);
      return realQuery(sql, params);
    }) as any);
    await SessionLifecycleService.endSession(clean);
    countSpy.mockRestore();

    // ONE statement, carrying BOTH halves. Two statements = the half-landed window is
    // back and "restore both" is wrong again. One statement carrying only one half = the
    // other half is being written somewhere this count cannot see.
    expect(counterWrites).toHaveLength(1);
    expect(counterWrites[0]).toMatch(/tasks_updated/);
    expect(counterWrites[0]).toMatch(/total_tokens/);

    // …and it wrote the delta, not a multiple of it.
    expect(await readCounters(clean)).toMatchObject({
      c: CTX,
      t: TASK_NEW,
      tu: TASK_UPD,
      tok: TOK_IN + TOK_OUT
    });

    await db.query('DELETE FROM sessions WHERE id = $1', [clean]);
  });

  // ────────────────────────────────────────────────────────────────────────────────────
  // F7 — THE "IS THERE ANYTHING TO PERSIST" GATE MUST READ THE DELTA, NOT A FIELD LIST.
  //
  // Three call sites gated a CONSUMED delta by enumerating its fields by hand, and one of
  // them was already a field short: `OperationTracker.flushToDatabase` asked
  // `tasks_created || tasks_updated || contexts_created` and then passed `tasks_completed`
  // to the write it had just decided to skip. Because `consumeAll()` deletes the entry
  // before the gate runs, the skipped branch DESTROYS the delta — it is the destructive
  // branch, not the cheap one.
  //
  // It never bit only because `incrementTasksUpdated` bumps `tasks_updated` whenever it
  // bumps `tasks_completed`, so the dropped field never travelled alone. That is a
  // coupling between two functions that have no reason to know about each other — it
  // agrees today and can be weakened without the gate noticing. All three sites now ask
  // `isEmptyDelta(delta)`, which is derived from the object's own values.
  //
  // These three tests are one guard with three jobs:
  //   F7a  the FIELDS — every field of the activity delta must be able to travel ALONE.
  //        The field list is read off the product's own default delta AT RUNTIME, so a
  //        counter added tomorrow is covered without anyone remembering this file. That
  //        is the whole point: a test that types the field list out is the same allow-list
  //        as the gate it is guarding.
  //   F7b  the TOKENS — the token gate's `usage.total > 0` was the same disease in its
  //        one-field form.
  //   F7c  the GATE ITSELF — an all-zero delta must still write NOTHING. Without this,
  //        deleting the gate outright passes F7a and F7b.
  //   F7d  the THIRD SITE — `endSession`'s gate was the same seven-term hand-written
  //        disjunction, complete today but sitting above a seven-field object literal it
  //        had to be maintained in step with. F7a/F7b/F7c all run through the periodic
  //        flush and none of them touch this branch; F6b/F6c drive an end but always with
  //        `tasks_updated` set, so an end-gate that dropped a field stayed green. This is
  //        what proves the site DELEGATES to the shared predicate instead of re-deriving.
  // ────────────────────────────────────────────────────────────────────────────────────

  // A session id that has never been used, so `consume` returns the store's DEFAULT delta:
  // the product's own list of counter fields, at runtime. Not a literal list — see F7a.
  const UNUSED_SESSION_A = '00000000-0000-4000-8000-0000000000f7';
  const UNUSED_SESSION_T = '00000000-0000-4000-8000-0000000000f8';

  test('F7a: EVERY field of the activity delta can travel ALONE (the old gate dropped tasks_completed)', async () => {
    const template = OperationTracker.consumeActivityCounts(UNUSED_SESSION_A);
    const fields = Object.keys(template) as Array<keyof typeof template>;

    // Fail closed. If the template ever comes back empty or short, the loop below would
    // run zero (or too few) times and this test would PASS while guarding nothing — the
    // silent-pass default that makes a coverage test an allow-list. `tasks_completed` is
    // named explicitly because it is the field the shipped gate actually omitted.
    expect(fields.length).toBeGreaterThanOrEqual(4);
    expect(fields).toContain('tasks_completed');

    for (const field of fields) {
      const victim = await newVictim(`solo-${String(field)}`);

      // The ONLY non-zero field. `restore` is the product's own re-entry point for a
      // consumed delta (endSession's failure path uses it) and accepts any ActivityCounts,
      // which is precisely why the gate may not assume fields arrive in company.
      OperationTracker.restoreActivityCounts(victim, { ...template, [field]: 1 });
      await SessionTracker.flushActivityToDatabase();

      // Each delta field is named for its column. If that ever stops holding, this SELECT
      // fails on an unknown column — RED, not a silent skip.
      const cols = fields.map((f) => `COALESCE(${String(f)},0)::int AS ${String(f)}`).join(', ');
      const row = (await db.query(`SELECT ${cols} FROM sessions WHERE id = $1`, [victim])).rows[0];

      for (const other of fields) {
        expect(
          row[other],
          `delta with only ${String(field)}=1 → column ${String(other)}`
        ).toBe(other === field ? 1 : 0);
      }

      await db.query('DELETE FROM sessions WHERE id = $1', [victim]);
    }
  });

  test('F7b: a token delta lands even when the summarizing `total` is 0', async () => {
    const victim = await newVictim('token-solo-input');
    const template = TokenTracker.consume(UNUSED_SESSION_T);

    // `total` is maintained as input+output TODAY, which is what made `usage.total > 0`
    // look like a reading of the whole object. This is the shape any token field that is
    // NOT folded into `total` produces — a cache-read counter, say. Under the old gate
    // this delta was consumed and then thrown away.
    TokenTracker.restore(victim, { ...template, input: 7 });
    await SessionTracker.flushTokensToDatabase();

    const row = (
      await db.query(
        `SELECT COALESCE(input_tokens,0)::int AS ti, COALESCE(total_tokens,0)::int AS tok
           FROM sessions WHERE id = $1`,
        [victim]
      )
    ).rows[0];
    expect(row.ti).toBe(7);
    expect(row.tok).toBe(0);

    await db.query('DELETE FROM sessions WHERE id = $1', [victim]);
  });

  test('F7c: an ALL-ZERO delta writes NOTHING (the gate is a boundary, not an optimisation)', async () => {
    const victim = await newVictim('empty-delta');
    const readActivityStamp = async () =>
      (await db.query(`SELECT last_activity_at FROM sessions WHERE id = $1`, [victim])).rows[0]
        .last_activity_at;
    const before = await readActivityStamp();

    // An all-zero ENTRY is reachable in production: `restore` of a delta that was consumed
    // from a session with nothing pending creates one.
    OperationTracker.restoreActivityCounts(victim, OperationTracker.consumeActivityCounts(UNUSED_SESSION_A));
    TokenTracker.restore(victim, TokenTracker.consume(UNUSED_SESSION_T));

    const realQuery = db.query.bind(db);
    const writes: string[] = [];
    const spy = vi.spyOn(db, 'query').mockImplementation(((sql: any, params: any) => {
      if (
        typeof sql === 'string' &&
        COUNTER_WRITE.test(sql) &&
        Array.isArray(params) &&
        params[0] === victim
      ) {
        writes.push(sql);
      }
      return realQuery(sql, params);
    }) as any);
    await SessionTracker.flushActivityToDatabase();
    await SessionTracker.flushTokensToDatabase();
    spy.mockRestore();

    expect(writes).toHaveLength(0);

    // …and therefore `last_activity_at` still tells the truth. `applyCounterDelta` stamps
    // it with NOW(), so a gate-less flush would report activity on every 30 s tick for
    // every session holding an empty entry. This is why the gate exists at all.
    expect(await readActivityStamp()).toEqual(before);

    await db.query('DELETE FROM sessions WHERE id = $1', [victim]);
  });

  test('F7d: endSession persists a delta of ONLY tasks_completed (its gate is the delta, not a field list)', async () => {
    const victim = await newVictim('end-solo-completed');
    const template = OperationTracker.consumeActivityCounts(UNUSED_SESSION_A);
    OperationTracker.restoreActivityCounts(victim, { ...template, tasks_completed: 1 });

    await SessionLifecycleService.endSession(victim);

    // Read the raw COLUMN, not getFinalCounts: `tasks_completed` re-derives from the
    // tasks table for a session that owns task rows, which would mask a dropped delta.
    // This session owns none, so the column is the only place the delta can show up.
    const row = (
      await db.query(
        `SELECT COALESCE(tasks_completed,0)::int AS tc, COALESCE(tasks_updated,0)::int AS tu
           FROM sessions WHERE id = $1`,
        [victim]
      )
    ).rows[0];
    expect(row.tc).toBe(1);
    expect(row.tu).toBe(0);

    await db.query('DELETE FROM sessions WHERE id = $1', [victim]);
  });

  // ────────────────────────────────────────────────────────────────────────────────────
  // F8 — THE FIXTURE MUST NOT DEPEND ON THE NODE AND POSTGRES CLOCKS AGREEING.
  //
  // This guards the fixture-clock rule at the top of the file, and it is deliberately a
  // test OF THE FIXTURE rather than of the product: the fixture is what broke. F6c and F7d
  // went RED on the clean gate box and GREEN on the dev box with no source change between
  // them, because `newVictim` seeded `started_at` from the POSTGRES clock while endSession
  // stamps `ended_at` from the NODE clock, milliseconds apart.
  //
  // The lever is the only one that reproduces that deterministically: skew THIS process's
  // clock and leave the Postgres server clock alone — a real node-vs-DB offset, of an exact
  // size. BOTH halves (create and end) run under the skew, exactly as they would on a
  // genuinely skewed box.
  //
  // The skew is an HOUR: orders of magnitude past any real machine's, so this cannot pass
  // by being lucky the way the old fixture did. NEGATIVE (node behind Postgres) is the
  // direction that actually bit; positive is here so a one-directional "fix" is caught too.
  //
  // TEETH — and note WHICH assertion supplies them, because the obvious one only covers
  // half the cases. Mutating `newVictim` back to `started_at = NOW()`:
  //   • BEHIND  → endSession THROWS `violates check constraint
  //               "reasonable_session_duration"`. Caught by the constraint itself.
  //   • AHEAD   → the constraint is satisfied and the write SUCCEEDS. Measured: with only
  //               an `ended_at IS NOT NULL` check this case passed GREEN against the
  //               mutation. What is actually wrong is the LIFETIME — the row comes out an
  //               hour long instead of the FIXTURE_SESSION_AGE_MS the fixture declared,
  //               because its two ends were stamped by two different clocks.
  // So the load-bearing assertion is the measured lifetime, which fails in BOTH directions
  // and is a direct statement of the invariant ("this session is as long as the fixture
  // says, at any skew") rather than a proxy for it. Every assertion reads the row back off
  // DISK — a side effect, not a return value that could be right by luck.
  // ────────────────────────────────────────────────────────────────────────────────────
  const CLOCK_SKEW_PROBE_MS = 60 * 60_000;

  // Pinned as a LITERAL, and the fixture's constant asserted against it. A bound derived
  // from FIXTURE_SESSION_AGE_MS would widen in lockstep with the very thing it guards
  // — someone shrinking the fixture back toward a zero-length session would
  // take this guard's floor down with it and stay green. Now that is a two-line edit
  // somebody has to mean.
  const FIXTURE_SESSION_AGE_MS_PINNED = 30 * 60_000;

  // How far the measured lifetime may sit from the declared age. With Date frozen for the
  // duration of the case this is ~0 in practice; a minute is slack for a future change that
  // lets the clock run. It MUST stay far below CLOCK_SKEW_PROBE_MS or the injected skew hides
  // inside the tolerance — asserted below, because the first version of this bound
  // (`< PINNED + CLOCK_SKEW_PROBE_MS / 2`) did exactly that: the mutated AHEAD case measured
  // 3,599,991 ms against a 3,600,000 ms bound and passed by NINE MILLISECONDS out of 3.6
  // million. Found by printing the number, not by reading the expression.
  const FIXTURE_LIFETIME_TOLERANCE_MS = 60_000;

  test.each([
    ['behind', -CLOCK_SKEW_PROBE_MS],
    ['ahead', CLOCK_SKEW_PROBE_MS]
  ])(
    'F8: a fixture session survives create→end with this process\'s clock %s Postgres by an hour',
    async (direction, skewMs) => {
      // Fake ONLY Date. Timers stay real, so the pg pool's own timeouts are untouched and
      // nothing can hang; a frozen Date is fine here because the fixture derives its
      // `started_at` from the same frozen instant the end will use.
      vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + (skewMs as number) });

      let victim: string;
      try {
        victim = await newVictim(`clock-${direction}`);
        // The call that writes `ended_at`. Under the old fixture this threw.
        await SessionLifecycleService.endSession(victim);
      } finally {
        vi.useRealTimers();
      }

      const row = (
        await db.query(
          `SELECT started_at, ended_at, (ended_at >= started_at) AS ordered
             FROM sessions WHERE id = $1`,
          [victim!]
        )
      ).rows[0];
      expect(row.ended_at).not.toBeNull();
      expect(row.ordered).toBe(true);

      // THE ASSERTION WITH TEETH IN BOTH DIRECTIONS (see the TEETH note above).
      // Guard the guard first: the tolerance may not be wide enough to swallow the skew
      // this test injects, and the fixture's age must still be the value pinned here.
      expect(FIXTURE_LIFETIME_TOLERANCE_MS * 2).toBeLessThan(CLOCK_SKEW_PROBE_MS);
      expect(FIXTURE_SESSION_AGE_MS).toBe(FIXTURE_SESSION_AGE_MS_PINNED);

      // The session is exactly as long as the fixture declared, at any skew — because both
      // of its ends came off ONE clock. Two clocks show up here as the offset between them.
      const lifetimeMs =
        new Date(row.ended_at).getTime() - new Date(row.started_at).getTime();
      expect(
        Math.abs(lifetimeMs - FIXTURE_SESSION_AGE_MS_PINNED),
        `session lifetime ${lifetimeMs}ms vs declared ${FIXTURE_SESSION_AGE_MS_PINNED}ms ` +
          `(skew ${skewMs}ms) — started_at and ended_at came off different clocks`
      ).toBeLessThanOrEqual(FIXTURE_LIFETIME_TOLERANCE_MS);

      await db.query('DELETE FROM sessions WHERE id = $1', [victim!]);
    }
  );
});
