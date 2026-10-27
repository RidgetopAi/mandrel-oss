/**
 * CLAIM FLAG — THE NAIVE-CLIENT PROPERTY. Contract tests.
 *
 * WHAT THIS PINS, AND WHY A CONFIG ROW DEPENDS ON IT
 *   docker-compose.yml defaults MANDREL_TASK_CLAIM_ENABLED to true for every instance that
 *   does not set it. That default is only safe because of ONE property, measured here
 *   rather than reasoned (2026-09-05, batch 15 lane H):
 *
 *     enabling the claim feature changes NOTHING observable for a client that never calls
 *     task_claim and never passes claimId/force.
 *
 *   The default was held back until this was driven. The instinct against it was that it looked
 *   like an earlier task — MANDREL_SESSION_REQUIRE_ACTOR shipped enforcing and 403'd a live
 *   customer's 88 writes in 14 days. The measurement showed the two flags have OPPOSITE
 *   POLARITY, and that is the whole argument:
 *
 *     REQUIRE_ACTOR fences on the ABSENCE of a header  -> a naive client breaks IMMEDIATELY,
 *                                                         with no opt-in anywhere.
 *     TASK_CLAIM    fences on the PRESENCE of a claim  -> and a claim exists ONLY because
 *                                                         somebody called task_claim.
 *
 *   So a tenant whose client never claims carries claim_id IS NULL on every row forever, and
 *   every fence predicate (claim_id IS NULL OR claim_expires_at <= now()) is trivially true.
 *
 * IF THIS SUITE GOES RED, THE DEFAULT IS NO LONGER SAFE. Do not fix the test: the fence
 *   polarity changed, and the compose is now shipping a customer-breaking default. Flip the
 *   MANDREL_TASK_CLAIM_ENABLED default in the same commit.
 *
 * THE POPULATION (state it, per C3)
 *   The four mutating task surfaces a naive client can reach — task_update (plain field),
 *   task_update (status), task_bulk_update, task_delete — each driven through the PUBLIC tool
 *   path (validate -> routeExecutor) against the real disposable CI database, with the flag
 *   OFF and ON. Plus the response PAYLOAD, which is a separate observable from the row.
 *   NOT in the population: task_claim/renew/release themselves. Their behaviour DOES differ
 *   by design, and a naive client does not call them — that is what "naive" means here.
 *
 * NON-VACUITY. §M6 pairs its identity assertion with a CONTROL that DOES differ (a client
 *   passing claimId sees 'disabled' vs 'claim-lost'), so "the two payloads matched" cannot be
 *   green because the check is blind. §M5's two halves do the same job for the row state.
 *
 * WITNESS CHANNEL: process.stdout.write, not console.*, so the measured values survive
 *   whatever the suite's console configuration is (CLASSES.md C3).
 */
import { describe, test, expect, beforeAll, afterAll } from 'vitest';

import { db } from '../config/database.js';
import { validateToolArguments } from '../middleware/validation.js';
import { routeExecutor } from '../routes/index.js';
import { TASK_CLAIM_CONFIG } from '../config/claimConfig.js';

const STAMP = Date.now();
let projectId: string;
const SAVED = { ...TASK_CLAIM_CONFIG };

function say(line: string) { process.stdout.write(`MEASURE ${line}\n`); }

async function tool(name: string, args: any, actor?: string): Promise<any> {
  const validated = validateToolArguments(name, args);
  return routeExecutor(name, validated, actor === undefined ? undefined : { actor });
}
async function makeTask(title: string): Promise<string> {
  const r = await db.query(
    `INSERT INTO tasks (project_id, title, type, priority, status, progress)
     VALUES ($1,$2,'general','medium','todo',10) RETURNING id`, [projectId, title]);
  return r.rows[0].id;
}
async function row(id: string) {
  const r = await db.query(
    `SELECT status, progress, version, claim_id::text AS claim_id FROM tasks WHERE id=$1`, [id]);
  return r.rows[0];
}
/** THE NAIVE CLIENT: never claims, never sends claimId or force. */
async function naiveUpdate(taskId: string, patch: any) {
  try { return { ok: true, res: await tool('task_update', { projectId, taskId, ...patch }, 'naive-client') }; }
  catch (e: any) { return { ok: false, err: String(e?.message ?? e), res: undefined as any }; }
}

beforeAll(async () => {
  const p = await db.query(
    `INSERT INTO projects (name, description) VALUES ($1,'claim flag naive-client contract') RETURNING id`,
    [`claimflag-${STAMP}`]);
  projectId = p.rows[0].id;
});
afterAll(async () => { Object.assign(TASK_CLAIM_CONFIG, SAVED); });

describe('M0 — a claim cannot come into existence unless a client calls task_claim', () => {
  test('flag OFF: task_claim answers `disabled` and writes no claim_id', async () => {
    Object.assign(TASK_CLAIM_CONFIG, SAVED, { enabled: false });
    const t = await makeTask('m0-off');
    const r = await tool('task_claim', { projectId, taskId: t }, 'other-agent');
    const after = await row(t);
    say(`[M0 OFF] task_claim -> claimed=${r.structuredContent?.claimed} reason=${r.structuredContent?.reason}; claim_id=${after.claim_id}`);
    expect(r.structuredContent?.claimed).toBe(false);
    expect(after.claim_id).toBeNull();
  });
  test('flag ON: task_claim succeeds — it is the one door', async () => {
    Object.assign(TASK_CLAIM_CONFIG, SAVED, { enabled: true });
    const t = await makeTask('m0-on');
    const r = await tool('task_claim', { projectId, taskId: t }, 'other-agent');
    const after = await row(t);
    say(`[M0 ON ] task_claim -> claimed=${r.structuredContent?.claimed}; claim_id set=${after.claim_id !== null}`);
    expect(r.structuredContent?.claimed).toBe(true);
    expect(after.claim_id).not.toBeNull();
  });
});

describe('M1..M4 — a NAIVE client on a board where nobody ever claims', () => {
  for (const enabled of [false, true]) {
    const L = enabled ? 'ON ' : 'OFF';
    test(`[flag ${L}] update, status change, bulk_update and delete all behave identically`, async () => {
      Object.assign(TASK_CLAIM_CONFIG, SAVED, { enabled });

      const t1 = await makeTask(`m1-${L}`);
      const u1 = await naiveUpdate(t1, { progress: 55 });
      const r1 = await row(t1);
      say(`[M1 ${L}] plain update ok=${u1.ok} progress=${r1.progress} version=${r1.version}`);
      expect(u1.ok).toBe(true);
      expect(Number(r1.progress)).toBe(55);

      const t2 = await makeTask(`m2-${L}`);
      const u2 = await naiveUpdate(t2, { status: 'in_progress' });
      const r2 = await row(t2);
      say(`[M2 ${L}] status change ok=${u2.ok} status=${r2.status}`);
      expect(u2.ok).toBe(true);
      expect(r2.status).toBe('in_progress');

      const t3a = await makeTask(`m3a-${L}`); const t3b = await makeTask(`m3b-${L}`);
      let bulkOk = true;
      try { await tool('task_bulk_update', { projectId, task_ids: [t3a, t3b], status: 'in_progress' }, 'naive-client'); }
      catch { bulkOk = false; }
      const r3a = await row(t3a), r3b = await row(t3b);
      say(`[M3 ${L}] bulk_update ok=${bulkOk} statuses=${r3a.status},${r3b.status}`);
      expect(bulkOk).toBe(true);
      expect([r3a.status, r3b.status]).toEqual(['in_progress', 'in_progress']);

      const t4 = await makeTask(`m4-${L}`);
      let delOk = true;
      try { await tool('task_delete', { projectId, taskId: t4 }, 'naive-client'); }
      catch { delOk = false; }
      const r4 = await db.query(`SELECT archived_at FROM tasks WHERE id=$1`, [t4]);
      say(`[M4 ${L}] delete ok=${delOk} archived=${r4.rows[0]?.archived_at !== null}`);
      expect(delOk).toBe(true);
      expect(r4.rows[0]?.archived_at).not.toBeNull();
    });
  }
});

describe('M5 — the CONDITIONAL, stated rather than hidden: someone else holding the task', () => {
  test('[flag ON] a held task refuses the naive write, with ZERO mutation', async () => {
    Object.assign(TASK_CLAIM_CONFIG, SAVED, { enabled: true });
    const t = await makeTask('m5-on');
    const c = await tool('task_claim', { projectId, taskId: t }, 'other-agent');
    expect(c.structuredContent?.claimed).toBe(true);
    const before = await row(t);
    const u = await naiveUpdate(t, { progress: 99 });
    const after = await row(t);
    say(`[M5 ON ] held by other-agent: naive progress ${before.progress}->${after.progress}, version ${before.version}->${after.version}, reason=${u.res?.structuredContent?.reason}`);
    expect(Number(after.progress)).toBe(Number(before.progress));
    expect(Number(after.version)).toBe(Number(before.version));
    expect(u.res?.structuredContent?.reason).toBe('held');
  });
  test('[flag OFF] the same held row IS writable — so the flag alone is the fence', async () => {
    // SYNTHETIC AND LABELLED: with the flag off no claim can be minted (M0 OFF), so this row
    // state is UNREACHABLE on a board that has always had the flag off. It exists only to
    // isolate the flag as the cause of M5-ON's refusal, and it is why M5-ON's RED means the
    // flag rather than some unrelated precondition.
    Object.assign(TASK_CLAIM_CONFIG, SAVED, { enabled: false });
    const t = await makeTask('m5-off');
    await db.query(
      `UPDATE tasks SET claim_id=gen_random_uuid(), claim_actor='other-agent',
                        claim_expires_at=now()+interval '1 hour' WHERE id=$1`, [t]);
    const u = await naiveUpdate(t, { progress: 99 });
    const after = await row(t);
    say(`[M5 OFF] synthetic held row: naive update ok=${u.ok} progress->${after.progress}`);
    expect(u.ok).toBe(true);
    expect(Number(after.progress)).toBe(99);
  });
});

describe('M6 — the response PAYLOAD a naive client receives is unchanged', () => {
  test('identical structuredContent keys and no claimFencing echo, OFF vs ON', async () => {
    const keys: Record<string, string> = {};
    for (const enabled of [false, true]) {
      Object.assign(TASK_CLAIM_CONFIG, SAVED, { enabled });
      const t = await makeTask(`m6-${enabled}`);
      const r = await tool('task_update', { projectId, taskId: t, progress: 42 }, 'naive-client');
      const sc: any = r.structuredContent ?? {};
      keys[String(enabled)] = Object.keys(sc).sort().join(',');
      say(`[M6 ${enabled ? 'ON ' : 'OFF'}] keys=${keys[String(enabled)]} claimFencing=${JSON.stringify(sc.claimFencing)}`);
      expect(sc.claimFencing).toBeUndefined();
    }
    expect(keys['true']).toBe(keys['false']);
  });
  test('CONTROL — a client that DOES pass claimId sees the payload differ, so M6 is not blind', async () => {
    const seen: Record<string, any> = {};
    for (const enabled of [false, true]) {
      Object.assign(TASK_CLAIM_CONFIG, SAVED, { enabled });
      const t = await makeTask(`m6c-${enabled}`);
      const r = await tool('task_update',
        { projectId, taskId: t, progress: 42, claimId: '00000000-0000-4000-8000-000000000000' }, 'naive-client');
      const sc: any = r.structuredContent ?? {};
      seen[String(enabled)] = sc.claimFencing ?? sc.reason ?? '<none>';
      say(`[M6-CTL ${enabled ? 'ON ' : 'OFF'}] = ${JSON.stringify(seen[String(enabled)])}`);
    }
    expect(seen['true']).not.toBe(seen['false']);
  });
});
