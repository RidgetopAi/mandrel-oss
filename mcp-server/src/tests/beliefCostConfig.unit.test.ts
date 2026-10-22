/**
 * BELIEF COST CONFIG — env-override + fail-safe parsing tests (BL-10). NO DB.
 *
 * Locks the money-knob contract: the default rate table ships the two live adjudicator models,
 * every value is env-overridable, and a malformed override NEVER crashes cost accounting (it
 * falls back to defaults). The config module reads env at LOAD, so each case sets env then
 * dynamically re-imports a fresh module instance (vi.resetModules) — the same technique the
 * rest of the config suite uses.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

const ENV_KEYS = [
  'MANDREL_BELIEF_COST_RATES_JSON',
  'MANDREL_BELIEF_COST_ALERT_USD_PER_DAY',
  'MANDREL_BELIEF_COST_ROLLUP_WINDOW_DAYS',
];
const saved: Record<string, string | undefined> = {};
for (const k of ENV_KEYS) saved[k] = process.env[k];

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k]!;
  }
  vi.restoreAllMocks();
  vi.resetModules();
});

async function loadConfig() {
  vi.resetModules();
  return (await import('../config/beliefCostConfig.js')).BELIEF_COST_CONFIG;
}

describe('BELIEF_COST_CONFIG — defaults', () => {
  it('ships rates for both live adjudicator models + sane alarm/window defaults', async () => {
    for (const k of ENV_KEYS) delete process.env[k];
    const cfg = await loadConfig();
    expect(cfg.rates['claude-sonnet-5']).toEqual({
      input: 2.0,
      output: 10.0,
      cacheRead: 0.2,
      cacheWrite: 2.5,
    });
    expect(cfg.rates['claude-sonnet-5-5']).toEqual({
      input: 2.0,
      output: 10.0,
      cacheRead: 0.1,
      cacheWrite: 2.5,
    });
    expect(cfg.rates['openai/gpt-oss-120b']).toEqual({
      input: 0.15,
      output: 0.75,
      cacheRead: 0.075,
      cacheWrite: 0,
    });
    expect(cfg.alertUsdPerDay).toBe(5.0);
    expect(cfg.rollupWindowDays).toBe(7);
  });
});

describe('BELIEF_COST_CONFIG — env overrides', () => {
  it('alert threshold + window are env-overridable', async () => {
    process.env.MANDREL_BELIEF_COST_ALERT_USD_PER_DAY = '25';
    process.env.MANDREL_BELIEF_COST_ROLLUP_WINDOW_DAYS = '30';
    const cfg = await loadConfig();
    expect(cfg.alertUsdPerDay).toBe(25);
    expect(cfg.rollupWindowDays).toBe(30);
  });

  it('RATES_JSON overrides an existing model rate (partial fields keep defaults)', async () => {
    process.env.MANDREL_BELIEF_COST_RATES_JSON = JSON.stringify({
      'claude-sonnet-5': { input: 2.5 },
    });
    const cfg = await loadConfig();
    // input overridden; the other three fields keep the shipped defaults.
    expect(cfg.rates['claude-sonnet-5']).toEqual({
      input: 2.5,
      output: 10.0,
      cacheRead: 0.2,
      cacheWrite: 2.5,
    });
  });

  it('RATES_JSON can ADD a new model', async () => {
    process.env.MANDREL_BELIEF_COST_RATES_JSON = JSON.stringify({
      'some/new-model': { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 },
    });
    const cfg = await loadConfig();
    expect(cfg.rates['some/new-model']).toEqual({
      input: 1,
      output: 2,
      cacheRead: 0.1,
      cacheWrite: 1.25,
    });
    // Defaults still present.
    expect(cfg.rates['claude-sonnet-5'].input).toBe(2.0);
  });
});

describe('BELIEF_COST_CONFIG — fail-safe parsing (a bad env never crashes)', () => {
  it('malformed JSON is ignored → defaults kept (no throw)', async () => {
    process.env.MANDREL_BELIEF_COST_RATES_JSON = '{not valid json';
    const cfg = await loadConfig();
    expect(cfg.rates['claude-sonnet-5'].input).toBe(2.0);
    expect(cfg.rates['openai/gpt-oss-120b'].input).toBe(0.15);
  });

  it('a non-object override value is skipped, others still apply', async () => {
    process.env.MANDREL_BELIEF_COST_RATES_JSON = JSON.stringify({
      'claude-sonnet-5': 'nonsense',
      'openai/gpt-oss-120b': { input: 0.2 },
    });
    const cfg = await loadConfig();
    expect(cfg.rates['claude-sonnet-5'].input).toBe(2.0); // untouched
    expect(cfg.rates['openai/gpt-oss-120b'].input).toBe(0.2); // applied
  });

  it('a JSON array (not an object) is ignored entirely', async () => {
    process.env.MANDREL_BELIEF_COST_RATES_JSON = '[1,2,3]';
    const cfg = await loadConfig();
    expect(cfg.rates['claude-sonnet-5'].input).toBe(2.0);
  });
});
