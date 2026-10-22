import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, parseConfig } from '../src/settings.js';

const base = {
  mandrel: { url: 'http://localhost:8080', project: 'p' },
  models: { worker: 'm-a', critic: 'm-b' },
};
const load = (o: unknown) => parseConfig(JSON.stringify(o), '/cfg', { home: '/h' });

describe('nested config keys are rejected like top-level ones', () => {
  it.each(['worker', 'critic', 'merge', 'mandrel', 'models', 'notify'])('unknown key inside %s names the full path', (section) => {
    const cfg = { ...base, [section]: { ...((base as Record<string, object>)[section] ?? {}), user: 'loop' } };
    expect(() => load(cfg)).toThrow(ConfigError);
    expect(() => load(cfg)).toThrow(new RegExp(`${section}\\.user|${section}: .*user`));
    expect(() => load(cfg)).toThrow(/user/);
  });

  it('unknown key inside a repo entry is rejected', () => {
    const cfg = { ...base, repos: { 'repo:x': { path: '.', gate: 'g', sandbox: true } } };
    expect(() => load(cfg)).toThrow(/sandbox/);
  });

  it('the top level still rejects unknown keys', () => {
    expect(() => load({ ...base, extra: 1 })).toThrow(ConfigError);
  });

  it('valid configs still load', () => {
    const cfg = load({
      ...base,
      repos: { 'repo:x': { path: '.', gate: 'g' } },
      worker: { maxAttempts: 3 },
      critic: { maxAttempts: 1 },
      merge: { mode: 'direct' },
    });
    expect(cfg.worker.maxAttempts).toBe(3);
    expect(cfg.merge.mode).toBe('direct');
  });

  it('the shipped example config loads', () => {
    for (const f of ['../mandrel-loop.config.example.json', '../../mandrel-loop.config.example.json']) {
      try {
        const text = readFileSync(resolve(__dirname, f), 'utf8');
        expect(() => parseConfig(text, '/cfg', { home: '/h' })).not.toThrow();
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      }
    }
  });
});
