import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, parseConfig } from '../src/settings.js';
import { CONFIG_DEFAULTS, MERGE_MODES, MERGER_CONFIG } from '../src/config.js';

const DIR = '/etc-fixture/cfgdir';
const HOME = '/fixture-home';
const base = {
  mandrel: { url: 'http://localhost:8080', project: 'p' },
  models: { worker: 'm-a', critic: 'm-b' },
};
const parse = (o: unknown) => parseConfig(JSON.stringify(o), DIR, { home: HOME });

describe('config defaults', () => {
  const c = parse({ ...base, repos: { 'repo:x': { path: '../x', gate: 'make gate' } } });

  it('applies every stated default when omitted', () => {
    expect(c.mandrel.tokenEnv).toBe('MANDREL_TOKEN');
    expect(c.mandrel.actor).toBe('loop');
    expect(c.repos['repo:x']).toMatchObject({ main: 'main', remote: 'origin', gate: 'make gate' });
    expect(c.repos['repo:x']!.gateTimeoutMinutes).toBeGreaterThan(0);
    expect(c.lanes).toBe(1);
    expect(c.tickSeconds).toBe(300);
    expect(c.merge.mode).toBe('pr');
    expect(c.worker).toEqual({ timeoutMinutes: 45, maxAttempts: 2, permissionMode: 'bypassPermissions', allowRoot: false });
    expect(c.critic).toEqual({ maxAttempts: 2, permissionMode: 'bypassPermissions', allowSameModel: false });
    expect(c.critic.permissionMode).toBe(c.worker.permissionMode);
    expect(c.workdir).toBe(`${HOME}/.mandrel-loop`);
    expect(c.notify).toEqual({});
  });

  it('rejects a permission mode outside the allowed list, naming the key', () => {
    expect(() => parse({ ...base, critic: { permissionMode: 'yolo' } })).toThrow(/critic\.permissionMode/);
    expect(() => parse({ ...base, critic: { permissionMode: 'yolo' } })).toThrow(ConfigError);
    expect(() => parse({ ...base, worker: { permissionMode: 'yolo' } })).toThrow(/worker\.permissionMode/);
    expect(parse({ ...base, critic: { permissionMode: 'plan' } }).critic.permissionMode).toBe('plan');
  });

  it('resolves repo paths relative to the config file directory', () => {
    expect(c.repos['repo:x']!.path).toBe(resolve(DIR, '../x'));
  });

  it('keeps explicit values', () => {
    const e = parse({ ...base, lanes: 3, merge: { mode: 'direct' }, worker: { allowRoot: true } });
    expect(e.lanes).toBe(3);
    expect(e.merge.mode).toBe('direct');
    expect(e.worker.allowRoot).toBe(true);
  });
});

describe('config rejections', () => {
  it('rejects merge.mode rebase naming the key', () => {
    expect(() => parse({ ...base, merge: { mode: 'rebase' } })).toThrow(/merge\.mode/);
    expect(() => parse({ ...base, merge: { mode: 'rebase' } })).toThrow(ConfigError);
  });

  it('rejects the same model for worker and critic unless allowed', () => {
    const same = { ...base, models: { worker: 'm', critic: 'm' } };
    expect(() => parse(same)).toThrow(/allowSameModel/);
    expect(parse({ ...same, critic: { allowSameModel: true } }).critic.allowSameModel).toBe(true);
  });

  it('rejects unknown keys and bad JSON', () => {
    expect(() => parse({ ...base, bogus: 1 })).toThrow(/bogus/);
    expect(() => parseConfig('{', DIR)).toThrow(/JSON/);
  });
});

describe('merge modes have one source of truth', () => {
  it("MERGER_CONFIG derives its default mode and mode list from config.ts's single declaration", () => {
    expect(MERGER_CONFIG.defaultMode).toBe(CONFIG_DEFAULTS.mergeMode);
    expect(MERGER_CONFIG.modes).toEqual(MERGE_MODES);
  });

  it('MERGER_CONFIG shares the MERGE_MODES array itself, not an equal copy', () => {
    expect(MERGER_CONFIG.modes).toBe(MERGE_MODES);
  });

  it("spells the mode literals 'pr' and 'direct' in exactly one declaration of config.ts", () => {
    const src = readFileSync(new URL('../src/config.ts', import.meta.url), 'utf8');
    expect(src.match(/'pr'/g)).toHaveLength(1);
    expect(src.match(/'direct'/g)).toHaveLength(1);
  });
});
