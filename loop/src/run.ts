import { readFileSync, writeFileSync } from 'node:fs';
import type { Board } from './board.js';
import { MandrelBoard } from './board/mandrel.js';
import { defaultDoctorDeps, liveChecks, type DoctorDeps } from './doctor.js';
import { defaultAuthDeps, preflight, type AuthDeps } from './auth.js';
import { resolve } from 'node:path';
import { AUTH_CONFIG, claimStatusesFor, CONFIG_DEFAULTS, PLAN_CONFIG, SERVICE_CONFIG, TASK_STAGES, TICK_CONFIG } from './config.js';
import { costLine, formatCost, type CostSink } from './claudeRun.js';
import { formatViolation, formatWarning, lintPunches, lintWarnings } from './lint.js';
import { applyPunches, claudeRunner, LintRefusal, planFromSpec, type PlannerRunner } from './plan.js';
import { loadConfig, type LoopConfig } from './settings.js';
import { makeNotifier, notifyingBoard } from './notify.js';
import { renderService, SERVICE_TARGETS, type ServiceTarget } from './service.js';
import { hasValidPunch } from './pick.js';
import { tick } from './tick.js';
import { readVersion } from './version.js';

export const USAGE = [
  'usage: mandrel-loop [--version] [--help]',
  '       mandrel-loop plan <spec.md> [-o punches.json] [--config <file>]',
  '       mandrel-loop lint <punches.json> [--config <file>]',
  '       mandrel-loop plan --apply <punches.json> [--config <file>]',
  '       mandrel-loop doctor [--config <file>]',
  '       mandrel-loop run [--config <file>]',
  '       mandrel-loop once [--config <file>]',
  '       mandrel-loop status [--config <file>]',
  '       mandrel-loop ready <task-id> [--config <file>]',
  `       mandrel-loop service --print ${SERVICE_TARGETS.join('|')} [--config <file>]`,
].join('\n');

/** Everything `run` touches outside itself, injectable for tests. */
export interface Deps {
  out: (line: string) => void;
  err: (line: string) => void;
  env: NodeJS.ProcessEnv;
  /** The board for this run, built from the loaded config. */
  board: (env: NodeJS.ProcessEnv, config: LoopConfig, fetch?: typeof globalThis.fetch) => Board;
  planner: (env: NodeJS.ProcessEnv, onCost?: CostSink) => PlannerRunner;
  auth?: Partial<AuthDeps>;
  /** Overrides for the `doctor` live checks (git, filesystem). */
  doctor?: Partial<DoctorDeps>;
  fetch?: typeof fetch;
  /** Ends `run` when aborted; by default SIGINT and SIGTERM abort it. */
  signal?: AbortSignal;
  /** Absolute path of the running CLI, for the printed service definition. */
  cliPath?: string;
  /** Resolves after `ms` or when `signal` aborts. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

/** A board for the config's project; credentials come from the environment, by name. */
export function boardFromConfig(config: LoopConfig, env: NodeJS.ProcessEnv, fetch?: typeof globalThis.fetch): Board {
  const token = env[config.mandrel.tokenEnv];
  if (!token) throw new Error(`${config.mandrel.tokenEnv} is not set`);
  return new MandrelBoard({
    url: config.mandrel.url,
    authToken: token,
    connectionId: `${CONFIG_DEFAULTS.actor}-${config.mandrel.actor}`,
    actorId: config.mandrel.actor,
    project: config.mandrel.project,
    fetch,
  });
}

/** Runs `f` on `board`, then ends the board's connection whatever happened. */
async function withBoard<T>(board: Board, f: (b: Board) => Promise<T>): Promise<T> {
  try {
    return await f(board);
  } finally {
    await board.close().catch(() => undefined);
  }
}

let stdoutClosed = false;

/** Stops writing to `stream` once the reader has gone (EPIPE, e.g. `status | head`) instead of crashing. */
export function quietOnEpipe(stream: NodeJS.WriteStream): void {
  stream.on('error', (e: NodeJS.ErrnoException) => {
    if (e.code !== 'EPIPE') throw e;
    stdoutClosed = true;
  });
}

const defaultDeps: Deps = {
  out: (line) => {
    if (!stdoutClosed) process.stdout.write(`${line}\n`);
  },
  err: console.error,
  env: process.env,
  board: (env, config, fetch) => boardFromConfig(config, env, fetch),
  planner: claudeRunner,
};

const sleepUnlessAborted = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((done) => {
    const finish = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      done();
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener('abort', finish);
  });

/** SIGINT/SIGTERM as an AbortSignal; the handlers are removed by `dispose`. */
function terminationSignal(): { signal: AbortSignal; dispose: () => void } {
  const ctl = new AbortController();
  const stop = (): void => ctl.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  return {
    signal: ctl.signal,
    dispose: () => {
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
    },
  };
}

/** `--config <file>` or nothing. */
function configArg(rest: readonly string[]): string | undefined {
  if (rest.length === 0) return CONFIG_DEFAULTS.fileName;
  return rest.length === 2 && rest[0] === '--config' ? rest[1] : undefined;
}

/** `lint <file>` or `lint <file> --config <x>` or `lint --config <x> <file>`; undefined when malformed. */
function parseLintArgs(rest: readonly string[]): { file: string; config?: string } | undefined {
  const ci = rest.indexOf('--config');
  if (ci === -1) return rest.length === 1 ? { file: rest[0]! } : undefined;
  const others = [...rest.slice(0, ci), ...rest.slice(ci + 2)];
  const config = rest[ci + 1];
  return config === undefined || others.length !== 1 ? undefined : { file: others[0]!, config };
}

/** Runs `tick` once (`once`) or every `tickSeconds` until aborted or halted (`run`). */
async function tickLoop(d: Deps, config: LoopConfig, forever: boolean): Promise<number> {
  const notify = makeNotifier(config, { out: d.out, err: d.err, env: d.env, fetch: d.fetch });
  const board = notifyingBoard(d.board(d.env, config, d.fetch), notify);
  const term = d.signal ? null : terminationSignal();
  const signal = (d.signal ?? term!.signal);
  const sleep = d.sleep ?? sleepUnlessAborted;
  try {
    let streak = 0;
    do {
      const r = await tick({ board, config, env: d.env, err: d.err }, streak);
      streak = r.consecutiveNotStarted;
      d.err(`tick: dispatched ${r.dispatched}, ${r.outcomes.map((o) => o.outcome).join(',') || 'no workers'}${
          r.claudeRuns > 0 ? `, ${r.claudeRuns} claude run(s), cost ${formatCost(r.costUsd)}` : ''
        }`);
      if (r.halted) {
        d.err(`run: stopping after ${TICK_CONFIG.maxConsecutiveNotStarted} consecutive not-started workers`);
        return TICK_CONFIG.haltExit;
      }
      if (!forever || signal.aborted) break;
      await sleep(config.tickSeconds * 1000, signal);
    } while (!signal.aborted);
    return 0;
  } finally {
    term?.dispose();
    await board.close().catch(() => undefined);
  }
}

/** `ready <id>`: a draft the loop will not promote by itself (no dependencies) goes to ready. */
async function readyPunch(board: Board, id: string, out: (line: string) => void): Promise<number> {
  const task = await board.get(id);
  if (!task) throw new Error(`task ${id} not found`);
  if (task.stage !== TICK_CONFIG.readyFromStage) {
    throw new Error(`task ${id} is at stage ${task.stage}; only ${TICK_CONFIG.readyFromStage} punches can be marked ready`);
  }
  if (!hasValidPunch(task)) throw new Error(`task ${id} has no valid punch; run lint and fix it first`);
  const c = await board.claim(id, claimStatusesFor(task.stage));
  if (!c.ok) throw new Error(`could not claim ${id}: ${c.reason}`);
  try {
    const moved = await board.update(id, { stage: TICK_CONFIG.promotedStage, notes: 'loop: marked ready by operator' }, c.claimId);
    if (!moved.ok) throw new Error(`board refused: ${moved.reason}`);
  } finally {
    await board.release(id, c.claimId).catch(() => undefined);
  }
  out(`${id}: ${TICK_CONFIG.readyFromStage} -> ${TICK_CONFIG.promotedStage}`);
  return 0;
}

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(file, 'utf8'));
}

/** Runs the CLI against `argv` (without node/script), returning the process exit code. */
export async function run(argv: readonly string[], overrides: Partial<Deps> = {}): Promise<number> {
  const d = { ...defaultDeps, ...overrides };
  if (argv.includes('--version') || argv.includes('-v')) {
    d.out(readVersion());
    return 0;
  }
  const [cmd, ...rest] = argv;
  if (argv.includes('--help') || argv.includes('-h') || cmd === 'help') {
    d.out(USAGE);
    return 0;
  }
  try {
    if (cmd === 'ready' && rest.length >= 1 && configArg(rest.slice(1)) !== undefined) {
      const config = loadConfig(configArg(rest.slice(1))!, { home: d.env.HOME });
      return await withBoard(d.board(d.env, config, d.fetch), (b) => readyPunch(b, rest[0]!, d.out));
    }
    if (cmd === 'status' && configArg(rest) !== undefined) {
      const config = loadConfig(configArg(rest)!, { home: d.env.HOME });
      return await withBoard(d.board(d.env, config, d.fetch), async (board) => {
        for (const stage of TASK_STAGES) d.out(`${stage}: ${(await board.listStage(stage)).length}`);
        return 0;
      });
    }
    if (cmd === 'service' && rest[0] === '--print' && SERVICE_TARGETS.includes(rest[1] as ServiceTarget)) {
      const file = configArg(rest.slice(2));
      if (file === undefined) {
        d.err(USAGE);
        return 2;
      }
      const config = loadConfig(file, { home: d.env.HOME });
      d.out(renderService(rest[1] as ServiceTarget, resolve(file), config, d.cliPath ?? resolve(process.argv[1] ?? SERVICE_CONFIG.command)));
      return 0;
    }
    if ((cmd === 'doctor' || cmd === 'run' || cmd === 'once') && configArg(rest) !== undefined) {
      const config = loadConfig(configArg(rest)!, { home: d.env.HOME });
      const { problems, warnings } = preflight(config, { ...defaultAuthDeps(d.env), ...d.auth });
      warnings.forEach((w) => d.out(w));
      if (problems.length > 0) {
        problems.forEach((p) => d.err(`${cmd}: ${p}`));
        return AUTH_CONFIG.refusalExit;
      }
      if (cmd === 'doctor') {
        const live = await liveChecks(config, {
          ...defaultDoctorDeps(d.env, () => d.board(d.env, config, d.fetch)),
          ...d.doctor,
        });
        if (live.length > 0) {
          live.forEach((p) => d.err(`doctor: ${p}`));
          return AUTH_CONFIG.refusalExit;
        }
        d.out('doctor: all checks passed');
        return 0;
      }
      return await tickLoop(d, config, cmd === 'run');
    }
    const lintArgs = cmd === 'lint' ? parseLintArgs(rest) : undefined;
    if (lintArgs !== undefined) {
      const repoKeys = lintArgs.config === undefined ? undefined : Object.keys(loadConfig(lintArgs.config, { home: d.env.HOME }).repos);
      const punches = readJson(lintArgs.file);
      const violations = lintPunches(punches, undefined, repoKeys);
      violations.forEach((v) => d.out(formatViolation(v)));
      lintWarnings(punches).forEach((w) => d.out(formatWarning(w)));
      d.out(violations.length === 0 ? 'lint: clean' : `lint: ${violations.length} violation(s)`);
      return violations.length === 0 ? 0 : 1;
    }
    if (cmd === 'plan' && rest[0] === '--apply' && rest.length >= 2 && configArg(rest.slice(2)) !== undefined) {
      const config = loadConfig(configArg(rest.slice(2))!, { home: d.env.HOME });
      const created = await withBoard(d.board(d.env, config, d.fetch), (b) => applyPunches(b, readJson(rest[1]!), Object.keys(config.repos)));
      created.forEach((t) => d.out(`${t.id} ${t.title}`));
      d.out(`applied: ${created.length} draft(s)`);
      return 0;
    }
    if (cmd === 'plan' && rest.length >= 1 && rest[0] !== '--apply') {
      const ci = rest.indexOf('--config');
      const planRest = ci === -1 ? rest : [...rest.slice(0, ci), ...rest.slice(ci + 2)];
      const configFile = ci === -1 ? CONFIG_DEFAULTS.fileName : rest[ci + 1];
      const oi = planRest.indexOf('-o');
      const outFile = oi === -1 ? PLAN_CONFIG.defaultOutput : planRest[oi + 1];
      if (!outFile || !configFile || (oi !== -1 && planRest.length !== 3) || (oi === -1 && planRest.length !== 1)) {
        d.err(USAGE);
        return 2;
      }
      const config = loadConfig(configFile, { home: d.env.HOME });
      const repoKeys = Object.keys(config.repos);
      const punches = planFromSpec(readFileSync(planRest[0]!, 'utf8'), d.planner(d.env, (role, id, usd) => d.err(costLine(role, id, usd))), repoKeys);
      writeFileSync(outFile, `${JSON.stringify(punches, null, 2)}\n`);
      const violations = lintPunches(punches, undefined, repoKeys);
      violations.forEach((v) => d.out(formatViolation(v)));
      lintWarnings(punches).forEach((w) => d.out(formatWarning(w)));
      d.out(`wrote ${outFile}${violations.length === 0 ? '' : ` (${violations.length} lint violation(s))`}`);
      return violations.length === 0 ? 0 : 1;
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EPIPE') return 0;
    d.err(e instanceof LintRefusal ? e.message : `error: ${(e as Error).message}`);
    return 1;
  }
  d.out(USAGE);
  return argv.length === 0 ? 0 : 2;
}
