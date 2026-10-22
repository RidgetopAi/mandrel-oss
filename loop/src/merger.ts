import { spawnSync } from 'node:child_process';
import { loopPunch, type Board, type Claim, type Task, type TaskUpdate } from './board.js';
import { childEnv } from './auth.js';
import { AUTH_CONFIG, claimStatusesFor, MERGER_CONFIG as C, RISK_GATE_TAG } from './config.js';

export type MergerMode = (typeof C.modes)[number];

export interface MergerOptions {
  mode: MergerMode;
  /** Checkout of the repository the punch's branch lives in. */
  repoDir: string;
  remote: string;
  mainBranch: string;
  /** The gh binary (a name or path); tests substitute a recording fake. */
  ghBin: string;
  gateCommand: string;
  gateTimeoutMs: number;
  gateTailLines: number;
  /** The loop's environment; the gate and gh each get an allow-listed subset of it. */
  env: NodeJS.ProcessEnv;
}

export function mergerOptions(
  repoDir: string,
  overrides: Partial<MergerOptions> = {},
  env: NodeJS.ProcessEnv = process.env,
): MergerOptions {
  return {
    mode: C.defaultMode,
    repoDir,
    remote: C.defaultRemote,
    mainBranch: C.defaultMainBranch,
    ghBin: env[C.ghBinEnv] || C.defaultGhBin,
    gateCommand: C.defaultGateCommand,
    gateTimeoutMs: C.gateTimeoutMs,
    gateTailLines: C.gateTailLines,
    env,
    ...overrides,
  };
}

export interface VerdictClause {
  text: string;
  result?: string;
  evidence?: string;
}

/** The walkthrough verdict recorded at `metadata.punch.verdict`. */
export interface Verdict {
  result: string;
  /** The branch head the walkthrough measured. */
  sha: string;
  clauses?: VerdictClause[];
}

export type MergeAction =
  | 'not-a-candidate'
  | 'pr-opened'
  | 'pr-merged'
  | 'pr-pending'
  | 'restaged-stale'
  | 'merged'
  | 'gate-red'
  | 'could-not-measure'
  | 'conflict'
  | 'claim-refused';

export interface MergeResult {
  id: string;
  action: MergeAction;
  detail?: string;
}

interface Run {
  rc: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  error?: string;
}

function run(
  cmd: string,
  args: readonly string[],
  cwd: string,
  timeoutMs?: number,
  env?: NodeJS.ProcessEnv,
): Run {
  const r = spawnSync(cmd, [...args], { cwd, env, encoding: 'utf8', timeout: timeoutMs, maxBuffer: C.maxBufferBytes });
  const timedOut = (r.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT';
  return { rc: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', timedOut, error: r.error?.message };
}

/** The environment gh runs with: the allow-list plus the gh token, never the Mandrel token. */
export function ghEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out = childEnv(env);
  const token = env[AUTH_CONFIG.ghTokenEnv];
  if (token) out[AUTH_CONFIG.ghTokenEnv] = token;
  return out;
}

const git = (o: MergerOptions, ...args: string[]): Run => run('git', args, o.repoDir);
const out = (r: Run): string => r.stdout.trim();
const failure = (r: Run): string => r.error ?? (r.stderr.trim() || r.stdout.trim() || `rc=${r.rc}`);

/** The verdict rendered as markdown for a PR body. */
export function renderVerdict(task: Task, verdict: Verdict): string {
  const lines = [`## ${task.title}`, '', `Walkthrough verdict: **${verdict.result}** @ \`${verdict.sha}\``, '', '### Done when'];
  for (const c of verdict.clauses ?? []) {
    lines.push(`- ${c.result ? `**${c.result}** — ` : ''}${c.text}${c.evidence ? `\n  - ${c.evidence}` : ''}`);
  }
  return `${lines.join('\n')}\n`;
}

function verdictOf(task: Task): Verdict | null {
  const v = task.metadata.punch?.verdict as Partial<Verdict> | undefined;
  return v && typeof v.result === 'string' && typeof v.sha === 'string' ? (v as Verdict) : null;
}

const branchOf = (task: Task): string | null => {
  const b = task.metadata.punch?.branch;
  return typeof b === 'string' && b !== '' ? b : null;
};

/** Candidate rules short of the branch-head check. */
function isCandidate(task: Task): boolean {
  const punch = task.metadata.punch;
  if (task.stage !== 'evidence' || !punch) return false;
  if (verdictOf(task)?.result !== C.passVerdict) return false;
  if (!punch.proofKind || punch.proofKind === 'look') return false;
  if (task.tags.includes(RISK_GATE_TAG)) return false;
  return branchOf(task) !== null;
}

/** One pass over the evidence stage (limited to tasks `accept` allows). Each task is claimed only while it is acted on. */
export async function sweep(
  board: Board,
  opts: MergerOptions,
  accept: (task: Task) => boolean = () => true,
): Promise<MergeResult[]> {
  const results: MergeResult[] = [];
  for (const row of await board.listStage('evidence')) {
    const task = await board.get(row.id);
    if (!task || !accept(task)) continue;
    const r = await handle(board, task, opts);
    if (r) results.push(r);
  }
  return results;
}

async function handle(board: Board, task: Task, opts: MergerOptions): Promise<MergeResult | null> {
  const pr = task.metadata.punch?.pr as { number?: number } | undefined;
  if (pr && typeof pr.number === 'number') return withClaim(board, task, (u) => checkPr(task, pr.number!, opts, u));
  if (!isCandidate(task)) return null;
  if (task.metadata.punch?.conflict) return null;
  return withClaim(board, task, (u) => advance(task, opts, u));
}

type Updater = (update: TaskUpdate) => Promise<void>;

async function withClaim(
  board: Board,
  task: Task,
  body: (update: Updater) => Promise<MergeResult>,
): Promise<MergeResult> {
  const c = await board.claim(task.id, claimStatusesFor(task.stage));
  if (!c.ok) return { id: task.id, action: 'claim-refused', detail: c.reason };
  const claim: Claim = c;
  try {
    return await body(async (update) => {
      const r = await board.update(task.id, update, claim.claimId);
      if (!r.ok) throw new Error(`update refused: ${r.reason}${r.message ? ` (${r.message})` : ''}`);
    });
  } finally {
    await board.release(task.id, claim.claimId);
  }
}

async function checkPr(task: Task, number: number, opts: MergerOptions, update: Updater): Promise<MergeResult> {
  const r = run(opts.ghBin, ['pr', 'view', String(number), '--json', 'state'], opts.repoDir, undefined, ghEnv(opts.env));
  if (r.rc !== 0) return { id: task.id, action: 'could-not-measure', detail: `gh pr view: ${failure(r)}` };
  let state: unknown;
  try {
    state = (JSON.parse(r.stdout) as { state?: unknown }).state;
  } catch {
    return { id: task.id, action: 'could-not-measure', detail: 'gh pr view: unparseable output' };
  }
  if (state !== C.prMergedState) return { id: task.id, action: 'pr-pending', detail: String(state) };
  await update({ stage: C.mergedStage });
  return { id: task.id, action: 'pr-merged' };
}

async function advance(task: Task, opts: MergerOptions, update: Updater): Promise<MergeResult> {
  const id = task.id;
  const verdict = verdictOf(task)!;
  const branch = branchOf(task)!;
  const head = git(opts, 'rev-parse', '--verify', `refs/heads/${branch}^{commit}`);
  if (head.rc !== 0 || out(head) !== verdict.sha) {
    const now = head.rc === 0 ? out(head) : 'missing';
    await update({
      stage: C.restageOnStale,
      notes: `merger: branch ${branch} is at ${now}, verdict was measured at ${verdict.sha}`,
    });
    return { id, action: 'restaged-stale', detail: now };
  }
  return opts.mode === 'pr' ? openPr(task, branch, verdict, opts, update) : mergeDirect(task, branch, opts, update);
}

async function openPr(
  task: Task,
  branch: string,
  verdict: Verdict,
  opts: MergerOptions,
  update: Updater,
): Promise<MergeResult> {
  const id = task.id;
  const push = git(opts, 'push', opts.remote, `refs/heads/${branch}:refs/heads/${branch}`);
  if (push.rc !== 0) return { id, action: 'could-not-measure', detail: `push: ${failure(push)}` };
  const create = run(
    opts.ghBin,
    ['pr', 'create', '--base', opts.mainBranch, '--head', branch, '--title', task.title, '--body', renderVerdict(task, verdict)],
    opts.repoDir,
    undefined,
    ghEnv(opts.env),
  );
  if (create.rc !== 0) return { id, action: 'could-not-measure', detail: `gh pr create: ${failure(create)}` };
  const url = out(create).split('\n').pop()!.trim();
  const m = C.prUrlPattern.exec(url);
  if (!m) return { id, action: 'could-not-measure', detail: `gh pr create: no PR url in output "${url}"` };
  await update(loopPunch({ pr: { url, number: Number(m[1]) } }));
  return { id, action: 'pr-opened', detail: url };
}

function tail(text: string, lines: number): string {
  return text.trimEnd().split('\n').slice(-lines).join('\n');
}

async function mergeDirect(task: Task, branch: string, opts: MergerOptions, update: Updater): Promise<MergeResult> {
  const id = task.id;
  const cant = (detail: string): MergeResult => ({ id, action: 'could-not-measure', detail });

  // Preflight: nothing is touched unless the main checkout is on main, clean, and level with the remote.
  const onBranch = git(opts, 'symbolic-ref', '--short', 'HEAD');
  if (onBranch.rc !== 0 || out(onBranch) !== opts.mainBranch) return cant(`checkout is not on ${opts.mainBranch}`);
  const status = git(opts, 'status', '--porcelain');
  if (status.rc !== 0) return cant(`git status: ${failure(status)}`);
  if (out(status) !== '') return cant('main checkout is not clean');
  const fetch = git(opts, 'fetch', opts.remote);
  if (fetch.rc !== 0) return cant(`git fetch: ${failure(fetch)}`);
  const pre = out(git(opts, 'rev-parse', 'HEAD'));
  const remote = git(opts, 'rev-parse', `refs/remotes/${opts.remote}/${opts.mainBranch}`);
  if (remote.rc !== 0 || out(remote) !== pre) return cant(`${opts.mainBranch} is not level with ${opts.remote}`);

  const restore = (): void => {
    git(opts, 'reset', '--hard', pre);
    git(opts, 'clean', '-fd');
  };

  const merge = git(opts, 'merge', '--no-ff', '-m', `Merge ${branch} (task ${id.slice(0, 8)})`, `refs/heads/${branch}`);
  if (merge.rc !== 0) {
    const files = out(git(opts, 'diff', '--name-only', '--diff-filter=U'));
    git(opts, 'merge', '--abort');
    restore();
    if (files === '') return cant(`git merge: ${failure(merge)}`);
    await update(loopPunch({ conflict: { branch, at: pre, detail: tail(`${merge.stdout}\n${merge.stderr}`, opts.gateTailLines) } }));
    return { id, action: 'conflict', detail: files };
  }

  const gate = run('bash', ['-c', opts.gateCommand], opts.repoDir, opts.gateTimeoutMs, childEnv(opts.env));
  const gateOutput = `${gate.stdout}\n${gate.stderr}`;
  if (gate.rc === C.gateExit.green) {
    const merged = out(git(opts, 'rev-parse', 'HEAD'));
    const push = git(opts, 'push', opts.remote, `refs/heads/${opts.mainBranch}:refs/heads/${opts.mainBranch}`);
    if (push.rc !== 0) {
      restore();
      return cant(`push: ${failure(push)}`);
    }
    await update({ stage: C.mergedStage, ...loopPunch({ merge: { sha: merged, rc: gate.rc }, conflict: null }) });
    return { id, action: 'merged', detail: merged };
  }
  restore();
  if (gate.rc === C.gateExit.red) {
    const failures = Number(task.metadata.punch?.mergeFailures ?? 0) + 1;
    await update({
      stage: C.restageOnRed,
      notes: `merger: gate RED\n${tail(gateOutput, opts.gateTailLines)}`,
      ...loopPunch({ mergeFailures: failures, verdict: null }),
    });
    return { id, action: 'gate-red', detail: String(failures) };
  }
  return cant(gate.timedOut ? 'gate timed out' : `gate exited ${gate.rc ?? 'without a status'}`);
}

