import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseClaudeResult, type CostSink } from './claudeRun.js';
import { childEnv } from './auth.js';
import { loopPunch, type Board, type DoneWhenClause, type Task } from './board.js';
import { CLAUDE_RUN_CONFIG, CRITIC_CONFIG as C, LOOP_EXHAUSTED_TAG, PLAN_CONFIG, PROOF_REQUIRED_OWNER, REPO_TAG_PREFIX, type CRITIC_VERDICTS } from './config.js';
import type { LoopConfig } from './settings.js';

export type Verdict = (typeof CRITIC_VERDICTS)[number];

export interface Run {
  passed: boolean;
  evidence?: string;
}
export interface MutationRecord {
  name: string;
  red?: Run;
  green?: Run;
}
export interface ClauseVerdict {
  index: number;
  verified: boolean;
  evidence?: string;
  mutations?: MutationRecord[];
}
export interface CriticVerdict {
  verdict: Verdict;
  note: string;
  clauses: ClauseVerdict[];
}

const VERDICTS: readonly string[] = Object.keys(C.stageFor);
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function parseRun(v: unknown): Run | undefined {
  return isRecord(v) && typeof v.passed === 'boolean'
    ? { passed: v.passed, ...(typeof v.evidence === 'string' ? { evidence: v.evidence } : {}) }
    : undefined;
}

/** Validates the shape of a verdict; throws with the reason when it is not one. */
export function parseVerdict(raw: unknown): CriticVerdict {
  if (!isRecord(raw)) throw new Error('verdict is not an object');
  if (typeof raw.verdict !== 'string' || !VERDICTS.includes(raw.verdict)) {
    throw new Error(`verdict must be one of ${VERDICTS.join(', ')}`);
  }
  const clauses = (Array.isArray(raw.clauses) ? raw.clauses : []).map((c, i): ClauseVerdict => {
    if (!isRecord(c)) throw new Error(`clauses[${i}] is not an object`);
    const mutations = Array.isArray(c.mutations)
      ? c.mutations.filter(isRecord).map((m): MutationRecord => {
          const red = parseRun(m.red);
          const green = parseRun(m.green);
          return { name: String(m.name ?? ''), ...(red ? { red } : {}), ...(green ? { green } : {}) };
        })
      : undefined;
    return {
      index: typeof c.index === 'number' ? c.index : i,
      verified: c.verified === true,
      ...(typeof c.evidence === 'string' ? { evidence: c.evidence } : {}),
      ...(mutations ? { mutations } : {}),
    };
  });
  return { verdict: raw.verdict as Verdict, note: typeof raw.note === 'string' ? raw.note : '', clauses };
}

/** The structured clauses of a punch; a legacy bare-string doneWhen has none. */
export function clausesOf(task: Task): DoneWhenClause[] {
  const dw = task.metadata.punch?.doneWhen;
  return Array.isArray(dw) ? dw : [];
}

/** Why a PASS must be downgraded to FAIL, or null when it stands. Non-PASS verdicts are never touched. */
export function passViolation(v: CriticVerdict, clauses: readonly DoneWhenClause[]): string | null {
  if (v.verdict !== 'PASS') return null;
  for (const [i, clause] of clauses.entries()) {
    const got = v.clauses.find((c) => c.index === i);
    if (clause.owner === PROOF_REQUIRED_OWNER && !got?.verified) {
      return `PASS rejected: owner:${clause.owner} clause ${i} ("${clause.text}") is not verified`;
    }
    if (clause.text.includes(C.mutationClauseText)) {
      const muts = got?.mutations ?? [];
      if (muts.length === 0) return `PASS rejected: clause ${i} requires a named mutation with red and green runs, none recorded`;
      for (const m of muts) {
        if (!m.red) return `PASS rejected: clause ${i} mutation "${m.name}" has no red run recorded`;
        if (!m.green) return `PASS rejected: clause ${i} mutation "${m.name}" has no green run recorded`;
        if (m.red.passed && m.green.passed) {
          return `PASS rejected: clause ${i} mutation "${m.name}" is GREEN in both runs (the proof does not detect it)`;
        }
        if (m.red.passed) return `PASS rejected: clause ${i} mutation "${m.name}" red run passed`;
        if (!m.green.passed) return `PASS rejected: clause ${i} mutation "${m.name}" green (unmutated) run failed`;
      }
    }
  }
  return null;
}

/** Applies the mechanical rules: a PASS that breaks one becomes a FAIL carrying the reason. */
export function score(v: CriticVerdict, clauses: readonly DoneWhenClause[]): CriticVerdict {
  const why = passViolation(v, clauses);
  return why ? { ...v, verdict: 'FAIL', note: [why, v.note].filter(Boolean).join(' — ') } : v;
}

/** Reads the verdict: `verdict.json` is the source of record; the marker line is only a fallback. */
export function readVerdict(evidenceDir: string, stdout: string): CriticVerdict {
  const file = join(evidenceDir, C.verdictFile);
  if (existsSync(file)) return parseVerdict(JSON.parse(readFileSync(file, 'utf8')));
  const line = stdout
    .split('\n')
    .reverse()
    .find((l) => l.startsWith(C.verdictMarker));
  if (!line) throw new Error(`no ${C.verdictFile} and no ${C.verdictMarker} line`);
  return parseVerdict(JSON.parse(line.slice(C.verdictMarker.length)));
}

export function renderDoneWhen(task: Task): string {
  const dw = task.metadata.punch?.doneWhen;
  if (typeof dw === 'string') return dw;
  return clausesOf(task)
    .map((c, i) => `${i}. [${c.owner}] ${c.text}${c.proof ? ` (proof: ${c.proof})` : ''}`)
    .join('\n');
}

export function readCriticCard(): string {
  return readFileSync(fileURLToPath(new URL(`../${C.cardPath}`, import.meta.url)), 'utf8');
}

export interface Workspace {
  tree: string;
  evidence: string;
}

/** Everything the critic touches outside itself, injectable for tests. */
export interface CriticDeps {
  env: NodeJS.ProcessEnv;
  card: string;
  /** Receives each Claude run's cost. */
  onCost?: CostSink;
  /** Runs a command, returning its status and output. */
  exec: (cmd: string, args: string[], opts: { cwd?: string; input?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number }) => {
    status: number | null;
    stdout: string;
    stderr: string;
  };
}

export const defaultCriticDeps = (env: NodeJS.ProcessEnv = process.env): CriticDeps => ({
  env,
  card: readCriticCard(),
  exec: (cmd, args, o) => {
    const r = spawnSync(cmd, args, {
      cwd: o.cwd,
      input: o.input,
      env: o.env,
      encoding: 'utf8',
      timeout: o.timeoutMs,
      maxBuffer: C.maxBufferBytes,
    });
    return { status: r.error ? null : r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? r.error?.message ?? '' };
  },
});

export type CriticOutcome = { verdict: Verdict; stage: string; note: string; exhausted: boolean };

const tail = (s: string): string => s.trim().split('\n').slice(-5).join(' | ');

/**
 * Verifies a `verifying` punch on its own worktree with `models.critic`, then moves it by verdict.
 * `claimId` is the live claim the board requires for the update.
 */
export async function runCritic(
  board: Board,
  config: LoopConfig,
  taskId: string,
  claimId: string,
  deps: CriticDeps = defaultCriticDeps(),
): Promise<CriticOutcome> {
  const task = await board.get(taskId);
  if (!task) throw new Error(`task ${taskId} not found`);
  const punch = task.metadata.punch ?? {};
  const repoTag = task.tags.find((t) => t.startsWith(REPO_TAG_PREFIX));
  const repo = repoTag ? (config.repos[repoTag] ?? config.repos[repoTag.slice(REPO_TAG_PREFIX.length)]) : undefined;
  const branch = punch[C.punchKeys.branch];
  const sha = punch[C.punchKeys.sha];
  const failures = Number(punch[C.punchKeys.failures] ?? 0) || 0;

  const cannot = async (note: string): Promise<CriticOutcome> => {
    await board.update(taskId, { notes: `critic COULD-NOT-MEASURE: ${note}` }, claimId);
    return { verdict: 'COULD-NOT-MEASURE', stage: C.stageFor['COULD-NOT-MEASURE'], note, exhausted: false };
  };

  if (!repo) return cannot(`no configured repo for tag ${repoTag ?? '(none)'}`);
  if (typeof branch !== 'string' || typeof sha !== 'string') return cannot('punch records no branch/sha to verify');

  const root = join(config.workdir ?? '', C.dir, task.id.slice(0, C.idPrefixLength));
  const ws: Workspace = { tree: join(root, C.treeDir), evidence: join(root, C.evidenceDir) };
  const git = (args: string[], cwd = repo.path) => deps.exec('git', args, { cwd, env: childEnv(deps.env) });
  rmSync(ws.tree, { recursive: true, force: true });
  rmSync(ws.evidence, { recursive: true, force: true });
  mkdirSync(ws.evidence, { recursive: true });
  git(['worktree', 'prune']);
  const added = git(['worktree', 'add', '--detach', ws.tree, sha]);
  if (added.status !== 0) return cannot(`cannot check out ${branch}@${sha}: ${tail(added.stderr)}`);

  try {
    const base = typeof punch[C.punchKeys.base] === 'string' ? (punch[C.punchKeys.base] as string) : repo.main;
    const prompt = [
      deps.card,
      '---',
      '# PUNCH',
      `title: ${task.title}`,
      `description: ${String(task.metadata.description ?? '')}`,
      `proofKind: ${String(punch.proofKind ?? '')}`,
      `repo: ${repoTag}`,
      `branch: ${branch}`,
      `sha: ${sha}`,
      `base: ${base}`,
      `evidence directory: ${ws.evidence}`,
      'doneWhen:',
      renderDoneWhen(task),
      '',
    ].join('\n');
    const bin = deps.env[PLAN_CONFIG.binEnv] || PLAN_CONFIG.defaultBin;
    const ran = deps.exec(bin, [...C.args, C.permissionModeFlag, config.critic.permissionMode, C.modelFlag, config.models.critic], {
      cwd: ws.tree,
      input: prompt,
      env: { ...childEnv(deps.env), [C.evidenceEnv]: ws.evidence },
      timeoutMs: C.timeoutMs,
    });

    const result = parseClaudeResult(ran.stdout);
    deps.onCost?.(CLAUDE_RUN_CONFIG.roles.critic, task.id.slice(0, C.idPrefixLength), result.costUsd);
    let verdict: CriticVerdict;
    try {
      verdict = readVerdict(ws.evidence, result.text);
    } catch (e) {
      const why = ran.status === 0 ? '' : ` (${bin} exited ${ran.status}: ${tail(ran.stderr)})`;
      return cannot(`${(e as Error).message}${why}`);
    }
    return await apply(board, task, claimId, score(verdict, clausesOf(task)), { branch, sha, failures, maxAttempts: config.critic.maxAttempts });
  } finally {
    git(['worktree', 'remove', '--force', ws.tree]);
    git(['worktree', 'prune']);
  }
}

async function apply(
  board: Board,
  task: Task,
  claimId: string,
  v: CriticVerdict,
  ctx: { branch: string; sha: string; failures: number; maxAttempts: number },
): Promise<CriticOutcome> {
  const stage = C.stageFor[v.verdict];
  const note = `critic ${v.verdict}${v.note ? `: ${v.note}` : ''}`;
  const out = (exhausted = false): CriticOutcome => ({ verdict: v.verdict, stage, note: v.note, exhausted });
  const check = async (r: ReturnType<Board['update']>): Promise<void> => {
    const res = await r;
    if (!res.ok) throw new Error(`board refused the ${v.verdict} update: ${res.reason}${res.message ? ` (${res.message})` : ''}`);
  };

  switch (v.verdict) {
    case 'PASS': {
      const mutations = v.clauses.flatMap((c) => c.mutations ?? []);
      const walkthrough = {
        verdict: v.verdict,
        round: ctx.failures + 1,
        branch: ctx.branch,
        sha: ctx.sha,
        clauses: v.clauses,
        red: mutations.filter((m) => m.red?.passed === false).map((m) => m.name),
        green: mutations.filter((m) => m.green?.passed === true).map((m) => m.name),
      };
      await check(board.update(task.id, { stage, notes: note, ...loopPunch({ [C.punchKeys.walkthrough]: walkthrough }) }, claimId));
      return out();
    }
    case 'FAIL': {
      const count = ctx.failures + 1;
      const exhausted = count >= ctx.maxAttempts;
      await check(
        board.update(
          task.id,
          {
            stage,
            notes: note,
            ...loopPunch({ [C.punchKeys.failures]: count }),
            ...(exhausted && !task.tags.includes(LOOP_EXHAUSTED_TAG) ? { tags: [...task.tags, LOOP_EXHAUSTED_TAG] } : {}),
          },
          claimId,
        ),
      );
      return out(exhausted);
    }
    case 'CONTRACT-DEFECT':
      await check(board.update(task.id, { stage, notes: note }, claimId));
      return out();
    case 'COULD-NOT-MEASURE':
      await check(board.update(task.id, { notes: note }, claimId));
      return out();
  }
}
