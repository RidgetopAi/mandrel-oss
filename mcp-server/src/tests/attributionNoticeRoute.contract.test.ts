/**
 * attributionNoticeRoute.contract.test.ts — THE WIRING, at the choke point every tool call
 * passes through.
 *
 * ── WHAT THIS GUARDS ────────────────────────────────────────────────────────────────────
 * A customer (tenant contoso) wrote to Mandrel unattributed for weeks: 42 sessions on the
 * flagged `anonymous` fallback against 2 that ever carried his actor. His tenant runs
 * MANDREL_SESSION_REQUIRE_ACTOR=false — a deliberate waiver — so every one of those writes
 * SUCCEEDED and said nothing. The notice is the thing that now says something, on the write
 * itself.
 *
 * ── WHY IT ENTERS AT routeExecutor ──────────────────────────────────────────────────────
 * `routeExecutor` is the ONE point both surfaces reach (the flat /mcp/tools/* dispatcher and
 * the gateway, which delegates to routeExecutor(opId, …)), and it is where the ACTION_TOOLS
 * gate and the response sink both live. Asserting on `renderAttributionNotice` alone would
 * pass with the wiring deleted — which is exactly the hollow guard this house does not ship.
 * The mutation probe for this file is the wiring line in routes/index.ts; run it by neutering
 * that line and watching this file go RED.
 *
 * ── WHAT IS STUBBED AND WHAT IS REAL ────────────────────────────────────────────────────
 * REAL: routeExecutor, the ACTION_TOOLS gate, the notice decision, the response sink,
 * ensureStructuredContent, the config, the suppression map. STUBBED: the DB (so this runs
 * outside the disposable Postgres) and the terminal route handler (so a test can choose a
 * SUCCESS or an ERROR response deliberately — the error case is the whole point of case (d)
 * and cannot be provoked reliably from a real handler). Every DB touch on this path is
 * already wrapped to degrade, so stubbing it changes no branch under test.
 *
 * The READ-tool case uses `mandrel_ping`: a real op, really dispatched, genuinely not in
 * ACTION_TOOLS — not a fabricated tool name that no route would answer anyway.
 */
import { describe, test, expect, beforeEach, afterAll, vi } from 'vitest';

// The DB is not the subject. Every db touch on this path (project resolution, the write
// audit, session ensure) is already wrapped to degrade, so an empty result set exercises the
// same branches a cold connection would.
vi.mock('../config/database.js', () => ({
  db: { query: vi.fn(async () => ({ rows: [], rowCount: 0 })), connect: vi.fn(), end: vi.fn() },
  initializeDatabase: vi.fn(async () => {}),
  closeDatabase: vi.fn(async () => {}),
}));

const handleStore = vi.fn();
vi.mock('../routes/context.routes.js', () => ({
  contextRoutes: {
    handleStore: (...a: any[]) => handleStore(...a),
  },
}));

// task_update is the F3 witness: a REAL write op that is NOT in ACTION_TOOLS, i.e. exactly
// the population the first draft's predicate could not see.
const handleUpdate = vi.fn();
vi.mock('../routes/tasks.routes.js', () => ({
  tasksRoutes: {
    handleUpdate: (...a: any[]) => handleUpdate(...a),
  },
}));

import { routeExecutor, ACTION_TOOLS } from '../routes/index.js';
import { opEffect, OP_REGISTRY } from '../config/opRegistry.js';
import { SESSION_CONFIG } from '../config/sessionConfig.js';
import { ATTRIBUTION_NOTICE_CONFIG } from '../config/attributionNoticeConfig.js';
import {
  __resetAttributionNoticeState,
  ATTRIBUTION_NOTICE_KEY,
} from '../services/attributionNotice.js';

const NOTICE_HEAD = '⚠️ ACTION REQUIRED — RELAY THIS TO YOUR USER, DO NOT SUMMARIZE IT AWAY:';

const textOf = (r: any): string => (r?.content ?? []).map((c: any) => c?.text ?? '').join('\n');
const noticeOf = (r: any): unknown => (r as any)?.structuredContent?.[ATTRIBUTION_NOTICE_KEY];

const okResponse = () => ({
  content: [{ type: 'text' as const, text: '✅ Context stored successfully' }],
  structuredContent: { ok: true, id: 'ctx-1' },
});
const errResponse = () => ({
  isError: true,
  content: [{ type: 'text' as const, text: '❌ Context store failed: boom' }],
});

const savedRequireActor = SESSION_CONFIG.requireActor;
const savedEnabled = ATTRIBUTION_NOTICE_CONFIG.enabled;
const savedTtl = ATTRIBUTION_NOTICE_CONFIG.ttlMs;

beforeEach(() => {
  __resetAttributionNoticeState();
  handleStore.mockReset();
  handleStore.mockResolvedValue(okResponse());
  handleUpdate.mockReset();
  handleUpdate.mockResolvedValue({
    content: [{ type: 'text' as const, text: '✅ Task updated' }],
    structuredContent: { ok: true, id: 'task-1' },
  });
  // THE WAIVER DEPLOYMENT — the only configuration in which this notice can fire. With
  // requireActor ON the call is REJECTED instead, and that path is untouched by this feature.
  SESSION_CONFIG.requireActor = false;
  ATTRIBUTION_NOTICE_CONFIG.enabled = true;
  ATTRIBUTION_NOTICE_CONFIG.ttlMs = savedTtl;
});

afterAll(() => {
  SESSION_CONFIG.requireActor = savedRequireActor;
  ATTRIBUTION_NOTICE_CONFIG.enabled = savedEnabled;
  ATTRIBUTION_NOTICE_CONFIG.ttlMs = savedTtl;
  __resetAttributionNoticeState();
});

const storeCall = (connectionId: string, actor?: string) =>
  routeExecutor(
    'context_store',
    { content: 'hello', type: 'completion' },
    { connectionId, actor, identified: true } as any
  );

describe('unattributed-write notice — routeExecutor wiring', () => {
  test('(a) an unattributed content-producing call is noticed in BOTH channels, and it LEADS', async () => {
    const res: any = await storeCall('conn-a');

    // THE MACHINE CHANNEL — some clients render only this.
    expect(noticeOf(res)).toContain(NOTICE_HEAD);

    // THE TEXT CHANNEL — and it must be the FIRST thing in it. A summariser keeps the head
    // and drops the tail; that is precisely how the ping echo failed to reach the customer.
    const text = textOf(res);
    expect(text.startsWith(NOTICE_HEAD)).toBe(true);
    expect(text).toContain('X-Actor-ID');
    // The write's own output is still there — the notice is ADDITIVE, not a replacement.
    expect(text).toContain('✅ Context stored successfully');
    // …and it did not invent a content block, which would disturb anything counting blocks.
    expect(res.content).toHaveLength(1);
    // …and the handler really ran (this is not a short-circuit that skipped the write).
    expect(handleStore).toHaveBeenCalledTimes(1);
  });

  test('(b) a SECOND call on the same connection inside the window is NOT noticed', async () => {
    const first: any = await storeCall('conn-b');
    expect(noticeOf(first)).toBeDefined();

    const second: any = await storeCall('conn-b');
    expect(noticeOf(second)).toBeUndefined();
    expect(textOf(second)).not.toContain(NOTICE_HEAD);
    expect(textOf(second)).toContain('✅ Context stored successfully');

    // ANTI-VACUOUS: a DIFFERENT connection in the same window still gets it, so (b) is
    // suppression and not the feature having quietly switched itself off.
    const other: any = await storeCall('conn-b-other');
    expect(noticeOf(other)).toBeDefined();
  });

  test('(c) a call CARRYING an actor is never noticed', async () => {
    const res: any = await storeCall('conn-c', 'contoso');
    expect(noticeOf(res)).toBeUndefined();
    expect(textOf(res)).not.toContain(NOTICE_HEAD);

    // ANTI-VACUOUS: the same connection with the actor REMOVED is noticed, so (c) is the
    // actor doing the work — not this connection being suppressed for some other reason.
    const anon: any = await storeCall('conn-c');
    expect(noticeOf(anon)).toBeDefined();
  });

  test('(d) an ERROR response is NOT noticed, and the next SUCCESS still gets it', async () => {
    handleStore.mockResolvedValueOnce(errResponse());
    const failed: any = await storeCall('conn-d');
    expect(failed.isError).toBe(true);
    expect(noticeOf(failed)).toBeUndefined();
    expect(textOf(failed)).not.toContain(NOTICE_HEAD);

    // The one notice this user was going to get must NOT have been burned on a failed write.
    const ok: any = await storeCall('conn-d');
    expect(noticeOf(ok)).toBeDefined();
    expect(textOf(ok).startsWith(NOTICE_HEAD)).toBe(true);
  });

  test('(e) a READ tool is never noticed — mandrel_ping is really dispatched and really not an ACTION', async () => {
    expect(ACTION_TOOLS.has('mandrel_ping')).toBe(false); // states the precondition, not assumes it
    const res: any = await routeExecutor('mandrel_ping', {}, {
      connectionId: 'conn-e',
      identified: true,
    } as any);
    expect(textOf(res)).toContain('Mandrel Pong!');   // the op really ran
    expect(noticeOf(res)).toBeUndefined();
    expect(textOf(res)).not.toContain(NOTICE_HEAD);
  });

  test('a notice that could NOT be attached is NOT consumed — the next call still gets it', async () => {
    // THE ORDERING DEFECT (Reviewer probe A). `markNoticed` used to fire BEFORE the content
    // mutation inside the same try, so any throw between them burned the caller's one notice
    // for the whole TTL window with nothing delivered — the silent skip is worse than never
    // having built the feature. A non-iterable `content` is the reachable shape of that
    // throw: the spread `[...(resp.content ?? [])]` raises TypeError.
    handleStore.mockResolvedValueOnce({
      content: 42 as any,                       // not iterable
      structuredContent: { ok: true, id: 'ctx-x' },
    });

    // It DEGRADES, it does not break the write: the response comes back, unannotated.
    const broken: any = await storeCall('conn-probe-a');
    expect(noticeOf(broken)).toBeUndefined();

    // …and the notice was NOT consumed, which is the assertion the fix is about.
    const next: any = await storeCall('conn-probe-a');
    expect(noticeOf(next)).toBeDefined();
    expect(textOf(next).startsWith(NOTICE_HEAD)).toBe(true);
  });

  test('a DELIVERED notice IS consumed — the anti-vacuous twin of the case above', async () => {
    const first: any = await storeCall('conn-probe-b');
    expect(noticeOf(first)).toBeDefined();
    const second: any = await storeCall('conn-probe-b');
    expect(noticeOf(second)).toBeUndefined();
  });

  // ───────────────────────────────────────────────────────────────────────────────────────
  // THE POPULATION (Reviewer F3). The first draft anchored eligibility on ACTION_TOOLS —
  // three ops built for lazy session creation, which config/opRegistry.ts's own header warns
  // is "a guard with a hole shaped exactly like the author's mental model". These cases pin
  // the canonical population instead, and the first one states the precondition executably
  // rather than trusting the prose above it.
  test('PRECONDITION: task_update IS a canonical write and is NOT in ACTION_TOOLS', () => {
    expect(opEffect('task_update')).toBe('write');
    expect(ACTION_TOOLS.has('task_update')).toBe(false);
    // The size of the hole, measured rather than asserted in prose: the canonical write
    // population is far larger than the three-op session-creation set it was anchored on.
    const canonicalWrites = OP_REGISTRY.filter((o) => o.effect === 'write').map((o) => o.opId);
    expect(canonicalWrites.length).toBeGreaterThan(ACTION_TOOLS.size);
    for (const t of ACTION_TOOLS) expect(canonicalWrites).toContain(t);
  });

  test('a BROADENED write op (task_update) IS noticed', async () => {
    const res: any = await routeExecutor(
      'task_update',
      { taskId: 't-1', status: 'in_progress' },
      { connectionId: 'conn-h', identified: true } as any
    );
    expect(handleUpdate).toHaveBeenCalledTimes(1);       // the op really ran
    expect(noticeOf(res)).toContain(NOTICE_HEAD);
    expect(textOf(res).startsWith(NOTICE_HEAD)).toBe(true);
    expect(textOf(res)).toContain('✅ Task updated');
  });

  test('suppression is per CONNECTION, not per op — a user is told once across write ops', async () => {
    const first: any = await storeCall('conn-i');
    expect(noticeOf(first)).toBeDefined();
    const second: any = await routeExecutor(
      'task_update',
      { taskId: 't-1', status: 'completed' },
      { connectionId: 'conn-i', identified: true } as any
    );
    // This is what keeps the broadened reach from becoming noise the client learns to strip.
    expect(noticeOf(second)).toBeUndefined();
  });

  test('a READ op is still never noticed, and project_switch (scope-switch) is not either', async () => {
    expect(opEffect('context_search')).toBe('read');
    // scope-switch persists the project SLOT, not a record — there is no record to report.
    expect(opEffect('project_switch')).toBe('scope-switch');
    const res: any = await routeExecutor('mandrel_ping', {}, {
      connectionId: 'conn-j',
      identified: true,
    } as any);
    expect(noticeOf(res)).toBeUndefined();
  });

  test('the kill switch is real: disabled ⇒ no notice on an otherwise-eligible call', async () => {
    ATTRIBUTION_NOTICE_CONFIG.enabled = false;
    const res: any = await storeCall('conn-f');
    expect(noticeOf(res)).toBeUndefined();
    expect(textOf(res)).toBe('✅ Context stored successfully');
  });

  test('requireActor ON ⇒ this feature is not the thing that speaks (the call is rejected instead)', async () => {
    SESSION_CONFIG.requireActor = true;
    const res: any = await storeCall('conn-g');
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('X-Actor-ID');
    expect(noticeOf(res)).toBeUndefined();
    expect(textOf(res)).not.toContain(NOTICE_HEAD);
  });
});
