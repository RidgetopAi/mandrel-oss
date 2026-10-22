import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseClaudeResult, type CostSink } from './claudeRun.js';
import { childEnv } from './auth.js';
import { loopPunch, type Board, type Claim, type Task } from './board.js';
import { CLAUDE_RUN_CONFIG, LOOP_EXHAUSTED_TAG, PLAN_CONFIG, REPO_TAG_PREFIX, WORKER_CONFIG as W } from './config.js';
import { renderDoneWhen } from './donewhen.js';
import type { LoopConfig } from './settings.js';

export type WorkerOutcome = 'built' | 'failed' | 'not-started';

export interface WorkerResult {
  outcome: WorkerOutcome;
  note: string;
  branch?: string;
  sha?: string;
}

/** Everything the worker touches outside itself. */
export interface WorkerDeps {
  board: Board;
  config: LoopConfig;
  env: NodeJS.ProcessEnv;
  /** A claim the caller already holds; otherwise the worker claims the task itself. */
  claim?: Claim;
  card?: string;
  /** Receives the worker run's cost. */
  onCost?: CostSink;
}

interface Lane {
  branch?: string;
  sha?: string;
  round?: number;
}

export function branchSlug(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, W.slugMaxLength)
    .replace(/-+$/g, '');
  return slug || W.slugFallback;
}

export function branchName(id: string, title: string): string {
  return `${W.branchPrefix}${id.slice(0, W.idLength)}-${branchSlug(title)}`;
}

export function readWorkerCard(): string {
  return readFileSync(fileURLToPath(new URL(`../${W.cardPath}`, import.meta.url)), 'utf8');
}

/** The brief fed to the worker: card, task, and the shared rendering of the done-when clauses. */
export function renderBrief(task: Task, branch: string, card: string): string {
  const description = typeof task.metadata.description === 'string' ? task.metadata.description : '';
  return [
    card.trim(),
    '',
    `# TASK: ${task.title}`,
    `Branch: ${branch}`,
    ...(description ? ['', description.trim()] : []),
    '',
    '## DONE WHEN',
    renderDoneWhen(task.metadata.punch?.doneWhen),
    '',
  ].join('\n');
}

class Git {
  constructor(private readonly env: NodeJS.ProcessEnv) {}
  run(cwd: string, args: string[]): { ok: boolean; out: string } {
    const r = spawnSync('git', args, { cwd, env: childEnv(this.env), encoding: 'utf8', timeout: W.gitTimeoutMs });
    return { ok: r.status === 0 && !r.error, out: ((r.stdout ?? '') + (r.stderr ?? '') + (r.error?.message ?? '')).trim() };
  }
}

interface Run {
  error?: NodeJS.ErrnoException;
  status: number | null;
  timedOut: boolean;
  /** stdout and stderr interleaved, for failure notes. */
  tail: string;
  stdout: string;
}

function runClaude(bin: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, input: string, timeoutMs: number): Promise<Run> {
  return new Promise((resolve) => {
    let tail = '';
    let stdout = '';
    let timedOut = false;
    let settled = false;
    const done = (r: Run): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    const child = spawn(bin, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    const keep = (b: Buffer): void => {
      tail = (tail + b.toString()).slice(-W.maxBufferBytes);
    };
    child.stdout.on('data', (b: Buffer) => {
      stdout = (stdout + b.toString()).slice(-W.maxBufferBytes);
      keep(b);
    });
    child.stderr.on('data', keep);
    child.stdin.on('error', () => undefined);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), W.killGraceMs).unref();
    }, timeoutMs);
    child.on('error', (error: NodeJS.ErrnoException) => done({ error, status: null, timedOut, tail, stdout }));
    child.on('close', (status) => done({ status, timedOut, tail, stdout }));
    child.stdin.end(input);
  });
}

/**
 * Runs one punch through a worker: worktree, headless claude, then verification from git alone.
 * The claim is released on every path.
 */
export async function runWorker(taskId: string, deps: WorkerDeps): Promise<WorkerResult | null> {
  const { board } = deps;
  let claim = deps.claim;
  if (!claim) {
    const c = await board.claim(taskId);
    if (!c.ok) return null;
    claim = { claimId: c.claimId, expiresAt: c.expiresAt };
  }
  const claimId = claim.claimId;
  const renew = setInterval(() => void board.renew(taskId, claimId).catch(() => undefined), W.renewEveryMs);
  renew.unref();
  try {
    const task = await board.get(taskId);
    if (!task) return { outcome: 'not-started', note: `task ${taskId} not found` };
    return await attempt(task, claimId, deps);
  } finally {
    clearInterval(renew);
    await board.release(taskId, claimId).catch(() => undefined);
  }
}

async function attempt(task: Task, claimId: string, deps: WorkerDeps): Promise<WorkerResult> {
  const { board, config, env } = deps;
  const git = new Git(env);
  const punch = task.metadata.punch ?? {};
  const lane = (punch.lane ?? {}) as Lane;
  const failures = typeof punch.dispatchFailures === 'number' ? punch.dispatchFailures : 0;

  const notStarted = async (note: string): Promise<WorkerResult> => {
    await board.update(task.id, { notes: `worker not started: ${note}` }, claimId);
    return { outcome: 'not-started', note };
  };

  const repoTag = task.tags.find((t) => t.startsWith(REPO_TAG_PREFIX));
  if (!repoTag) return notStarted(`task has no ${REPO_TAG_PREFIX}<tag> tag`);
  const repo = config.repos[repoTag.slice(REPO_TAG_PREFIX.length)] ?? config.repos[repoTag];
  if (!repo) return notStarted(`no repos entry configured for tag ${repoTag}`);

  const retry = typeof lane.branch === 'string' && lane.branch !== '';
  const branch = retry ? lane.branch! : branchName(task.id, task.title);
  const base = repo.main;
  // parseConfig always resolves workdir.
  const wt = join(config.workdir!, W.worktreeDir, branch.slice(W.branchPrefix.length));

  if (!git.run(repo.path, ['rev-parse', '--verify', '--quiet', `${base}^{commit}`]).ok) {
    return notStarted(`repo ${repo.path} has no ${base} branch`);
  }
  try {
    mkdirSync(dirname(wt), { recursive: true });
  } catch (e) {
    return notStarted(`cannot create ${dirname(wt)}: ${(e as Error).message}`);
  }
  if (existsSync(wt)) git.run(repo.path, ['worktree', 'remove', '--force', wt]);
  git.run(repo.path, ['worktree', 'prune']);
  const add = retry
    ? git.run(repo.path, ['worktree', 'add', wt, branch])
    : git.run(repo.path, ['worktree', 'add', '-B', branch, wt, base]);
  if (!add.ok) return notStarted(`git worktree add failed: ${add.out}`);

  try {
    const bin = env[PLAN_CONFIG.binEnv] || PLAN_CONFIG.defaultBin;
    const args = [
      W.args.print,
      W.args.permissionMode,
      config.worker.permissionMode,
      W.args.outputFormat,
      W.args.outputValue,
      W.args.model,
      config.models.worker,
    ];
    const brief = renderBrief(task, branch, deps.card ?? readWorkerCard());
    const r = await runClaude(bin, args, wt, childEnv(env), brief, config.worker.timeoutMinutes * 60_000);
    if (r.error) return notStarted(`could not run ${bin}: ${r.error.message}`);
    deps.onCost?.(CLAUDE_RUN_CONFIG.roles.worker, task.id.slice(0, W.idLength), parseClaudeResult(r.stdout).costUsd);

    const fail = async (why: string): Promise<WorkerResult> => {
      const count = failures + 1;
      const exhausted = count >= config.worker.maxAttempts;
      const note = `worker attempt ${count}/${config.worker.maxAttempts} failed: ${why}`;
      await board.update(
        task.id,
        {
          stage: 'ready',
          notes: exhausted ? `${note}; giving up (${LOOP_EXHAUSTED_TAG})` : note,
          ...loopPunch({ dispatchFailures: count }),
          ...(exhausted ? { tags: [...task.tags.filter((t) => t !== LOOP_EXHAUSTED_TAG), LOOP_EXHAUSTED_TAG] } : {}),
        },
        claimId,
      );
      return { outcome: 'failed', note, branch };
    };

    if (r.timedOut) return fail(`timed out after ${config.worker.timeoutMinutes} minutes`);
    if (r.status !== 0) return fail(`claude exited ${r.status}: ${r.tail.slice(-W.noteTailChars).trim()}`);

    // Verify from git, never from what the model said.
    const head = git.run(repo.path, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`]);
    if (!head.ok) return fail(`branch ${branch} does not resolve`);
    const sha = head.out;
    const mb = git.run(repo.path, ['merge-base', base, sha]);
    if (!mb.ok || !mb.out) return fail(`branch ${branch} shares no merge-base with ${base}`);
    const diff = git.run(repo.path, ['diff', '--quiet', mb.out, sha]);
    if (diff.ok) return fail(`branch ${branch} has no changes against ${base}`);
    if (retry && sha === lane.sha) return fail(`branch ${branch} head did not move from ${sha}`);

    const round = (typeof lane.round === 'number' ? lane.round : 0) + 1;
    const note = `worker built ${branch} @ ${sha} (round ${round})`;
    await board.update(
      task.id,
      { stage: 'verifying', notes: note, ...loopPunch({ lane: { branch, sha, round } }) },
      claimId,
    );
    return { outcome: 'built', note, branch, sha };
  } finally {
    git.run(repo.path, ['worktree', 'remove', '--force', wt]);
  }
}
