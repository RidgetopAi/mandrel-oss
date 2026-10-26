/**
 * ATOMIC TASK CLAIM — contract tests (SPEC v1 §8).
 *
 * WHAT THIS PROVES: that `task_update`'s unconditional last-writer-wins write (WHERE id ONLY)
 * has been replaced, for OWNERSHIP, by a real compare-and-swap + lease that two workers cannot
 * both win. Externally reproduced bug (Amp-orb evaluation, probe): worker 2 OBSERVED
 * worker 1's active assignment and its write still succeeded, silently evicting worker 1.
 *
 * ALL 11 SPEC §8 CASES ARE HERE, in order, each labelled with what it defends:
 *    1  N workers, one task → exactly ONE winner, N-1 typed conflicts.
 *    2  D1 REGRESSION GUARD — a completed/cancelled task is NOT resurrected by a claim.
 *    3  Two workers racing an EXPIRED claim → exactly one wins (the EvalPlanQual property).
 *    4  D2 REGRESSION GUARD — a shared ACTOR NAME does not share a claim; claim_id does. The
 *       token is SERVER-MINTED: a presented one is a predicate operand, never an adopted key,
 *       and it unlocks nothing (not the lock key, not reentryStatuses) unless it MATCHES a
 *       live claim.
 *   4b  The token is a KEY, not a field — no read surface publishes it, so the fence is not a
 *       bearer capability a reader can pick up and take over with.
 *    5  D4 — stale expectedVersion rejected; the version bumps on ORDINARY updates too.
 *    6  Real wall-clock lease expiry → reclaimable; the audit shows the transition.
 *    7  Idempotent retry with the same claimId → SAME claim, no double-count.
 *    8  D3 — the fenced lifecycle: an expired holder's late write is refused, typed. Since
 *       an earlier task the fence covers EVERY task_update field while a claim is LIVE (the
 *       old content-field carve-out was the field-shaped hole; a dead claim fences nothing).
 *    9  Audit records BOTH attempts; a WINNER-audit failure ROLLS THE CLAIM BACK.
 *   10  bulk_update cannot stomp a live claim; archive refuses one; restore clears a stale one.
 *   11  MUTATION PROBE — deliberately break each guard and prove these tests go RED.
 *
 * Driven through the PUBLIC tool path (validate → routeExecutor) wherever the behaviour is
 * user-visible, so what is proven is what a caller actually gets — not an internal shortcut.
 * Real Postgres (the disposable CI DB, migrated by the real runner), vitest singleFork, so
 * the races below are genuine DB-level races.
 */

import { describe, test, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';

import { db } from '../config/database.js';
import { validateToolArguments } from '../middleware/validation.js';
import { routeExecutor } from '../routes/index.js';
import { TASK_CLAIM_CONFIG } from '../config/claimConfig.js';
import { taskClaimService } from '../services/taskClaim.js';
import { tasksHandler } from '../handlers/tasks.js';
import { isValidUuid } from '../utils/uuid.js';
import { AIDIS_TOOL_DEFINITIONS, categoryForTool } from '../config/toolDefinitions.js';
import { ACTOR_IDENTITY_ENV } from '../config/actorIdentityConfig.js';
import { outputZodSchemas } from '../config/outputSchemas.js';
import { rawDatastoreMessage } from '../utils/datastoreError.js';

const STAMP = Date.now();
const PROJ_NAME = `claim-${STAMP}`;
let projectId: string;

/** Snapshot the mutable config so every knob a case flips is restored (no cross-test leak). */
const SAVED = { ...TASK_CLAIM_CONFIG };

async function viaPublicTool(toolName: string, rawArgs: any): Promise<any> {
  const validated = validateToolArguments(toolName, rawArgs);
  return routeExecutor(toolName, validated);
}

/**
 * Insert a task directly so a case can arrange ANY starting status (incl. completed).
 *
 * `stage` is OPTIONAL and left undefined by default, so the tasks_sync_stage_status trigger
 * derives it from `status` exactly as before (todo -> ready, in_progress -> claimed, ...).
 * A caller that plans to run an ORDINARY (non-claim) content update against a row that
 * would otherwise land at 'ready' with no punch fields should pass `stage: 'draft'`
 * explicitly (an earlier task clause 10: the completeness gate now keys on the MERGED row's
 * stage, so such an update would otherwise be correctly refused — a gate concern unrelated
 * to what most of these claim/CAS tests exercise).
 */
async function makeTask(
  title: string,
  status = 'todo',
  assignedTo: string | null = null,
  stage?: string,
): Promise<string> {
  const r = await db.query(
    `INSERT INTO tasks (project_id, title, type, priority, status, assigned_to, stage)
     VALUES ($1, $2, 'general', 'medium', $3, $4, $5) RETURNING id`,
    [projectId, title, status, assignedTo, stage ?? null],
  );
  return r.rows[0].id;
}

async function readTask(taskId: string) {
  const r = await db.query(
    `SELECT status, assigned_to, version, claim_id::text AS claim_id, claim_actor, claim_expires_at, archived_at
       FROM tasks WHERE id = $1`,
    [taskId],
  );
  return r.rows[0];
}

/** Force a claim's lease into the past — deterministic expiry with no sleep. */
async function expireClaim(taskId: string): Promise<void> {
  await db.query(`UPDATE tasks SET claim_expires_at = now() - interval '1 second' WHERE id = $1`, [taskId]);
}

async function events(taskId: string) {
  return taskClaimService.listEvents(taskId, 100);
}

beforeAll(async () => {
  projectId = (
    await db.query(`INSERT INTO projects (name, description) VALUES ($1, 'atomic task claim') RETURNING id`, [PROJ_NAME])
  ).rows[0].id;
  // The feature ships DARK. Every behavioural case below runs with it ENABLED;
  // the legacy==today invariant is proven separately, with it off, in §10c.
  TASK_CLAIM_CONFIG.enabled = true;
});

afterEach(() => {
  Object.assign(TASK_CLAIM_CONFIG, SAVED, { enabled: true });
  vi.restoreAllMocks();
});

afterAll(async () => {
  Object.assign(TASK_CLAIM_CONFIG, SAVED);
  await db.query(`DELETE FROM task_claim_events WHERE task_id IN (SELECT id FROM tasks WHERE project_id = $1)`, [projectId]);
  await db.query(`DELETE FROM tasks WHERE project_id = $1`, [projectId]);
  await db.query(`DELETE FROM projects WHERE id = $1`, [projectId]);
});

// ═══════════════════════════════════════════════════════════════════════════════════════
// 0. WIRING (drift guards) — the tool exists, is categorized, and has both schemas.
// ═══════════════════════════════════════════════════════════════════════════════════════
describe('0. wiring — claim/renew/release are registered, categorized, schema-backed tools', () => {
  for (const tool of ['task_claim', 'task_renew', 'task_release']) {
    test(`${tool} is advertised with an input + output schema under Task Management`, () => {
      const def = AIDIS_TOOL_DEFINITIONS.find((d) => d.name === tool);
      expect(def, `${tool} tool definition`).toBeTruthy();
      expect(def!.outputSchema, `${tool} outputSchema`).toBeTruthy();
      expect(tool in outputZodSchemas).toBe(true);
      expect(categoryForTool(tool)).toBe('Task Management');
      expect(Object.keys(def!.inputSchema.properties)).toContain('taskId');
    });
  }

  /**
   * `claimId` is a LOCK KEY compared verbatim against a `uuid` column, not a record handle you
   * look up — so unlike `taskId` it does NOT accept an 8-hex short id. Without this, a short id
   * passed the edge and blew up on the `$n::uuid` cast as a raw Postgres driver error instead
   * of the typed refusal this contract promises. Every claimId-bearing tool, not just the one
   * it was noticed on.
   */
  const CLAIM_ID_TOOLS: Array<[string, any]> = [
    ['task_claim', { taskId: '59823126' }],
    ['task_renew', { taskId: '59823126' }],
    ['task_release', { taskId: '59823126' }],
    ['task_update', { taskId: '59823126', status: 'completed' }],
    ['cancel_task', { taskId: '59823126' }],
  ];

  test('every claimId param refuses a SHORT id at the edge, and accepts a full uuid', () => {
    for (const [tool, base] of CLAIM_ID_TOOLS) {
      expect(
        () => validateToolArguments(tool, { ...base, claimId: '3f0c1d2e' }),
        `${tool} must refuse a short claimId with a typed error`,
      ).toThrow(/claimId/i);
      expect(
        () => validateToolArguments(tool, { ...base, claimId: randomUUID() }),
        `${tool} must accept a full uuid claimId`,
      ).not.toThrow();
    }
  });

  /**
   * The claimId edge check must accept EXACTLY what the `uuid` COLUMN accepts — any 8-4-4-4-12
   * hex string (utils/uuid.ts, the single source). Pinning the CONTRACT rather than an
   * implementation is what makes this catch a future library `.uuid()` that tightens to the
   * RFC-4122 version/variant nibbles and starts refusing tokens the DB happily stored, locking
   * a legitimate holder out of its own claim.
   *
   * HONEST LIMITATION, mutation-probed rather than assumed: swapping `claimToken()` to zod's
   * `.uuid()` does NOT turn this RED on the CURRENT zod, whose uuid regex is behaviourally the
   * same over these cases (a past incident — a check written against a library bakes in THAT
   * version). What that swap DOES change is the advertised wire surface (`"format": "uuid"` on
   * five params), and that is caught loudly by toolSurfaceGolden.contract.test.ts. Two guards
   * on one class; this one is the behavioural half and it is the half that survives a zod bump.
   */
  test('the claimId check accepts EXACTLY what the uuid column accepts (contract, not library)', () => {
    const cases: Array<[string, boolean]> = [
      [randomUUID(), true],
      ['ffffffff-ffff-ffff-ffff-ffffffffffff', true], // version nibble 'f' — not RFC-4122, but Postgres takes it
      ['00000000-0000-0000-0000-000000000000', true], // the nil uuid
      ['3F0C1D2E-1234-1234-1234-123456789ABC', true], // upper case
      ['3f0c1d2e', false],                            // a short id: a lock key is not a record handle
      ['3f0c1d2e-1234-1234-1234-123456789ab', false], // one hex digit short
      ['3f0c1d2e-1234-1234-1234-123456789abg', false],// non-hex
      ['not-a-uuid', false],
      ['', false],
    ];
    for (const [value, shouldPass] of cases) {
      // The house predicate defines the contract…
      expect(isValidUuid(value), `house predicate on ${JSON.stringify(value)}`).toBe(shouldPass);
      // …and every claimId param must agree with it, exactly.
      for (const [tool, base] of CLAIM_ID_TOOLS) {
        const run = () => validateToolArguments(tool, { ...base, claimId: value });
        if (shouldPass) expect(run, `${tool} must accept ${JSON.stringify(value)}`).not.toThrow();
        else expect(run, `${tool} must refuse ${JSON.stringify(value)}`).toThrow(/claimId/i);
      }
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════
// CASE 1 — N workers, one task → exactly ONE winner, N-1 TYPED conflicts.
// ═══════════════════════════════════════════════════════════════════════════════════════
describe('1. ten workers race one task — exactly one wins', () => {
  test('10 concurrent claims yield 1 winner, 9 typed `held` conflicts, and ONE claim on the row', async () => {
    const taskId = await makeTask('race me');
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        viaPublicTool('task_claim', { projectId, taskId, actor: `worker-${i}` }),
      ),
    );

    const winners = results.filter((r) => r.structuredContent.claimed === true);
    const losers = results.filter((r) => r.structuredContent.claimed === false);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(9);
    // A loser is TOLD why — a bare false would leave it retrying blindly.
    for (const l of losers) expect(l.structuredContent.reason).toBe('held');
    // Every winner claim id is distinct-by-construction; exactly one reached the row.
    expect(new Set(winners.map((w) => w.structuredContent.claimId)).size).toBe(1);

    const row = await readTask(taskId);
    expect(row.claim_id).toBe(winners[0].structuredContent.claimId);
    expect(row.claim_actor).toBe(winners[0].structuredContent.actor);
    expect(row.status).toBe('in_progress');

    // THE INVARIANT, read from the DB rather than from the responses: exactly one WON event.
    const won = (await events(taskId)).filter((e) => e.event_type === 'claim_won');
    expect(won).toHaveLength(1);
  });

  /**
   * THE SAME RACE WITH THE STATUS GUARD NEUTRALISED. Found by mutation-probing this file
   * (§11): with allowedStatuses at its default ['todo'], the winner's status flip to
   * in_progress ALSO refuses the other nine — so the test above stays green even against a
   * claim whose CAS predicate has been deleted, and would have proven only the status guard.
   * Widening allowedStatuses removes that second line of defence, leaving the CAS predicate
   * as the ONLY thing that can produce a single winner. This is the case that actually
   * isolates it (mutation-verified: it goes RED when the predicate is removed).
   */
  test('10 concurrent claims with the STATUS GUARD WIDENED still yield exactly one winner (isolates the CAS)', async () => {
    const taskId = await makeTask('race me, guard widened');
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        viaPublicTool('task_claim', {
          projectId, taskId, actor: `w-${i}`, allowedStatuses: ['todo', 'in_progress', 'blocked'],
        }),
      ),
    );
    const winners = results.filter((r) => r.structuredContent.claimed === true);
    expect(winners).toHaveLength(1);
    for (const l of results.filter((r) => r.structuredContent.claimed === false)) {
      expect(l.structuredContent.reason).toBe('held');
    }
    expect((await events(taskId)).filter((e) => e.event_type === 'claim_won')).toHaveLength(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════
// CASE 2 — D1 REGRESSION GUARD. Without `AND status = ANY(...)` the claim predicate passes
// on every unarchived row (all 3,152 have claim_id IS NULL) and the SET forces
// status='in_progress' — silently resurrecting finished work. This is that guard.
// ═══════════════════════════════════════════════════════════════════════════════════════
describe('2. D1 — a completed / cancelled task is NEVER resurrected by a claim', () => {
  for (const terminal of ['completed', 'cancelled']) {
    test(`claiming a ${terminal} task → wrong-status, and the task stays ${terminal}`, async () => {
      const taskId = await makeTask(`${terminal} work`, terminal);
      const resp = await viaPublicTool('task_claim', { projectId, taskId, actor: 'necromancer' });

      expect(resp.structuredContent.claimed).toBe(false);
      expect(resp.structuredContent.reason).toBe('wrong-status');

      const row = await readTask(taskId);
      expect(row.status).toBe(terminal); // NOT flipped to in_progress
      expect(row.claim_id).toBeNull();
      expect(row.claim_actor).toBeNull();
    });
  }

  test('a caller may WIDEN allowedStatuses, but never to a terminal status it did not name', async () => {
    const blocked = await makeTask('blocked work', 'blocked');
    // Default (todo) refuses it…
    const refused = await viaPublicTool('task_claim', { projectId, taskId: blocked, actor: 'w' });
    expect(refused.structuredContent.reason).toBe('wrong-status');
    // …explicitly widening to blocked succeeds.
    const ok = await viaPublicTool('task_claim', {
      projectId, taskId: blocked, actor: 'w', allowedStatuses: ['todo', 'blocked'],
    });
    expect(ok.structuredContent.claimed).toBe(true);
  });

  /**
   * THE PROD DEFECT, VERBATIM (measured 2026-09-19T21:22Z): a caller does not
   * need to find a hole in the CAS predicate — it can just NAME the terminal status in
   * `allowedStatuses`. Before the fix this WAS honoured: `status = ANY(['completed'])` matches
   * a completed row and the SET clause flips it to 'in_progress', resurrecting finished work
   * through the exact param the server's own refusal hint (routes/tasks.routes.ts:165) claims
   * can never do that. RED without the claimConfig.claimableStatuses ceiling.
   */
  for (const terminal of ['completed', 'cancelled']) {
    test(`naming '${terminal}' in allowedStatuses does NOT resurrect a ${terminal} task`, async () => {
      const taskId = await makeTask(`${terminal} work, explicitly widened`, terminal);

      const resp = await viaPublicTool('task_claim', {
        projectId, taskId, actor: 'necromancer', allowedStatuses: [terminal],
      });
      expect(resp.structuredContent.claimed).toBe(false);
      expect(resp.structuredContent.reason).toBe('wrong-status');

      // task_details (the public read path, not a raw DB peek) confirms nothing moved: still
      // the terminal status, and no live claim was minted.
      const details = await viaPublicTool('task_details', { projectId, taskId });
      expect(details.structuredContent.task.status).toBe(terminal);
      expect(details.structuredContent.task.claimLive).toBeFalsy();

      const row = await readTask(taskId);
      expect(row.status).toBe(terminal);
      expect(row.claim_id).toBeNull();
      expect(row.claim_actor).toBeNull();
    });
  }

  test('narrowing is still honoured: a todo task claims with allowedStatuses:[todo], refuses with [in_progress]', async () => {
    const taskId = await makeTask('narrow to todo');

    const wrongNarrow = await viaPublicTool('task_claim', {
      projectId, taskId, actor: 'w', allowedStatuses: ['in_progress'],
    });
    expect(wrongNarrow.structuredContent.claimed).toBe(false);
    expect(wrongNarrow.structuredContent.reason).toBe('wrong-status');
    expect((await readTask(taskId)).status).toBe('todo');

    const rightNarrow = await viaPublicTool('task_claim', {
      projectId, taskId, actor: 'w', allowedStatuses: ['todo'],
    });
    expect(rightNarrow.structuredContent.claimed).toBe(true);
  });

  /**
   * THE CEILING IS ONE NAMED CONSTANT (an earlier task acceptance #4): both the DEFAULT path
   * (no allowedStatuses) and the CALLER-SUPPLIED path must read `claimConfig.claimableStatuses`
   * — not each carry its own literal list. Proven by mutating the shared constant and showing
   * BOTH paths react identically; a fix that clamped only the custom-allowedStatuses branch
   * with a locally-hardcoded list would leave the default path unaffected here and this test
   * would fail.
   */
  test('the claimable ceiling is ONE shared constant — mutating it moves BOTH the default and the allowedStatuses path', async () => {
    const taskId = await makeTask('shared ceiling probe');

    TASK_CLAIM_CONFIG.claimableStatuses = ['in_progress']; // 'todo' is no longer claimable AT ALL

    const viaDefault = await viaPublicTool('task_claim', { projectId, taskId, actor: 'a' });
    expect(viaDefault.structuredContent.claimed).toBe(false);
    expect(viaDefault.structuredContent.reason).toBe('wrong-status');

    const viaNamed = await viaPublicTool('task_claim', {
      projectId, taskId, actor: 'a', allowedStatuses: ['todo'],
    });
    expect(viaNamed.structuredContent.claimed).toBe(false);
    expect(viaNamed.structuredContent.reason).toBe('wrong-status');

    // Restore, then prove 'todo' is claimable again through BOTH paths — they track the live
    // config, not a value frozen at module load.
    TASK_CLAIM_CONFIG.claimableStatuses = SAVED.claimableStatuses;
    expect((await viaPublicTool('task_claim', { projectId, taskId, actor: 'a' })).structuredContent.claimed).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════
// CASE 3 — two workers racing an EXPIRED claim. This is the property the single-statement
// CAS buys under READ COMMITTED: the loser re-evaluates against the winner's COMMITTED row
// (EvalPlanQual), sees the FRESH expiry, and matches 0 rows.
// ═══════════════════════════════════════════════════════════════════════════════════════
describe('3. two workers racing an EXPIRED claim — exactly one wins', () => {
  test('an expired lease cannot be won twice', async () => {
    const taskId = await makeTask('expired race');
    const first = await viaPublicTool('task_claim', { projectId, taskId, actor: 'original' });
    expect(first.structuredContent.claimed).toBe(true);
    await expireClaim(taskId);

    // Both callers see an expired claim at read time; only one may take it.
    const [a, b] = await Promise.all([
      viaPublicTool('task_claim', { projectId, taskId, actor: 'racer-a', allowedStatuses: ['todo', 'in_progress'] }),
      viaPublicTool('task_claim', { projectId, taskId, actor: 'racer-b', allowedStatuses: ['todo', 'in_progress'] }),
    ]);

    const claimed = [a, b].filter((r) => r.structuredContent.claimed === true);
    expect(claimed).toHaveLength(1);
    const refused = [a, b].find((r) => r.structuredContent.claimed === false)!;
    expect(refused.structuredContent.reason).toBe('held');

    const row = await readTask(taskId);
    expect(row.claim_id).toBe(claimed[0].structuredContent.claimId);
    expect(row.claim_id).not.toBe(first.structuredContent.claimId);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════
// CASE 4 — D2 REGRESSION GUARD. `assigned_to`/`claim_actor` is a free-form varchar with no
// FK. If exclusion were keyed on the ACTOR, two builders (or two tick runs) sharing a name
// would both "hold" the claim. Exclusion is keyed on the SERVER-MINTED claim_id.
// ═══════════════════════════════════════════════════════════════════════════════════════
describe('4. D2 — a shared actor NAME does not share a claim (claim_id is the lock key)', () => {
  test('a second caller using the SAME actor string is still refused', async () => {
    const taskId = await makeTask('same-name race');
    const first = await viaPublicTool('task_claim', { projectId, taskId, actor: 'builder' });
    expect(first.structuredContent.claimed).toBe(true);

    const second = await viaPublicTool('task_claim', {
      projectId, taskId, actor: 'builder', allowedStatuses: ['todo', 'in_progress'],
    });
    expect(second.structuredContent.claimed).toBe(false);
    expect(second.structuredContent.reason).toBe('held');

    const row = await readTask(taskId);
    expect(row.claim_id).toBe(first.structuredContent.claimId);
  });

  test('a FORGED claim id (right actor, wrong token) neither re-enters nor renews nor releases', async () => {
    const taskId = await makeTask('forged token');
    const real = await viaPublicTool('task_claim', { projectId, taskId, actor: 'builder' });
    const forged = randomUUID();

    const reenter = await viaPublicTool('task_claim', { projectId, taskId, actor: 'builder', claimId: forged });
    expect(reenter.structuredContent.claimed).toBe(false);
    expect(reenter.structuredContent.reason).toBe('held');

    const renew = await viaPublicTool('task_renew', { projectId, taskId, claimId: forged });
    expect(renew.structuredContent.claimed).toBe(false);
    expect(renew.structuredContent.reason).toBe('claim-lost');

    const release = await viaPublicTool('task_release', { projectId, taskId, claimId: forged });
    expect(release.structuredContent.released).toBeUndefined();
    expect(release.structuredContent.reason).toBe('claim-lost');

    expect((await readTask(taskId)).claim_id).toBe(real.structuredContent.claimId);
  });

  /**
   * THE HOLE THE FIRST BUILD SHIPPED (Reviewer B1). The test above only ever presented a
   * forged token against a task with a LIVE claim — where the row's own claim_id refuses it
   * anyway. The unclaimed row was never tested, and that is exactly where the defect lived:
   * `claimId` was gated on PRESENCE, not on MATCHING, so it was written straight through as
   * the row's lock key. A caller could PIN the fence to a value it chose (two workers deriving
   * the same constant would both "hold" it) — the D2 decorative-lock failure in a new costume.
   */
  test('a token presented against an UNCLAIMED task is NOT adopted as the lock key', async () => {
    const taskId = await makeTask('client-chosen token');
    const chosen = '00000000-0000-4000-8000-000000000009';

    const resp = await viaPublicTool('task_claim', { projectId, taskId, actor: 'client', claimId: chosen });
    // It is a perfectly legal FRESH claim — it just does not get to name its own token.
    expect(resp.structuredContent.claimed).toBe(true);
    expect(resp.structuredContent.reentered).toBe(false);
    expect(resp.structuredContent.claimId).not.toBe(chosen);

    const row = await readTask(taskId);
    expect(row.claim_id).not.toBe(chosen);                            // THE ASSERTION
    expect(row.claim_id).toBe(resp.structuredContent.claimId);        // server-minted, and returned
  });

  test('two workers presenting the SAME constant token do not both hold the claim', async () => {
    const taskId = await makeTask('shared constant token');
    const constant = '00000000-0000-4000-8000-00000000000c';

    const a = await viaPublicTool('task_claim', { projectId, taskId, actor: 'worker-a', claimId: constant });
    const b = await viaPublicTool('task_claim', { projectId, taskId, actor: 'worker-b', claimId: constant });

    expect(a.structuredContent.claimed).toBe(true);
    expect(b.structuredContent.claimed).toBe(false);
    expect(b.structuredContent.reason).toBe('held');
    expect((await readTask(taskId)).claim_actor).toBe('worker-a');
  });

  /**
   * The SECOND consequence of gating on presence: `reentryStatuses` became reachable by
   * ATTACHING any uuid. The refusal a caller gets with no token must be the SAME refusal it
   * gets with a random one — a token you do not hold buys nothing.
   */
  test('a random token does NOT unlock reentryStatuses on a task the caller does not hold', async () => {
    const taskId = await makeTask('in_progress but unclaimed', 'in_progress');
    // `in_progress` is in TASK_CLAIM_CONFIG.reentryStatuses — the widening a holder gets.
    expect(TASK_CLAIM_CONFIG.reentryStatuses).toContain('in_progress');

    const noToken = await viaPublicTool('task_claim', { projectId, taskId, actor: 'x' });
    expect(noToken.structuredContent.claimed).toBe(false);
    expect(noToken.structuredContent.reason).toBe('wrong-status');

    const randomToken = await viaPublicTool('task_claim', { projectId, taskId, actor: 'x', claimId: randomUUID() });
    expect(randomToken.structuredContent.claimed).toBe(false);        // THE ASSERTION
    expect(randomToken.structuredContent.reason).toBe('wrong-status');
    // …and the refusal message must not promise a widening it was never granted.
    expect(randomToken.content[0].text).toContain('allowed: todo');

    const row = await readTask(taskId);
    expect(row.claim_id).toBeNull();
    expect(row.status).toBe('in_progress');
  });

  test('an EXPIRED holder re-presenting its own token gets no widening either (the lease is the grant)', async () => {
    const taskId = await makeTask('expired re-entry');
    const held = await viaPublicTool('task_claim', { projectId, taskId, actor: 'slowpoke' });
    const token = held.structuredContent.claimId;
    await expireClaim(taskId);

    // The token still MATCHES the row — but the lease is dead, so it is not ownership and the
    // re-entry widening does not apply. Re-acquiring is a deliberate act, not a silent retry.
    const retry = await viaPublicTool('task_claim', { projectId, taskId, actor: 'slowpoke', claimId: token });
    expect(retry.structuredContent.claimed).toBe(false);
    expect(retry.structuredContent.reason).toBe('wrong-status');

    // Widening the guard EXPLICITLY re-acquires it — on a NEW token, because the old lease died.
    const reacquired = await viaPublicTool('task_claim', {
      projectId, taskId, actor: 'slowpoke', claimId: token, allowedStatuses: ['todo', 'in_progress'],
    });
    expect(reacquired.structuredContent.claimed).toBe(true);
    expect(reacquired.structuredContent.claimId).not.toBe(token);
    expect(reacquired.structuredContent.reentered).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════
// CASE 4b — THE TOKEN IS A KEY, NOT A FIELD (Reviewer B2). The first build published the raw
// claimId on task_details to every reader, which made the fence a BEARER CAPABILITY: worker B
// read A's token off the public surface, presented it, and both were live owners — the exact
// §1 bug this spec exists to kill, reachable with advertised tools only. A reader gets WHO
// holds it, UNTIL WHEN, and WHETHER IT IS LIVE; only the winner gets the key.
// ═══════════════════════════════════════════════════════════════════════════════════════
describe('4b. the fencing token is never published to a reader', () => {
  test('no public read surface leaks the token, in either channel', async () => {
    const taskId = await makeTask('token stays private');
    const held = await viaPublicTool('task_claim', { projectId, taskId, actor: 'worker-a' });
    const token: string = held.structuredContent.claimId;
    expect(token).toBeTruthy();
    // Ground truth: the DB really does hold this token — so a leak below would be a real leak,
    // not an artefact of the claim having failed.
    expect((await readTask(taskId)).claim_id).toBe(token);

    const surfaces: Array<[string, any]> = [
      ['task_details', { projectId, taskId }],
      ['task_list', { projectId }],
      // The mutation RESPONSES render a task record through the same mapper — a redaction that
      // only covered the obvious read tool would be theatre (the whole class).
      // The edit carries the HOLDER's token (since an earlier task a live claim fences every
      // task_update write) — which also proves a successful holder write does not ECHO the
      // token back through the response.
      ['task_update', { projectId, taskId, claimId: token, description: 'a content edit by the holder' }],
    ];
    for (const [tool, args] of surfaces) {
      const resp = await viaPublicTool(tool, args);
      expect(JSON.stringify(resp), `${tool} must not publish the fencing token`).not.toContain(token);
    }

    // LAYER 1 — THE CHOKE POINT ITSELF. Asserted SEPARATELY from the tool responses above,
    // because the redaction is two-deep (mapTask withholds it; the route no longer reads it)
    // and a test that only checks the outer layer CANNOT GO RED when the inner one regresses
    // — mutation-verified: re-adding `claimId` to mapTask left the end-to-end assertions
    // green. This is the assertion that catches it, and it is the one that matters: every
    // FUTURE read surface is built on this read model.
    const fromHandler: any = (await tasksHandler.listTasks(projectId)).find((t: any) => t.id === taskId);
    expect(fromHandler, 'the task must be in the shared read model').toBeTruthy();
    expect(fromHandler.claimId).toBeUndefined();
    expect(Object.values(fromHandler).map((v) => JSON.stringify(v))).not.toContain(JSON.stringify(token));
    expect(fromHandler.claimActor).toBe('worker-a');
    expect(fromHandler.claimLive).toBe(true);

    // …and the reader is NOT left blind: who / until when / live are all still answerable.
    const details = await viaPublicTool('task_details', { projectId, taskId });
    expect(details.structuredContent.task.claimId).toBeUndefined();
    expect(details.structuredContent.task.claimActor).toBe('worker-a');
    expect(details.structuredContent.task.claimLive).toBe(true);
    expect(details.structuredContent.task.claimExpiresAt).toBeTruthy();
    expect(details.content[0].text).toContain('Claim: LIVE');
    expect(details.content[0].text).toContain('worker-a');
  });

  test('a non-holder cannot take over from anything a public read gives it', async () => {
    const taskId = await makeTask('no takeover');
    const a = await viaPublicTool('task_claim', { projectId, taskId, actor: 'worker-a' });
    const token: string = a.structuredContent.claimId;

    // EVERYTHING worker B can see through the tool contract.
    const details = await viaPublicTool('task_details', { projectId, taskId });
    const visible = Object.values(details.structuredContent.task).map((v) => JSON.stringify(v));
    expect(visible).not.toContain(JSON.stringify(token));

    // B's best attempts with what it actually has: the holder's NAME, and a guess.
    const byName = await viaPublicTool('task_claim', {
      projectId, taskId, actor: 'worker-a', allowedStatuses: ['todo', 'in_progress'],
    });
    expect(byName.structuredContent.claimed).toBe(false);
    expect(byName.structuredContent.reason).toBe('held');

    const byGuess = await viaPublicTool('task_update', {
      projectId, taskId, claimId: randomUUID(), assignedTo: 'worker-b', status: 'completed',
    });
    expect(byGuess.isError).toBe(true);
    // A guessed token against a LIVE claim is `claim-mismatch`: someone else
    // provably owns the task right now, so "re-claim" would not be actionable advice.
    expect(byGuess.structuredContent.reason).toBe('claim-mismatch');

    // ONE live owner, still A.
    const row = await readTask(taskId);
    expect(row.claim_id).toBe(token);
    expect(row.claim_actor).toBe('worker-a');
    expect(row.assigned_to).toBe('worker-a');
    expect(row.status).toBe('in_progress');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════
// CASE 5 — D4. `version` is a lie unless EVERY write bumps it, so the bump lives in a DB
// TRIGGER, not in the claim handler: ordinary task_update, the Command backend, and
// bulkUpdateTasks are all unguarded paths.
// ═══════════════════════════════════════════════════════════════════════════════════════
describe('5. D4 — expectedVersion CAS, and the version bumps on EVERY write path', () => {
  test('a stale expectedVersion is rejected with version-stale; a fresh one succeeds', async () => {
    const taskId = await makeTask('versioned', 'todo', null, 'draft');
    const v0 = (await readTask(taskId)).version;
    // Move the row underneath the caller via an ORDINARY (non-claim) content update.
    await viaPublicTool('task_update', { projectId, taskId, title: 'moved underneath you' });

    const stale = await viaPublicTool('task_claim', { projectId, taskId, actor: 'w', expectedVersion: v0 });
    expect(stale.structuredContent.claimed).toBe(false);
    expect(stale.structuredContent.reason).toBe('version-stale');

    const fresh = (await readTask(taskId)).version;
    expect(fresh).toBeGreaterThan(v0);
    const ok = await viaPublicTool('task_claim', { projectId, taskId, actor: 'w', expectedVersion: fresh });
    expect(ok.structuredContent.claimed).toBe(true);
  });

  test('the TRIGGER owns the bump — a raw SQL update and a bulk update bump it too', async () => {
    const taskId = await makeTask('trigger owns it');
    const v0 = (await readTask(taskId)).version;

    // (a) a raw SQL write that bypasses every handler
    await db.query(`UPDATE tasks SET title = 'raw sql' WHERE id = $1`, [taskId]);
    const v1 = (await readTask(taskId)).version;
    expect(v1).toBe(v0 + 1);

    // (b) the bulk path (its own unguarded UPDATE ... WHERE id = ANY(...))
    await viaPublicTool('task_bulk_update', { projectId, task_ids: [taskId], priority: 'high' });
    const v2 = (await readTask(taskId)).version;
    expect(v2).toBe(v1 + 1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════
// CASE 6 — REAL wall-clock lease expiry (not a hand-edited timestamp): claim with a 1s
// lease, wait it out, and prove the task becomes claimable again with the audit trail.
// ═══════════════════════════════════════════════════════════════════════════════════════
describe('6. a lease actually expires by the clock, and the task becomes reclaimable', () => {
  test('after the lease elapses a NEW worker wins, and the audit shows the transition', async () => {
    TASK_CLAIM_CONFIG.minLeaseSeconds = 1; // let this case buy a 1-second lease
    const taskId = await makeTask('short lease');
    const first = await viaPublicTool('task_claim', { projectId, taskId, actor: 'sprinter', leaseSeconds: 1 });
    expect(first.structuredContent.claimed).toBe(true);

    // While LIVE, a second worker is refused…
    const early = await viaPublicTool('task_claim', {
      projectId, taskId, actor: 'latecomer', allowedStatuses: ['todo', 'in_progress'],
    });
    expect(early.structuredContent.reason).toBe('held');

    await new Promise((r) => setTimeout(r, 1300)); // …wait the lease out (real time)

    const late = await viaPublicTool('task_claim', {
      projectId, taskId, actor: 'latecomer', allowedStatuses: ['todo', 'in_progress'],
    });
    expect(late.structuredContent.claimed).toBe(true);
    expect(late.structuredContent.claimId).not.toBe(first.structuredContent.claimId);

    const evs = await events(taskId);
    const won = evs.filter((e) => e.event_type === 'claim_won');
    expect(won).toHaveLength(2);
    // Newest-first: the reclaim records the PREVIOUS holder's token as previous_claim_id —
    // that link is what makes the takeover legible after the fact.
    expect(won[0].previous_claim_id).toBe(first.structuredContent.claimId);
    expect(won[0].actor).toBe('latecomer');
    expect(won[1].actor).toBe('sprinter');
  }, 15000);
});

// ═══════════════════════════════════════════════════════════════════════════════════════
// CASE 7 — idempotent retry. A holder that re-presents its OWN token gets the SAME claim
// back (never a second token for the same work) and it is not counted as a fresh win.
// ═══════════════════════════════════════════════════════════════════════════════════════
describe('7. idempotent retry with the same claimId', () => {
  test('re-claiming with the held token returns the SAME claim and does not double-count', async () => {
    const taskId = await makeTask('retry me');
    const first = await viaPublicTool('task_claim', { projectId, taskId, actor: 'retrier' });
    const token = first.structuredContent.claimId;

    const retry = await viaPublicTool('task_claim', { projectId, taskId, actor: 'retrier', claimId: token });
    expect(retry.structuredContent.claimed).toBe(true);
    expect(retry.structuredContent.claimId).toBe(token); // SAME token, not a new one
    expect(retry.structuredContent.reentered).toBe(true);

    expect((await readTask(taskId)).claim_id).toBe(token);

    const evs = await events(taskId);
    // Exactly ONE acquisition; the retry is recorded as a re-entry, not a second win.
    expect(evs.filter((e) => e.event_type === 'claim_won')).toHaveLength(1);
    expect(evs.filter((e) => e.event_type === 'claim_reentered')).toHaveLength(1);
  });

  test('re-entry does NOT become a back door to a terminal status (the D1 guard still holds)', async () => {
    const taskId = await makeTask('reentry vs D1');
    const first = await viaPublicTool('task_claim', { projectId, taskId, actor: 'r' });
    const token = first.structuredContent.claimId;
    // Complete it WITHOUT the token (force) so the row keeps its claim columns but goes terminal.
    await viaPublicTool('task_update', { projectId, taskId, status: 'completed', force: true });
    await db.query(`UPDATE tasks SET claim_id = $2, claim_actor = 'r', claim_expires_at = now() + interval '1 hour' WHERE id = $1`, [taskId, token]);

    const retry = await viaPublicTool('task_claim', { projectId, taskId, actor: 'r', claimId: token });
    expect(retry.structuredContent.claimed).toBe(false);
    expect(retry.structuredContent.reason).toBe('wrong-status');
    expect((await readTask(taskId)).status).toBe('completed');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════
// CASE 8 — D3, the fenced lifecycle. This is the case the whole spec revision hinged on:
// without fencing on ORDINARY writes we would have shipped a decorative lock that passes
// its own tests, because the reproduced bug happened THROUGH ordinary update.
// ═══════════════════════════════════════════════════════════════════════════════════════
describe('8. fenced lifecycle — ownership writes are fenced, content edits are not', () => {
  test('a claimless ordinary update CANNOT take ownership of a live-claimed task', async () => {
    const taskId = await makeTask('fenced');
    const held = await viaPublicTool('task_claim', { projectId, taskId, actor: 'holder' });
    expect(held.structuredContent.claimed).toBe(true);

    // THE ORIGINAL BUG, verbatim: a second worker OBSERVES the assignment and writes anyway.
    const stomp = await viaPublicTool('task_update', { projectId, taskId, assignedTo: 'thief', status: 'in_progress' });
    expect(stomp.isError).toBe(true);
    expect(stomp.structuredContent.reason).toBe('held');
    expect(stomp.structuredContent.currentActor).toBe('holder');

    const row = await readTask(taskId);
    expect(row.assigned_to).toBe('holder'); // not evicted
    expect(row.claim_id).toBe(held.structuredContent.claimId);
  });

  /**
   * SEMANTICS SUPERSEDED by an earlier task. This test used to pin "claim ≠ edit lock" —
   * content fields freely editable on a live-claimed task. That carve-out was the
   * field-shaped hole (a forged token touching only progress/metadata walked through it,
   * verified live on the operator tenant 2026-07-28), so the fence now covers EVERY mutation
   * while a claim is LIVE. A dead claim still fences nothing — the lease is the lock's
   * lifetime, not the row's.
   */
  test('CONTENT fields are fenced too while a claim is LIVE; a dead claim fences nothing', async () => {
    const taskId = await makeTask('content fenced while live');
    const held = await viaPublicTool('task_claim', { projectId, taskId, actor: 'holder' });

    // A passer-by content edit during the live claim is REFUSED, typed, zero mutation.
    const edit = await viaPublicTool('task_update', {
      projectId, taskId, title: 'edited by a passer-by', description: 'not fine anymore', priority: 'high',
    });
    expect(edit.isError).toBe(true);
    expect(edit.structuredContent.reason).toBe('held');
    const row = await db.query(`SELECT title, priority FROM tasks WHERE id = $1`, [taskId]);
    expect(row.rows[0].title).toBe('content fenced while live');
    expect(row.rows[0].priority).toBe('medium');

    // The HOLDER edits content by presenting its token.
    const byHolder = await viaPublicTool('task_update', {
      projectId, taskId, claimId: held.structuredContent.claimId, title: 'edited by the holder',
    });
    expect(byHolder.isError).toBeFalsy();
    expect((await db.query(`SELECT title FROM tasks WHERE id = $1`, [taskId])).rows[0].title).toBe('edited by the holder');

    // Once the lease is DEAD, a tokenless content edit lands again (an expired lease is not ownership).
    await expireClaim(taskId);
    const afterExpiry = await viaPublicTool('task_update', { projectId, taskId, priority: 'high' });
    expect(afterExpiry.isError).toBeFalsy();
    expect((await db.query(`SELECT priority FROM tasks WHERE id = $1`, [taskId])).rows[0].priority).toBe('high');
  });

  test('the HOLDER writes ownership fields fine, and the write implicitly RENEWS the lease', async () => {
    const taskId = await makeTask('holder writes');
    const held = await viaPublicTool('task_claim', { projectId, taskId, actor: 'holder' });
    const token = held.structuredContent.claimId;
    // Age the lease so a renewal is measurable, but keep it live.
    await db.query(`UPDATE tasks SET claim_expires_at = now() + interval '5 seconds' WHERE id = $1`, [taskId]);
    const before = (await readTask(taskId)).claim_expires_at;

    const ok = await viaPublicTool('task_update', { projectId, taskId, claimId: token, status: 'blocked', /* a move to `blocked` must now NAME its blocker; 'agent' keeps this fixture's subject unchanged. */ blockedOn: 'agent', });
    expect(ok.isError).toBeFalsy();

    const after = await readTask(taskId);
    expect(after.status).toBe('blocked');
    expect(new Date(after.claim_expires_at).getTime()).toBeGreaterThan(new Date(before).getTime());
    const evs = await events(taskId);
    expect(evs.some((e) => e.event_type === 'claim_renewed')).toBe(true);
  });

  test('an EXPIRED holder\'s completion is refused with claim-mismatch (the zombie double-ship guard)', async () => {
    const taskId = await makeTask('zombie');
    const held = await viaPublicTool('task_claim', { projectId, taskId, actor: 'zombie' });
    const token = held.structuredContent.claimId;
    await expireClaim(taskId);
    // Someone else legitimately picks the work up.
    const reclaimed = await viaPublicTool('task_claim', {
      projectId, taskId, actor: 'successor', allowedStatuses: ['todo', 'in_progress'],
    });
    expect(reclaimed.structuredContent.claimed).toBe(true);

    // The zombie finishes its old build and tries to ship. A LIVE claim (the successor's)
    // exists and the zombie's token is not it → `claim-mismatch` (this was
    // `claim-lost` before the reason taxonomy could tell the two apart).
    const late = await viaPublicTool('task_update', { projectId, taskId, claimId: token, status: 'completed' });
    expect(late.isError).toBe(true);
    expect(late.structuredContent.reason).toBe('claim-mismatch');
    expect((await readTask(taskId)).status).toBe('in_progress'); // not completed by the zombie

    // …and its tokenless CONTENT edit is fenced too while the successor's claim is live
    // (an earlier task — the "content still lands" carve-out was the field-shaped hole).
    const note = await viaPublicTool('task_update', { projectId, taskId, description: 'notes from the zombie' });
    expect(note.isError).toBe(true);
    expect(note.structuredContent.reason).toBe('held');
  });

  test('a fenced COMPLETION by the live holder clears the claim (no task left held forever)', async () => {
    const taskId = await makeTask('fenced completion');
    const held = await viaPublicTool('task_claim', { projectId, taskId, actor: 'finisher' });
    const token = held.structuredContent.claimId;

    const done = await viaPublicTool('task_update', { projectId, taskId, claimId: token, status: 'completed' });
    expect(done.isError).toBeFalsy();

    const row = await readTask(taskId);
    expect(row.status).toBe('completed');
    expect(row.claim_id).toBeNull();
    expect(row.claim_expires_at).toBeNull();
    expect((await events(taskId)).some((e) => e.event_type === 'claim_cleared')).toBe(true);

    // And the completed task is NOT re-claimable (D1 again, from the other direction).
    const revive = await viaPublicTool('task_claim', { projectId, taskId, actor: 'necro' });
    expect(revive.structuredContent.reason).toBe('wrong-status');
  });

  test('an out-of-bounds lease is REJECTED (typed), never silently clamped', async () => {
    const taskId = await makeTask('lease bounds');
    const tooLong = await viaPublicTool('task_claim', {
      projectId, taskId, actor: 'w', leaseSeconds: TASK_CLAIM_CONFIG.maxLeaseSeconds + 1,
    });
    expect(tooLong.structuredContent.claimed).toBe(false);
    expect(tooLong.structuredContent.reason).toBe('lease-out-of-bounds');
    expect((await readTask(taskId)).claim_id).toBeNull(); // nothing was written

    // The bound is read at CALL time from the live config — not frozen into a schema at
    // module load (that split-source drift is what a past incident warns about).
    TASK_CLAIM_CONFIG.minLeaseSeconds = 1;
    const ok = await viaPublicTool('task_claim', { projectId, taskId, actor: 'w', leaseSeconds: 1 });
    expect(ok.structuredContent.claimed).toBe(true);
    expect(ok.structuredContent.leaseSeconds).toBe(1);
  });

  test('release hands the claim back and the next worker can take it', async () => {
    const taskId = await makeTask('released');
    const held = await viaPublicTool('task_claim', { projectId, taskId, actor: 'quitter' });
    const rel = await viaPublicTool('task_release', { projectId, taskId, claimId: held.structuredContent.claimId });
    expect(rel.structuredContent.released).toBe(true);
    expect((await readTask(taskId)).claim_id).toBeNull();

    const next = await viaPublicTool('task_claim', {
      projectId, taskId, actor: 'successor', allowedStatuses: ['todo', 'in_progress'],
    });
    expect(next.structuredContent.claimed).toBe(true);
  });

  test('renew extends a live lease and is refused once the claim is gone', async () => {
    const taskId = await makeTask('renewable');
    const held = await viaPublicTool('task_claim', { projectId, taskId, actor: 'runner' });
    const token = held.structuredContent.claimId;
    await db.query(`UPDATE tasks SET claim_expires_at = now() + interval '5 seconds' WHERE id = $1`, [taskId]);

    const renewed = await viaPublicTool('task_renew', { projectId, taskId, claimId: token });
    expect(renewed.structuredContent.claimed).toBe(true);
    expect(new Date(renewed.structuredContent.expiresAt).getTime()).toBeGreaterThan(Date.now() + 60_000);

    await viaPublicTool('task_release', { projectId, taskId, claimId: token });
    const after = await viaPublicTool('task_renew', { projectId, taskId, claimId: token });
    expect(after.structuredContent.claimed).toBe(false);
    expect(after.structuredContent.reason).toBe('claim-lost');
  });

  test('force:true is the audited human override', async () => {
    const taskId = await makeTask('forced');
    await viaPublicTool('task_claim', { projectId, taskId, actor: 'holder' });

    const forced = await viaPublicTool('task_update', { projectId, taskId, assignedTo: 'operator', force: true });
    expect(forced.isError).toBeFalsy();
    expect((await readTask(taskId)).assigned_to).toBe('operator');
    const ev = (await events(taskId)).find((e) => e.event_type === 'force_override');
    expect(ev, 'a force override MUST leave an audit trail').toBeTruthy();
    expect(ev!.metadata.overroteActor).toBe('holder');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════
// CASE 9 — the audit. Both outcomes are recorded, and the WINNER event is inside the claim
// transaction: if it cannot be written, the claim ROLLS BACK. An unauditable claim is not a
// claim (this deliberately inverts the house error-swallowing stance).
// ═══════════════════════════════════════════════════════════════════════════════════════
describe('9. immutable audit — both outcomes recorded; a winner-audit failure rolls the claim back', () => {
  test('winner and loser events carry actor, claim id, versions, and a SERVER timestamp', async () => {
    const taskId = await makeTask('audited');
    const before = Date.now();
    const win = await viaPublicTool('task_claim', { projectId, taskId, actor: 'auditor-1' });
    const lose = await viaPublicTool('task_claim', {
      projectId, taskId, actor: 'auditor-2', allowedStatuses: ['todo', 'in_progress'],
    });
    expect(win.structuredContent.claimed).toBe(true);
    expect(lose.structuredContent.claimed).toBe(false);

    const evs = await events(taskId);
    const won = evs.find((e) => e.event_type === 'claim_won')!;
    const rejected = evs.find((e) => e.event_type === 'claim_rejected')!;

    expect(won.actor).toBe('auditor-1');
    expect(won.claim_id).toBe(win.structuredContent.claimId);
    expect(won.old_version).toBe(0);
    expect(won.new_version).toBe(1);
    expect(won.expires_at).toBeTruthy();
    // Server time, not client-supplied.
    expect(new Date(won.occurred_at).getTime()).toBeGreaterThanOrEqual(before - 5000); // reserved-port-ok: 5s tolerance in ms, not a port

    expect(rejected.actor).toBe('auditor-2');
    expect(rejected.reason).toBe('held');
    expect(rejected.previous_claim_id).toBe(win.structuredContent.claimId);
  });

  test('WINNER-AUDIT FAILURE ROLLS THE CLAIM BACK — no unaudited claim can exist', async () => {
    const taskId = await makeTask('audit must not fail');
    const spy = vi
      .spyOn(taskClaimService, 'recordEvent')
      .mockRejectedValueOnce(new Error('simulated audit outage'));

    await expect(
      taskClaimService.claim({ taskId, projectId, actor: 'unauditable' }),
    ).rejects.toThrow(/simulated audit outage/);

    // THE PROOF: the guarded UPDATE ran and was then UNDONE with it.
    const row = await readTask(taskId);
    expect(row.claim_id).toBeNull();
    expect(row.status).toBe('todo');
    expect(row.version).toBe(0);
    spy.mockRestore();

    // And the task is still cleanly claimable afterwards (no poisoned state).
    const ok = await viaPublicTool('task_claim', { projectId, taskId, actor: 'later' });
    expect(ok.structuredContent.claimed).toBe(true);
  });

  test('the audit log is IMMUTABLE — an UPDATE against it is refused by the database', async () => {
    const taskId = await makeTask('immutable audit');
    await viaPublicTool('task_claim', { projectId, taskId, actor: 'w' });
    // The datastore error boundary redacts the driver's message before any
    // caller sees it, so `.rejects.toThrow(/…/)` — which matches the CALLER-FACING message —
    // can no longer read the trigger's text. The assertion is UNCHANGED in strength: it still
    // proves Postgres itself refused the UPDATE with OUR trigger's message. It just reads it
    // through the named accessor for raw datastore text instead of through the redacted one.
    let auditErr: unknown;
    try {
      await db.query(`UPDATE task_claim_events SET actor = 'rewritten' WHERE task_id = $1`, [taskId]);
    } catch (e) {
      auditErr = e;
    }
    expect(auditErr, 'the UPDATE was ACCEPTED — the audit log is NOT immutable').toBeTruthy();
    expect(rawDatastoreMessage(auditErr)).toMatch(/immutable audit log/i);
  });

  test('retention pruning is a real mechanism, not a config knob nothing reads', async () => {
    const taskId = await makeTask('prunable');
    await viaPublicTool('task_claim', { projectId, taskId, actor: 'w' });
    // Age an event beyond the window and prune.
    await db.query(
      `INSERT INTO task_claim_events (task_id, project_id, event_type, outcome, occurred_at)
       VALUES ($1, $2, 'claim_won', 'won', now() - interval '400 days')`,
      [taskId, projectId],
    );
    const before = (await events(taskId)).length;
    const deleted = await taskClaimService.pruneEvents(365);
    expect(deleted).toBeGreaterThanOrEqual(1);
    expect((await events(taskId)).length).toBe(before - 1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════
// CASE 10 — the adjacent write paths. Skipping these is exactly how this fix would become
// the next dispatch-claim.ts: a lock that holds on the surface everyone tested.
// ═══════════════════════════════════════════════════════════════════════════════════════
describe('10. adjacent paths — bulk update, archive, restore', () => {
  test('bulk_update SKIPS a live-claimed task, REPORTS it, and still updates the others', async () => {
    const claimed = await makeTask('bulk claimed');
    const free = await makeTask('bulk free');
    await viaPublicTool('task_claim', { projectId, taskId: claimed, actor: 'holder' });

    const resp = await viaPublicTool('task_bulk_update', {
      projectId, task_ids: [claimed, free], status: 'blocked',
      /* a move to `blocked` must now NAME its blocker; 'agent' keeps this fixture's subject unchanged. */ blockedOn: 'agent',
    });
    expect(resp.structuredContent.successfullyUpdated).toBe(1);
    expect(resp.structuredContent.failed).toBe(1);
    expect(resp.structuredContent.updatedTaskIds).toEqual([free]);
    // A skipped row must be VISIBLE — a silent skip is the same lie as a silent stomp.
    expect(resp.structuredContent.errors.join(' ')).toContain(claimed);

    expect((await readTask(claimed)).status).toBe('in_progress'); // untouched
    expect((await readTask(free)).status).toBe('blocked');
  });

  /**
   * SEMANTICS SUPERSEDED by bulk content writes used to sail through a live
   * claim ("not fenced at all") — the same field-shaped hole as task_update, one door over
   * (fix the class). Now EVERY bulk mutation skips + reports a live-claimed row.
   */
  test('bulk_update on CONTENT-only fields is fenced too while a claim is LIVE', async () => {
    const claimed = await makeTask('bulk content');
    await viaPublicTool('task_claim', { projectId, taskId: claimed, actor: 'holder' });
    const resp = await viaPublicTool('task_bulk_update', { projectId, task_ids: [claimed], priority: 'urgent' });
    expect(resp.structuredContent.successfullyUpdated).toBe(0);
    expect(resp.structuredContent.failed).toBe(1);
    expect(resp.structuredContent.errors.join(' ')).toContain(claimed);
    expect((await db.query(`SELECT priority FROM tasks WHERE id = $1`, [claimed])).rows[0].priority).toBe('medium');

    // A DEAD claim fences nothing — the bulk content write lands once the lease expires.
    await expireClaim(claimed);
    const after = await viaPublicTool('task_bulk_update', { projectId, task_ids: [claimed], priority: 'urgent' });
    expect(after.structuredContent.successfullyUpdated).toBe(1);
  });

  test('bulk_update force:true overrides and is audited', async () => {
    const claimed = await makeTask('bulk forced');
    await viaPublicTool('task_claim', { projectId, taskId: claimed, actor: 'holder' });
    const resp = await viaPublicTool('task_bulk_update', {
      projectId, task_ids: [claimed], status: 'blocked', force: true,
      /* a move to `blocked` must now NAME its blocker; 'agent' keeps this fixture's subject unchanged. */ blockedOn: 'agent',
    });
    expect(resp.structuredContent.successfullyUpdated).toBe(1);
    expect((await events(claimed)).some((e) => e.event_type === 'force_override')).toBe(true);
  });

  test('archive REFUSES a live-claimed task with a distinct reason, and force:true overrides', async () => {
    const taskId = await makeTask('archive me');
    await viaPublicTool('task_claim', { projectId, taskId, actor: 'holder' });

    const refused = await viaPublicTool('task_delete', { projectId, taskId });
    expect(refused.isError).toBe(true);
    expect(refused.structuredContent.reason).toBe('held'); // NOT "already archived"
    expect((await readTask(taskId)).archived_at).toBeNull();

    const forced = await viaPublicTool('task_delete', { projectId, taskId, force: true });
    expect(forced.isError).toBeFalsy();
    expect((await readTask(taskId)).archived_at).toBeTruthy();
  });

  test('restore clears a STALE claim so a resurrected task is not born fenced', async () => {
    const taskId = await makeTask('restore me');
    await viaPublicTool('task_claim', { projectId, taskId, actor: 'holder' });
    await viaPublicTool('task_delete', { projectId, taskId, force: true });

    const restored = await viaPublicTool('task_restore', { projectId, taskId });
    expect(restored.isError).toBeFalsy();
    const row = await readTask(taskId);
    expect(row.archived_at).toBeNull();
    expect(row.claim_id).toBeNull();
    expect(row.claim_actor).toBeNull();
  });

  test('an ARCHIVED task cannot be claimed (typed `archived`, not a confusing conflict)', async () => {
    const taskId = await makeTask('archived task');
    await viaPublicTool('task_delete', { projectId, taskId });
    const resp = await viaPublicTool('task_claim', { projectId, taskId, actor: 'w' });
    expect(resp.structuredContent.claimed).toBe(false);
    expect(resp.structuredContent.reason).toBe('archived');
  });

  test('cancel_task is fenced identically (it IS an ownership write)', async () => {
    const taskId = await makeTask('cancel fenced');
    const held = await viaPublicTool('task_claim', { projectId, taskId, actor: 'holder' });
    const blocked = await viaPublicTool('cancel_task', { projectId, taskId });
    expect(blocked.isError).toBe(true);
    expect(blocked.structuredContent.reason).toBe('held');
    // …and the holder can cancel its own work by presenting the token.
    const ok = await viaPublicTool('cancel_task', { projectId, taskId, claimId: held.structuredContent.claimId });
    expect(ok.isError).toBeFalsy();
    expect((await readTask(taskId)).status).toBe('cancelled');
  });

  test('LEGACY == TODAY: with the flag OFF nothing is fenced and claim/renew/release are inert', async () => {
    TASK_CLAIM_CONFIG.enabled = false;
    const taskId = await makeTask('flag off');
    // A claim attempt changes nothing and says so.
    const claim = await viaPublicTool('task_claim', { projectId, taskId, actor: 'w' });
    expect(claim.structuredContent.claimed).toBe(false);
    expect(claim.structuredContent.reason).toBe('disabled');
    expect((await readTask(taskId)).claim_id).toBeNull();

    // Pre-existing claim columns do NOT fence anything while the flag is off.
    await db.query(
      `UPDATE tasks SET claim_id = $2, claim_actor = 'ghost', claim_expires_at = now() + interval '1 hour' WHERE id = $1`,
      [taskId, randomUUID()],
    );
    const update = await viaPublicTool('task_update', { projectId, taskId, status: 'blocked', /* a move to `blocked` must now NAME its blocker; 'agent' keeps this fixture's subject unchanged. */ blockedOn: 'agent', assignedTo: 'anyone' });
    expect(update.isError).toBeFalsy();
    expect((await readTask(taskId)).status).toBe('blocked');
    // A caller that DOES pass a token while the feature is off is TOLD it was inert —
    // silently ignoring a deliberately-passed param is the same class of lie as a silent stomp.
    const withToken = await viaPublicTool('task_update', { projectId, taskId, priority: 'low', claimId: randomUUID() });
    expect(withToken.structuredContent.claimFencing).toBe('disabled');
    const bulk = await viaPublicTool('task_bulk_update', { projectId, task_ids: [taskId], status: 'todo' });
    expect(bulk.structuredContent.successfullyUpdated).toBe(1);
    const archived = await viaPublicTool('task_delete', { projectId, taskId });
    expect(archived.isError).toBeFalsy();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════
// CASE 11 — MUTATION PROBE ([[guards-need-guarding]]). A claim test that passes
// against a BROKEN lock is worse than no test. Each probe below re-runs the same harness the
// cases above use against a deliberately-broken predicate and proves the invariant FAILS —
// i.e. these tests can actually go RED.
// ═══════════════════════════════════════════════════════════════════════════════════════
describe('11. mutation probe — the guards are proven capable of failing', () => {
  /**
   * MUTANT A: the pre-claim behaviour — SELECT-then-UPDATE with no CAS predicate. This is
   * literally today's `task_update` shape (WHERE id ONLY), i.e. the reproduced bug.
   */
  async function brokenClaimNoCas(taskId: string, actor: string): Promise<boolean> {
    const client = await db.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      const read = await client.query(`SELECT claim_id, status FROM tasks WHERE id = $1`, [taskId]);
      const free = read.rows[0].claim_id === null && read.rows[0].status === 'todo';
      // A polite worker even CHECKS first — and still both win, which is the whole point.
      if (!free) {
        await client.query('ROLLBACK');
        return false;
      }
      await new Promise((r) => setTimeout(r, 30)); // widen the window the real CAS closes
      await client.query(
        `UPDATE tasks SET claim_id = $2, claim_actor = $3, claim_expires_at = now() + interval '1 hour',
                          status = 'in_progress', assigned_to = $3
           WHERE id = $1`,
        [taskId, randomUUID(), actor],
      );
      await client.query('COMMIT');
      return true;
    } finally {
      client.release();
    }
  }

  test('PROBE A: with the CAS predicate removed, the 10-worker harness reports MORE THAN ONE winner', async () => {
    const taskId = await makeTask('mutant A');
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => brokenClaimNoCas(taskId, `mutant-${i}`)),
    );
    const winners = results.filter(Boolean).length;
    // The EXACT assertion case 1 makes (=== 1) is what would go RED here. If this ever
    // reports 1, the harness cannot distinguish a working lock from a broken one and case 1
    // proves nothing.
    expect(winners).toBeGreaterThan(1);
  });

  /**
   * MUTANT B: the D1 status guard removed from an otherwise-correct single-statement claim.
   * Proves case 2 is not vacuously green — the guard is what stops the resurrection.
   */
  async function brokenClaimNoStatusGuard(taskId: string, actor: string): Promise<boolean> {
    const r = await db.query(
      `UPDATE tasks
          SET claim_id = $2, claim_actor = $3, claim_expires_at = now() + interval '1 hour',
              status = 'in_progress', assigned_to = $3
        WHERE id = $1
          AND archived_at IS NULL
          AND (claim_id IS NULL OR claim_expires_at <= now())
        RETURNING id`,
      [taskId, randomUUID(), actor],
    );
    return r.rowCount === 1;
  }

  test('PROBE B: with the status guard removed, a COMPLETED task IS resurrected (case 2 can go RED)', async () => {
    const taskId = await makeTask('mutant B', 'completed');
    const won = await brokenClaimNoStatusGuard(taskId, 'necromancer');
    expect(won).toBe(true); // the broken predicate matches a finished task…
    const row = await readTask(taskId);
    expect(row.status).toBe('in_progress'); // …and silently reopens it — the D1 defect, live.

    // Sanity: the REAL claim refuses the very same shape.
    await db.query(
      `UPDATE tasks SET status = 'completed', claim_id = NULL, claim_actor = NULL, claim_expires_at = NULL WHERE id = $1`,
      [taskId],
    );
    const real = await viaPublicTool('task_claim', { projectId, taskId, actor: 'necromancer' });
    expect(real.structuredContent.reason).toBe('wrong-status');
    expect((await readTask(taskId)).status).toBe('completed');
  });

  /**
   * MUTANT C: exclusion keyed on the ACTOR instead of the claim_id (the D2 defect). Two
   * callers sharing a name both "hold" it — proves case 4 is not vacuously green.
   */
  async function brokenClaimActorKeyed(taskId: string, actor: string): Promise<boolean> {
    const r = await db.query(
      `UPDATE tasks
          SET claim_id = $2, claim_actor = $3, claim_expires_at = now() + interval '1 hour',
              status = 'in_progress', assigned_to = $3
        WHERE id = $1
          AND status = ANY(ARRAY['todo','in_progress'])
          AND (claim_id IS NULL OR claim_expires_at <= now() OR claim_actor = $3)
        RETURNING id`,
      [taskId, randomUUID(), actor],
    );
    return r.rowCount === 1;
  }

  test('PROBE C: with the lock keyed on the ACTOR, a same-named second worker also wins (case 4 can go RED)', async () => {
    const taskId = await makeTask('mutant C');
    expect(await brokenClaimActorKeyed(taskId, 'builder')).toBe(true);
    const firstToken = (await readTask(taskId)).claim_id;
    // A DIFFERENT process that merely shares the actor string walks straight in.
    expect(await brokenClaimActorKeyed(taskId, 'builder')).toBe(true);
    expect((await readTask(taskId)).claim_id).not.toBe(firstToken);

    // Sanity: the REAL claim refuses the same second caller (case 4's assertion).
    await db.query(
      `UPDATE tasks SET claim_id = NULL, claim_actor = NULL, claim_expires_at = NULL, status = 'todo' WHERE id = $1`,
      [taskId],
    );
    await viaPublicTool('task_claim', { projectId, taskId, actor: 'builder' });
    const second = await viaPublicTool('task_claim', {
      projectId, taskId, actor: 'builder', allowedStatuses: ['todo', 'in_progress'],
    });
    expect(second.structuredContent.reason).toBe('held');
  });

  /**
   * MUTANT E: the SHIPPED-AND-REJECTED build, verbatim — `tokenToSet = args.claimId ?? uuid()`
   * plus `claim_id = $token`, i.e. the widening gated on the PRESENCE of a token rather than
   * its MATCH. Proves case 4's "a token presented against an UNCLAIMED task is NOT adopted as
   * the lock key" is not vacuously green.
   */
  async function brokenClaimPresenceGated(
    taskId: string, actor: string, presented: string | null, allowed: string[],
  ): Promise<boolean> {
    // The pre-fix code merged reentryStatuses in whenever a token was merely PRESENT…
    const merged = presented ? Array.from(new Set([...allowed, ...TASK_CLAIM_CONFIG.reentryStatuses])) : allowed;
    // …and wrote the presented token straight through as the row's lock key.
    const tokenToSet = presented ?? randomUUID();
    const r = await db.query(
      `UPDATE tasks
          SET claim_id = $2::uuid, claim_actor = $3, claim_expires_at = now() + interval '1 hour',
              status = 'in_progress', assigned_to = $3
        WHERE id = $1
          AND archived_at IS NULL
          AND status = ANY($4::text[])
          AND (claim_id IS NULL OR claim_expires_at <= now() OR claim_id = $5::uuid)
        RETURNING id`,
      [taskId, tokenToSet, actor, merged, presented],
    );
    return r.rowCount === 1;
  }

  test('PROBE E: with the token gated on PRESENCE, a caller PINS the lock key it chose (case 4 can go RED)', async () => {
    const taskId = await makeTask('mutant E');
    const chosen = '00000000-0000-4000-8000-0000000000ee';
    expect(await brokenClaimPresenceGated(taskId, 'client', chosen, ['todo'])).toBe(true);
    // The forgeable lock, live: the row's fence is now a value the CLIENT picked.
    expect((await readTask(taskId)).claim_id).toBe(chosen);

    // Sanity: the REAL claim refuses to adopt it (case 4's assertion).
    await db.query(
      `UPDATE tasks SET claim_id = NULL, claim_actor = NULL, claim_expires_at = NULL, status = 'todo' WHERE id = $1`,
      [taskId],
    );
    const real = await viaPublicTool('task_claim', { projectId, taskId, actor: 'client', claimId: chosen });
    expect(real.structuredContent.claimed).toBe(true);
    expect((await readTask(taskId)).claim_id).not.toBe(chosen);
  });

  test('PROBE F: with the widening gated on PRESENCE, ANY uuid unlocks reentryStatuses (case 4 can go RED)', async () => {
    const taskId = await makeTask('mutant F', 'in_progress');
    // No token → refused by the D1 guard, exactly like the real claim.
    expect(await brokenClaimPresenceGated(taskId, 'x', null, ['todo'])).toBe(false);
    // A RANDOM token → the merged list now contains in_progress, and it walks straight in.
    expect(await brokenClaimPresenceGated(taskId, 'x', randomUUID(), ['todo'])).toBe(true);
    expect((await readTask(taskId)).claim_actor).toBe('x');

    // Sanity: the REAL claim refuses the identical call.
    await db.query(
      `UPDATE tasks SET claim_id = NULL, claim_actor = NULL, claim_expires_at = NULL, status = 'in_progress',
                        assigned_to = NULL WHERE id = $1`,
      [taskId],
    );
    const real = await viaPublicTool('task_claim', { projectId, taskId, actor: 'x', claimId: randomUUID() });
    expect(real.structuredContent.claimed).toBe(false);
    expect(real.structuredContent.reason).toBe('wrong-status');
    expect((await readTask(taskId)).claim_id).toBeNull();
  });

  test('PROBE G: publishing the token on a read IS a takeover path (case 4b can go RED)', async () => {
    const taskId = await makeTask('mutant G');
    const a = await viaPublicTool('task_claim', { projectId, taskId, actor: 'worker-a' });
    const token = a.structuredContent.claimId;

    // MUTANT: the pre-fix read surface handed the raw token to any caller. Simulate exactly
    // that disclosure — nothing else changes — and worker B walks in with it.
    const leaked = (await readTask(taskId)).claim_id; // ← what task_details used to publish
    expect(leaked).toBe(token);

    const takeover = await viaPublicTool('task_update', {
      projectId, taskId, claimId: leaked, assignedTo: 'worker-b', status: 'blocked',
      /* a move to `blocked` must now NAME its blocker; 'agent' keeps this fixture's subject unchanged. */ blockedOn: 'agent',
    });
    expect(takeover.isError).toBeFalsy();                  // the fence opens for a bearer…
    expect((await readTask(taskId)).assigned_to).toBe('worker-b');
    // …and A is STILL a live owner on the same token: two owners, the §1 bug.
    const aStillWrites = await viaPublicTool('task_update', {
      projectId, taskId, claimId: token, assignedTo: 'worker-a',
    });
    expect(aStillWrites.isError).toBeFalsy();

    // Sanity: the disclosure itself is what case 4b removes — no read surface carries it.
    const details = await viaPublicTool('task_details', { projectId, taskId });
    expect(JSON.stringify(details)).not.toContain(token);
  });

  test('PROBE D: the fence assertion is real — removing it lets the stomp through', async () => {
    const taskId = await makeTask('mutant D');
    await viaPublicTool('task_claim', { projectId, taskId, actor: 'holder' });
    // With the fence DISABLED (the pre-claim world), the exact write case 8 rejects succeeds.
    TASK_CLAIM_CONFIG.enabled = false;
    const stomp = await viaPublicTool('task_update', { projectId, taskId, assignedTo: 'thief' });
    expect(stomp.isError).toBeFalsy();
    expect((await readTask(taskId)).assigned_to).toBe('thief'); // the original bug, reproduced
    TASK_CLAIM_CONFIG.enabled = true;
    // …and re-enabled, the same write is refused again.
    const refused = await viaPublicTool('task_update', { projectId, taskId, assignedTo: 'thief-2' });
    expect(refused.isError).toBe(true);
    expect(refused.structuredContent.reason).toBe('held');
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * ACTOR ATTRIBUTION CANNOT BE FORGED (an earlier task / an earlier decision, closing an earlier context
 * — Reviewer B1, 2026-07-25)
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * THE HOLE THESE CASES CLOSE: `claimActor` used to be
 *     normalizeActor(args.actor) ?? normalizeActor(context?.actor) ?? ACTOR_ANONYMOUS
 * — a client-supplied TOOL ARGUMENT outranking the principal derived at the edge. `normalizeActor`
 * passes the composite delimiter through by design, so once composite actors exist a caller could
 * send `actor: '<victim-sub>/<handle>'` and write the VICTIM'S actor into `claim_actor`:
 * cross-principal impersonation manufactured by the very feature that promises it cannot happen.
 *
 * Driven through the PUBLIC tool path with a real RouteContext and asserted on the DB COLUMN,
 * not on a return value — the observable is the row that was actually written.
 */
describe('task_claim — attribution actor cannot be forged (a7e9f00d)', () => {
  const FLAG = ACTOR_IDENTITY_ENV.COMPOSITE_ENABLED;
  let savedFlag: string | undefined;

  const VICTIM_PRINCIPAL = 'victim@example.com';
  const VICTIM_COMPOSITE = `${VICTIM_PRINCIPAL}/coordinator`;
  const ATTACKER_COMPOSITE = 'attacker@evil.com/worker-1';

  /** Drive the real tool path as a caller whose edge-derived actor is `actor`. */
  async function claimAs(actor: string | undefined, rawArgs: any): Promise<any> {
    const validated = validateToolArguments('task_claim', rawArgs);
    return routeExecutor('task_claim', validated, { actor });
  }

  beforeAll(() => {
    savedFlag = process.env[FLAG];
  });
  afterAll(() => {
    if (savedFlag === undefined) delete process.env[FLAG];
    else process.env[FLAG] = savedFlag;
  });

  test('COMPOSITE ON: a declared actor naming the VICTIM cannot write the victim’s actor', async () => {
    process.env[FLAG] = 'true';
    const taskId = await makeTask('forgery target');

    const res = await claimAs(ATTACKER_COMPOSITE, { projectId, taskId, actor: VICTIM_COMPOSITE });
    expect(res.isError).toBeFalsy();

    const written = (await readTask(taskId)).claim_actor as string;
    // THE ASSERTION THAT WAS MISSING FROM ALL 161 SUITE FILES:
    expect(written).not.toBe(VICTIM_COMPOSITE);
    // …and it is still rooted in the ATTACKER's OWN principal — declared data refined the
    // HANDLE segment, it did not replace the PRINCIPAL, so attribution stays honest rather
    // than merely non-forgeable. The victim's principal cannot appear in the principal slot.
    expect(written.startsWith('attacker@evil.com/')).toBe(true);
    expect(written.split('/')[0]).not.toContain(VICTIM_PRINCIPAL);
  });

  test('COMPOSITE ON: the declared handle is SCOPED under the derived principal (refine, not replace)', async () => {
    process.env[FLAG] = 'true';
    const taskId = await makeTask('scoped attribution');
    await claimAs('operator@example.com/coordinator', { projectId, taskId, actor: 'builder-a1b2c3d4' });
    // The declared handle replaces the HANDLE segment under the caller's own PRINCIPAL — it
    // does NOT nest a third segment, and it does NOT re-encode the already-derived actor
    // (`operator@example.com%2Fcoordinator/…` would be the double-derivation bug).
    expect((await readTask(taskId)).claim_actor).toBe('operator@example.com/builder-a1b2c3d4');
  });

  test('COMPOSITE OFF (the shipped default): the derived principal WINS — declared never replaces it', async () => {
    delete process.env[FLAG];
    const taskId = await makeTask('precedence default');
    await claimAs('coordinator', { projectId, taskId, actor: 'somebody-else' });
    // Before this task the row would have read 'somebody-else' — unauthenticated say-so.
    expect((await readTask(taskId)).claim_actor).toBe('coordinator');
  });

  test('a caller with NO derived principal still gets its declared handle (dispatcher path preserved)', async () => {
    delete process.env[FLAG];
    const taskId = await makeTask('no principal');
    await claimAs(undefined, { projectId, taskId, actor: 'builder-0803f00d' });
    expect((await readTask(taskId)).claim_actor).toBe('builder-0803f00d');
  });

  /**
   * REVIEWER N2 — `tasks.claim_actor` is varchar(200) and Postgres does NOT truncate, it raises
   * 22001. The caller-supplied arg is zod-capped, but the DERIVED composite is not, so a long sub
   * plus a handle would surface a raw driver error on an unrelated-looking write.
   */
  test('an over-long derived actor fails LOUD with an actionable error, not a raw PG 22001', async () => {
    process.env[FLAG] = 'true';
    const taskId = await makeTask('over-long actor');
    const longPrincipal = `${'a'.repeat(190)}@example.com`; // 202 chars before any handle
    const res = await claimAs(longPrincipal, { projectId, taskId, actor: 'w' });
    expect(res.isError).toBe(true);
    const text = JSON.stringify(res);
    expect(text).toContain('exceeds');
    expect(text).not.toContain('22001');
    expect(text).not.toContain('value too long');
    // …and nothing was written.
    expect((await readTask(taskId)).claim_actor).toBeNull();
  });
});
