/**
 * claimStressHarness — the PARENT side of the atomic-claim concurrency acceptance test
 *. Spawns real worker PROCESSES, releases them on a wall-clock
 * barrier, and — critically — owns the ANALYZER that decides whether a race was safe.
 *
 * THE ONE RULE THIS FILE EXISTS TO ENFORCE (a past incident — "your guard and your product agree,
 * and you can weaken one without the other noticing"): the real run and the mutation probe
 * must be judged by THE SAME FUNCTION. `assertExactlyOneWinner` is called by the shipped
 * assertion AND by the probe, which asserts it THROWS against a CAS-less claim. If the two
 * sides ever drift apart, the probe stops proving anything about the assertion that ships.
 *
 * Everything tunable is a named config value with an env override (configs-not-hardcoded):
 * worker counts, board size, the barrier lead, and the process boot timeout.
 */
import { spawn, ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** mcp-server/ — resolved from THIS file so it is correct under vitest, tsx and dist alike. */
const MCP_DIR = path.resolve(HERE, '../../..');
const WORKER_ENTRY = path.join(MCP_DIR, 'src/tests/helpers/claimStressWorker.ts');
const TSX_BIN = path.join(MCP_DIR, 'node_modules/.bin/tsx');

function envInt(name: string, fallback: number): number {
  const raw = process.env[name]; // env-read: via-callers
  const v = Number(raw);
  return raw !== undefined && raw !== '' && Number.isInteger(v) && v > 0 ? v : fallback;
}

export const STRESS_CONFIG = {
  /** Workers in the head-to-head race. The eval asks for ≥10 (report experiment X1). */
  raceWorkers: envInt('MANDREL_CLAIM_STRESS_RACE_WORKERS', 12),
  /** Workers in the scale run (report experiment X5 / roadmap item 10: ~20 workers). */
  scaleWorkers: envInt('MANDREL_CLAIM_STRESS_SCALE_WORKERS', 20),
  /** Tasks on the board for the scale run (~100). */
  scaleTasks: envInt('MANDREL_CLAIM_STRESS_SCALE_TASKS', 100),
  /** How many times the head-to-head race is repeated — a race proven ONCE proves little. */
  raceRounds: envInt('MANDREL_CLAIM_STRESS_RACE_ROUNDS', 20),
  /** Lead time from "send the command" to the barrier instant, in ms. */
  barrierLeadMs: envInt('MANDREL_CLAIM_STRESS_BARRIER_LEAD_MS', 250),
  /** How long to wait for a worker process to boot and warm its pool. */
  bootTimeoutMs: envInt('MANDREL_CLAIM_STRESS_BOOT_TIMEOUT_MS', 90_000),
  /** How long to wait for a single command's result. */
  opTimeoutMs: envInt('MANDREL_CLAIM_STRESS_OP_TIMEOUT_MS', 120_000),
  /** How long a worker gets to shut down cleanly before the group is SIGKILLed. */
  shutdownGraceMs: envInt('MANDREL_CLAIM_STRESS_SHUTDOWN_GRACE_MS', 5_000),
  /** How long to wait for a killed process GROUP to actually disappear. */
  killVerifyTimeoutMs: envInt('MANDREL_CLAIM_STRESS_KILL_VERIFY_MS', 10_000),
};

export interface WorkerResult {
  id: number;
  op: string;
  actor: string;
  firedAt: number;
  ms: number;
  payload: any;
}

/** A live worker process, addressed by its actor name. */
export class StressWorker {
  private nextId = 1;
  private pending = new Map<number, { resolve: (r: WorkerResult) => void; reject: (e: Error) => void }>();
  private readyResolve!: () => void;
  private readyReject!: (e: Error) => void;
  readonly ready: Promise<void>;
  private exited = false;

  constructor(readonly actor: string, private proc: ChildProcess) {
    this.ready = new Promise<void>((res, rej) => {
      this.readyResolve = res;
      this.readyReject = rej;
    });
    const rl = createInterface({ input: proc.stdout! });
    rl.on('line', (line) => this.onLine(line));
    proc.on('exit', (code, signal) => {
      this.exited = true;
      const err = new Error(`worker ${actor} exited (code=${code} signal=${signal}) with ${this.pending.size} op(s) in flight`);
      this.readyReject(err);
      for (const [, p] of this.pending) p.reject(err);
      this.pending.clear();
    });
  }

  private onLine(line: string): void {
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      return; // product logging noise on stdout is not protocol — ignore it
    }
    if (msg.ev === 'ready') this.readyResolve();
    else if (msg.ev === 'fatal') this.readyReject(new Error(`worker ${this.actor} fatal: ${msg.error}`));
    else if (msg.ev === 'result') {
      const p = this.pending.get(msg.id);
      if (p) {
        this.pending.delete(msg.id);
        p.resolve(msg as WorkerResult);
      }
    }
  }

  /** Send a command; resolves with the worker's result line. `at` is the barrier instant. */
  send(cmd: Record<string, unknown>): Promise<WorkerResult> {
    if (this.exited) return Promise.reject(new Error(`worker ${this.actor} is dead`));
    const id = this.nextId++;
    const promise = new Promise<WorkerResult>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const t = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`worker ${this.actor} op ${cmd.op} timed out`));
      }, STRESS_CONFIG.opTimeoutMs);
      t.unref?.();
    });
    this.proc.stdin!.write(JSON.stringify({ id, ...cmd }) + '\n');
    return promise;
  }

  /**
   * SIGKILL THE WHOLE PROCESS GROUP, and do not return until it is measurably gone.
   *
   * WHY THE GROUP AND NOT `proc.kill()` — this was a real defect in this harness, found by
   * noticing worker processes still holding connections after a run: `node_modules/.bin/tsx`
   * is a LAUNCHER that forks the actual node process. Signalling the child killed only the
   * launcher; the grandchild — the thing that holds the claim and the pool — survived. A test
   * whose "worker that died" did not die is testing nothing (report the proof,
   * not the claim). Workers are therefore spawned `detached` (own process group) and killed by
   * NEGATIVE pid, then the death is VERIFIED with signal 0 rather than assumed.
   */
  async kill(): Promise<void> {
    this.killGroup('SIGKILL');
    await this.awaitGroupGone();
  }

  private killGroup(signal: NodeJS.Signals): void {
    try {
      process.kill(-this.proc.pid!, signal); // negative pid = the whole group
    } catch {
      try {
        this.proc.kill(signal);
      } catch {
        /* already gone */
      }
    }
  }

  /** Poll with signal 0 until the group no longer exists. Throws if it outlives the timeout. */
  private async awaitGroupGone(): Promise<void> {
    const deadline = Date.now() + STRESS_CONFIG.killVerifyTimeoutMs;
    for (;;) {
      try {
        process.kill(-this.proc.pid!, 0);
      } catch {
        return; // ESRCH — the group is gone, measured
      }
      if (Date.now() > deadline) {
        throw new Error(`worker ${this.actor} process group ${this.proc.pid} survived SIGKILL`);
      }
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  async stop(): Promise<void> {
    if (!this.exited) {
      try {
        this.proc.stdin!.write(JSON.stringify({ id: 0, op: 'exit' }) + '\n');
      } catch {
        /* already gone */
      }
      await new Promise<void>((res) => {
        const t = setTimeout(res, STRESS_CONFIG.shutdownGraceMs);
        t.unref?.();
        this.proc.on('exit', () => {
          clearTimeout(t);
          res();
        });
      });
    }
    // ALWAYS reap the group afterwards. A clean `exit` ends the launcher, but a worker whose
    // pool.end() hangs would otherwise be left behind holding a Postgres connection — which is
    // exactly how this harness leaked 7 processes and blocked its own DB teardown.
    this.killGroup('SIGKILL');
    await this.awaitGroupGone();
  }
}

export interface SpawnOpts {
  /** 'real' (the shipped claim) or 'broken' (the CAS-less mutant) — see claimStressWorker. */
  cas?: 'real' | 'broken';
  /** Read-to-write window for the mutant, in ms. */
  brokenWindowMs?: number;
  /** Prefix for actor names, so a case can tell its workers apart in the audit. */
  actorPrefix?: string;
  /** Extra env for the children (e.g. a shortened lease floor for the expiry case). */
  env?: Record<string, string>;
}

/** Spawn `n` worker processes and resolve once every one has warmed its pool. */
export async function spawnWorkers(n: number, opts: SpawnOpts = {}): Promise<StressWorker[]> {
  const prefix = opts.actorPrefix ?? 'w';
  const workers = Array.from({ length: n }, (_, i) => {
    const actor = `${prefix}-${i}`;
    const proc = spawn(
      TSX_BIN,
      [
        WORKER_ENTRY,
        '--actor', actor,
        '--cas', opts.cas ?? 'real',
        '--brokenWindowMs', String(opts.brokenWindowMs ?? 30),
      ],
      {
        cwd: MCP_DIR,
        stdio: ['pipe', 'pipe', 'inherit'],
        // OWN PROCESS GROUP — so a kill reaches the tsx launcher AND the node process it
        // forks. Without this, `kill()` decapitates the launcher and leaves the real worker
        // alive (see StressWorker.kill).
        detached: true,
        env: {
          ...process.env,
          // The feature ships DARK. The children turn it on through the REAL config path
          // (env → claimConfig), not by mutating an object — this is also the only honest way
          // to run it, since each child is a separate process with its own module registry.
          MANDREL_TASK_CLAIM_ENABLED: 'true',
          // Keep the children's background machinery quiet: no belief adjudication (which
          // would make paid LLM calls) and no re-embed sweeps against the shared CI DB.
          MANDREL_BELIEF_ENABLED: 'false',
          MANDREL_REEMBED_WORKER_ENABLED: 'false',
          ...(opts.env ?? {}),
        },
      },
    );
    return new StressWorker(actor, proc);
  });

  const boot = Promise.all(workers.map((w) => w.ready));
  const timeout = new Promise<never>((_, rej) => {
    const t = setTimeout(() => rej(new Error(`worker boot timed out after ${STRESS_CONFIG.bootTimeoutMs}ms`)), STRESS_CONFIG.bootTimeoutMs);
    t.unref?.();
  });
  await Promise.race([boot, timeout]);
  return workers;
}

export async function stopWorkers(workers: StressWorker[]): Promise<void> {
  await Promise.all(workers.map((w) => w.stop()));
}

/**
 * Fire ONE command per worker, all released at the same wall-clock instant.
 * Returns the results in worker order.
 */
export async function barrierFire(
  workers: StressWorker[],
  build: (w: StressWorker, index: number) => Record<string, unknown>,
  leadMs: number = STRESS_CONFIG.barrierLeadMs,
): Promise<WorkerResult[]> {
  const at = Date.now() + leadMs;
  return Promise.all(workers.map((w, i) => w.send({ ...build(w, i), at })));
}

/* ═══════════════════════════════════════════════════════════════════════════════════════
 * THE ANALYZER — one implementation, used by the real assertion AND by the mutation probe
 * ═══════════════════════════════════════════════════════════════════════════════════════ */

export interface RaceAnalysis {
  workers: number;
  winners: WorkerResult[];
  losers: WorkerResult[];
  errors: WorkerResult[];
  /** Distinct claim ids handed out as a WIN — >1 means two owners were minted. */
  distinctWinningClaimIds: string[];
  /** reason → count over the refusals, so a loser distribution can be reported, not guessed. */
  reasonCounts: Record<string, number>;
  /** ms between the first and last worker actually firing — proof the release was simultaneous. */
  fireSpreadMs: number;
}

export function analyzeRace(results: WorkerResult[]): RaceAnalysis {
  const winners = results.filter((r) => r.payload?.claimed === true);
  const losers = results.filter((r) => r.payload?.claimed === false);
  const errors = results.filter((r) => r.payload?.claimed === undefined);
  const reasonCounts: Record<string, number> = {};
  for (const l of losers) {
    const reason = String(l.payload?.reason ?? 'unknown');
    reasonCounts[reason] = (reasonCounts[reason] ?? 0) + 1;
  }
  const fired = results.map((r) => r.firedAt);
  return {
    workers: results.length,
    winners,
    losers,
    errors,
    distinctWinningClaimIds: Array.from(new Set(winners.map((w) => String(w.payload?.claimId)))),
    reasonCounts,
    fireSpreadMs: fired.length ? Math.max(...fired) - Math.min(...fired) : 0,
  };
}

/**
 * THE SHIPPED ASSERTION. Throws — with the measured numbers in the message — unless the race
 * produced exactly one winner, one distinct claim token, N-1 typed refusals and zero errors.
 *
 * Deliberately a THROWING function rather than a pile of `expect`s inside the test: the
 * mutation probe needs to invoke the very same judgement and prove it FAILS. A probe that
 * re-implements the check proves only that the probe is broken.
 */
export function assertExactlyOneWinner(results: WorkerResult[], label = 'race'): RaceAnalysis {
  const a = analyzeRace(results);
  const problems: string[] = [];
  if (a.winners.length !== 1) {
    problems.push(`expected exactly 1 winner, measured ${a.winners.length} ` +
      `(actors: ${a.winners.map((w) => w.actor).join(', ') || 'none'})`);
  }
  if (a.distinctWinningClaimIds.length > 1) {
    problems.push(`expected 1 winning claim token, measured ${a.distinctWinningClaimIds.length}`);
  }
  if (a.losers.length !== a.workers - 1) {
    problems.push(`expected ${a.workers - 1} typed refusals, measured ${a.losers.length}`);
  }
  for (const l of a.losers) {
    if (!l.payload?.reason) problems.push(`worker ${l.actor} was refused with NO typed reason`);
  }
  if (a.errors.length) {
    problems.push(`${a.errors.length} worker(s) errored: ` +
      a.errors.map((e) => `${e.actor}: ${JSON.stringify(e.payload)}`).join(' | '));
  }
  if (problems.length) {
    throw new Error(`[${label}] UNSAFE: ${problems.join('; ')}. reasons=${JSON.stringify(a.reasonCounts)}`);
  }
  return a;
}

/* ═══════════════════════════════════════════════════════════════════════════════════════
 * AUDIT RECONSTRUCTION — the story told by server events ALONE
 * ═══════════════════════════════════════════════════════════════════════════════════════ */

export interface ClaimEventRow {
  event_type: string;
  outcome: string;
  actor: string | null;
  claim_id: string | null;
  previous_claim_id: string | null;
  old_version: number | null;
  new_version: number | null;
  reason: string | null;
  occurred_at: Date | string;
}

export interface OwnershipReconstruction {
  /** Ownership intervals in the order the server saw them: who held which token, from when. */
  holders: Array<{ actor: string | null; claimId: string | null; from: string; via: string }>;
  /** Every refused attempt with its typed reason — the losers' side of the story. */
  refusals: Array<{ actor: string | null; reason: string | null; at: string; presentedClaimId: string | null }>;
  /** Anything the events cannot account for. NON-EMPTY = the audit does not explain the row. */
  anomalies: string[];
}

/**
 * Rebuild "who held what, and when" from task_claim_events ALONE — no worker-authored input.
 *
 * This is the report's acceptance bar for the audit (line 645): the duplicate-claim incident
 * must be explainable ENTIRELY from server events. So the reconstruction takes only the event
 * rows plus the row's FINAL claim token, and reports an anomaly if the two disagree — which is
 * exactly what happens when something takes ownership without going through the claim (the
 * mutant does precisely that, so this check goes RED under the probe too).
 */
export function reconstructOwnership(events: ClaimEventRow[], finalClaimId: string | null): OwnershipReconstruction {
  const asc = [...events].sort(
    (a, b) => new Date(a.occurred_at).getTime() - new Date(b.occurred_at).getTime(),
  );
  const holders: OwnershipReconstruction['holders'] = [];
  const refusals: OwnershipReconstruction['refusals'] = [];
  const anomalies: string[] = [];

  for (const e of asc) {
    const at = new Date(e.occurred_at).toISOString();
    switch (e.event_type) {
      case 'claim_won':
        holders.push({ actor: e.actor, claimId: e.claim_id, from: at, via: 'claim_won' });
        break;
      case 'claim_reentered':
        if (!holders.length || holders[holders.length - 1].claimId !== e.claim_id) {
          anomalies.push(`claim_reentered at ${at} for token ${e.claim_id} that no claim_won ever granted`);
        }
        break;
      case 'force_override':
        holders.push({ actor: e.actor, claimId: e.claim_id, from: at, via: 'force_override' });
        break;
      case 'claim_released':
      case 'claim_cleared':
        holders.push({ actor: null, claimId: null, from: at, via: e.event_type });
        break;
      case 'claim_rejected':
      case 'renew_rejected':
      case 'release_rejected':
      case 'fence_rejected':
        refusals.push({ actor: e.actor, reason: e.reason, at, presentedClaimId: e.claim_id });
        break;
      default:
        break;
    }
  }

  const lastHeld = [...holders].reverse().find((h) => h.claimId !== null)?.claimId ?? null;
  const currentlyHeld = holders.length ? holders[holders.length - 1].claimId : null;
  if (finalClaimId && finalClaimId !== currentlyHeld) {
    anomalies.push(
      `the row holds token ${finalClaimId} but the audit's last ownership event is ` +
      `${currentlyHeld ?? 'none'}${lastHeld && lastHeld !== finalClaimId ? ` (last granted: ${lastHeld})` : ''} ` +
      `— an owner the server never recorded granting`,
    );
  }
  if (!finalClaimId && currentlyHeld) {
    anomalies.push(`the audit says token ${currentlyHeld} is held but the row carries no claim`);
  }
  return { holders, refusals, anomalies };
}
