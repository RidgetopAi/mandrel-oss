import { spawnSync } from 'node:child_process';
import { childEnv } from './auth.js';
import { costLine, CostTally, type CostSink } from './claudeRun.js';
import { loopPunch, type Board, type Stage, type Task, type TaskRow } from './board.js';
import { claimStatusesFor, REPO_TAG_PREFIX, TICK_CONFIG as T } from './config.js';
import { clausesOf, defaultCriticDeps, runCritic, type ClauseVerdict, type CriticDeps } from './critic.js';
import { mergerOptions, sweep } from './merger.js';
import { hasValidPunch, isClosedStatus, orderPickable } from './pick.js';
import type { LoopConfig } from './settings.js';
import { runWorker, type WorkerResult } from './worker.js';

type Repo = LoopConfig['repos'][string];

/** Everything a sweep touches outside itself, injectable for tests. */
export interface TickDeps {
  board: Board;
  config: LoopConfig;
  env: NodeJS.ProcessEnv;
  err: (line: string) => void;
  worker?: typeof runWorker;
  critic?: CriticDeps;
}

export interface TickResult {
  dispatched: number;
  outcomes: WorkerResult[];
  /** Not-started outcomes seen in a row, carried across ticks. */
  consecutiveNotStarted: number;
  /** True when `consecutiveNotStarted` reached the limit: the caller must stop. */
  halted: boolean;
  /** Claude runs made this tick (worker + critic) and their summed cost in USD. */
  claudeRuns: number;
  costUsd: number;
}

/** The repos entry a task's `repo:<tag>` points at (the same lookup the worker uses). */
export function repoOf(config: LoopConfig, task: Pick<Task, 'tags'>): Repo | undefined {
  const tag = task.tags.find((t) => t.startsWith(REPO_TAG_PREFIX));
  return tag ? (config.repos[tag.slice(REPO_TAG_PREFIX.length)] ?? config.repos[tag]) : undefined;
}

/** Ids already reported as naming an unknown repo, so each is logged once per process. */
const reportedUnknownRepo = new WeakMap<TickDeps['err'], Set<string>>();

/** Drops ready punches whose `repo:` tag has no config entry (they can never run); logs each once. */
function skipUnknownRepo(deps: TickDeps, tasks: readonly Task[]): Task[] {
  const seen = reportedUnknownRepo.get(deps.err) ?? new Set<string>();
  reportedUnknownRepo.set(deps.err, seen);
  return tasks.filter((t) => {
    if (repoOf(deps.config, t)) return true;
    if (!seen.has(t.id)) {
      seen.add(t.id);
      const tag = t.tags.find((x) => x.startsWith(REPO_TAG_PREFIX)) ?? 'no repo: tag';
      const keys = Object.keys(deps.config.repos).join(', ') || 'none';
      deps.err(`tick: skipping ${t.id}: ${tag} has no repos entry in the config (valid: ${keys}); retag it or retire it`);
    }
    return false;
  });
}

async function load(board: Board, rows: readonly TaskRow[]): Promise<Task[]> {
  const tasks = await Promise.all(rows.map((r) => board.get(r.id)));
  return tasks.filter((t): t is Task => t !== null);
}

/** Runs `body` under a fresh claim, always releasing it; returns null when the claim is refused. */
async function withClaim<T>(
  board: Board,
  id: string,
  stage: Stage,
  body: (claimId: string) => Promise<T>,
): Promise<T | null> {
  const c = await board.claim(id, claimStatusesFor(stage));
  if (!c.ok) return null;
  try {
    return await body(c.claimId);
  } finally {
    await board.release(id, c.claimId).catch(() => undefined);
  }
}

/** Claimed punches whose lease lapsed (a crashed lane) go back to ready. */
async function releaseStale(deps: TickDeps): Promise<void> {
  const { board } = deps;
  for (const row of await board.listStage(T.claimedStage)) {
    if (row.claimLive) continue;
    await withClaim(board, row.id, row.stage, (claimId) =>
      board.update(row.id, { stage: T.releasedStage, notes: 'loop: released a stale claim' }, claimId),
    );
  }
}

/** Drafts with dependencies, every one of them closed, move to ready. A draft already worked is left for a human. */
async function promote(deps: TickDeps, isClosed: (id: string) => boolean): Promise<void> {
  const { board } = deps;
  for (const task of await load(board, await board.listStage(T.promoteFromStage))) {
    const punch = task.metadata.punch;
    const blockers = punch?.dependsOn ?? [];
    if (blockers.length === 0 || !blockers.every(isClosed) || !hasValidPunch(task) || punch?.[T.workedPunchKey] !== undefined) continue;
    await withClaim(board, task.id, task.stage, (claimId) =>
      board.update(task.id, { stage: T.promotedStage, notes: 'loop: dependencies closed' }, claimId),
    );
  }
}

async function mergeSweep(deps: TickDeps): Promise<void> {
  const { board, config, env } = deps;
  for (const repo of Object.values(config.repos)) {
    const opts = mergerOptions(
      repo.path,
      {
        mode: config.merge.mode,
        remote: repo.remote,
        mainBranch: repo.main,
        gateCommand: repo.gate,
        gateTimeoutMs: repo.gateTimeoutMinutes * 60_000,
      },
      env,
    );
    try {
      for (const r of await sweep(board, opts, (task) => repoOf(config, task) === repo)) {
        deps.err(`tick: ${r.id.slice(0, 8)} ${r.action}${r.detail ? `: ${r.detail}` : ''}`);
      }
    } catch (e) {
      deps.err(`tick: merge sweep failed for ${repo.path}: ${(e as Error).message}`);
    }
  }
}

/** The branch head per git; the worker's recorded sha is only the fallback. */
function branchHead(repo: Repo, branch: string, env: NodeJS.ProcessEnv): string | null {
  const r = spawnSync('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`], {
    cwd: repo.path,
    env: childEnv(env),
    encoding: 'utf8',
  });
  return r.status === 0 ? r.stdout.trim() || null : null;
}

async function criticSweep(deps: TickDeps, onCost: CostSink): Promise<void> {
  const { board, config, env } = deps;
  const criticDeps = { ...(deps.critic ?? defaultCriticDeps(env)), onCost };
  for (const task of await load(board, (await board.listStage('verifying')).filter((r) => !r.claimLive))) {
    const punch = task.metadata.punch ?? {};
    const lane = (punch[T.bridge.lane] ?? {}) as { branch?: unknown; sha?: unknown };
    const repo = repoOf(config, task);
    const branch = typeof punch[T.bridge.branch] === 'string' ? (punch[T.bridge.branch] as string) : lane.branch;
    if (!repo || typeof branch !== 'string') continue;
    const sha = branchHead(repo, branch, env) ?? (typeof lane.sha === 'string' ? lane.sha : null);
    if (!sha) continue;
    try {
      await withClaim(board, task.id, task.stage, async (claimId) => {
        // The critic reads punch.branch/sha; the merger reads punch.branch and punch.verdict.
        const bridged = await board.update(task.id, loopPunch({ [T.bridge.branch]: branch, [T.bridge.sha]: sha }), claimId);
        if (!bridged.ok) throw new Error(`board refused the branch/sha update: ${bridged.reason}`);
        const outcome = await runCritic(board, config, task.id, claimId, criticDeps);
        if (outcome.verdict !== 'PASS') return;
        const done = await board.get(task.id);
        const walkthrough = done?.metadata.punch?.walkthrough as { clauses?: ClauseVerdict[] } | undefined;
        const texts = clausesOf(task);
        const clauses = (walkthrough?.clauses ?? []).map((c) => ({
          text: texts[c.index]?.text ?? `clause ${c.index}`,
          result: c.verified ? 'PASS' : 'FAIL',
          ...(c.evidence ? { evidence: c.evidence } : {}),
        }));
        const verdict = { result: outcome.verdict, sha, clauses };
        await board.update(task.id, loopPunch({ [T.bridge.verdict]: verdict }), claimId);
      });
    } catch (e) {
      deps.err(`tick: critic failed for ${task.id}: ${(e as Error).message}`);
    }
  }
}

async function dispatch(deps: TickDeps, task: Task, onCost: CostSink): Promise<WorkerResult | null> {
  const { board, config, env } = deps;
  const worker = deps.worker ?? runWorker;
  const c = await board.claim(task.id);
  if (!c.ok) return null;
  const claim = { claimId: c.claimId, expiresAt: c.expiresAt };
  let result: WorkerResult;
  try {
    const moved = await board.update(task.id, { stage: T.claimedStage }, claim.claimId);
    if (!moved.ok) {
      await board.release(task.id, claim.claimId).catch(() => undefined);
      return null;
    }
    result = (await worker(task.id, { board, config, env, claim, onCost })) ?? { outcome: 'not-started', note: 'claim lost' };
  } catch (e) {
    deps.err(`tick: worker for ${task.id} threw: ${(e as Error).message}`);
    result = { outcome: 'not-started', note: (e as Error).message };
  }
  if (result.outcome === 'not-started') {
    const { note } = result;
    deps.err(`tick: ${task.id} not started: ${note}`);
    // The worker released its claim; take a new one just to put the punch back where it was.
    await withClaim(board, task.id, T.claimedStage, (claimId) =>
      board.update(task.id, { stage: T.releasedStage, notes: `loop: worker not started: ${note}` }, claimId),
    ).catch(() => undefined);
  }
  return result;
}

/**
 * One sweep: release stale claims, promote unblocked drafts, merge, critique, then fill the free
 * lanes with workers. `consecutiveNotStarted` is threaded through by the caller.
 */
export async function tick(deps: TickDeps, consecutiveNotStarted = 0): Promise<TickResult> {
  const { board, config } = deps;
  const status = new Map<string, boolean>();
  const isClosedAsync = async (id: string): Promise<boolean> => {
    if (!status.has(id)) status.set(id, isClosedStatus((await board.get(id))?.status ?? ''));
    return status.get(id)!;
  };
  const prime = async (tasks: readonly Task[]): Promise<void> => {
    await Promise.all(tasks.flatMap((t) => t.metadata.punch?.dependsOn ?? []).map(isClosedAsync));
  };
  const isClosed = (id: string): boolean => status.get(id) ?? false;

  await releaseStale(deps);
  const drafts = await load(board, await board.listStage(T.promoteFromStage));
  await prime(drafts);
  await promote(deps, isClosed);
  await mergeSweep(deps);
  const tally = new CostTally();
  const onCost: CostSink = (role, punchId, costUsd) => {
    tally.add(costUsd);
    deps.err(costLine(role, punchId, costUsd));
  };
  await criticSweep(deps, onCost);

  const busy = (await board.listStage(T.claimedStage)).filter((r) => r.claimLive).length;
  const free = Math.max(0, config.lanes - busy);
  const ready = skipUnknownRepo(deps, await load(board, await board.listStage('ready')));
  await prime(ready);
  const picked = orderPickable(ready, isClosed).slice(0, free);
  const results = await Promise.all(picked.map((t) => dispatch(deps, t, onCost)));

  const outcomes: WorkerResult[] = [];
  let streak = consecutiveNotStarted;
  for (const r of results) {
    if (!r) continue;
    outcomes.push(r);
    streak = r.outcome === 'not-started' ? streak + 1 : 0;
  }
  return {
    dispatched: picked.length,
    outcomes,
    consecutiveNotStarted: streak,
    halted: streak >= T.maxConsecutiveNotStarted,
    claudeRuns: tally.runs,
    costUsd: tally.totalUsd,
  };
}
