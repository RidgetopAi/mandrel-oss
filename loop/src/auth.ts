import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { AUTH_CONFIG, CONFIG_DEFAULTS } from './config.js';
import type { LoopConfig } from './settings.js';

/** Everything the preflight touches outside itself, injectable for tests. */
export interface AuthDeps {
  env: NodeJS.ProcessEnv;
  /** Effective uid; `undefined` where the platform has none (never treated as root). */
  uid: () => number | undefined;
  fileExists: (path: string) => boolean;
  /** True when `gh auth status` exits 0. */
  ghAuthOk: (env: NodeJS.ProcessEnv) => boolean;
}

export const defaultAuthDeps = (env: NodeJS.ProcessEnv): AuthDeps => ({
  env,
  uid: () => process.getuid?.(),
  fileExists: existsSync,
  ghAuthOk: (e) => spawnSync(AUTH_CONFIG.ghBin, [...AUTH_CONFIG.ghAuthArgs], { env: childEnv(e), stdio: 'ignore' }).status === 0,
});

/**
 * Every credential env name `doctor` can ask for, by default: the Mandrel token, the worker
 * credentials and the gh token. The README documents exactly this set (docs-env-names test).
 */
export const AUTH_ENV_NAMES: readonly string[] = [CONFIG_DEFAULTS.tokenEnv, ...AUTH_CONFIG.workerEnv, AUTH_CONFIG.ghTokenEnv];

/** The allow-listed environment handed to child processes. Nothing else is inherited. */
export function childEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const k of [...AUTH_CONFIG.childEnvBase, ...AUTH_CONFIG.workerEnv]) {
    const v = env[k];
    if (v) out[k] = v;
  }
  return out;
}

export interface PreflightResult {
  /** Refusals: any entry means exit 2. Names only, never values. */
  problems: string[];
  warnings: string[];
}

/** Checks root, the Mandrel token, a worker credential and (pr mode) a gh credential. */
export function preflight(config: LoopConfig, deps: AuthDeps): PreflightResult {
  const problems: string[] = [];
  const warnings: string[] = [];
  const { env } = deps;

  if (deps.uid() === 0) {
    if (config.worker.allowRoot) {
      warnings.push('WARNING: running as root (uid 0) because worker.allowRoot is true; use only in throwaway containers');
    } else {
      problems.push('refusing to run as root (uid 0): set worker.allowRoot to true to allow it in a throwaway container');
    }
  }

  const tokenEnv = config.mandrel.tokenEnv;
  if (!env[tokenEnv]) problems.push(`missing Mandrel token: ${tokenEnv}`);

  const home = env.HOME;
  const hasWorkerEnv = AUTH_CONFIG.workerEnv.some((k) => Boolean(env[k]));
  const hasCredFile = Boolean(home) && deps.fileExists(join(home!, ...AUTH_CONFIG.workerCredentialsFile));
  if (!hasWorkerEnv && !hasCredFile) {
    problems.push(
      `missing worker credential: set ${AUTH_CONFIG.workerEnv.join(' or ')}, or sign in with Claude Code (${join('~', ...AUTH_CONFIG.workerCredentialsFile)})`,
    );
  }

  if (config.merge.mode === 'pr' && !env[AUTH_CONFIG.ghTokenEnv] && !deps.ghAuthOk(env)) {
    problems.push(`missing gh credential (merge.mode is pr): set ${AUTH_CONFIG.ghTokenEnv} or run \`gh auth login\``);
  }

  return { problems, warnings };
}
