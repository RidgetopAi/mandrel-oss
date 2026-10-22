import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { childEnv } from './auth.js';
import type { Board } from './board.js';
import { AuthError, EndpointError, mcpEndpoint, ToolError } from './board/mandrel.js';
import { DOCTOR_CONFIG as C, MCP_CONFIG } from './config.js';
import type { LoopConfig } from './settings.js';

/** Everything the live checks touch outside themselves, injectable for tests. */
export interface DoctorDeps {
  env: NodeJS.ProcessEnv;
  board: () => Board;
  pathExists: (path: string) => boolean;
  /** Runs git in `cwd`; `status` is null when git could not be started. */
  git: (cwd: string, args: readonly string[]) => { status: number | null; stdout: string; stderr: string };
}

export const defaultDoctorDeps = (env: NodeJS.ProcessEnv, board: () => Board): DoctorDeps => ({
  env,
  board,
  pathExists: existsSync,
  git: (cwd, args) => {
    const r = spawnSync(C.gitBin, [...args], {
      cwd,
      env: { ...childEnv(env), ...C.gitEnv },
      encoding: 'utf8',
      timeout: C.gitTimeoutMs,
    });
    return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? r.error?.message ?? '' };
  },
});

const oneLine = (s: string): string => s.trim().split('\n')[0]?.slice(0, 200) ?? '';

/** The loop claims every task it works, so a server with claims off fails the loop at `ready`; catch it here. */
async function claimsCheck(board: Board, url: string): Promise<string[]> {
  const fail = (why: string): string[] => [
    `check task-claims failed: ${why}; fix: set ${C.claimsEnvVar}=true in the Mandrel server's environment (.env for the compose install) and restart it`,
  ];
  try {
    const r = await board.claim(C.claimProbeTaskId);
    if (r.ok) {
      // Cannot happen for an id that exists nowhere, but never leave a lease behind if it does.
      await board.release(C.claimProbeTaskId, r.claimId).catch(() => undefined);
      return [];
    }
    return r.reason === C.claimsDisabledReason ? fail(`${url} has task claims disabled (${C.claimsEnvVar} is off)`) : [];
  } catch (e) {
    return fail(`could not probe task claims on ${url} (${oneLine((e as Error).message)})`);
  }
}

/**
 * One project-scoped gateway call (`task.list`) proves, in order: Mandrel answers an MCP initialize,
 * it accepts the token, it dispatches the gateway tools, and the project exists. The first that fails
 * is the one reported. Gateway calls dispatch on every tool surface, so nothing reads tools/list.
 */
async function mandrelChecks(board: Board, config: LoopConfig): Promise<string[]> {
  const { url, tokenEnv, project } = config.mandrel;
  const endpoint = mcpEndpoint(url).href;
  try {
    await board.listStage(C.projectProbeStage);
    return [];
  } catch (e) {
    const why = oneLine((e as Error).message);
    if (e instanceof AuthError) {
      return [
        `check mandrel-auth failed: ${endpoint} refused the token in ${tokenEnv} (${why}); ` +
          `fix: create a token in Settings → API tokens (hosted Mandrel) or use the server's MCP_AUTH_TOKEN (self-hosted), and export it as ${tokenEnv}`,
      ];
    }
    if (e instanceof EndpointError) {
      return [
        `check mandrel-endpoint failed: ${why}; ` +
          `fix: set mandrel.url to the Mandrel server's base URL (the loop adds ${MCP_CONFIG.endpointPath}), and check the server is a Mandrel`,
      ];
    }
    if (!(e instanceof ToolError)) {
      return [
        `check mandrel-ping failed: ${endpoint} could not complete an MCP call (${why}); ` +
          `fix: start Mandrel, correct mandrel.url, or check the network between this machine and the server`,
      ];
    }
    if (C.unknownToolPatterns.some((p) => p.test(e.message))) {
      return [
        `check mandrel-project failed: ${endpoint} does not know the gateway tool the loop calls (${why}); ` +
          `fix: upgrade Mandrel to a version with the gateway tools (task, project)`,
      ];
    }
    return [
      `check mandrel-project failed: project "${project}" is not usable (${why}); ` +
        `fix: set mandrel.project to an existing project name or id${await projectNames(board)}, ` +
        `or create it with project({action:'create'}) (see loop/README.md)`,
    ];
  }
}

/** The project-check hint naming the projects the token can see; empty when they cannot be listed. */
async function projectNames(board: Board): Promise<string> {
  let names: string[];
  try {
    names = (await board.listProjects()).map((p) => p.name);
  } catch {
    return '';
  }
  if (names.length === 0) return '';
  const shown = names.slice(0, C.projectHintLimit).join(', ');
  const rest = names.length - C.projectHintLimit;
  return ` (this token sees: ${shown}${rest > 0 ? ` and ${rest} more` : ''})`;
}

/** Live checks, each reported by name with a fix hint. Returns problems (any entry means exit 2). */
export async function liveChecks(config: LoopConfig, deps: DoctorDeps): Promise<string[]> {
  const problems: string[] = [];
  const { url, tokenEnv } = config.mandrel;

  let board: Board | undefined;
  try {
    board = deps.board();
  } catch (e) {
    problems.push(`check mandrel-ping failed: cannot connect to ${url} with ${tokenEnv} (${oneLine((e as Error).message)}); fix: check mandrel.url and the token`);
  }
  if (board) {
    try {
      const mandrelProblems = await mandrelChecks(board, config);
      problems.push(...mandrelProblems);
      if (mandrelProblems.length === 0) problems.push(...(await claimsCheck(board, url)));
    } finally {
      await board.close().catch(() => undefined);
    }
  }

  for (const [tag, repo] of Object.entries(config.repos)) {
    const name = `repo ${tag}`;
    if (!deps.pathExists(repo.path)) {
      problems.push(`check repo-path failed: ${name}: ${repo.path} does not exist; fix: clone the repository there or correct repos.${tag}.path`);
      continue;
    }
    const inside = deps.git(repo.path, ['rev-parse', '--git-dir']);
    if (inside.status !== 0) {
      problems.push(`check repo-git failed: ${name}: ${repo.path} is not a git repository; fix: run \`git clone\` into it or correct repos.${tag}.path`);
      continue;
    }
    const remote = deps.git(repo.path, ['ls-remote', '--exit-code', repo.remote, 'HEAD']);
    if (remote.status !== 0) {
      problems.push(
        `check git-ls-remote failed: ${name}: remote "${repo.remote}" refused \`git ls-remote\` (${oneLine(remote.stderr) || `exit ${remote.status}`}); ` +
          `fix: check the remote name, network and credentials (GH_TOKEN, ssh key, credential helper)`,
      );
    }
    for (const key of C.identityKeys) {
      const v = deps.git(repo.path, ['config', '--get', key]);
      if (v.status !== 0 || v.stdout.trim() === '') {
        problems.push(`check git-identity failed: ${name}: git ${key} is not set; fix: git config --global ${key} "<value>"`);
      }
    }
  }
  return problems;
}
