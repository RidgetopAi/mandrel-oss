/**
 * claimStressWorker — ONE independent WORKER PROCESS for the atomic-claim stress harness
 * (the acceptance test for the atomic claim W1 / an earlier task).
 *
 * WHY A SEPARATE PROCESS AT ALL. The in-file contract suite
 * (taskAtomicClaim.contract.test.ts) races 10 `Promise.all` claims inside ONE node process
 * sharing ONE 20-connection pool. That already overlaps at the database, but every claim is
 * dispatched by a single event loop, on connections from a single pool, in one client's
 * statement-issue order. The property under test — "two INDEPENDENT clients cannot both own
 * one task" — is exactly the thing the eval reproduced against real, separate Amp orbs
 * (probe 5e43a9de). So the acceptance harness runs N real OS processes, each with its OWN
 * pg Pool and its OWN connections, released simultaneously by a wall-clock barrier. If the
 * guarantee lives anywhere but the database's isolation behaviour, this is what finds it.
 *
 * WHAT IT RUNS. The PUBLIC tool path (`validateToolArguments` → `routeExecutor`), i.e. the
 * same surface an orb reaches over MCP — not an internal shortcut. What is proven is what a
 * caller actually gets back.
 *
 * PROTOCOL (line-delimited JSON, stdin → stdout; stderr is left for the product's logger):
 *   parent → child  {"id":1,"op":"claim","at":<epochMs>, ...args}
 *   child  → parent {"ev":"ready"}                       (once, after the pool is WARM)
 *   child  → parent {"ev":"result","id":1,"op":"claim","firedAt":…,"ms":…,"payload":{…}}
 *
 * THE BARRIER. `at` is an absolute epoch-ms instant supplied by the parent. The child sleeps
 * to ~2ms before it and then SPINS, so every process issues its statement inside the same
 * millisecond. Connection setup, module load and validation all happen BEFORE the barrier
 * (the pool is warmed at boot), so what is raced is the claim itself and nothing else.
 *
 * MUTATION MODE (`--cas broken`). The whole harness — same processes, same barrier, same
 * parent-side analyzer — can be pointed at a DELIBERATELY BROKEN claim: read-then-write with
 * no compare, which is precisely today's unguarded `task_update` shape (WHERE id ONLY). A
 * concurrency test that stays green against that is measuring nothing (probe the
 * guard, and probe it through the SAME path the real assertion uses).
 */
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';

import { db } from '../../config/database.js';
import { validateToolArguments } from '../../middleware/validation.js';
import { routeExecutor } from '../../routes/index.js';

/* ── argv (configs-not-hardcoded: every knob is a named flag with a default) ──────────── */

function flag(name: string, fallback?: string): string {
  const i = process.argv.indexOf(name);
  const v = i >= 0 ? process.argv[i + 1] : undefined;
  if (v === undefined) {
    if (fallback === undefined) throw new Error(`claimStressWorker: missing required ${name}`);
    return fallback;
  }
  return v;
}

/** Attribution string this worker claims under. */
const ACTOR = flag('--actor');
/** `real` = the shipped claim; `broken` = the CAS-less mutant (see MUTATION MODE above). */
const CAS_MODE = flag('--cas', 'real');
/**
 * How long the BROKEN mutant waits between its read and its write. Models a worker doing a
 * beat of work inside the check-then-act window the real CAS closes. Parameterised (rather
 * than fixed at 30ms) so the probe can be run at 0 too and the measured winner count reported
 * for both — an honest probe states the window it needed, it does not hide it.
 */
const BROKEN_WINDOW_MS = Number(flag('--brokenWindowMs', '30'));

/* ── wire ─────────────────────────────────────────────────────────────────────────────── */

function emit(obj: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

/** Sleep to ~2ms before the barrier instant, then spin so every process fires together. */
async function waitForBarrier(at?: number): Promise<void> {
  if (!at) return;
  const coarse = at - Date.now() - 2;
  if (coarse > 0) await new Promise((r) => setTimeout(r, coarse));
  while (Date.now() < at) {
    /* spin — the last couple of ms, so the release is simultaneous and not setTimeout-jittered */
  }
}

async function viaPublicTool(tool: string, rawArgs: Record<string, unknown>): Promise<any> {
  const validated = validateToolArguments(tool, rawArgs);
  return routeExecutor(tool, validated);
}

/* ── the mutant: read-then-write with NO compare ──────────────────────────────────────── */

/**
 * THE BUG, RESTORED. A "polite" worker that even READS first and only writes if the task
 * looks free — and still both win, because between the read and the write there is nothing
 * holding the row. This is the exact shape of the reproduced incident (worker 2 OBSERVED
 * worker 1's assignment, wrote anyway, both calls returned success).
 *
 * Note it does NOT consult status: the real claim's status guard would otherwise mask the
 * missing CAS (the winner's flip to in_progress refuses everyone else), which is why the real
 * race is also run with `allowedStatuses` WIDENED — leaving the CAS as the only defence on
 * both sides of the comparison.
 */
async function brokenClaimNoCas(taskId: string): Promise<Record<string, unknown>> {
  const client = await db.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
    const read = await client.query('SELECT claim_id::text AS claim_id FROM tasks WHERE id = $1::uuid', [taskId]);
    if (read.rows.length === 0 || read.rows[0].claim_id !== null) {
      await client.query('ROLLBACK');
      return { ok: true, claimed: false, reason: 'held', taskId };
    }
    if (BROKEN_WINDOW_MS > 0) await new Promise((r) => setTimeout(r, BROKEN_WINDOW_MS));
    const upd = await client.query(
      `UPDATE tasks
          SET claim_id = $2::uuid, claim_actor = $3, claim_expires_at = now() + interval '1 hour',
              status = 'in_progress', assigned_to = $3
        WHERE id = $1::uuid
      RETURNING claim_id::text AS claim_id, version`,
      [taskId, randomUUID(), ACTOR],
    );
    await client.query('COMMIT');
    return {
      ok: true,
      claimed: true,
      taskId,
      claimId: upd.rows[0].claim_id,
      actor: ACTOR,
      version: upd.rows[0].version,
      reentered: false,
    };
  } finally {
    client.release();
  }
}

/* ── ops ──────────────────────────────────────────────────────────────────────────────── */

async function runClaim(cmd: any): Promise<Record<string, unknown>> {
  if (CAS_MODE === 'broken') return brokenClaimNoCas(cmd.taskId);
  const resp = await viaPublicTool('task_claim', {
    projectId: cmd.projectId,
    taskId: cmd.taskId,
    actor: ACTOR,
    ...(cmd.allowedStatuses ? { allowedStatuses: cmd.allowedStatuses } : {}),
    ...(cmd.expectedVersion !== undefined ? { expectedVersion: cmd.expectedVersion } : {}),
    ...(cmd.leaseSeconds !== undefined ? { leaseSeconds: cmd.leaseSeconds } : {}),
    ...(cmd.claimId ? { claimId: cmd.claimId } : {}),
  });
  return resp.structuredContent;
}

/**
 * The SCALE op: walk a whole board of tasks, claiming what this worker can get. Each worker
 * shuffles its own copy, so 20 workers do not all march the list in the same order — the
 * contention is spread the way a real fleet's would be instead of degenerating into a queue.
 */
async function runClaimBoard(cmd: any): Promise<Record<string, unknown>> {
  const ids: string[] = [...cmd.taskIds];
  for (let i = ids.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [ids[i], ids[j]] = [ids[j], ids[i]];
  }
  const claimed: Array<{ taskId: string; claimId: string }> = [];
  const refused: Array<{ taskId: string; reason: string }> = [];
  const errors: Array<{ taskId: string; error: string }> = [];
  for (const taskId of ids) {
    try {
      const sc: any = await runClaim({ ...cmd, taskId });
      if (sc?.claimed === true) claimed.push({ taskId, claimId: sc.claimId });
      else refused.push({ taskId, reason: String(sc?.reason ?? 'unknown') });
    } catch (e) {
      errors.push({ taskId, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return { ok: true, attempted: ids.length, claimed, refused, errors };
}

async function runOp(cmd: any): Promise<Record<string, unknown>> {
  switch (cmd.op) {
    case 'claim':
      return runClaim(cmd);
    case 'claimBoard':
      return runClaimBoard(cmd);
    case 'renew':
      return (await viaPublicTool('task_renew', {
        projectId: cmd.projectId, taskId: cmd.taskId, claimId: cmd.claimId,
        ...(cmd.leaseSeconds !== undefined ? { leaseSeconds: cmd.leaseSeconds } : {}),
      })).structuredContent;
    case 'release':
      return (await viaPublicTool('task_release', {
        projectId: cmd.projectId, taskId: cmd.taskId, claimId: cmd.claimId,
      })).structuredContent;
    case 'update': {
      const resp = await viaPublicTool('task_update', {
        projectId: cmd.projectId, taskId: cmd.taskId,
        ...(cmd.status !== undefined ? { status: cmd.status } : {}),
        ...(cmd.assignedTo !== undefined ? { assignedTo: cmd.assignedTo } : {}),
        ...(cmd.title !== undefined ? { title: cmd.title } : {}),
        ...(cmd.claimId ? { claimId: cmd.claimId } : {}),
      });
      // A fenced refusal comes back as isError with a typed structuredContent — surface BOTH
      // so the parent asserts on what a caller really sees, not a flattened success flag.
      return { ...(resp.structuredContent ?? {}), isError: Boolean(resp.isError) };
    }
    case 'sleep':
      await new Promise((r) => setTimeout(r, Number(cmd.ms ?? 0)));
      return { ok: true, slept: Number(cmd.ms ?? 0) };
    default:
      throw new Error(`claimStressWorker: unknown op '${cmd.op}'`);
  }
}

/* ── main loop ────────────────────────────────────────────────────────────────────────── */

async function main(): Promise<void> {
  // WARM THE POOL BEFORE ANNOUNCING READY. Connection establishment must not land inside the
  // race — otherwise the barrier measures libpq handshakes, not the claim.
  await db.query('SELECT 1');
  emit({ ev: 'ready', actor: ACTOR, pid: process.pid, cas: CAS_MODE });

  const rl = createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    const text = line.trim();
    if (!text) return;
    const cmd = JSON.parse(text);
    if (cmd.op === 'exit') {
      db.end().catch(() => undefined).finally(() => process.exit(0));
      return;
    }
    // Dispatched WITHOUT await so several barrier-aligned commands can be in flight at once
    // (the idempotent-retry case fires the same token from many processes simultaneously).
    void (async () => {
      try {
        await waitForBarrier(cmd.at);
        const t0 = Date.now();
        const payload = await runOp(cmd);
        emit({ ev: 'result', id: cmd.id, op: cmd.op, actor: ACTOR, firedAt: t0, ms: Date.now() - t0, payload });
      } catch (e) {
        emit({
          ev: 'result', id: cmd.id, op: cmd.op, actor: ACTOR, firedAt: Date.now(), ms: 0,
          payload: { ok: false, error: e instanceof Error ? e.message : String(e) },
        });
      }
    })();
  });
}

main().catch((e) => {
  emit({ ev: 'fatal', actor: ACTOR, error: e instanceof Error ? e.message : String(e) });
  process.exit(1);
});
