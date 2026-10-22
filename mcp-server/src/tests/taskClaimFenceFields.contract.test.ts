/**
 * CLAIM FENCE — THE FIELD-SHAPED HOLE. Contract tests.
 *
 * THE DEFECT THIS CLOSES, both halves verified live on the operator tenant 2026-07-28:
 *   1. During a LIVE claim held by A, a task_update from B carrying a FORGED claimId that
 *      only touched `progress`/`metadata` was ACCEPTED AND PERSISTED ("✅ Progress: 77%") —
 *      the fence predicate was gated on touchesOwnership(status, assignedTo), so every
 *      other field walked around it.
 *   2. On an UNCLAIMED task, a supplied (invalid) claimId was silently ignored entirely —
 *      an ownership assertion dropped on the floor.
 *
 * THE RULE NOW (see claimFenceClause + updateTaskStatus):
 *   • a supplied claimId is an OWNERSHIP ASSERTION, validated on EVERY update regardless of
 *     fields; invalid ⇒ typed rejection (claim-mismatch / claim-expired / claim-lost) with
 *     ZERO mutation;
 *   • while a claim is LIVE, EVERY task_update mutation requires the valid token or the
 *     audited force:true override;
 *   • the fence is CONDITIONAL MUTATION — the claim predicates live in the UPDATE's WHERE,
 *     never a check-then-update;
 *   • BEARER POLICY (pinned, do not relitigate): the token is a bearer secret; a VALID
 *     token presented by a DIFFERENT resolved actor IS authorized (b3bfd5f3 accepted
 *     residual — actor-string binding was rejected as a decorative lock);
 *   • all under TASK_CLAIM_CONFIG.enabled — flag off keeps today's inert-echo contract.
 *
 * Driven through the PUBLIC tool path (validate → routeExecutor) against the real disposable
 * CI database, the taskAtomicClaim.contract.test.ts house pattern. Mutation probes (§P) are
 * in-suite replicas of the two broken shapes, proving the green cases above are capable of
 * going RED (a past incident / CLASSES.md C3).
 */

import { describe, test, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';

import { db } from '../config/database.js';
import { validateToolArguments } from '../middleware/validation.js';
import { routeExecutor } from '../routes/index.js';
import { TASK_CLAIM_CONFIG } from '../config/claimConfig.js';
import { taskClaimService } from '../services/taskClaim.js';
import { logger } from '../utils/logger.js';

const STAMP = Date.now();
const PROJ_NAME = `claimfence-${STAMP}`;
let projectId: string;

const SAVED = { ...TASK_CLAIM_CONFIG };

/** Drive the real tool path; `actor` is the edge-derived attribution (RouteContext). */
async function viaPublicTool(toolName: string, rawArgs: any, actor?: string): Promise<any> {
  const validated = validateToolArguments(toolName, rawArgs);
  return routeExecutor(toolName, validated, actor === undefined ? undefined : { actor });
}

// STAGE COLUMN PINNED TO 'draft' (an earlier task clause 10): a bare INSERT naming no `stage`
// column is backfilled to 'ready' by the tasks_sync_stage_status trigger (migration 101,
// status='todo' -> stage='ready'). The completeness gate now keys on the MERGED row's
// stage, so an unrelated field write against such a row would be correctly refused (ready,
// no punch fields) — a gate concern these claim-fence tests are not exercising. NOTE: the
// `'{"stage":"original"}'::jsonb` metadata literal below is an unrelated JSON key inside
// `metadata`, not the `tasks.stage` column.
async function makeTask(title: string, status = 'todo'): Promise<string> {
  const r = await db.query(
    `INSERT INTO tasks (project_id, title, type, priority, status, stage, progress, metadata)
     VALUES ($1, $2, 'general', 'medium', $3, 'draft', 10, '{"stage":"original"}'::jsonb) RETURNING id`,
    [projectId, title, status],
  );
  return r.rows[0].id;
}

/** The FULL row image a rejected write must leave untouched (data + metadata + version + timestamps). */
async function rowImage(taskId: string) {
  const r = await db.query(
    `SELECT title, description, status, priority, progress, assigned_to, tags, metadata,
            version, updated_at, claim_id::text AS claim_id, claim_actor, claim_expires_at
       FROM tasks WHERE id = $1`,
    [taskId],
  );
  return r.rows[0];
}

/** Force a claim's lease into the past WITHOUT touching the token — deterministic expiry. */
async function expireClaim(taskId: string): Promise<void> {
  await db.query(`UPDATE tasks SET claim_expires_at = now() - interval '1 second' WHERE id = $1`, [taskId]);
}

async function claimAs(actor: string, taskId: string): Promise<string> {
  const r = await viaPublicTool('task_claim', { projectId, taskId }, actor);
  expect(r.structuredContent.claimed, `claim by ${actor} must succeed`).toBe(true);
  return r.structuredContent.claimId;
}

async function events(taskId: string) {
  return taskClaimService.listEvents(taskId, 100);
}

beforeAll(async () => {
  projectId = (
    await db.query(`INSERT INTO projects (name, description) VALUES ($1, 'claim fence fields') RETURNING id`, [PROJ_NAME])
  ).rows[0].id;
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
// 1. THE LIVE-TENANT REPRO, REFUSED — a forged token touching ONLY progress/metadata
// ═══════════════════════════════════════════════════════════════════════════════════════
describe('1. the reproduced defect — forged token on non-ownership fields during a live claim', () => {
  test('B\'s forged-token progress/metadata write is rejected TYPED with ZERO mutation', async () => {
    const taskId = await makeTask('the 77% task');
    await claimAs('worker-a', taskId);
    const before = await rowImage(taskId);

    const warnSpy = vi.spyOn(logger, 'warn');

    // The exact live repro: only progress + metadata, forged claimId, different caller.
    const resp = await viaPublicTool(
      'task_update',
      { projectId, taskId, claimId: randomUUID(), progress: 77, metadata: { stage: 'stolen' } },
      'worker-b',
    );
    expect(resp.isError).toBe(true);
    // A LIVE claim exists and the token is not it — the sharp reason, not the generic one.
    expect(resp.structuredContent.reason).toBe('claim-mismatch');

    // ZERO mutation, asserted on the row itself: data, metadata, version, updated_at.
    const after = await rowImage(taskId);
    expect(after).toEqual(before);
    expect(after.progress).toBe(10);
    expect(after.metadata).toEqual({ stage: 'original' });

    // The rejected forgery is WARN-logged with tool + task (item 6; token value withheld).
    const call = warnSpy.mock.calls.find(([msg]) => String(msg).includes('fence rejected'));
    expect(call, 'a rejected presented token must be WARN-logged').toBeTruthy();
    expect(JSON.stringify(call![1])).toContain(taskId);
    expect(JSON.stringify(call![1])).toContain('task_update');

    // …and audited as fence_rejected with the typed reason.
    const ev = (await events(taskId)).find((e) => e.event_type === 'fence_rejected');
    expect(ev).toBeTruthy();
    expect(ev!.reason).toBe('claim-mismatch');
  });

  test('a MISSING token during a live claim fences non-ownership fields too (typed `held`)', async () => {
    const taskId = await makeTask('tokenless content write');
    await claimAs('worker-a', taskId);
    const before = await rowImage(taskId);

    const resp = await viaPublicTool('task_update', { projectId, taskId, progress: 50, title: 'sneaky' }, 'worker-b');
    expect(resp.isError).toBe(true);
    expect(resp.structuredContent.reason).toBe('held');
    expect(resp.structuredContent.currentActor).toBe('worker-a');
    expect(await rowImage(taskId)).toEqual(before);
  });

  test('wrong token from the SAME actor string is rejected identically (the actor is never the key)', async () => {
    const taskId = await makeTask('same-name forgery');
    await claimAs('worker-a', taskId);
    const before = await rowImage(taskId);

    const resp = await viaPublicTool('task_update', { projectId, taskId, claimId: randomUUID(), progress: 90 }, 'worker-a');
    expect(resp.isError).toBe(true);
    expect(resp.structuredContent.reason).toBe('claim-mismatch');
    expect(await rowImage(taskId)).toEqual(before);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════
// 2. THE SECOND HALF — an invalid token on an UNCLAIMED task is never silently ignored
// ═══════════════════════════════════════════════════════════════════════════════════════
describe('2. a supplied claimId is an ownership assertion on EVERY update', () => {
  test('an invalid token on an UNCLAIMED task → typed claim-lost, ZERO mutation (was: silently ignored)', async () => {
    const taskId = await makeTask('unclaimed, bogus token');
    const before = await rowImage(taskId);
    expect(before.claim_id).toBeNull(); // genuinely unclaimed — the population that slipped through

    const resp = await viaPublicTool('task_update', { projectId, taskId, claimId: randomUUID(), progress: 55 });
    expect(resp.isError).toBe(true);
    expect(resp.structuredContent.reason).toBe('claim-lost');
    expect(await rowImage(taskId)).toEqual(before);
  });

  test('an EXPIRED token (still on the row) → typed claim-expired, ZERO mutation', async () => {
    const taskId = await makeTask('expired token');
    const token = await claimAs('slowpoke', taskId);
    await expireClaim(taskId);
    const before = await rowImage(taskId);

    const resp = await viaPublicTool('task_update', { projectId, taskId, claimId: token, progress: 99 }, 'slowpoke');
    expect(resp.isError).toBe(true);
    // Distinguishable from claim-lost: the row still carries this very token, dead.
    expect(resp.structuredContent.reason).toBe('claim-expired');
    expect(await rowImage(taskId)).toEqual(before);
  });

  test('a RELEASED token → typed claim-lost, ZERO mutation; the release itself is fenced + readable', async () => {
    const taskId = await makeTask('released token');
    const token = await claimAs('quitter', taskId);

    // RELEASE FENCING PIN (item 5): a WRONG token cannot release…
    const badRelease = await viaPublicTool('task_release', { projectId, taskId, claimId: randomUUID() });
    expect(badRelease.structuredContent.released).toBeUndefined();
    expect(badRelease.structuredContent.reason).toBe('claim-lost');

    // …the REAL token can, and the no-live-claim state is readable through the tool contract.
    const rel = await viaPublicTool('task_release', { projectId, taskId, claimId: token });
    expect(rel.structuredContent.released).toBe(true);
    const details = await viaPublicTool('task_details', { projectId, taskId });
    expect(details.structuredContent.task.claimLive).toBeFalsy();

    // The released token now buys nothing on an update.
    const before = await rowImage(taskId);
    const resp = await viaPublicTool('task_update', { projectId, taskId, claimId: token, progress: 42 }, 'quitter');
    expect(resp.isError).toBe(true);
    expect(resp.structuredContent.reason).toBe('claim-lost');
    expect(await rowImage(taskId)).toEqual(before);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════
// 3. WHO IS AUTHORIZED — holder, bearer, force
// ═══════════════════════════════════════════════════════════════════════════════════════
describe('3. authorization — valid token accepted; bearer policy pinned; force audited', () => {
  test('the holder (correct token, correct actor) updates any field and implicitly renews', async () => {
    const taskId = await makeTask('holder writes');
    const token = await claimAs('worker-a', taskId);
    await db.query(`UPDATE tasks SET claim_expires_at = now() + interval '5 seconds' WHERE id = $1`, [taskId]);
    const leaseBefore = (await rowImage(taskId)).claim_expires_at;

    const resp = await viaPublicTool(
      'task_update',
      { projectId, taskId, claimId: token, progress: 60, metadata: { stage: 'working' }, title: 'renamed by holder' },
      'worker-a',
    );
    expect(resp.isError).toBeFalsy();
    const after = await rowImage(taskId);
    expect(after.progress).toBe(60);
    expect(after.metadata).toEqual({ stage: 'working' });
    expect(after.title).toBe('renamed by holder');
    // The holder write implicitly RENEWED the lease.
    expect(new Date(after.claim_expires_at).getTime()).toBeGreaterThan(new Date(leaseBefore).getTime());
  });

  /**
   * BEARER POLICY — DECIDED (an earlier task pin; b3bfd5f3 accepted residual). The token is a
   * bearer secret: a VALID token presented by a DIFFERENT resolved actor IS authorized.
   * Binding the fence to the actor string was rejected as a decorative lock (free-form
   * varchar, no registry — two workers sharing a name would both "hold" it). Secrecy is
   * enforced on the READ side instead: no surface publishes the token (case 4b of the main
   * claim suite). If this test starts failing because someone added an actor check, that is
   * a POLICY change, not a bug fix — take it back to a decision first.
   */
  test('BEARER PIN: a valid token presented by a DIFFERENT resolved actor is authorized', async () => {
    const taskId = await makeTask('bearer handoff');
    const token = await claimAs('worker-a', taskId);

    const resp = await viaPublicTool(
      'task_update',
      { projectId, taskId, claimId: token, progress: 80, status: 'blocked', /* a move to `blocked` must now NAME its blocker; 'agent' keeps this fixture's subject unchanged. */ blockedOn: 'agent', },
      'worker-b', // a different principal, presenting A's real token
    );
    expect(resp.isError).toBeFalsy();
    const after = await rowImage(taskId);
    expect(after.progress).toBe(80);
    expect(after.status).toBe('blocked');
    // Attribution is untouched by the bearer write: the claim still names its winner.
    expect(after.claim_actor).toBe('worker-a');
    expect(after.claim_id).toBe(token);
  });

  /**
   * FORCE, PINNED HONESTLY: force:true is NOT gated on any identity — any caller may pass it
   * (it exists for humans on the dashboard). The control is the AUDIT, not a gate: every
   * force that overrode a live claim writes a force_override event attributing the
   * overrider. There is no "unauthorized force" concept today; if one is added it must come
   * through a decision, and this comment is where the current contract is stated.
   */
  test('force:true overrides ANY field during a live claim and is audited with the forcing actor', async () => {
    const taskId = await makeTask('forced content');
    await claimAs('worker-a', taskId);

    const resp = await viaPublicTool(
      'task_update',
      { projectId, taskId, force: true, progress: 100, metadata: { stage: 'forced' } },
      'operator',
    );
    expect(resp.isError).toBeFalsy();
    const after = await rowImage(taskId);
    expect(after.progress).toBe(100);
    expect(after.metadata).toEqual({ stage: 'forced' });

    const ev = (await events(taskId)).find((e) => e.event_type === 'force_override');
    expect(ev, 'a force override of a live claim MUST leave an audit trail').toBeTruthy();
    expect(ev!.actor).toBe('operator');
    expect(ev!.metadata.overroteActor).toBe('worker-a');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════
// 4. CONDITIONAL MUTATION — the predicate lives in the WHERE; a renewal racing an update
//    is transactionally safe
// ═══════════════════════════════════════════════════════════════════════════════════════
describe('4. conditional mutation and the renew/update race', () => {
  test('a renewal racing a holder update: both single statements land, no torn state', async () => {
    const taskId = await makeTask('renew races update');
    const token = await claimAs('runner', taskId);
    await db.query(`UPDATE tasks SET claim_expires_at = now() + interval '5 seconds' WHERE id = $1`, [taskId]);

    // Both are single guarded UPDATEs on the same row: under READ COMMITTED they serialize
    // on the row lock and the second re-evaluates its predicate against the first's
    // committed image (the same EvalPlanQual property CLAIM_SQL rests on). Neither can
    // observe a half-applied peer, in either order.
    const [renewed, updated] = await Promise.all([
      viaPublicTool('task_renew', { projectId, taskId, claimId: token }),
      viaPublicTool('task_update', { projectId, taskId, claimId: token, status: 'blocked', /* a move to `blocked` must now NAME its blocker; 'agent' keeps this fixture's subject unchanged. */ blockedOn: 'agent', progress: 30 }, 'runner'),
    ]);
    expect(renewed.structuredContent.claimed).toBe(true);
    expect(updated.isError).toBeFalsy();

    const after = await rowImage(taskId);
    expect(after.status).toBe('blocked');
    expect(after.progress).toBe(30);
    expect(after.claim_id).toBe(token); // same claim throughout — no re-mint, no clear
    expect(new Date(after.claim_expires_at).getTime()).toBeGreaterThan(Date.now());
  });

  test('a forged write racing the holder\'s write cannot interleave a partial mutation', async () => {
    const taskId = await makeTask('forged vs holder race');
    const token = await claimAs('holder', taskId);

    const [forged, real] = await Promise.all([
      viaPublicTool('task_update', { projectId, taskId, claimId: randomUUID(), progress: 1, title: 'forged' }, 'thief'),
      viaPublicTool('task_update', { projectId, taskId, claimId: token, progress: 70 }, 'holder'),
    ]);
    expect(forged.isError).toBe(true);
    expect(real.isError).toBeFalsy();

    const after = await rowImage(taskId);
    expect(after.progress).toBe(70);         // only the holder's write landed
    expect(after.title).toBe('forged vs holder race'); // no partial forged field slipped in
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════
// 5. FLAG OFF — today's inert-echo contract, byte-for-byte
// ═══════════════════════════════════════════════════════════════════════════════════════
describe('5. TASK_CLAIM_CONFIG.enabled=false keeps today\'s behaviour', () => {
  test('with the flag OFF a forged token on any fields is INERT (echoed, not enforced)', async () => {
    TASK_CLAIM_CONFIG.enabled = false;
    const taskId = await makeTask('flag off');
    // Even with live-looking claim columns on the row, nothing fences and nothing validates.
    await db.query(
      `UPDATE tasks SET claim_id = $2, claim_actor = 'ghost', claim_expires_at = now() + interval '1 hour' WHERE id = $1`,
      [taskId, randomUUID()],
    );

    const resp = await viaPublicTool('task_update', {
      projectId, taskId, claimId: randomUUID(), progress: 77, metadata: { stage: 'flag-off' },
    });
    expect(resp.isError).toBeFalsy();
    // The write LANDED (today's behaviour)…
    const after = await rowImage(taskId);
    expect(after.progress).toBe(77);
    expect(after.metadata).toEqual({ stage: 'flag-off' });
    // …and the deliberately-passed token is disclosed as inert, not silently swallowed.
    expect(resp.structuredContent.claimFencing).toBe('disabled');

    // No fence audit rows, no fence errors — the claim machinery stayed out of the path.
    expect((await events(taskId)).filter((e) => e.event_type === 'fence_rejected')).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════
// P. MUTATION PROBES — the two broken shapes, live, proving the suite can go RED
//    (in-suite replicas per the house style; the real-code mutations were ALSO run during
//    the build — see the an earlier task report — with the same outcomes.)
// ═══════════════════════════════════════════════════════════════════════════════════════
describe('P. mutation probes', () => {
  /**
   * PROBE A — the WHERE predicate with the claim_id match DROPPED (liveness kept). This is
   * the "weaken the fence SQL" mutation: any token sails through a live claim as long as
   * SOME live claim exists.
   */
  test('PROBE A: dropping the claim_id match from the WHERE lets a FORGED token write (case 1 can go RED)', async () => {
    const taskId = await makeTask('mutant: no claim_id match');
    await claimAs('worker-a', taskId);

    // The broken predicate: `claim_expires_at > now()` alone — token never compared.
    const broken = await db.query(
      `UPDATE tasks SET progress = 77
        WHERE id = $1 AND claim_expires_at > now()
        RETURNING id`,
      [taskId],
    );
    expect(broken.rowCount, 'the weakened predicate accepts the forged write').toBe(1);
    expect((await rowImage(taskId)).progress).toBe(77); // the mutation LANDED — the defect, live

    // CONTROL: the real surface refuses the identical forged shape on the same row.
    const real = await viaPublicTool('task_update', { projectId, taskId, claimId: randomUUID(), progress: 88 }, 'worker-b');
    expect(real.isError).toBe(true);
    expect(real.structuredContent.reason).toBe('claim-mismatch');
    expect((await rowImage(taskId)).progress).toBe(77); // unchanged by the refused call
  });

  /**
   * PROBE B — the ownership-fields-only gate, verbatim (the SHIPPED defect): fencing applied
   * only when status/assignedTo were touched, so a progress/metadata write got NO fence
   * clause at all.
   */
  async function brokenOwnershipOnlyUpdate(
    taskId: string,
    fields: { progress?: number; status?: string },
    presentedClaimId: string | null,
  ): Promise<boolean> {
    const touchesOwnership = fields.status !== undefined; // the old predicate (assignedTo omitted: not used here)
    const sets: string[] = ['updated_at = CURRENT_TIMESTAMP'];
    const params: any[] = [];
    let i = 1;
    if (fields.progress !== undefined) { sets.push(`progress = $${i++}`); params.push(fields.progress); }
    if (fields.status !== undefined) { sets.push(`status = $${i++}`); params.push(fields.status); }
    params.push(taskId);
    const idIdx = i++;
    let fence = '';
    if (TASK_CLAIM_CONFIG.enabled && touchesOwnership) {
      if (presentedClaimId) { fence = ` AND claim_id = $${i++}::uuid AND claim_expires_at > now()`; params.push(presentedClaimId); }
      else fence = ' AND (claim_id IS NULL OR claim_expires_at <= now())';
    }
    const r = await db.query(`UPDATE tasks SET ${sets.join(', ')} WHERE id = $${idIdx}${fence} RETURNING id`, params);
    return r.rowCount === 1;
  }

  test('PROBE B: the ownership-only gate accepts the forged progress write (cases 1+2 can go RED)', async () => {
    const taskId = await makeTask('mutant: ownership-only gate');
    await claimAs('worker-a', taskId);

    // The live-tenant repro against the OLD gate: forged token, progress only → no fence at all.
    expect(await brokenOwnershipOnlyUpdate(taskId, { progress: 77 }, randomUUID())).toBe(true);
    expect((await rowImage(taskId)).progress).toBe(77); // the "✅ Progress: 77%" defect, reproduced

    // The SAME old gate still fences an ownership write — which is exactly why the hole
    // survived review: the tested shape was covered, the untested one was the defect.
    expect(await brokenOwnershipOnlyUpdate(taskId, { status: 'blocked' }, randomUUID())).toBe(false);

    // CONTROL: the real surface refuses the forged progress write on the same row.
    const real = await viaPublicTool('task_update', { projectId, taskId, claimId: randomUUID(), progress: 33 }, 'worker-b');
    expect(real.isError).toBe(true);
    expect(real.structuredContent.reason).toBe('claim-mismatch');
    expect((await rowImage(taskId)).progress).toBe(77);
  });

  test('PROBE C: the unclaimed-task silent-ignore, reproduced against the old gate (case 2 can go RED)', async () => {
    const taskId = await makeTask('mutant: silent ignore');
    expect((await rowImage(taskId)).claim_id).toBeNull();

    // Old gate + unclaimed row + bogus token + content field ⇒ the token is never examined.
    expect(await brokenOwnershipOnlyUpdate(taskId, { progress: 55 }, randomUUID())).toBe(true);
    expect((await rowImage(taskId)).progress).toBe(55); // silently accepted — the defect, live

    // CONTROL: the real surface types it as claim-lost and changes nothing.
    const before = await rowImage(taskId);
    const real = await viaPublicTool('task_update', { projectId, taskId, claimId: randomUUID(), progress: 66 });
    expect(real.isError).toBe(true);
    expect(real.structuredContent.reason).toBe('claim-lost');
    expect(await rowImage(taskId)).toEqual(before);
  });
});
