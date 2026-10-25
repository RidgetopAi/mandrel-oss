/**
 * ATOMIC TASK CLAIM — CONCURRENCY ACCEPTANCE TEST (eval experiment X1).
 *
 * WHAT THIS IS FOR. The atomic claim (migration 067) ships
 * DARK behind MANDREL_TASK_CLAIM_ENABLED. Its ENTIRE purpose is a concurrency guarantee —
 * N independent workers race one task, exactly ONE wins, N-1 get typed conflicts — and until
 * this file existed that guarantee had never been exercised under actual concurrency. The
 * in-file contract suite (taskAtomicClaim.contract.test.ts) races `Promise.all` inside ONE
 * process on ONE pool; the bug it defends against was reproduced by two INDEPENDENT Amp orbs
 * (the Amp-orb evaluation probe). Flipping the flag on single-process evidence would be enabling
 * unvalidated concurrency control.
 *
 * SO EVERY RACE HERE IS REAL: N separate OS PROCESSES (src/tests/helpers/claimStressWorker.ts),
 * each with its own pg Pool and its own connections, each driving the PUBLIC tool path
 * (validate → routeExecutor), all released at the same wall-clock instant by a spin barrier.
 * Module load, pool warm-up and validation happen BEFORE the barrier, so what is raced is the
 * claim and nothing else.
 *
 * THE CASES (the report's line-361 test set, plus the scale run from experiment X5 / roadmap
 * item 10):
 *   1  N (≥10) processes race ONE task, repeatedly → exactly one winner, N-1 typed conflicts.
 *   2  Stale version → typed `version-stale`, never a silent accept — serially and in a race.
 *   3  A worker that DIES (SIGKILL) mid-flight has its lease expire and the task is reclaimed.
 *   4  FENCING — a token that lost the claim is REFUSED on renew, release AND ordinary write.
 *   5  Idempotent retry with the SAME token, fired concurrently → one claim, never a second.
 *   6  The AUDIT is read back and must explain the whole story on its own (report L645).
 *   7  SCALE — ~100 tasks / ~20 worker processes: no task claimed twice, no task stranded.
 *   8  MUTATION PROBE — the same harness against a CAS-less claim must go RED with >1 winner.
 *
 * ON CASE 8 (the most important test in this file). A concurrency test that passes against a
 * deliberately broken CAS measures nothing. The probe therefore runs the SAME processes, the
 * SAME barrier and — the part that matters — the SAME judgement function
 * `assertExactlyOneWinner`, and proves it THROWS. If someone later weakens the assertion, the
 * probe stops passing; the guard and the thing it guards cannot drift apart silently.
 *
 * ON FLAKINESS. The race is repeated `raceRounds` times (default 20) and every round is
 * asserted. A nondeterministic result is a FINDING to be reported with numbers, not something
 * to re-run until green.
 */
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { appendFileSync } from 'node:fs';

import { db } from '../config/database.js';
import { TASK_CLAIM_CONFIG } from '../config/claimConfig.js';
import { taskClaimService } from '../services/taskClaim.js';
import { validateToolArguments } from '../middleware/validation.js';
import { routeExecutor } from '../routes/index.js';
import {
  STRESS_CONFIG,
  spawnWorkers,
  stopWorkers,
  barrierFire,
  analyzeRace,
  assertExactlyOneWinner,
  reconstructOwnership,
  type StressWorker,
  type SpawnOpts,
  type WorkerResult,
} from './helpers/claimStressHarness.js';

const STAMP = Date.now();
const PROJ_NAME = `claim-stress-${STAMP}`;
let projectId: string;

/** Every case gets its workers via this: spawned, used, and ALWAYS stopped (bounded RAM). */
async function withWorkers<T>(n: number, opts: SpawnOpts, fn: (ws: StressWorker[]) => Promise<T>): Promise<T> {
  const ws = await spawnWorkers(n, opts);
  try {
    return await fn(ws);
  } finally {
    await stopWorkers(ws);
  }
}

/**
 * `stage` is OPTIONAL and left undefined by default, so the tasks_sync_stage_status trigger
 * derives it from `status` exactly as before (todo -> ready, in_progress -> claimed, ...). A
 * caller that plans to run an ORDINARY (non-claim) content update — one naming `title`,
 * `metadata`, `punch`, `dependencies` or `stage` itself — against a row that would otherwise
 * land at 'ready' with no punch fields should pass `stage: 'draft'` explicitly (an earlier task
 * clause 10 / the completeness gate keys on the MERGED row's stage,
 * so such an update would otherwise be correctly refused with PUNCH_INCOMPLETE — a gate
 * concern unrelated to what these claim/CAS tests exercise). See the sibling in-process file
 * taskAtomicClaim.contract.test.ts's own `makeTask`, fixed the same way in the fixture-gap fix.
 */
async function makeTask(title: string, status = 'todo', stage?: string): Promise<string> {
  const r = await db.query(
    `INSERT INTO tasks (project_id, title, type, priority, status, stage)
     VALUES ($1, $2, 'general', 'medium', $3, $4) RETURNING id`,
    [projectId, title, status, stage ?? null],
  );
  return r.rows[0].id;
}

async function readTask(taskId: string) {
  const r = await db.query(
    `SELECT status, assigned_to, version, claim_id::text AS claim_id, claim_actor, claim_expires_at
       FROM tasks WHERE id = $1`,
    [taskId],
  );
  return r.rows[0];
}

const events = (taskId: string) => taskClaimService.listEvents(taskId, 500);

/** The statuses that leave the CAS as the ONLY defence (see case 1's note). */
const WIDE = ['todo', 'in_progress', 'blocked'];

/**
 * Emit a measured result. This file's entire deliverable is NUMBERS, so it writes straight to
 * stdout: vitest.setup.ts mocks `console.log` to a no-op suite-wide, which would silently
 * swallow every measurement and leave a green tick as the only evidence — exactly the
 * "configured is not verified" failure. Set MANDREL_CLAIM_STRESS_REPORT to also
 * append the run's numbers to a durable JSONL artifact.
 */
function report(label: string, data: Record<string, unknown>): void {
  const line = `[stress] ${label} ${JSON.stringify(data)}`;
  process.stdout.write(line + '\n');
  const artifact = process.env.MANDREL_CLAIM_STRESS_REPORT; // env-read: via-callers
  if (artifact) {
    appendFileSync(artifact, JSON.stringify({ ts: new Date().toISOString(), label, ...data }) + '\n');
  }
}

beforeAll(async () => {
  projectId = (
    await db.query(`INSERT INTO projects (name, description) VALUES ($1, 'atomic claim stress') RETURNING id`, [PROJ_NAME])
  ).rows[0].id;
  // The PARENT only reads the DB and does content-only writes; the WORKERS enable the feature
  // through the real env→config path in their own processes. Enabled here too so any
  // parent-side service call behaves like the environment under test.
  TASK_CLAIM_CONFIG.enabled = true;
}, 60_000);

afterAll(async () => {
  TASK_CLAIM_CONFIG.enabled = false;
  await db.query(`DELETE FROM task_claim_events WHERE task_id IN (SELECT id FROM tasks WHERE project_id = $1)`, [projectId]);
  await db.query(`DELETE FROM tasks WHERE project_id = $1`, [projectId]);
  await db.query(`DELETE FROM projects WHERE id = $1`, [projectId]);
}, 60_000);

// ═══════════════════════════════════════════════════════════════════════════════════════
// 1. N INDEPENDENT PROCESSES RACE ONE TASK — repeatedly
// ═══════════════════════════════════════════════════════════════════════════════════════
describe('1. N worker PROCESSES race one task simultaneously', () => {
  test(
    `${STRESS_CONFIG.raceWorkers} processes × ${STRESS_CONFIG.raceRounds} rounds → exactly one winner every time`,
    async () => {
      const n = STRESS_CONFIG.raceWorkers;
      expect(n, 'the eval asks for at least 10 racing workers').toBeGreaterThanOrEqual(10);

      const spreads: number[] = [];
      const anomalies: string[] = [];
      let totalWinners = 0;
      let totalLosers = 0;

      await withWorkers(n, { actorPrefix: 'race' }, async (ws) => {
        for (let round = 0; round < STRESS_CONFIG.raceRounds; round++) {
          const taskId = await makeTask(`race round ${round}`);
          // allowedStatuses WIDENED on purpose: with the default ['todo'] the winner's flip to
          // in_progress ALSO refuses everyone else, so the round would stay green even against
          // a claim with no CAS at all. Widening removes that second line of defence and leaves
          // the compare-and-swap as the only thing that can produce a single winner.
          const results = await barrierFire(ws, () => ({
            op: 'claim', projectId, taskId, allowedStatuses: WIDE,
          }));

          const a = assertExactlyOneWinner(results, `round ${round}`);
          spreads.push(a.fireSpreadMs);
          totalWinners += a.winners.length;
          totalLosers += a.losers.length;

          // THE INVARIANT READ FROM THE DATABASE, not from the workers' own answers.
          const row = await readTask(taskId);
          const won = (await events(taskId)).filter((e) => e.event_type === 'claim_won');
          if (row.claim_id !== a.winners[0].payload.claimId) {
            anomalies.push(`round ${round}: row token ${row.claim_id} != winner token ${a.winners[0].payload.claimId}`);
          }
          if (won.length !== 1) anomalies.push(`round ${round}: ${won.length} claim_won events`);
          for (const l of a.losers) {
            if (l.payload.reason !== 'held') anomalies.push(`round ${round}: loser ${l.actor} reason=${l.payload.reason}`);
          }
        }
      });

      report('race', {
        workers: n,
        rounds: STRESS_CONFIG.raceRounds,
        attempts: n * STRESS_CONFIG.raceRounds,
        winners: totalWinners,
        typedConflicts: totalLosers,
        anomalies: anomalies.length,
        fireSpreadMs: { min: Math.min(...spreads), max: Math.max(...spreads) },
      });

      expect(anomalies, 'DB-side invariants for every round').toEqual([]);
      expect(totalWinners).toBe(STRESS_CONFIG.raceRounds);
      expect(totalLosers).toBe(STRESS_CONFIG.raceRounds * (n - 1));
    },
    600_000,
  );

  test('the default status guard path also yields exactly one winner', async () => {
    await withWorkers(STRESS_CONFIG.raceWorkers, { actorPrefix: 'dfl' }, async (ws) => {
      const taskId = await makeTask('race, shipped defaults');
      const results = await barrierFire(ws, () => ({ op: 'claim', projectId, taskId }));
      const a = assertExactlyOneWinner(results, 'default-guard');
      report('race-default-guard', { winners: a.winners.length, reasons: a.reasonCounts, fireSpreadMs: a.fireSpreadMs });
      expect((await events(taskId)).filter((e) => e.event_type === 'claim_won')).toHaveLength(1);
    });
  }, 300_000);
});

// ═══════════════════════════════════════════════════════════════════════════════════════
// 2. STALE VERSION — refused TYPED, never silently accepted
// ═══════════════════════════════════════════════════════════════════════════════════════
describe('2. a claim presented against a superseded version', () => {
  test('is refused with `version-stale`, and in a race still yields exactly one winner', async () => {
    await withWorkers(STRESS_CONFIG.raceWorkers, { actorPrefix: 'ver' }, async (ws) => {
      // (a) SERIAL, deterministic: the row moves underneath the caller between read and claim.
      // STAGE PINNED TO 'draft' (an earlier task clause 10 / an earlier task): a bare INSERT
      // naming no `stage` is backfilled to 'ready' by the tasks_sync_stage_status trigger
      // (status='todo' -> stage='ready'), which the completeness gate correctly refuses the
      // title-only task_update below against (ready, no punch fields) — starving this test
      // of the version bump it needs and masking the version-stale assertions entirely. See
      // which pinned the same fixture gap everywhere except this stress file (the
      // one suite the confined lane cannot run, so it never met clause 10 until the full gate).
      const taskId = await makeTask('version stale', 'todo', 'draft');
      const v0 = (await readTask(taskId)).version;
      // A CONTENT-only edit — proves the version bump is surface-independent (the trigger owns
      // it), so a stale expectedVersion is caught even when nothing about ownership changed.
      await routeExecutor('task_update', validateToolArguments('task_update', { projectId, taskId, title: 'moved underneath you' }));
      const v1 = (await readTask(taskId)).version;
      expect(v1).toBeGreaterThan(v0);

      const stale = await ws[0].send({ op: 'claim', projectId, taskId, expectedVersion: v0 });
      expect(stale.payload.claimed).toBe(false);
      expect(stale.payload.reason).toBe('version-stale');
      const afterStale = await readTask(taskId);
      expect(afterStale.claim_id, 'a rejected stale claim must not have written anything').toBeNull();
      expect(afterStale.status).toBe('todo');

      // A correct version still wins — the guard rejects staleness, not everything.
      const fresh = await ws[0].send({ op: 'claim', projectId, taskId, expectedVersion: v1 });
      expect(fresh.payload.claimed).toBe(true);

      // (b) CONCURRENT: every worker presents the SAME version it read at t0. Exactly one can
      // still be right — and every loser must be told which way it lost.
      const raceTask = await makeTask('version race');
      const rv = (await readTask(raceTask)).version;
      const results = await barrierFire(ws, () => ({
        op: 'claim', projectId, taskId: raceTask, expectedVersion: rv, allowedStatuses: WIDE,
      }));
      const a = assertExactlyOneWinner(results, 'version-race');
      report('version-race', { winners: a.winners.length, reasons: a.reasonCounts });
      for (const l of a.losers) {
        expect(['held', 'version-stale', 'conflict'], `loser ${l.actor} reason`).toContain(l.payload.reason);
      }
    });
  }, 300_000);
});

// ═══════════════════════════════════════════════════════════════════════════════════════
// 3+4. A WORKER DIES MID-FLIGHT — the lease expires, the task is reclaimed, and the old
//      token is FENCED OUT on every surface it could still write through.
// ═══════════════════════════════════════════════════════════════════════════════════════
describe('3+4. lease expiry, reclaim, and fencing of the superseded token', () => {
  test('a SIGKILLed holder loses the task at expiry, and its token is refused after takeover', async () => {
    const LEASE = 2; // seconds — real wall-clock expiry, not an UPDATE that back-dates the row
    await withWorkers(STRESS_CONFIG.raceWorkers, {
      actorPrefix: 'lease',
      // The shipped floor is 60s (a lease shorter than a unit of work makes expiry the common
      // case). Lowered HERE ONLY, through the real config surface, so the test can watch a
      // genuine lease elapse instead of faking it with SQL.
      env: { MANDREL_TASK_CLAIM_MIN_LEASE_SECONDS: '1' },
    }, async (ws) => {
      const dying = ws[0];
      const survivors = ws.slice(1);

      // ── Phase A: a worker that really DIES ────────────────────────────────────────────
      const taskA = await makeTask('the worker that died');
      const claimA = await dying.send({ op: 'claim', projectId, taskId: taskA, leaseSeconds: LEASE });
      expect(claimA.payload.claimed).toBe(true);
      const deadToken = claimA.payload.claimId as string;
      // SIGKILL the worker's whole process GROUP — no release, no cleanup, no goodbye. kill()
      // does not return until the group is measurably gone (signal 0), so "the worker died"
      // is verified rather than assumed.
      await dying.kill();

      // While the lease is still live the task is NOT up for grabs: expiry is what frees it,
      // not the holder's absence (a live lease is the only thing standing between a stalled
      // worker and a duplicate build).
      const tooEarly = await survivors[0].send({ op: 'claim', projectId, taskId: taskA, allowedStatuses: WIDE });
      expect(tooEarly.payload.claimed, 'a live lease must survive the holder dying').toBe(false);
      expect(tooEarly.payload.reason).toBe('held');

      // THE PILE-ON. When a worker dies, a real fleet does not reclaim politely one at a time
      // — everyone notices the free task at once. So every survivor races the expired lease
      // simultaneously; the `claim_expires_at <= now()` disjunct is now the contended
      // predicate, and it must still admit exactly one.
      await new Promise((r) => setTimeout(r, LEASE * 1000 + 500));
      const pileOn = await barrierFire(survivors, () => ({
        op: 'claim', projectId, taskId: taskA, allowedStatuses: WIDE, leaseSeconds: LEASE * 300,
      }));
      const reclaimAnalysis = assertExactlyOneWinner(pileOn, 'expired-lease pile-on');
      const reclaimed = reclaimAnalysis.winners[0];
      const liveToken = reclaimed.payload.claimId as string;
      expect(liveToken).not.toBe(deadToken);
      // Two owners over the task's life — the dead one and the reclaimer — and no more.
      expect((await events(taskA)).filter((e) => e.event_type === 'claim_won')).toHaveLength(2);
      report('expired-lease-pile-on', {
        workers: survivors.length, winners: reclaimAnalysis.winners.length, reasons: reclaimAnalysis.reasonCounts,
      });

      // ── Phase B: FENCING — the superseded token presented AFTER takeover ──────────────
      // This is the property the whole design rests on: the dead worker's writes must not
      // land. Probed on all three surfaces it could still reach. Driven by a worker that did
      // NOT win the pile-on, so the stale token is presented by a process that genuinely does
      // not hold the claim.
      const zombie = survivors.find((w) => w.actor !== reclaimed.actor)!;
      const watcher = survivors.find((w) => w.actor !== reclaimed.actor && w.actor !== zombie.actor)!;

      const staleRenew = await zombie.send({ op: 'renew', projectId, taskId: taskA, claimId: deadToken });
      expect(staleRenew.payload.claimed).toBe(false);
      expect(staleRenew.payload.reason).toBe('claim-lost');

      const staleRelease = await zombie.send({ op: 'release', projectId, taskId: taskA, claimId: deadToken });
      expect(staleRelease.payload.reason, 'a superseded token must not be able to release someone else\'s claim').toBe('claim-lost');

      const staleWrite = await zombie.send({ op: 'update', projectId, taskId: taskA, claimId: deadToken, status: 'completed' });
      expect(staleWrite.payload.isError, 'a superseded token must not complete the task').toBe(true);
      // Since an earlier task the fence distinguishes: a LIVE claim (the reclaimer's) exists
      // and the presented token is not it → claim-mismatch, not the generic claim-lost.
      expect(staleWrite.payload.reason).toBe('claim-mismatch');

      const staleReclaim = await zombie.send({ op: 'claim', projectId, taskId: taskA, claimId: deadToken, allowedStatuses: WIDE });
      expect(staleReclaim.payload.claimed, 'a superseded token buys nothing on a re-claim either').toBe(false);
      expect(staleReclaim.payload.reason).toBe('held');

      const rowA = await readTask(taskA);
      expect(rowA.claim_id, 'the row still belongs to the taker').toBe(liveToken);
      expect(rowA.status, 'the zombie\'s completion never landed').not.toBe('completed');

      // ── Phase C: the ORIGINAL holder is still ALIVE and LEARNS it lost the claim ──────
      // (the stalled-worker case: nobody can interrupt it, so the contract is that its next
      // write is refused with a reason it can act on, rather than silently succeeding).
      const taskB = await makeTask('the worker that stalled');
      const claimB = await zombie.send({ op: 'claim', projectId, taskId: taskB, leaseSeconds: LEASE });
      expect(claimB.payload.claimed).toBe(true);
      const stalledToken = claimB.payload.claimId as string;

      await new Promise((r) => setTimeout(r, LEASE * 1000 + 500));
      const takenOver = await watcher.send({ op: 'claim', projectId, taskId: taskB, allowedStatuses: WIDE, leaseSeconds: LEASE * 30 });
      expect(takenOver.payload.claimed).toBe(true);

      const stalledWrite = await zombie.send({ op: 'update', projectId, taskId: taskB, claimId: stalledToken, status: 'completed' });
      expect(stalledWrite.payload.isError).toBe(true);
      // claim-mismatch: the watcher's LIVE claim exists and the stalled
      // holder's token is not it — it LEARNS it lost, with the sharper reason.
      expect(stalledWrite.payload.reason, 'the stalled holder must LEARN it lost the claim').toBe('claim-mismatch');
      const stalledRenew = await zombie.send({ op: 'renew', projectId, taskId: taskB, claimId: stalledToken });
      expect(stalledRenew.payload.reason).toBe('claim-lost');

      report('lease-expiry', {
        deadTokenRefusedOn: ['renew', 'release', 'update', 'claim'],
        reclaimedAfterSeconds: LEASE,
        stalledHolderLearned: stalledWrite.payload.reason,
      });
    });
  }, 300_000);
});

// ═══════════════════════════════════════════════════════════════════════════════════════
// 4b. THE REPRODUCED INCIDENT, REPLAYED UNDER REAL CONCURRENCY
// ═══════════════════════════════════════════════════════════════════════════════════════
describe('4b. the eval\'s original incident — an ordinary task_update stealing an active assignment', () => {
  test('N processes issuing plain ownership updates cannot evict the holder', async () => {
    const n = STRESS_CONFIG.raceWorkers;
    await withWorkers(n, { actorPrefix: 'stomp' }, async (ws) => {
      const taskId = await makeTask('worker 1 is working on this');
      const held = await ws[0].send({ op: 'claim', projectId, taskId });
      expect(held.payload.claimed).toBe(true);
      const token = held.payload.claimId as string;

      // EXACTLY what worker 2 did in the eval: OBSERVE the active
      // assignment, then issue the same ordinary update shape with itself as assignee. Back
      // then both calls returned success and worker 1 was silently replaced. Here every
      // other process does it AT THE SAME INSTANT.
      const attackers = ws.slice(1);
      const results = await barrierFire(attackers, (w) => ({
        op: 'update', projectId, taskId, status: 'in_progress', assignedTo: w.actor,
      }));

      const accepted = results.filter((r) => r.payload.isError !== true);
      const reasons: Record<string, number> = {};
      for (const r of results) {
        const reason = String(r.payload.reason ?? 'none');
        reasons[reason] = (reasons[reason] ?? 0) + 1;
      }
      report('incident-replay', { attackers: attackers.length, accepted: accepted.length, reasons });

      expect(accepted, 'not one ordinary update may take ownership of a claimed task').toEqual([]);
      for (const r of results) expect(r.payload.reason, `${r.actor} must be told WHY`).toBe('held');

      // The row still belongs to worker 1 — assignee, token and all.
      const row = await readTask(taskId);
      expect(row.claim_id).toBe(token);
      expect(row.claim_actor).toBe(ws[0].actor);
      expect(row.assigned_to).toBe(ws[0].actor);

      // And the audit RECORDS the attempts rather than letting them vanish: every refused
      // stomp is a fence_rejected event naming the token that was live at the time.
      const fenced = (await events(taskId)).filter((e) => e.event_type === 'fence_rejected');
      expect(fenced).toHaveLength(attackers.length);
      for (const e of fenced) expect(e.reason).toBe('held');
    });
  }, 300_000);

  /**
   * THE PROBE FOR THE CASE ABOVE — and, incidentally, the measurement of what we are exposed
   * to RIGHT NOW. With MANDREL_TASK_CLAIM_ENABLED at its shipped default (false), the fence
   * is inert by design (the Lesson-025 "legacy == today" invariant), so the identical harness
   * must WATCH THE INCIDENT HAPPEN. If it does not, the case above is green for some reason
   * other than the fence and proves nothing.
   */
  test('PROBE: with the flag OFF the incident REPRODUCES — worker 1 is silently evicted', async () => {
    const n = STRESS_CONFIG.raceWorkers;
    await withWorkers(n, { actorPrefix: 'legacy', env: { MANDREL_TASK_CLAIM_ENABLED: 'false' } }, async (ws) => {
      const taskId = await makeTask('legacy: no lock exists');
      // With claiming off there IS no claim — worker 1 takes the task the only way today's
      // API allows, an ordinary update. That is precisely the eval's setup.
      const first = await ws[0].send({ op: 'update', projectId, taskId, status: 'in_progress', assignedTo: ws[0].actor });
      expect(first.payload.isError).not.toBe(true);

      const attackers = ws.slice(1);
      const results = await barrierFire(attackers, (w) => ({
        op: 'update', projectId, taskId, status: 'in_progress', assignedTo: w.actor,
      }));
      const accepted = results.filter((r) => r.payload.isError !== true);
      const row = await readTask(taskId);
      report('incident-replay-flag-off', {
        attackers: attackers.length,
        acceptedSilently: accepted.length,
        firstAssignee: ws[0].actor,
        finalAssignee: row.assigned_to,
        evicted: row.assigned_to !== ws[0].actor,
      });

      expect(accepted, 'flag OFF: every stomp is accepted — this IS the reproduced bug').toHaveLength(attackers.length);
      expect(row.assigned_to, 'flag OFF: worker 1 is silently replaced').not.toBe(ws[0].actor);
    });
  }, 300_000);
});

// ═══════════════════════════════════════════════════════════════════════════════════════
// 5. IDEMPOTENT RETRY — the same token, fired concurrently from many processes
// ═══════════════════════════════════════════════════════════════════════════════════════
describe('5. idempotent retry by the same claim id', () => {
  test('concurrent retries with the held token all succeed as ONE claim, never a second', async () => {
    const n = 8;
    await withWorkers(n, { actorPrefix: 'retry' }, async (ws) => {
      const taskId = await makeTask('idempotent retry');
      const first = await ws[0].send({ op: 'claim', projectId, taskId });
      expect(first.payload.claimed).toBe(true);
      const token = first.payload.claimId as string;

      // Every process presents THE SAME held token at the same instant — the retry storm a
      // flaky network or an over-eager orb produces.
      const results = await barrierFire(ws, () => ({ op: 'claim', projectId, taskId, claimId: token }));
      for (const r of results) {
        expect(r.payload.claimed, `${r.actor} retry`).toBe(true);
        expect(r.payload.claimId, `${r.actor} must get the SAME token back, not a new one`).toBe(token);
        expect(r.payload.reentered).toBe(true);
      }

      const row = await readTask(taskId);
      expect(row.claim_id).toBe(token);
      const ev = await events(taskId);
      expect(ev.filter((e) => e.event_type === 'claim_won'), 'a retry must never mint a second claim').toHaveLength(1);
      expect(ev.filter((e) => e.event_type === 'claim_reentered')).toHaveLength(n);
      report('idempotent-retry', { retries: n, distinctTokens: new Set(results.map((r) => r.payload.claimId)).size });
    });
  }, 300_000);
});

// ═══════════════════════════════════════════════════════════════════════════════════════
// 6. THE AUDIT MUST TELL THE TRUE STORY ON ITS OWN
// ═══════════════════════════════════════════════════════════════════════════════════════
describe('6. reading the audit back', () => {
  test('server events alone identify the winner, the losers and a takeover — no worker input', async () => {
    const n = STRESS_CONFIG.raceWorkers;
    await withWorkers(n, { actorPrefix: 'audit', env: { MANDREL_TASK_CLAIM_MIN_LEASE_SECONDS: '1' } }, async (ws) => {
      const taskId = await makeTask('audit story');
      const results = await barrierFire(ws, () => ({
        op: 'claim', projectId, taskId, allowedStatuses: WIDE, leaseSeconds: 2,
      }));
      const a = assertExactlyOneWinner(results, 'audit-race');
      const winner = a.winners[0];

      // Then a takeover after expiry, so the story has TWO owners to keep straight.
      await new Promise((r) => setTimeout(r, 2_500));
      const loserWorker = ws.find((w) => w.actor !== winner.actor)!;
      const takeover = await loserWorker.send({ op: 'claim', projectId, taskId, allowedStatuses: WIDE, leaseSeconds: 600 });
      expect(takeover.payload.claimed).toBe(true);

      // ── THE READ-BACK. Everything below is derived from task_claim_events + the row. ──
      const row = await readTask(taskId);
      const story = reconstructOwnership(await events(taskId), row.claim_id);

      expect(story.anomalies, 'the audit must fully explain the row').toEqual([]);
      expect(story.holders).toHaveLength(2);
      // Who held it FIRST, and with which token — from the audit, then checked against ground truth.
      expect(story.holders[0].actor).toBe(winner.actor);
      expect(story.holders[0].claimId).toBe(winner.payload.claimId);
      expect(story.holders[1].actor).toBe(takeover.actor);
      expect(story.holders[1].claimId).toBe(takeover.payload.claimId);
      // And every loser of the race is in there with its typed reason.
      const held = story.refusals.filter((r) => r.reason === 'held');
      expect(held).toHaveLength(n - 1);
      expect(new Set(held.map((r) => r.actor)).size, 'every losing actor is named').toBe(n - 1);

      // The audit's timestamps are the SERVER's and are ordered.
      const ts = story.holders.map((h) => new Date(h.from).getTime());
      expect(ts[1]).toBeGreaterThan(ts[0]);

      report('audit', {
        holders: story.holders.map((h) => ({ actor: h.actor, via: h.via })),
        refusals: story.refusals.length,
        anomalies: story.anomalies.length,
      });
    });
  }, 300_000);
});

// ═══════════════════════════════════════════════════════════════════════════════════════
// 7. SCALE — ~100 tasks, ~20 worker processes
// ═══════════════════════════════════════════════════════════════════════════════════════
describe('7. scale run', () => {
  test(
    `${STRESS_CONFIG.scaleWorkers} processes over ${STRESS_CONFIG.scaleTasks} tasks — none claimed twice, none stranded`,
    async () => {
      const taskIds: string[] = [];
      for (let i = 0; i < STRESS_CONFIG.scaleTasks; i++) taskIds.push(await makeTask(`board ${i}`));

      const t0 = Date.now();
      const results = await withWorkers(STRESS_CONFIG.scaleWorkers, { actorPrefix: 'scale' }, async (ws) =>
        barrierFire(ws, () => ({ op: 'claimBoard', projectId, taskIds, allowedStatuses: WIDE })),
      );
      const elapsedMs = Date.now() - t0;

      // ── who claimed what, according to the workers ──
      const owners = new Map<string, string[]>(); // taskId → actors that believe they own it
      let attempts = 0;
      const errors: any[] = [];
      const reasons: Record<string, number> = {};
      for (const r of results) {
        attempts += r.payload.attempted;
        errors.push(...r.payload.errors);
        for (const c of r.payload.claimed) {
          owners.set(c.taskId, [...(owners.get(c.taskId) ?? []), r.actor]);
        }
        for (const f of r.payload.refused) reasons[f.reason] = (reasons[f.reason] ?? 0) + 1;
      }

      const doubleClaimed = [...owners.entries()].filter(([, as]) => as.length > 1);
      const stranded = taskIds.filter((id) => !owners.has(id));

      // ── and what the DATABASE says, independently ──
      const rows = await db.query(
        `SELECT id::text AS id, claim_id::text AS claim_id, status FROM tasks WHERE id = ANY($1::uuid[])`,
        [taskIds],
      );
      const unclaimedRows = rows.rows.filter((r: any) => r.claim_id === null);
      const wonCounts = await db.query(
        `SELECT task_id::text AS task_id, count(*)::int AS n
           FROM task_claim_events
          WHERE task_id = ANY($1::uuid[]) AND event_type = 'claim_won'
          GROUP BY task_id HAVING count(*) <> 1`,
        [taskIds],
      );

      report('scale', {
        workers: STRESS_CONFIG.scaleWorkers,
        tasks: STRESS_CONFIG.scaleTasks,
        attempts,
        elapsedMs,
        claimsPerSec: Math.round((attempts / elapsedMs) * 1000),
        doubleClaimed: doubleClaimed.length,
        stranded: stranded.length,
        errors: errors.length,
        refusalReasons: reasons,
      });

      expect(errors).toEqual([]);
      expect(doubleClaimed, 'no task may be claimed by two workers').toEqual([]);
      expect(stranded, 'no task may be left stranded').toEqual([]);
      expect(unclaimedRows.map((r: any) => r.id), 'every row carries a claim').toEqual([]);
      expect(wonCounts.rows, 'every task has exactly ONE claim_won event').toEqual([]);
      expect(owners.size).toBe(STRESS_CONFIG.scaleTasks);
    },
    900_000,
  );
});

// ═══════════════════════════════════════════════════════════════════════════════════════
// 8. MUTATION PROBE — break the CAS and prove THIS harness reports two owners
// ═══════════════════════════════════════════════════════════════════════════════════════
describe('8. mutation probe — the harness is capable of failing', () => {
  /**
   * Runs the identical race against workers whose claim is read-then-write with NO compare
   * (today's unguarded `task_update` shape). Returns what the SHIPPED assertion did.
   */
  async function probe(windowMs: number): Promise<{ winners: number; thrown: string | null; anomalies: string[]; results: WorkerResult[] }> {
    return withWorkers(STRESS_CONFIG.raceWorkers, { actorPrefix: `mut${windowMs}`, cas: 'broken', brokenWindowMs: windowMs }, async (ws) => {
      const taskId = await makeTask(`mutant window=${windowMs}ms`);
      const results = await barrierFire(ws, () => ({ op: 'claim', projectId, taskId }));
      let thrown: string | null = null;
      try {
        assertExactlyOneWinner(results, `mutant-${windowMs}ms`);
      } catch (e) {
        thrown = e instanceof Error ? e.message : String(e);
      }
      const row = await readTask(taskId);
      const story = reconstructOwnership(await events(taskId), row.claim_id);
      return { winners: analyzeRace(results).winners.length, thrown, anomalies: story.anomalies, results };
    });
  }

  test('with the CAS removed, the SAME assertion goes RED reporting MORE THAN ONE winner', async () => {
    const p = await probe(30);
    report('mutation-probe-30ms', { winners: p.winners, threw: Boolean(p.thrown), message: p.thrown, auditAnomalies: p.anomalies });

    // The exact assertion case 1 relies on must FAIL here. If it does not, case 1 cannot tell
    // a working lock from a broken one and proves nothing.
    expect(p.thrown, 'assertExactlyOneWinner must throw against a CAS-less claim').toBeTruthy();
    expect(p.winners, 'a CAS-less claim must produce more than one owner').toBeGreaterThan(1);
    expect(p.thrown).toContain('UNSAFE');
    // And the AUDIT-side check goes red too: an owner arrived on the row that the server never
    // recorded granting — which is precisely how an unaudited overwrite looks.
    expect(p.anomalies.length, 'the audit read-back must also refuse to explain a stolen row').toBeGreaterThan(0);
  }, 300_000);

  test('with NO artificial window at all, the CAS-less claim is still measurably unsafe', async (ctx) => {
    // Reported honestly whatever it says: a probe that needs a 30ms window should say so.
    const p = await probe(0);
    report('mutation-probe-0ms', { winners: p.winners, threw: Boolean(p.thrown), message: p.thrown });

    // THIS PROBE HAS THREE OUTCOMES, NOT TWO (CLASSES.md C1 — yes / no / could-not-measure).
    // `brokenClaimNoCas` writes UNCONDITIONALLY once it has read `claim_id IS NULL`, so
    // `winners` is exactly the number of workers that observed the row free. That makes the
    // low outcomes distinguishable by construction rather than by judgement:
    //   winners > 1  the reads overlapped the write — the race OPENED and the mutant is unsafe.
    //   winners = 1  only one worker ever saw the row free, so the processes ran serially and
    //                NO race occurred. This is NOT evidence that a CAS-less claim is safe:
    //                the mutant's UPDATE carries no compare, so no interleaving exists that
    //                could make it safe. It is the absence of a measurement.
    //   winners = 0  nobody claimed a free row — the harness itself failed. A real RED.
    // MEASURED 2026-08-12, which is why this branch exists: 12/12 winners on the control host gate box
    // (8 vCPU), 12/12 again pinned to one CPU, 6-11 pinned to two — versus 1 on the
    // GitHub-hosted runner, where the SAME run's 30ms probe still reported 12 winners. The
    // harness was demonstrably capable there; the zero-window interleaving simply did not
    // open. Asserting RED on that is an instrument reporting a defect it never observed, and
    // widening the window until it agrees is tuning a probe to a number. So it announces,
    // the way the CI gate STAGE 1b announces an embedder axis it could not exercise.
    expect(
      p.winners,
      'no worker claimed a free row — that is a harness failure, not a timing miss',
    ).toBeGreaterThan(0);
    if (p.winners === 1) {
      process.stdout.write(
        `SKIP-LOUD [stress] mutation-probe-0ms: the zero-window race DID NOT OPEN on this host — ` +
          `1 of ${STRESS_CONFIG.raceWorkers} workers observed the row free, so no worker's read ` +
          `overlapped another's write. The zero-window interleaving was NOT exercised on this ` +
          `run and a regression in it cannot be caught here. The 30ms probe above did exercise ` +
          `the same CAS-less path; re-run on a host where the workers get real parallelism to ` +
          `cover this axis.\n`,
      );
      ctx.skip();
      return;
    }
    expect(p.winners, 'zero-window read-then-write across processes').toBeGreaterThan(1);
  }, 300_000);
});
