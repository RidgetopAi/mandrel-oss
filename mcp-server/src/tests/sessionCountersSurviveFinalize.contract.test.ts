/**
 * SESSION COUNTERS SURVIVE FINALIZE — the executable fuse for an earlier task.
 *
 * ── THE BUG ─────────────────────────────────────────────────────────────────────────────
 * `SessionRepo.finish()` ran an ABSOLUTE `SET total_tokens=$, contexts_created=$,
 * tasks_created=$ …` from the values `endSession` read out of `OperationTracker
 * .getActivityCounts` / `TokenTracker.get`. Those in-memory values are a DELTA — activity
 * since the last 30 s flush — and the flush EMPTIES the map after accumulating it into the
 * same columns with `col = COALESCE(col,0) + delta`. So any session that outlived one flush
 * interval arrived at finish() with an empty map and had its accumulated truth overwritten
 * with zeros. Measured on prod 2026-07-26: 79 of 114 `ended` sessions read
 * contexts_created = 0 while their contexts still existed.
 *
 * ── WHY THIS TEST IS SHAPED THE WAY IT IS (four ways a probe for this goes hollow) ───────
 *
 * 1. IT MUST FORCE THE FLUSH BEFORE ENDING. **The flush-before-end ordering IS the bug.**
 *    If the counts are still sitting in memory when endSession runs, the OLD buggy absolute
 *    SET writes the right number and a probe that skipped the flush passes GREEN against the
 *    bug. `forceFlush()` below is not setup convenience — it is the load-bearing step.
 *
 * 2. IT MUST NOT ASSERT THROUGH A FIXED READ PATH. Contexts/tasks/decisions are now derived
 *    from the child tables by every reader, so asserting "the API says 3 contexts" passes
 *    even with finish() still zeroing the column — the read path routes around the write
 *    bug. **`total_tokens` is the discriminating observable**: it has no child table, it is
 *    not recomputable, so the COLUMN is the only place the answer can come from. Every
 *    assertion on tokens below reads `sessions.total_tokens` with raw SQL.
 *
 * 3. EXACT VALUES, NEVER `> 0`. A count-shaped assertion (`toBeGreaterThan(0)`) is satisfied
 *    by a partial write, and a PARTIAL write is precisely the non-limiting case of this bug
 *    (a session ended seconds after activity got whatever delta happened to be un-flushed —
 *    an undercount, not a zero). A past incident.
 *
 * 4. IT MUST RUN ON BOTH END PATHS. The explicit `session_end` tool AND the CLOSER
 *    (`SessionTimeoutService.runCloser`, the duration-cap sweep that fires unattended). The
 *    closer is the path that actually bit the operator and the one a lazy test skips.
 *
 * ── MUTATION PROOF (do this if you touch finish()) ───────────────────────────────────────
 * Revert SessionRepo.finish() to the absolute SET and re-run: TEST 1 and TEST 2 must both go
 * RED on the `total_tokens` assertion. A probe nobody has watched fail is not a probe
 *. The recorded run of that mutation is in the earlier task report.
 *
 * DB target: a DISPOSABLE database created by scripts/test-session-counters.sh, which drops
 * it on exit. Run it via that script — NEVER against the production `mandrel` DB.
 */

import { describe, test, expect, beforeAll, afterAll, vi } from 'vitest';
import { patternEmbedding } from './helpers/embedGeometry.js';

// Real UUIDs per session (the global vitest.setup.ts mocks randomUUID with a counter).
vi.unmock('crypto');
vi.unmock('node:crypto');

// Stub embeddings only (native transformers/sharp are unavailable in CI). The REAL DB write
// + session attribution path still runs, so real `contexts` child rows are created.
vi.mock('../services/embedding.js', () => ({
  embeddingService: {
    generateEmbedding: vi.fn(async () => ({ embedding: patternEmbedding() })),
  },
}));

import { db } from '../config/database.js';
import { routeExecutor } from '../routes/index.js';
import { SessionTracker } from '../services/session/SessionTracker.js';
import { SessionTimeoutService } from '../services/sessionTimeout.js';
import { ActiveSessionStore } from '../services/session/state/ActiveSessionStore.js';
import { SESSION_CONFIG } from '../config/sessionConfig.js';

const STAMP = Date.now();
const PROJ_NAME = `counters-P-${STAMP}`;

/**
 * EXACT expected values. Deliberately distinct, non-round, and different from each other so
 * a transposed/aliased field cannot coincidentally satisfy an assertion.
 */
const CONTEXTS_TO_STORE = 3;
const TASKS_TO_CREATE = 2;
const TOKENS_IN = 1301;
const TOKENS_OUT = 907;
const TOKENS_TOTAL = TOKENS_IN + TOKENS_OUT; // 2208

let projectId: string;

/**
 * The CLOSER self-gates on `resolverMode === 'actor'` and returns 0 (inert) otherwise. The
 * shared gate (the CI gate STAGE 1) deliberately PINS the SHIPPED DEFAULTS for the whole
 * suite — `MANDREL_SESSION_RESOLVER_MODE=legacy` — so this file must OVERRIDE the flag
 * LOCALLY rather than depend on its runner's env, exactly like sessionRequireActor.contract
 * does for `requireActor`. A test that needs a non-default flag must PROVISION it, never
 * inherit it: inheriting made this file pass under its own script and RED under
 * the CI gate, which is the gate that actually decides.
 */
const savedResolverMode = SESSION_CONFIG.resolverMode;

/** The 30 s flush, run on demand — the step that makes this probe non-hollow (see #1). */
async function forceFlush(): Promise<void> {
  await SessionTracker.flushTokensToDatabase();
  await SessionTracker.flushActivityToDatabase();
}

/** Raw column read. Never goes through a reader that could route around the write bug. */
async function readCounterColumns(sessionId: string): Promise<{
  contexts_created: number;
  tasks_created: number;
  total_tokens: number;
  input_tokens: number;
  output_tokens: number;
  status: string;
  ended_at: string | null;
}> {
  const r = await db.query(
    `SELECT COALESCE(contexts_created,0)::int AS contexts_created,
            COALESCE(tasks_created,0)::int    AS tasks_created,
            COALESCE(total_tokens,0)::int     AS total_tokens,
            COALESCE(input_tokens,0)::int     AS input_tokens,
            COALESCE(output_tokens,0)::int    AS output_tokens,
            status, ended_at
       FROM sessions WHERE id = $1`,
    [sessionId]
  );
  if (r.rows.length === 0) throw new Error(`session ${sessionId} not found`);
  return r.rows[0];
}

/**
 * Drive a session through the REAL write path: project_switch, N context_store,
 * M task_create, plus a token record. Returns the session id the writes attached to.
 */
/**
 * Every session id this file has driven. Prod runs `resolverMode = 'actor'` and this harness
 * mirrors it, which means session resolution is ACTOR-keyed, not connection-keyed: two tests
 * using different connectionIds but the SAME actor share ONE session on the same UTC day.
 * That would silently accumulate one test's counts into the next and turn an exact assertion
 * into a cross-test artifact. Each test therefore uses a DISTINCT actor, and this set is the
 * fail-loud check that it actually worked (found the hard way — a malformed mutation left a
 * session un-terminalized and the next test adopted it, reporting 4416 instead of 2208).
 */
const seenSessionIds = new Set<string>();

async function driveRealActivity(label: string): Promise<string> {
  const connectionId = `counters-${label}-${STAMP}`;
  const actor = `counters-probe-${label}-${STAMP}`;
  const ctx = { connectionId, actor };

  await routeExecutor('project_switch', { project: projectId }, ctx);

  for (let i = 0; i < CONTEXTS_TO_STORE; i++) {
    await routeExecutor(
      'context_store',
      { content: `counters probe context ${i} ${STAMP}`, type: 'completion', tags: ['counters-probe'] },
      ctx
    );
  }
  for (let i = 0; i < TASKS_TO_CREATE; i++) {
    await routeExecutor(
      'task_create',
      { title: `counters probe task ${i} ${STAMP}`, type: 'test' },
      ctx
    );
  }

  const sessionId = ActiveSessionStore.get(connectionId);
  if (!sessionId) throw new Error('no active session was created by the real write path');
  if (seenSessionIds.has(sessionId)) {
    throw new Error(
      `session ${sessionId} was already used by an earlier test — sessions are being SHARED, ` +
      `so every count below would be a cross-test artifact rather than a measurement`
    );
  }
  seenSessionIds.add(sessionId);

  // Tokens: the discriminating observable (see #2). Recorded through the same tracker the
  // server's recordTokenUsage uses.
  SessionTracker.recordTokenUsage(sessionId, TOKENS_IN, TOKENS_OUT);

  return sessionId;
}

describe('session counters survive finalize', () => {
  beforeAll(async () => {
    SESSION_CONFIG.resolverMode = 'actor';
    projectId = (
      await db.query(
        `INSERT INTO projects (name, description) VALUES ($1, 'session counter finalize probe') RETURNING id`,
        [PROJ_NAME]
      )
    ).rows[0].id;
  });

  afterAll(async () => {
    SESSION_CONFIG.resolverMode = savedResolverMode;
    try {
      if (projectId) {
        await db.query('DELETE FROM contexts WHERE project_id = $1', [projectId]);
        await db.query('DELETE FROM tasks WHERE project_id = $1', [projectId]);
        await db.query('DELETE FROM sessions WHERE project_id = $1', [projectId]);
        await db.query('DELETE FROM projects WHERE id = $1', [projectId]);
      }
    } catch { /* ignore */ }
    await db.end();
  });

  // ────────────────────────────────────────────────────────────────────────────────────
  // TEST 1 — the EXPLICIT end path (session_end tool → SessionTracker.endSession).
  // ────────────────────────────────────────────────────────────────────────────────────
  test('explicit endSession: a FLUSHED session keeps its exact counts and tokens', async () => {
    const sessionId = await driveRealActivity('explicit');

    // THE LOAD-BEARING STEP. Without it the in-memory map is still full at end time and the
    // pre-fix absolute SET writes the correct number — the probe would pass against the bug.
    await forceFlush();

    const afterFlush = await readCounterColumns(sessionId);
    expect(afterFlush.contexts_created).toBe(CONTEXTS_TO_STORE);
    expect(afterFlush.tasks_created).toBe(TASKS_TO_CREATE);
    // Exact, on the column. This is the number the old finish() destroyed.
    expect(afterFlush.total_tokens).toBe(TOKENS_TOTAL);
    expect(afterFlush.input_tokens).toBe(TOKENS_IN);
    expect(afterFlush.output_tokens).toBe(TOKENS_OUT);

    await SessionTracker.endSession(sessionId);

    const afterEnd = await readCounterColumns(sessionId);
    // ↓↓↓ THE ASSERTIONS THAT FAIL AGAINST THE OLD CODE ↓↓↓
    expect(afterEnd.total_tokens).toBe(TOKENS_TOTAL);
    expect(afterEnd.input_tokens).toBe(TOKENS_IN);
    expect(afterEnd.output_tokens).toBe(TOKENS_OUT);
    expect(afterEnd.contexts_created).toBe(CONTEXTS_TO_STORE);
    expect(afterEnd.tasks_created).toBe(TASKS_TO_CREATE);
    // …and it still terminalized.
    expect(afterEnd.status).toBe('ended');
    expect(afterEnd.ended_at).not.toBeNull();
  });

  // ────────────────────────────────────────────────────────────────────────────────────
  // TEST 2 — the CLOSER path. This is the one that bit in prod: an unattended
  // duration-cap sweep finalizing sessions nobody ended by hand.
  // ────────────────────────────────────────────────────────────────────────────────────
  test('closer finalize: a FLUSHED session keeps its exact counts and tokens', async () => {
    // Precondition: the closer self-gates on resolverMode. This checks the beforeAll
    // override actually took (the gate reads this same object at call time). The
    // NON-circular guard is `expect(closed).toBeGreaterThanOrEqual(1)` further down —
    // that is what fails loud if the sweep ran but did nothing.
    expect(SESSION_CONFIG.resolverMode).toBe('actor');

    const sessionId = await driveRealActivity('closer');
    await forceFlush();

    const afterFlush = await readCounterColumns(sessionId);
    expect(afterFlush.total_tokens).toBe(TOKENS_TOTAL);
    expect(afterFlush.contexts_created).toBe(CONTEXTS_TO_STORE);

    // Age the session past the absolute cap so find_sessions_to_close returns it. We move
    // the CLOCK (started_at), not the counters — the row's counter columns are untouched.
    await db.query(
      `UPDATE sessions
          SET started_at = NOW() - ($2::int * INTERVAL '1 second') - INTERVAL '1 hour',
              last_activity_at = NOW() - ($2::int * INTERVAL '1 second') - INTERVAL '1 hour'
        WHERE id = $1`,
      [sessionId, SESSION_CONFIG.absoluteCapSec]
    );

    const closed = await SessionTimeoutService.runCloser();
    // The sweep must actually have finalized OUR session — otherwise the assertions after
    // this are measuring an untouched row and would pass for the wrong reason.
    expect(closed).toBeGreaterThanOrEqual(1);

    const afterClose = await readCounterColumns(sessionId);
    expect(afterClose.status).toBe('ended');
    expect(afterClose.ended_at).not.toBeNull();
    // ↓↓↓ THE ASSERTIONS THAT FAIL AGAINST THE OLD CODE ↓↓↓
    expect(afterClose.total_tokens).toBe(TOKENS_TOTAL);
    expect(afterClose.input_tokens).toBe(TOKENS_IN);
    expect(afterClose.output_tokens).toBe(TOKENS_OUT);
    expect(afterClose.contexts_created).toBe(CONTEXTS_TO_STORE);
    expect(afterClose.tasks_created).toBe(TASKS_TO_CREATE);
  });

  // ────────────────────────────────────────────────────────────────────────────────────
  // TEST 3 — RE-FINALIZE IS +0, NOT A RE-ZERO. Consuming the delta makes this free: the
  // second finish() adds an already-consumed (empty) delta. The old code re-zeroed the row
  // every time it ran, so a resumed-and-re-ended session lost its counts again.
  // ────────────────────────────────────────────────────────────────────────────────────
  test('re-finalizing an already-ended session does not change any counter', async () => {
    const sessionId = await driveRealActivity('refinalize');
    await forceFlush();
    await SessionTracker.endSession(sessionId);

    const first = await readCounterColumns(sessionId);
    await SessionTracker.endSession(sessionId);
    const second = await readCounterColumns(sessionId);

    expect(second.total_tokens).toBe(first.total_tokens);
    expect(second.contexts_created).toBe(first.contexts_created);
    expect(second.tasks_created).toBe(first.tasks_created);
    expect(second.total_tokens).toBe(TOKENS_TOTAL);
  });

  // ────────────────────────────────────────────────────────────────────────────────────
  // TEST 4 — THE UN-FLUSHED TAIL IS NOT LOST. The complement of TEST 1: activity recorded
  // AFTER the last flush must be ADDED at end time, not dropped. This is what rules out the
  // tempting-but-wrong "make finish() monotonic / GREATEST(existing, new)" fix, which would
  // compare a total against a delta and silently discard the tail.
  // ────────────────────────────────────────────────────────────────────────────────────
  test('activity recorded AFTER the last flush is added at end, not dropped', async () => {
    const conn = `counters-tail-${STAMP}`;
    const sessionId = await driveRealActivity('tail');
    await forceFlush();

    // A second round of real activity with NO flush after it — the un-flushed tail.
    await routeExecutor(
      'context_store',
      { content: `counters probe tail context ${STAMP}`, type: 'completion', tags: ['counters-probe'] },
      { connectionId: conn, actor: `counters-probe-tail-${STAMP}` }
    );
    const TAIL_IN = 41;
    const TAIL_OUT = 59;
    SessionTracker.recordTokenUsage(sessionId, TAIL_IN, TAIL_OUT);

    await SessionTracker.endSession(sessionId);

    const after = await readCounterColumns(sessionId);
    expect(after.contexts_created).toBe(CONTEXTS_TO_STORE + 1);
    expect(after.tasks_created).toBe(TASKS_TO_CREATE);
    expect(after.total_tokens).toBe(TOKENS_TOTAL + TAIL_IN + TAIL_OUT);
    expect(after.input_tokens).toBe(TOKENS_IN + TAIL_IN);
    expect(after.output_tokens).toBe(TOKENS_OUT + TAIL_OUT);
  });

  // ────────────────────────────────────────────────────────────────────────────────────
  // TEST 5 — THE READ SURFACES AGREE WITH THE COLUMN. The write fix is only half the
  // symptom: `StreamCard.tsx` reads the DETAIL path first, so a list-only fix leaves the UI
  // broken. Both mcp-server read surfaces must report the same numbers for an ENDED session.
  // ────────────────────────────────────────────────────────────────────────────────────
  test('detail and identity read surfaces both report the ended session correctly', async () => {
    const sessionId = await driveRealActivity('readers');
    await forceFlush();
    await SessionTracker.endSession(sessionId);

    const { SessionManagementHandler } = await import(
      '../handlers/sessionAnalytics/management/SessionManagementHandler.js'
    );
    const detail = await SessionManagementHandler.getSessionDetailsWithMeta(sessionId);
    expect(detail.success).toBe(true);
    expect(detail.session.contexts_created).toBe(CONTEXTS_TO_STORE);
    expect(detail.session.tasks_created).toBe(TASKS_TO_CREATE);
    expect(detail.session.total_tokens).toBe(TOKENS_TOTAL);

    const { SessionRepo } = await import('../services/session/infra/db/SessionRepo.js');
    const identity = await SessionRepo.getIdentityRow(sessionId);
    expect(Number(identity?.context_count)).toBe(CONTEXTS_TO_STORE);
    expect(Number(identity?.task_count)).toBe(TASKS_TO_CREATE);

    // The `v_session_summaries` view (migration 070) — the upstream of /api/v2/sessions
    // list, detail and compare, and of the session_summary tool. It read the denormalized
    // columns directly, so it was broken for all four at once.
    const view = await db.query(
      `SELECT contexts_created::int, tasks_created::int, total_tokens::int
         FROM v_session_summaries WHERE id = $1`,
      [sessionId]
    );
    expect(view.rows[0].contexts_created).toBe(CONTEXTS_TO_STORE);
    expect(view.rows[0].tasks_created).toBe(TASKS_TO_CREATE);
    expect(view.rows[0].total_tokens).toBe(TOKENS_TOTAL);
  });
});
