import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import { CONFIG_DEFAULTS as D, MERGE_MODES, PERMISSION_MODES } from './config.js';

const repoSchema = z.strictObject({
  path: z.string().min(1),
  main: z.string().min(1).default(D.repoMain),
  remote: z.string().min(1).default(D.repoRemote),
  gate: z.string().min(1),
  gateTimeoutMinutes: z.number().positive().default(D.gateTimeoutMinutes),
});

const permissionMode = (key: string) =>
  z.enum(PERMISSION_MODES, {
    errorMap: (issue, ctx) =>
      issue.code === 'invalid_enum_value'
        ? { message: `${key}: "${String(issue.received)}" is not supported (expected one of ${PERMISSION_MODES.join(', ')})` }
        : { message: ctx.defaultError },
  });
const mergeMode = z.enum(MERGE_MODES, {
  errorMap: (issue, ctx) =>
    issue.code === 'invalid_enum_value'
      ? { message: `merge.mode: "${String(issue.received)}" is not supported (expected ${MERGE_MODES.join(' or ')})` }
      : { message: ctx.defaultError },
});

const posInt = z.number().int().positive();

/** Schema for mandrel-loop.config.json. */
export const configSchema = z
  .object({
    mandrel: z.strictObject({
      url: z.string().url(),
      project: z.string().min(1),
      tokenEnv: z.string().min(1).default(D.tokenEnv),
      actor: z.string().min(1).default(D.actor),
    }),
    repos: z.record(z.string().min(1), repoSchema).default({}),
    models: z.strictObject({ worker: z.string().min(1), critic: z.string().min(1) }),
    lanes: posInt.default(D.lanes),
    tickSeconds: posInt.default(D.tickSeconds),
    merge: z.strictObject({ mode: mergeMode.default(D.mergeMode) }).default({}),
    worker: z
      .strictObject({
        timeoutMinutes: z.number().positive().default(D.workerTimeoutMinutes),
        maxAttempts: posInt.default(D.workerMaxAttempts),
        permissionMode: permissionMode('worker.permissionMode').default(D.workerPermissionMode),
        allowRoot: z.boolean().default(D.workerAllowRoot),
      })
      .default({}),
    critic: z
      .strictObject({
        maxAttempts: posInt.default(D.criticMaxAttempts),
        permissionMode: permissionMode('critic.permissionMode').default(D.criticPermissionMode),
        allowSameModel: z.boolean().default(D.criticAllowSameModel),
      })
      .default({}),
    workdir: z.string().min(1).optional(),
    notify: z.strictObject({ webhookUrlEnv: z.string().min(1).optional() }).default({}),
  })
  .strict()
  .superRefine((c, ctx) => {
    if (!c.critic.allowSameModel && c.models.worker === c.models.critic) {
      ctx.addIssue({
        code: 'custom',
        path: ['critic', 'allowSameModel'],
        message: 'models.worker and models.critic are the same model; set critic.allowSameModel to permit it',
      });
    }
  });

export type LoopConfig = z.infer<typeof configSchema>;

export class ConfigError extends Error {}

export interface LoadOptions {
  home?: string;
}

/** Parses config text; repo paths and the default workdir are resolved against `configDir` / `home`. */
export function parseConfig(text: string, configDir: string, opts: LoadOptions = {}): LoopConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new ConfigError(`config is not valid JSON: ${(e as Error).message}`);
  }
  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => {
      const key = i.path.join('.');
      return !key || i.message.startsWith(key) ? i.message : `${key}: ${i.message}`;
    });
    throw new ConfigError(`invalid config:\n  ${lines.join('\n  ')}`);
  }
  const c = parsed.data;
  const repos = Object.fromEntries(
    Object.entries(c.repos).map(([tag, r]) => [tag, { ...r, path: resolve(configDir, r.path) }]),
  );
  const workdir = c.workdir
    ? isAbsolute(c.workdir)
      ? c.workdir
      : resolve(configDir, c.workdir)
    : join(opts.home ?? homedir(), D.workdirName);
  return { ...c, repos, workdir };
}

/** Reads and validates the config file. */
export function loadConfig(file: string, opts: LoadOptions = {}): LoopConfig {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    throw new ConfigError(`cannot read config ${file}: ${(e as Error).message}`);
  }
  return parseConfig(text, dirname(resolve(file)), opts);
}
